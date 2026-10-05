/**
 * UI journeys — one `describe` per workflow in docs/workflows.md, driving the real <App/> with user-event
 * through the labels in PLAN §4.3 / workflows.md. Expected values come from the fixture anchors in
 * workflows.md; where the oracle gives a formula (summary counts, eligibility sentences, packet summary),
 * the expectation is computed with the engine so the test checks UI = engine rather than a hard-coded total.
 * Downloads are observed through the recorder in src/test/setup.ts.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { parseAuditLog } from '../engine/audit';
import { parseCaseFile, serializeCaseFile } from '../engine/casefile';
import { extensionEligibility, PROFILES } from '../engine/deadline';
import { buildDocket, DEFAULT_DOCKET_FILTERS, DOCKET_CSV_COLUMNS } from '../engine/docket';
import { findDuplicates } from '../engine/duplicates';
import { packetToHtml, packetToMarkdown, REVIEWER_BANNER } from '../engine/exports';
import { buildResponsePacket } from '../engine/reconcile';
import type { AuditLogFile } from '../engine/types';
import { setThemePreference } from '../theme/useTheme';
import { demoFile, demoRequest } from './fixtures/build';
import { wrongSchema } from './fixtures/hostile';
import {
  LABELS,
  SECTIONS,
  caseTitle,
  clearDownloads,
  clickAction,
  clockSummary,
  currentStage,
  docket,
  docketHeading,
  docketRow,
  docketRowIds,
  docketRows,
  expectAuditCount,
  expectStatusExact,
  jsonFile,
  openDialog,
  optionLabels,
  optionValues,
  pasteImport,
  readDownloadText,
  readDownloads,
  region,
  renderApp,
  selectRequest,
  setDateInput,
  sourceLine,
} from './helpers';

const AS_OF = '2026-10-01';
const DEMO_LOADED = 'Demo case file loaded. All data is synthetic; state lives in memory and resets on refresh.';
const EMPTY_DOCKET = 'No requests match these filters. Clear a filter or import a case file.';
const ALL_HELD = 'Every system of record already carries an active hold. Release one before applying another.';
/** The third-party value in REQ-2026-0411's crm `agentNote` (flagged `thirdParty` in the fixture); exports must omit it. */
const THIRD_PARTY_VALUE = 'Rowan';

afterEach(() => {
  setThemePreference('auto');
  document.documentElement.removeAttribute('data-theme');
  vi.restoreAllMocks();
});

function badge(id: string): HTMLElement | null {
  return docketRow(id).querySelector('.badge');
}

function sourceText(): string {
  return sourceLine().textContent?.replace(/\s+/g, ' ').trim() ?? '';
}

// =====================================================================================================

describe('1. Docket triage', () => {
  it('lists every request in urgency order with the preserved badge, meta and ribbon strings, and a summary strip that matches the engine', () => {
    renderApp();
    const file = demoFile();
    const { rows, summary } = buildDocket(file, findDuplicates(file.requests, 30), DEFAULT_DOCKET_FILTERS);

    expect(docketHeading()).toHaveTextContent(`Docket · ${summary.visible} of ${summary.total}`);
    expect(docketRowIds()).toEqual(rows.map((r) => r.request.id));
    expect(docketRowIds()[0]).toBe('REQ-2026-0398');

    const first = docketRow('REQ-2026-0398');
    expect(first).toHaveAttribute('aria-current', 'true');
    expect(badge('REQ-2026-0398')).toHaveTextContent('4d over');
    expect(first.querySelector('.meta')).toHaveTextContent('EU-GDPR · erasure · review');
    expect(within(first).getByRole('img')).toHaveAccessibleName('overdue: 4 days past due, due 2026-09-27, extension notice by 2026-09-27');
    expect(badge('REQ-2026-0399')).toHaveTextContent('4d left');
    expect(badge('REQ-2026-0411')).toHaveTextContent('7d left');
    expect(badge('REQ-2026-0415')).toHaveTextContent('14d left');
    expect(badge('REQ-2026-0416')).toHaveTextContent('15d left');
    expect(badge('REQ-2026-0420')).toHaveTextContent('39d left');
    expect(docketRow('REQ-2026-0416').querySelector('.meta')).toHaveTextContent('EU-GDPR · access · received · possible duplicate');
    expect(docketRow('REQ-2026-0411').querySelector('.meta')).not.toHaveTextContent('possible duplicate');
    expect(badge('REQ-2026-0380')).toHaveTextContent('closed');
    expect(badge('REQ-2026-0375')).toHaveTextContent('closed');
    expect(badge('REQ-2026-0390')).toHaveTextContent('rejected');
    expect(badge('REQ-2026-0419')).toHaveTextContent('21d left');
    expect(badge('REQ-2026-0423')).toHaveTextContent('43d left');
    expect(badge('REQ-2026-0402')).toHaveTextContent('61d left');
    expect(within(docketRow('REQ-2026-0402')).getByRole('img')).toHaveAccessibleName('on track: 61 days remaining, due 2026-12-01 after extension');

    const strip = within(docket()).getByRole('list', { name: SECTIONS.clockSummary });
    const items = within(strip).getAllByRole('listitem').map((li) => li.textContent);
    for (const [status, label] of [['overdue', 'overdue'], ['at-risk', 'at risk'], ['on-track', 'on track'], ['closed', 'closed'], ['rejected', 'rejected']] as const) {
      const count = summary.byStatus[status];
      if (count > 0) expect(items).toContain(`${count} ${label}`);
      else expect(items.some((t) => t?.endsWith(` ${label}`))).toBe(false);
    }
    expect(summary.byStatus.overdue).toBeGreaterThanOrEqual(1);
    expect(summary.duplicates).toBeGreaterThanOrEqual(1);
    expect(items).toContain(`${summary.duplicates} possible duplicate${summary.duplicates === 1 ? '' : 's'}`);
  });

  it('offers one jurisdiction option per profile, filters by jurisdiction, type and clock, shows the empty state, and selecting a row changes the detail but not the footer', async () => {
    const { user } = renderApp();
    const jurisdiction = screen.getByLabelText(LABELS.jurisdiction);
    expect(optionLabels(jurisdiction)).toEqual(['All', ...Object.values(PROFILES).map((p) => p.label)]);
    expect(optionLabels(jurisdiction)).toEqual(expect.arrayContaining(['EU GDPR', 'UK GDPR', 'California CCPA/CPRA', 'Virginia VCDPA', 'Colorado CPA', 'Canada PIPEDA']));
    expect(optionLabels(screen.getByLabelText(LABELS.type))).toEqual(['All', 'Access', 'Erasure', 'Rectification', 'Portability', 'Opt out']);
    expect(optionLabels(screen.getByLabelText(LABELS.clock))).toEqual(['All', 'Open only', 'Overdue', 'At risk', 'On track', 'Closed', 'Rejected']);

    await user.selectOptions(jurisdiction, 'CA-PIPEDA');
    expect(docketRowIds()).toEqual(['REQ-2026-0419']);
    expect(docketHeading()).toHaveTextContent(/^Docket · 1 of \d+$/);
    await user.selectOptions(jurisdiction, '');
    await user.selectOptions(screen.getByLabelText(LABELS.clock), 'closed');
    expect(docketRowIds()).toEqual(['REQ-2026-0375', 'REQ-2026-0380']);
    await user.selectOptions(screen.getByLabelText(LABELS.type), 'portability');
    expect(screen.getByText(EMPTY_DOCKET)).toBeInTheDocument();
    expect(docketHeading()).toHaveTextContent(/^Docket · 0 of \d+$/);
    await user.click(screen.getByRole('button', { name: LABELS.clearFilters }));
    expect(docketRowIds()[0]).toBe('REQ-2026-0398');

    await selectRequest(user, 'REQ-2026-0411');
    expect(caseTitle()).toHaveTextContent('REQ-2026-0411');
    expect(docketRow('REQ-2026-0411')).toHaveAttribute('aria-current', 'true');
    expect(docketRow('REQ-2026-0398')).toHaveAttribute('aria-current', 'false');
    expectStatusExact(DEMO_LOADED);
    expect(screen.getByRole('button', { name: 'Audit log (0)' })).toBeInTheDocument();
  });

  it('explains the duplicate match in the case detail of REQ-2026-0416', async () => {
    const { user } = renderApp();
    await selectRequest(user, 'REQ-2026-0416');
    expect(screen.getByText('possible duplicate of REQ-2026-0411')).toBeInTheDocument();
    expect(screen.getByRole('note')).toHaveTextContent(
      'Duplicate check. Same pseudonymous requester and request type as REQ-2026-0411 within the 30-day window. Consider merging or rejecting with reason duplicate; the decision stays with the analyst.',
    );
    await selectRequest(user, 'REQ-2026-0411');
    expect(screen.queryByText(/^possible duplicate of /)).toBeNull();
  });
});

// =====================================================================================================

describe('2. Set the as-of date', () => {
  it('recomputes every badge and the clock summary, ignores a cleared input and leaves the status and audit log untouched', async () => {
    const { user } = renderApp();
    const input = screen.getByLabelText(LABELS.asOfDate);
    expect(input).toHaveValue(AS_OF);
    expect(input).toHaveAccessibleDescription('Deadlines are calculated relative to this date so the demo stays deterministic.');
    expect(clockSummary()).toHaveTextContent('Window one calendar month');
    expect(clockSummary()).toHaveTextContent('Statutory due 27 Sep 2026');
    expect(clockSummary()).toHaveTextContent('Extension notice by 27 Sep 2026');
    expect(clockSummary()).toHaveTextContent('Elapsed 35 of 31 days');
    expect(clockSummary()).toHaveTextContent('4 days past due');
    expect(clockSummary().querySelector('time[datetime="2026-09-27"]')).toHaveTextContent('27 Sep 2026');

    setDateInput(input, '2026-10-06');
    expect(badge('REQ-2026-0398')).toHaveTextContent('9d over');
    expect(badge('REQ-2026-0399')).toHaveTextContent('1d over');
    expect(badge('REQ-2026-0411')).toHaveTextContent('2d left');
    expect(clockSummary()).toHaveTextContent('Elapsed 40 of 31 days');
    expect(clockSummary()).toHaveTextContent('9 days past due');

    setDateInput(input, '');
    expect(input).toHaveValue('2026-10-06');
    expect(badge('REQ-2026-0398')).toHaveTextContent('9d over');

    await selectRequest(user, 'REQ-2026-0419');
    expect(clockSummary()).toHaveTextContent('Window 30 calendar days');
    expect(clockSummary()).toHaveTextContent('Statutory due 22 Oct 2026');
    expect(clockSummary()).toHaveTextContent('Remaining 16 days');
    expect(within(region(SECTIONS.extension)).getByLabelText(LABELS.notifiedOn)).toHaveValue('2026-10-06');
    expectStatusExact(DEMO_LOADED);
    expect(screen.getByRole('button', { name: 'Audit log (0)' })).toBeInTheDocument();
  });
});

// =====================================================================================================

describe('3. Advance a request through the lifecycle', () => {
  it('walks REQ-2026-0415 from received to closed with the exact status after every action and focus on the heading after each stage change', async () => {
    const { user } = renderApp();
    await selectRequest(user, 'REQ-2026-0415');
    expect(within(region(SECTIONS.history)).getByText('No transitions yet. Start the identity check to begin the clock review.')).toBeInTheDocument();
    expect(within(region(SECTIONS.history)).getByText('0 transitions')).toBeInTheDocument();
    expect(currentStage()).toBe('Received');
    expect(within(region(SECTIONS.actions)).getByText('Moves to identity check and marks the check pending.')).toBeInTheDocument();
    expect(within(region(SECTIONS.actions)).getByText('Blocked actions explain themselves')).toBeInTheDocument();

    await clickAction(user, LABELS.startIdentityCheck);
    expectStatusExact('REQ-2026-0415: start-identity-check recorded. Stage is now identity-check.');
    expect(caseTitle()).toHaveFocus();
    expect(currentStage()).toBe('Identity check');
    expect(within(region(SECTIONS.identity)).getByText('pending')).toBeInTheDocument();

    await user.type(screen.getByLabelText(LABELS.noteForHistory), '  Signed-in session matched (synthetic)  ');
    await clickAction(user, LABELS.recordIdentityPassed);
    expectStatusExact('REQ-2026-0415: identity-passed recorded. Stage is now verified.');
    expect(caseTitle()).toHaveFocus();
    expect(currentStage()).toBe('Verified');
    expect(within(region(SECTIONS.history)).getByText('Signed-in session matched (synthetic)')).toBeInTheDocument(); // trimmed
    expect(screen.getByLabelText(LABELS.noteForHistory)).toHaveValue('');
    expect(within(region(SECTIONS.identity)).getByText('1 of 3')).toBeInTheDocument();

    await user.type(screen.getByLabelText(LABELS.noteForHistory), '   '); // whitespace-only: not recorded
    await clickAction(user, LABELS.beginSystemLookups);
    expectStatusExact('REQ-2026-0415: begin-collection recorded. Stage is now collecting.');
    expect(caseTitle()).toHaveFocus();
    expect(currentStage()).toBe('System lookups');
    expect(region(SECTIONS.history).querySelector('.history li:last-child .note')).toBeNull();

    for (const n of [1, 2, 3]) {
      await user.selectOptions(screen.getByLabelText(LABELS.outcome), 'none');
      await clickAction(user, LABELS.recordResult);
      expectStatusExact('REQ-2026-0415: record-system-result recorded. Stage is now collecting.');
      expect(region(SECTIONS.systems)).toHaveTextContent(new RegExp(`${n} of 3 looked up`));
    }
    expect(screen.getByText('All systems looked up. The request can go to the reviewer.')).toBeInTheDocument();
    expect(document.activeElement).not.toBe(document.body);

    await clickAction(user, LABELS.sendToReviewer);
    expectStatusExact('REQ-2026-0415: send-to-review recorded. Stage is now review.');
    expect(caseTitle()).toHaveFocus();
    expect(currentStage()).toBe('Reviewer');
    expect(within(region(SECTIONS.holds)).getByText('No holds. A hold excludes one system from this request and must carry a written justification before the response can be prepared.')).toBeInTheDocument();

    await clickAction(user, LABELS.prepareResponsePacket);
    expectStatusExact('REQ-2026-0415: prepare-response recorded. Stage is now response-ready.');
    expect(caseTitle()).toHaveFocus();
    expect(currentStage()).toBe('Response ready');

    await clickAction(user, LABELS.closeRequest);
    expectStatusExact('REQ-2026-0415: close recorded. Stage is now closed.');
    expect(caseTitle()).toHaveFocus();
    expect(currentStage()).toBe('Closed');
    expect(clockSummary()).toHaveTextContent('Closed 1 Oct 2026');
    expect(screen.getByText('Closed on time')).toBeInTheDocument();
    expect(badge('REQ-2026-0415')).toHaveTextContent('closed');
    expect(screen.getByText('This request is closed. Terminal stages accept no further actions; the history and audit log remain inspectable.')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: SECTIONS.extension })).toBeNull();
    expect(within(region(SECTIONS.history)).getByText('9 transitions')).toBeInTheDocument();
    expect(within(region(SECTIONS.history)).getAllByText('2026-10-01 12:00:00 UTC')).toHaveLength(9);
    expect(region(SECTIONS.history).querySelector('time[datetime="2026-10-01T12:00:00Z"]')).not.toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    await expectAuditCount(9);
  });

  it('the third failed identity attempt rejects REQ-2026-0420 with identity-unverified', async () => {
    const { user } = renderApp();
    await selectRequest(user, 'REQ-2026-0420');
    expect(within(region(SECTIONS.identity)).getByText('1 of 3')).toBeInTheDocument();
    expect(within(region(SECTIONS.actions)).getByText('Counts a failed attempt; the third failure rejects the request.')).toBeInTheDocument();

    await clickAction(user, LABELS.recordFailedAttempt);
    expectStatusExact('REQ-2026-0420: identity-failed recorded. Stage is now identity-check.');
    expect(within(region(SECTIONS.identity)).getByText('2 of 3')).toBeInTheDocument();
    expect(currentStage()).toBe('Identity check');
    expect(document.activeElement).not.toBe(document.body);

    await clickAction(user, LABELS.recordFailedAttempt);
    expectStatusExact('REQ-2026-0420: identity-failed recorded. Stage is now rejected.');
    expect(caseTitle()).toHaveFocus();
    expect(currentStage()).toBe('Rejected');
    expect(within(region(SECTIONS.identity)).getByText('3 of 3')).toBeInTheDocument();
    expect(within(region(SECTIONS.identity)).getByText('failed')).toBeInTheDocument();
    expect(clockSummary()).toHaveTextContent('Rejected: identity-unverified');
    expect(within(region(SECTIONS.history)).getByText('Identity could not be verified after 3 attempts.')).toBeInTheDocument();
    expect(screen.getByText('This request is rejected. Terminal stages accept no further actions; the history and audit log remain inspectable.')).toBeInTheDocument();
    expect(badge('REQ-2026-0420')).toHaveTextContent('rejected');
    await expectAuditCount(2);
  });

  it('rejects REQ-2026-0423 with the chosen reason and the optional note', async () => {
    const { user } = renderApp();
    await selectRequest(user, 'REQ-2026-0423');
    expect(clockSummary()).toHaveTextContent('Window 45 calendar days');
    expect(optionValues(screen.getByLabelText(LABELS.rejectReason))).toEqual(['duplicate', 'manifestly-unfounded', 'identity-unverified', 'out-of-scope']);
    await user.selectOptions(screen.getByLabelText(LABELS.rejectReason), 'out-of-scope');
    await user.type(screen.getByLabelText(LABELS.noteForHistory), 'Requester is outside the synthetic scope.');
    await clickAction(user, LABELS.rejectWithThisReason);
    expectStatusExact('REQ-2026-0423: reject recorded. Stage is now rejected.');
    expect(caseTitle()).toHaveFocus();
    expect(currentStage()).toBe('Rejected');
    expect(clockSummary()).toHaveTextContent('Rejected: out-of-scope');
    expect(within(region(SECTIONS.history)).getByText('Requester is outside the synthetic scope.')).toBeInTheDocument();
    expect(region(SECTIONS.history)).toHaveTextContent('reject · received → rejected · analyst.demo');
    expect(screen.queryByRole('button', { name: LABELS.rejectWithThisReason })).toBeNull();
    await expectAuditCount(1);
  });

  it('keeps a blocked action visible as a real button with aria-disabled and its explanation; clicking it does nothing', async () => {
    const { user } = renderApp();
    await selectRequest(user, 'REQ-2026-0411');
    const send = screen.getByRole('button', { name: LABELS.sendToReviewer });
    expect(send).toHaveAttribute('aria-disabled', 'true');
    expect(send).not.toBeDisabled();
    expect(send).toHaveAttribute('aria-describedby', 'why-send-to-review');
    expect(send).toHaveAccessibleDescription('Lookups still outstanding for: support.');
    await user.click(send);
    expect(screen.queryByRole('alert')).toBeNull();
    expectStatusExact(DEMO_LOADED);
    expect(currentStage()).toBe('System lookups');
    expect(screen.getByRole('button', { name: 'Audit log (0)' })).toBeInTheDocument();
  });
});

// =====================================================================================================

describe('4. Record simulated system lookups', () => {
  it('REQ-2026-0411: shows the lookup table with its flags, records a found result with a third-party field and reaches the green notice', async () => {
    const { user } = renderApp();
    await selectRequest(user, 'REQ-2026-0411');
    expect(region(SECTIONS.systems)).toHaveTextContent('2 of 3 looked up · outstanding: support');

    const table = screen.getByRole('region', { name: SECTIONS.lookupResults });
    expect(table).toHaveAttribute('tabindex', '0');
    expect(within(table).getAllByRole('columnheader').map((th) => th.textContent)).toEqual(['System', 'Result', 'Matched by', 'Subject email on file', 'Fields']);
    expect(within(table).getByText('not looked up')).toBeInTheDocument();
    expect(within(table).getByText('found · crm-10431')).toBeInTheDocument();
    expect(within(table).getByText('found · cust-88112')).toBeInTheDocument();
    expect(within(table).getByText('third party')).toBeInTheDocument();
    expect(within(table).queryByText('conflict')).toBeNull();

    const form = screen.getByRole('form', { name: SECTIONS.recordForm });
    expect(form).toHaveTextContent('Record a lookup result (simulated — nothing is queried)');
    expect(optionLabels(within(form).getByLabelText('System'))).toEqual(['Helpdesk Tickets (synthetic)']);
    expect(optionLabels(within(form).getByLabelText(LABELS.outcome))).toEqual(['Record found', 'No record']);
    await user.type(within(form).getByLabelText('Record id'), 'tickets-10431');
    await user.type(within(form).getByLabelText('Subject email on file'), 'lark.7731@people.example');
    await user.type(within(form).getByLabelText('Field 1 name'), 'tickets');
    await user.type(within(form).getByLabelText('Field 1 value'), '2 tickets about a delivery slot');
    await user.click(within(form).getByRole('button', { name: 'Add field' }));
    await user.type(within(form).getByLabelText('Field 2 name'), 'agentNote');
    await user.type(within(form).getByLabelText('Field 2 value'), 'Spouse called about the order (synthetic)');
    await user.click(within(form).getAllByLabelText('third party')[1]!);
    await user.click(within(form).getByRole('button', { name: 'Remove field 1' }));
    expect(within(form).queryByLabelText('Field 2 name')).toBeNull();
    expect(within(form).getByLabelText('Field 1 name')).toHaveValue('agentNote');

    await clickAction(user, LABELS.recordResult);
    expectStatusExact('REQ-2026-0411: record-system-result recorded. Stage is now collecting.');
    expect(region(SECTIONS.systems)).toHaveTextContent('3 of 3 looked up');
    expect(region(SECTIONS.systems)).not.toHaveTextContent('outstanding:');
    expect(within(table).getByText('found · tickets-10431')).toBeInTheDocument();
    expect(within(table).getAllByText('third party')).toHaveLength(2);
    expect(screen.getByText('All systems looked up. The request can go to the reviewer.')).toBeInTheDocument();
    expect(screen.queryByRole('form', { name: SECTIONS.recordForm })).toBeNull();
    expect(within(region(SECTIONS.history)).getByText('support: record found')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: LABELS.sendToReviewer })).toHaveAttribute('aria-disabled', 'false');
    expect(document.activeElement).not.toBe(document.body);
    // the new third-party field is redacted in the packet like the fixture's
    expect(within(region(SECTIONS.packet)).getAllByLabelText('redacted')).toHaveLength(2);
    expect(region(SECTIONS.packet)).not.toHaveTextContent('Spouse called');
    await expectAuditCount(1);
  });

  it('records "No record" for the outstanding system and leaves the other results alone', async () => {
    const { user } = renderApp();
    await selectRequest(user, 'REQ-2026-0411');
    await user.selectOptions(screen.getByLabelText(LABELS.outcome), 'none');
    expect(screen.queryByLabelText('Record id')).toBeNull();
    await clickAction(user, LABELS.recordResult);
    expectStatusExact('REQ-2026-0411: record-system-result recorded. Stage is now collecting.');
    const table = screen.getByRole('region', { name: SECTIONS.lookupResults });
    expect(within(table).getByText('no record')).toBeInTheDocument();
    expect(within(table).getByText('found · crm-10431')).toBeInTheDocument();
    expect(within(region(SECTIONS.history)).getByText('support: no record')).toBeInTheDocument();
    await clickAction(user, LABELS.sendToReviewer);
    expectStatusExact('REQ-2026-0411: send-to-review recorded. Stage is now review.');
  });
});

// =====================================================================================================

describe('5. Holds and exemptions', () => {
  it('REQ-2026-0411: record the lookup, send to review, an unjustified hold blocks the response, release it, prepare the response — with focus management and the held system excluded from the form', async () => {
    const { user } = renderApp();
    await selectRequest(user, 'REQ-2026-0411');
    await user.selectOptions(screen.getByLabelText(LABELS.outcome), 'none');
    await clickAction(user, LABELS.recordResult);
    expectStatusExact('REQ-2026-0411: record-system-result recorded. Stage is now collecting.');
    await clickAction(user, LABELS.sendToReviewer);
    expectStatusExact('REQ-2026-0411: send-to-review recorded. Stage is now review.');
    expect(caseTitle()).toHaveFocus();
    expect(currentStage()).toBe('Reviewer');

    const holdSystem = () => within(region(SECTIONS.holds)).getByLabelText('System');
    expect(region(SECTIONS.holds)).toHaveTextContent('0 active');
    expect(optionValues(holdSystem())).toEqual(['crm', 'billing', 'support']);
    expect(optionValues(within(region(SECTIONS.holds)).getByLabelText('Reason'))).toEqual(['legal-hold', 'ongoing-transaction', 'fraud-prevention', 'legal-obligation-retention', 'third-party-rights']);

    await clickAction(user, LABELS.applyHold);
    expectStatusExact('REQ-2026-0411: apply-hold recorded. Stage is now review.');
    expect(region(SECTIONS.holds)).toHaveTextContent('1 active');
    expect(region(SECTIONS.holds)).toHaveTextContent('legal-obligation-retention on crm · HOLD-0411-1');
    expect(within(region(SECTIONS.holds)).getByText('No justification written yet — blocks the response.')).toBeInTheDocument();
    expect(optionValues(holdSystem())).toEqual(['billing', 'support']);
    expect(document.activeElement).not.toBe(document.body);

    const prepare = screen.getByRole('button', { name: LABELS.prepareResponsePacket });
    expect(prepare).toHaveAttribute('aria-disabled', 'true');
    expect(prepare).toHaveAccessibleDescription('Holds without a written justification: HOLD-0411-1.');
    await user.click(prepare);
    expect(screen.queryByRole('alert')).toBeNull();
    expectStatusExact('REQ-2026-0411: apply-hold recorded. Stage is now review.');
    expect(currentStage()).toBe('Reviewer');
    expect(region(SECTIONS.packet)).toHaveTextContent('Excluded by hold');
    expect(region(SECTIONS.packet)).toHaveTextContent('crm · legal-obligation-retention:');

    await clickAction(user, LABELS.releaseHold);
    expectStatusExact('REQ-2026-0411: release-hold recorded. Stage is now review.');
    expect(region(SECTIONS.holds)).toHaveTextContent('0 active');
    expect(region(SECTIONS.holds)).toHaveTextContent(`released ${AS_OF}`);
    expect(within(region(SECTIONS.holds)).getByText('Released without a written justification.')).toBeInTheDocument();
    expect(optionValues(holdSystem())).toEqual(['crm', 'billing', 'support']);
    expect(document.activeElement).not.toBe(document.body);
    expect(screen.getByRole('button', { name: LABELS.prepareResponsePacket })).toHaveAttribute('aria-disabled', 'false');
    expect(region(SECTIONS.packet)).not.toHaveTextContent('Excluded by hold');

    await clickAction(user, LABELS.prepareResponsePacket);
    expectStatusExact('REQ-2026-0411: prepare-response recorded. Stage is now response-ready.');
    expect(caseTitle()).toHaveFocus();
    expect(currentStage()).toBe('Response ready');
    expect(screen.queryByRole('button', { name: LABELS.releaseHold })).toBeNull();
    expect(screen.queryByRole('button', { name: LABELS.applyHold })).toBeNull();
    expect(within(region(SECTIONS.history)).getByText('legal-obligation-retention on crm')).toBeInTheDocument();
    expect(within(region(SECTIONS.history)).getByText('released legal-obligation-retention on crm')).toBeInTheDocument();
    await expectAuditCount(5);
  });

  it('REQ-2026-0398: the held system is absent from the form; an unjustified hold blocks the packet until released; with every system held the form is replaced by the note; justified holds yield a partial response', async () => {
    const { user } = renderApp();
    const holds = () => region(SECTIONS.holds);
    expect(holds()).toHaveTextContent('1 active');
    expect(holds()).toHaveTextContent('legal-obligation-retention on billing · HOLD-0398-1');
    expect(holds()).toHaveTextContent('Invoices must be retained for the synthetic fiscal retention period');
    expect(optionValues(within(holds()).getByLabelText('System'))).toEqual(['crm', 'support']);
    expect(screen.getByRole('button', { name: LABELS.prepareResponsePacket })).toHaveAttribute('aria-disabled', 'false');
    expect(region(SECTIONS.packet)).toHaveTextContent('billing · legal-obligation-retention: Invoices must be retained');

    await user.selectOptions(within(holds()).getByLabelText('System'), 'support');
    await user.selectOptions(within(holds()).getByLabelText('Reason'), 'third-party-rights');
    await clickAction(user, LABELS.applyHold);
    expectStatusExact('REQ-2026-0398: apply-hold recorded. Stage is now review.');
    expect(holds()).toHaveTextContent('2 active');
    expect(holds()).toHaveTextContent('third-party-rights on support · HOLD-0398-2');
    expect(within(holds()).getByText('No justification written yet — blocks the response.')).toBeInTheDocument();
    expect(optionValues(within(holds()).getByLabelText('System'))).toEqual(['crm']);
    const prepare = screen.getByRole('button', { name: LABELS.prepareResponsePacket });
    expect(prepare).toHaveAttribute('aria-disabled', 'true');
    expect(prepare).toHaveAccessibleDescription('Holds without a written justification: HOLD-0398-2.');
    await user.click(prepare);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(region(SECTIONS.packet)).toHaveTextContent('support · third-party-rights:');

    await user.type(within(holds()).getByLabelText(LABELS.holdJustification), 'Profile fields retained for the synthetic dispute window.');
    await clickAction(user, LABELS.applyHold);
    expectStatusExact('REQ-2026-0398: apply-hold recorded. Stage is now review.');
    expect(holds()).toHaveTextContent('3 active');
    expect(holds()).toHaveTextContent('third-party-rights on crm · HOLD-0398-3');
    expect(within(holds()).getByText(ALL_HELD)).toBeInTheDocument();
    expect(within(holds()).queryByLabelText('System')).toBeNull();
    expect(screen.queryByRole('button', { name: LABELS.applyHold })).toBeNull();

    await clickAction(user, LABELS.releaseHold, 1); // HOLD-0398-2 (support), the unjustified one
    expectStatusExact('REQ-2026-0398: release-hold recorded. Stage is now review.');
    expect(holds()).toHaveTextContent('2 active');
    expect(within(holds()).queryByText(ALL_HELD)).toBeNull();
    expect(optionValues(within(holds()).getByLabelText('System'))).toEqual(['support']);
    expect(screen.getByRole('button', { name: LABELS.prepareResponsePacket })).toHaveAttribute('aria-disabled', 'false');

    await clickAction(user, LABELS.prepareResponsePacket);
    expectStatusExact('REQ-2026-0398: prepare-response recorded. Stage is now response-ready.');
    expect(region(SECTIONS.packet)).toHaveTextContent('Partial — something is withheld');
    expect(within(region(SECTIONS.packet)).getByText('No disclosable records: every found record is held or in conflict.')).toBeInTheDocument();
    const actions = within(region(SECTIONS.packet)).getByRole('table', { name: SECTIONS.proposedActions });
    expect(within(actions).getAllByRole('row').slice(1).map((row) => within(row).getAllByRole('cell').map((cell) => cell.textContent))).toEqual([
      ['crm', 'retain', 'third-party-rights'],
      ['billing', 'retain', 'legal-obligation-retention'],
    ]);
    // Holds tallied in systemResults order (crm before billing); cross-checked against the engine on the same end state.
    const expectedSummary = 'Erasure request: retain 2 systems (1 under third-party-rights, 1 under legal-obligation-retention); partial response.';
    const original = demoRequest('REQ-2026-0398');
    const endState = {
      ...original,
      holds: [
        ...original.holds,
        { id: 'HOLD-0398-2', systemId: 'support', reason: 'third-party-rights' as const, note: '', appliedAt: `${AS_OF}T12:00:00Z`, releasedAt: `${AS_OF}T12:00:00Z` },
        { id: 'HOLD-0398-3', systemId: 'crm', reason: 'third-party-rights' as const, note: 'Profile fields retained for the synthetic dispute window.', appliedAt: `${AS_OF}T12:00:00Z` },
      ],
    };
    expect(buildResponsePacket(endState, AS_OF).summary).toBe(expectedSummary);
    expect(within(region(SECTIONS.packet)).getByText(expectedSummary)).toBeInTheDocument();
    expect(region(SECTIONS.packet)).toHaveTextContent('crm · third-party-rights: Profile fields retained for the synthetic dispute window.');
    await expectAuditCount(4);
  });
});

// =====================================================================================================

describe('6. Response packet and exports', () => {
  it('REQ-2026-0399: previews disclosures, masks redactions until revealed, lists the proposed actions, the engine summary and the identity conflict', async () => {
    const { user } = renderApp();
    await selectRequest(user, 'REQ-2026-0399');
    const packet = region(SECTIONS.packet);
    expect(packet).toHaveTextContent('Partial — something is withheld');

    const engine = buildResponsePacket(demoRequest('REQ-2026-0399'), AS_OF);
    expect(engine.summary).toBe('Erasure request: erase 1 system, withhold 1 system (identity conflict), 2 redactions (1 third-party data, 1 identity conflict); partial response.');
    expect(within(packet).getByText(engine.summary!)).toBeInTheDocument();

    expect(within(packet).getAllByLabelText('redacted')).toHaveLength(2);
    expect(packet).not.toHaveTextContent('Ines Farrow');
    expect(within(packet).getByText('third-party-data')).toBeInTheDocument();
    expect(within(packet).getAllByText('identity-conflict')).toHaveLength(2); // redaction tag + proposed-action reason
    await user.click(within(packet).getByLabelText(LABELS.revealRedacted));
    expect(within(packet).getByLabelText('redacted value: Neighbour Ines Farrow accepted the parcel on 3 June.')).toBeInTheDocument();
    expect(within(packet).getByLabelText('redacted value: 2 tickets about a damaged parcel')).toBeInTheDocument();
    expect(within(packet).queryAllByLabelText('redacted')).toHaveLength(0);

    const actions = within(packet).getByRole('table', { name: SECTIONS.proposedActions });
    expect(within(actions).getAllByRole('columnheader').map((th) => th.textContent)).toEqual(['System', 'Action', 'Reason']);
    expect(within(actions).getAllByRole('row').slice(1).map((row) => within(row).getAllByRole('cell').map((cell) => cell.textContent))).toEqual([
      ['crm', 'erase', '—'],
      ['support', 'withhold', 'identity-conflict'],
    ]);
    expect(within(packet).getByText('Identity conflicts')).toBeInTheDocument();
    expect(packet).toHaveTextContent('support: stored subject email does not match the verified requester; record withheld pending re-verification.');
    expect(within(packet).getByText('displayName')).toBeInTheDocument();
    expect(within(packet).getByText('Heron Dalisay')).toBeInTheDocument();
    expect(packet).not.toHaveTextContent('Excluded by hold');
  });

  it('REQ-2026-0411: Export packet JSON / Markdown / HTML download under the request id and omit the third-party value', async () => {
    const { user } = renderApp();
    const request = demoRequest('REQ-2026-0411');
    const thirdParty = request.systemResults.flatMap((r) => r.fields).filter((f) => f.thirdParty);
    expect(thirdParty.map((f) => f.value)).toEqual([expect.stringContaining(THIRD_PARTY_VALUE)]);

    await selectRequest(user, 'REQ-2026-0411');
    expect(region(SECTIONS.packet)).not.toHaveTextContent(THIRD_PARTY_VALUE);
    await clickAction(user, LABELS.exportPacketJson);
    await clickAction(user, LABELS.exportPacketMarkdown);
    await clickAction(user, LABELS.exportPacketHtml);
    expect(readDownloads().map((d) => d.filename)).toEqual(['REQ-2026-0411-response-packet.json', 'REQ-2026-0411-response-packet.md', 'REQ-2026-0411-response-packet.html']);
    expect(readDownloads().map((d) => d.blob?.type)).toEqual(['application/json', 'text/markdown', 'text/html']);
    const [json, md, html] = await Promise.all([readDownloadText(0), readDownloadText(1), readDownloadText(2)]);

    const parsed = JSON.parse(json) as unknown;
    expect(parsed).toEqual(buildResponsePacket(request, AS_OF));
    expect((parsed as { redactions: unknown }).redactions).toEqual([{ systemId: 'crm', field: 'agentNote', reason: 'third-party-data' }]);

    for (const body of [json, md, html]) {
      expect(body).toContain('REQ-2026-0411');
      expect(body).toContain('agentNote');
      expect(body).not.toContain(THIRD_PARTY_VALUE);
      expect(body).not.toContain(REVIEWER_BANNER);
    }
    expect(md).toMatch(/^# Response packet — REQ-2026-0411 \(Access request\)/);
    for (const heading of ['## Disclosures', '## Redactions', '## Exclusions', '## Identity conflicts', '## Proposed actions (simulated — nothing is executed)', '## Summary']) expect(md).toContain(heading);
    expect(md).toContain('Educational prototype — synthetic data, not legal advice.');
    expect(md).toContain('| Northwind CRM (synthetic) | agentNote | third-party data |');
    expect(md).toContain('- Requester (pseudonym): lark-7731');
    expect(md).not.toContain('lark.7731@people.example');
    expect(html).toMatch(/^<!DOCTYPE html>/);
    expect(html).toContain('<title>Response packet REQ-2026-0411 — Access request</title>');
    expect(html.match(/<style>/g)).toHaveLength(1);
    expect(html).not.toMatch(/<script|<link|https?:\/\//i);
    expect(html).not.toContain('lark.7731@people.example');
    expect(screen.getByRole('button', { name: 'Audit log (0)' })).toBeInTheDocument(); // exports write no audit entry
  });

  it('the UI always exports without redacted values, even while the preview is revealed; only the engine option adds them under the reviewer banner', async () => {
    const { user } = renderApp();
    await selectRequest(user, 'REQ-2026-0411');
    await user.click(within(region(SECTIONS.packet)).getByLabelText(LABELS.revealRedacted));
    expect(region(SECTIONS.packet)).toHaveTextContent(THIRD_PARTY_VALUE);
    await clickAction(user, LABELS.exportPacketMarkdown);
    await clickAction(user, LABELS.exportPacketHtml);
    const [md, html] = await Promise.all([readDownloadText(0), readDownloadText(1)]);
    for (const body of [md, html]) {
      expect(body).not.toContain(THIRD_PARTY_VALUE);
      expect(body).not.toContain(REVIEWER_BANNER);
    }

    const request = demoRequest('REQ-2026-0411');
    const packet = buildResponsePacket(request, AS_OF);
    const systems = demoFile().systems;
    for (const body of [packetToMarkdown(packet, request, systems, { reveal: true }), packetToHtml(packet, request, systems, { reveal: true })]) {
      expect(body).toContain(REVIEWER_BANNER);
      expect(body).toContain(THIRD_PARTY_VALUE);
    }
  });
});

// =====================================================================================================

describe('7. Extension', () => {
  it('explains an impossible extension before the click with the exact sentences (REQ-2026-0398 too late, REQ-2026-0402 already extended) and hides the panel for terminal requests', async () => {
    const { user } = renderApp();
    const note = () => within(region(SECTIONS.extension)).getByRole('note');

    const late = extensionEligibility(demoRequest('REQ-2026-0398'), AS_OF);
    expect(late).toMatchObject({ eligible: false, code: 'EXTENSION_TOO_LATE', noticeDeadlineOn: '2026-09-27', maxDays: 61 });
    expect(note()).toHaveTextContent(`Extension not available: ${late.reason}`);
    expect(note().textContent).toBe('Extension not available: Extension notice dated 2026-10-01 is after the initial due date 2026-09-27; EU GDPR requires notice within the initial window.');
    expect(screen.queryByRole('button', { name: LABELS.recordExtension })).toBeNull();
    expect(region(SECTIONS.extension)).toHaveTextContent('One extension of up to 61 days; notice must fall inside the initial window');
    expect(region(SECTIONS.extension)).not.toHaveTextContent('— by');

    await selectRequest(user, 'REQ-2026-0402');
    const already = extensionEligibility(demoRequest('REQ-2026-0402'), AS_OF);
    expect(already.code).toBe('ALREADY_EXTENDED');
    expect(note().textContent).toBe('Extension not available: REQ-2026-0402 has already been extended once; the profile allows a single extension.');
    expect(note().textContent).toBe(`Extension not available: ${already.reason}`);
    expect(clockSummary()).toHaveTextContent('Extended to 1 Dec 2026 (61 days, notified 20 Sep 2026)');
    expect(clockSummary()).not.toHaveTextContent('Extension notice by');

    await selectRequest(user, 'REQ-2026-0380');
    expect(screen.queryByRole('region', { name: SECTIONS.extension })).toBeNull();
    await selectRequest(user, 'REQ-2026-0390');
    expect(screen.queryByRole('region', { name: SECTIONS.extension })).toBeNull();
  });

  it('records the single permitted extension on REQ-2026-0415 with the exact status, then explains that no second one is possible', async () => {
    const { user } = renderApp();
    await selectRequest(user, 'REQ-2026-0415');
    const panel = region(SECTIONS.extension);
    expect(panel).toHaveTextContent('One extension of up to 61 days; notice must fall inside the initial window — by 15 Oct 2026');
    expect(clockSummary()).toHaveTextContent('Extension notice by 15 Oct 2026');
    const days = within(panel).getByLabelText(LABELS.extensionDays);
    expect(days).toHaveValue(61);
    expect(days).toHaveAttribute('max', '61');
    expect(days).toHaveAttribute('min', '1');
    expect(within(panel).getByLabelText(LABELS.notifiedOn)).toHaveValue(AS_OF);
    const submit = within(panel).getByRole('button', { name: LABELS.recordExtension });
    expect(submit).toBeDisabled();
    await user.type(within(panel).getByLabelText(LABELS.extensionReason), 'Archived attachments across three systems (synthetic).');
    expect(submit).toBeEnabled();

    await user.click(submit);
    expectStatusExact('REQ-2026-0415: extension recorded; due date moved to 2026-12-15.');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(clockSummary()).toHaveTextContent('Extended to 15 Dec 2026 (61 days, notified 1 Oct 2026)');
    expect(clockSummary()).not.toHaveTextContent('Extension notice by');
    expect(badge('REQ-2026-0415')).toHaveTextContent('75d left');
    expect(within(docketRow('REQ-2026-0415')).getByRole('img')).toHaveAccessibleName('on track: 75 days remaining, due 2026-12-15 after extension');
    expect(within(region(SECTIONS.extension)).getByRole('note').textContent).toBe('Extension not available: REQ-2026-0415 has already been extended once; the profile allows a single extension.');
    expect(screen.queryByRole('button', { name: LABELS.recordExtension })).toBeNull();
    expect(within(region(SECTIONS.history)).getByText('Extension of 61 days recorded; requester notified on 2026-10-01.')).toBeInTheDocument();
    expect(currentStage()).toBe('Received');
    await expectAuditCount(1);
  });

  it('REQ-2026-0415 notified on 2026-12-01 is refused with the exact INVALID_EXTENSION_INPUT alert, audited as "extension (refused)", and the request is unchanged', async () => {
    const { user } = renderApp();
    await selectRequest(user, 'REQ-2026-0415');
    const panel = region(SECTIONS.extension);
    setDateInput(within(panel).getByLabelText(LABELS.notifiedOn), '2026-12-01');
    await user.type(within(panel).getByLabelText(LABELS.extensionReason), 'Vendor archive retrieval (synthetic).');
    await user.click(within(panel).getByRole('button', { name: LABELS.recordExtension }));

    const alert = screen.getByRole('alert');
    expect(alert.textContent).toBe('Refused. INVALID_EXTENSION_INPUT: Extension notice dated 2026-12-01 is after the as-of date 2026-10-01; a notice cannot be dated in the future.');
    expectStatusExact(DEMO_LOADED); // a refusal changes the alert, not the status
    expect(badge('REQ-2026-0415')).toHaveTextContent('14d left');
    expect(clockSummary()).not.toHaveTextContent('Extended to');
    expect(screen.getByRole('button', { name: LABELS.recordExtension })).toBeInTheDocument();
    await expectAuditCount(1);

    const { dialog } = await openDialog(user, /^Audit log \(1\)$/, SECTIONS.auditDialog);
    const entries = within(dialog).getByRole('region', { name: SECTIONS.auditEntries });
    expect(entries).toHaveTextContent('extension (refused)');
    expect(entries).toHaveTextContent('Extension notice dated 2026-12-01 is after the as-of date 2026-10-01; a notice cannot be dated in the future.');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    await selectRequest(user, 'REQ-2026-0411');
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

// =====================================================================================================

describe('8. Import and export a case file', () => {
  it('rejects an invalid pasted file with the alert and keeps the session, status, selection and audit log untouched', async () => {
    const { user } = renderApp();
    const headingBefore = docketHeading().textContent;
    await pasteImport(user, wrongSchema());
    const dialog = screen.getByRole('dialog', { name: SECTIONS.importDialog });
    const alert = within(dialog).getByRole('alert');
    expect(alert).toHaveTextContent('Import rejected.');
    expect(alert).toHaveTextContent('Fix these and try again:');
    expect(alert).toHaveTextContent('casefile.schema "nope" is not an allowed value');
    expectStatusExact(DEMO_LOADED);
    expect(sourceText()).toBe(`Source: bundled synthetic fixture · ${demoFile().requests.length} requests · no storage APIs, no network calls`);

    await user.click(within(dialog).getByRole('button', { name: LABELS.cancel }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(docketHeading().textContent).toBe(headingBefore);
    expect(caseTitle()).toHaveTextContent('REQ-2026-0398');
    expect(screen.getByRole('button', { name: 'Audit log (0)' })).toBeInTheDocument();
  });

  it('Validate only reports what would be imported without importing; Download sample case file serialises the bundled fixture', async () => {
    const { user } = renderApp();
    const file = demoFile();
    const { dialog } = await openDialog(user, LABELS.importCaseFile, SECTIONS.importDialog);
    expect(dialog).toHaveAccessibleDescription(/petitio\.casefile/);
    expect(dialog).toHaveAccessibleDescription(/read in this tab only; nothing is uploaded or stored/);
    expect(dialog).toHaveAccessibleDescription(/You can also drop a \.json file anywhere on this dialog\.$/);
    expect(within(dialog).getByRole('button', { name: LABELS.validateAndImport })).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: LABELS.validateOnly })).toBeDisabled();

    await user.click(within(dialog).getByLabelText(LABELS.orPasteJson));
    await user.paste(serializeCaseFile(file));
    expect(within(dialog).getByRole('button', { name: LABELS.validateAndImport })).toBeEnabled();
    await user.click(within(dialog).getByRole('button', { name: LABELS.validateOnly }));
    const note = within(dialog).getByRole('note');
    expect(note).toHaveTextContent(`Ready to import: ${file.requests.length} requests, ${file.systems.length} systems, as of ${file.asOf}`);
    expect(note).toHaveTextContent('Nothing has been imported yet. Choose “Validate and import” to replace the current session.');
    expect(note).not.toHaveTextContent('warning(s)');
    expect(within(dialog).queryByRole('alert')).toBeNull();
    expectStatusExact(DEMO_LOADED);
    expect(sourceText()).toContain('bundled synthetic fixture');

    await user.click(within(dialog).getByRole('button', { name: LABELS.downloadSample }));
    expect(readDownloads().map((d) => d.filename)).toEqual(['petitio-sample-casefile.json']);
    await expect(readDownloadText()).resolves.toBe(serializeCaseFile(file));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Audit log (0)', hidden: true })).toBeInTheDocument();
  });

  it('Export case file → re-import: exact status, source line, equal request ids, first request selected and the session state carried over', async () => {
    const { user } = renderApp();
    const file = demoFile();
    await selectRequest(user, 'REQ-2026-0415');
    await clickAction(user, LABELS.startIdentityCheck);
    await clickAction(user, LABELS.exportCaseFile);
    expect(readDownloads().map((d) => d.filename)).toEqual([`petitio-casefile-${AS_OF}.json`]);
    const exported = await readDownloadText();
    const reparsed = parseCaseFile(exported);
    expect(reparsed.ok).toBe(true);
    if (!reparsed.ok) return;
    expect(reparsed.warnings).toEqual([]);
    expect(reparsed.file.requests.map((r) => r.id)).toEqual(file.requests.map((r) => r.id));
    expect(reparsed.file.requests.find((r) => r.id === 'REQ-2026-0415')?.stage).toBe('identity-check');

    await pasteImport(user, exported);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expectStatusExact(`Imported ${file.requests.length} requests across ${file.systems.length} systems (as of ${file.asOf}).`);
    expect(sourceText()).toBe(`Source: imported file (in memory) · ${file.requests.length} requests · no storage APIs, no network calls`);
    expect([...docketRowIds()].sort()).toEqual(file.requests.map((r) => r.id).sort());
    expect(caseTitle()).toHaveTextContent(file.requests[0]!.id);
    expect(screen.queryByRole('alert')).toBeNull();
    await selectRequest(user, 'REQ-2026-0415');
    expect(currentStage()).toBe('Identity check');
    await expectAuditCount(2);
    const { dialog } = await openDialog(user, /^Audit log \(2\)$/, SECTIONS.auditDialog);
    const rows = within(within(dialog).getByRole('region', { name: SECTIONS.auditEntries })).getAllByRole('row');
    expect(within(rows[2]!).getAllByRole('cell').slice(0, 6).map((cell) => cell.textContent)).toEqual(['2', expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/), 'analyst.demo', '—', 'import', `${file.requests.length} requests`]);
  });

  it('imports through the file picker and reports importer warnings in the status', async () => {
    const { user } = renderApp();
    const file = demoFile();
    const first = file.requests[0]!;
    first.systemResults[0]!.systemId = 'warehouse';
    const { dialog } = await openDialog(user, LABELS.importCaseFile, SECTIONS.importDialog);
    await user.upload(within(dialog).getByLabelText(LABELS.chooseJsonFile), jsonFile(serializeCaseFile(file), 'petitio-casefile.json'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expectStatusExact(`Imported ${file.requests.length} requests across ${file.systems.length} systems (as of ${file.asOf}). 1 warning(s): ${first.id}: result for unknown system "warehouse"`);
    expect(sourceText()).toContain('imported file (in memory)');
    await expectAuditCount(1);
  });

  it('imports a .json file dropped onto the dialog exactly as the picker does', async () => {
    const { user } = renderApp();
    const file = demoFile();
    file.asOf = '2026-10-02';
    const { dialog } = await openDialog(user, LABELS.importCaseFile, SECTIONS.importDialog);
    const dropped = jsonFile(serializeCaseFile(file), 'dropped.json');
    fireEvent.dragEnter(dialog, { dataTransfer: { files: [dropped], types: ['Files'] } });
    fireEvent.dragOver(dialog, { dataTransfer: { files: [dropped], types: ['Files'] } });
    fireEvent.drop(dialog, { dataTransfer: { files: [dropped], types: ['Files'] } });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expectStatusExact(`Imported ${file.requests.length} requests across ${file.systems.length} systems (as of 2026-10-02).`);
    expect(screen.getByLabelText(LABELS.asOfDate)).toHaveValue('2026-10-02');
    expect(badge('REQ-2026-0398')).toHaveTextContent('5d over');
    await expectAuditCount(1);
  });
});

// =====================================================================================================

describe('9. Audit log', () => {
  it('verify → tamper → broken → restore → intact; Export JSON writes the petitio.auditlog envelope; a tampered export is caught by "Verify an exported log" without replacing the session log', async () => {
    const { user } = renderApp();
    await selectRequest(user, 'REQ-2026-0415');
    await clickAction(user, LABELS.startIdentityCheck);
    await expectAuditCount(1);
    const { dialog } = await openDialog(user, 'Audit log (1)', SECTIONS.auditDialog);
    expect(dialog).toHaveAccessibleDescription(/SHA-256/);
    expect(dialog).toHaveAccessibleDescription(/Export writes a petitio\.auditlog v1 file that can be verified here later\.$/);
    const entries = () => within(dialog).getByRole('region', { name: SECTIONS.auditEntries });
    expect(within(entries()).getAllByRole('columnheader').map((th) => th.textContent)).toEqual(['#', 'At', 'Actor', 'Request', 'Action', 'Detail', 'Hash']);
    expect(entries()).toHaveTextContent('analyst.demo');
    expect(entries()).toHaveTextContent('REQ-2026-0415');
    expect(entries()).toHaveTextContent('start-identity-check');
    expect(entries()).toHaveTextContent('received → identity-check');

    await user.click(within(dialog).getByRole('button', { name: LABELS.verifyChain }));
    expect(await within(dialog).findByRole('status')).toHaveTextContent('Chain intact: 1 entries, every hash recomputed and linked.');
    expect(within(dialog).getByRole('button', { name: LABELS.restoreRealLog })).toBeDisabled();

    await user.click(within(dialog).getByRole('button', { name: LABELS.simulateTampering }));
    expect(within(dialog).queryByRole('status')).toBeNull();
    expect(entries()).toHaveTextContent('received → identity-check (edited)');
    expect(within(dialog).getByRole('button', { name: LABELS.restoreRealLog })).toBeEnabled();
    await user.click(within(dialog).getByRole('button', { name: LABELS.verifyChain }));
    expect(await within(dialog).findByRole('status')).toHaveTextContent('Chain broken at entry 1: the stored hash or previous-hash link does not match the recomputed value.');

    await user.click(within(dialog).getByRole('button', { name: LABELS.restoreRealLog }));
    expect(within(dialog).queryByRole('status')).toBeNull();
    expect(entries()).not.toHaveTextContent('(edited)');
    await user.click(within(dialog).getByRole('button', { name: LABELS.verifyChain }));
    expect(await within(dialog).findByRole('status')).toHaveTextContent('Chain intact: 1 entries, every hash recomputed and linked.');

    await user.click(within(dialog).getByRole('button', { name: LABELS.exportJson }));
    expect(readDownloads().map((d) => d.filename)).toEqual(['petitio-audit-log.json']);
    const exported = await readDownloadText();
    const envelope = JSON.parse(exported) as AuditLogFile;
    expect(envelope).toMatchObject({ schema: 'petitio.auditlog', version: 1 });
    expect(envelope.exportedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(envelope.entries).toHaveLength(1);
    expect(envelope.entries[0]).toMatchObject({ seq: 1, actor: 'analyst.demo', requestId: 'REQ-2026-0415', action: 'start-identity-check', detail: 'received → identity-check', prevHash: 'GENESIS' });
    expect(envelope.entries[0]?.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(parseAuditLog(exported)).toEqual({ ok: true, entries: envelope.entries, legacy: false });

    const tampered: AuditLogFile = { ...envelope, entries: envelope.entries.map((e, i) => (i === 0 ? { ...e, detail: 'rewritten after export' } : e)) };
    await user.upload(within(dialog).getByLabelText(LABELS.verifyExportedLog), jsonFile(JSON.stringify(tampered), 'tampered-audit-log.json'));
    expect(await within(dialog).findByText('Imported log: chain broken at entry 1.')).toBeInTheDocument();
    expect(entries()).toHaveTextContent('rewritten after export');
    expect(within(dialog).getByRole('note').textContent).toBe('Imported log. Showing tampered-audit-log.json (1 entries). The session log is unchanged; choose “Restore real log” to show it again.');
    await user.click(within(dialog).getByRole('button', { name: LABELS.restoreRealLog }));
    expect(entries()).toHaveTextContent('received → identity-check');
    expect(entries()).not.toHaveTextContent('rewritten');
    expect(within(dialog).queryByRole('note')).toBeNull();

    await user.upload(within(dialog).getByLabelText(LABELS.verifyExportedLog), jsonFile(exported, 'petitio-audit-log.json'));
    expect(await within(dialog).findByText('Imported log: 1 entries, chain intact.')).toBeInTheDocument();

    expectStatusExact('REQ-2026-0415: start-identity-check recorded. Stage is now identity-check.');
    await user.click(within(dialog).getByRole('button', { name: LABELS.close }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByRole('button', { name: 'Audit log (1)' })).toBeInTheDocument(); // the dialog's own buttons add nothing

    const reopened = (await openDialog(user, 'Audit log (1)', SECTIONS.auditDialog)).dialog; // closing restored the session log and cleared the result
    expect(within(reopened).queryByRole('status')).toBeNull();
    expect(within(reopened).queryByRole('note')).toBeNull();
    expect(within(reopened).getByRole('region', { name: SECTIONS.auditEntries })).toHaveTextContent('received → identity-check');
  });

  it('starts empty: the tampering and export buttons are disabled and the table is replaced by an explanation', async () => {
    const { user } = renderApp();
    const { dialog } = await openDialog(user, 'Audit log (0)', SECTIONS.auditDialog);
    expect(within(dialog).getByText('No actions recorded yet in this session.')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: LABELS.simulateTampering })).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: LABELS.exportJson })).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: LABELS.restoreRealLog })).toBeDisabled();
    await user.click(within(dialog).getByRole('button', { name: LABELS.verifyChain }));
    expect(await within(dialog).findByRole('status')).toHaveTextContent('Chain intact: 0 entries, every hash recomputed and linked.');
  });

  it('when an append fails the action still stands, the alert says "Not recorded.", the source line counts it, and later appends continue from the last good entry', async () => {
    const { user } = renderApp();
    const digest = vi.spyOn(crypto.subtle, 'digest').mockRejectedValueOnce(new Error('digest unavailable (simulated)'));
    await selectRequest(user, 'REQ-2026-0415');
    await clickAction(user, LABELS.startIdentityCheck);
    expectStatusExact('REQ-2026-0415: start-identity-check recorded. Stage is now identity-check.');
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('Not recorded. Audit entry could not be recorded (start-identity-check on REQ-2026-0415): digest unavailable (simulated)');
    expect(currentStage()).toBe('Identity check');
    expect(sourceText()).toBe(`Source: bundled synthetic fixture · ${demoFile().requests.length} requests · no storage APIs, no network calls · 1 action(s) could not be audited`);
    expect(screen.getByRole('button', { name: 'Audit log (0)' })).toBeInTheDocument();
    expect(digest).toHaveBeenCalledTimes(1);

    await clickAction(user, LABELS.recordIdentityPassed);
    expectStatusExact('REQ-2026-0415: identity-passed recorded. Stage is now verified.');
    expect(screen.queryByRole('alert')).toBeNull(); // cleared by the next recorded action
    await expectAuditCount(1);
    const { dialog } = await openDialog(user, 'Audit log (1)', SECTIONS.auditDialog);
    const entries = within(dialog).getByRole('region', { name: SECTIONS.auditEntries });
    expect(entries).toHaveTextContent('identity-passed');
    expect(entries).not.toHaveTextContent('start-identity-check');
    await user.click(within(dialog).getByRole('button', { name: LABELS.verifyChain }));
    expect(await within(dialog).findByRole('status')).toHaveTextContent('Chain intact: 1 entries, every hash recomputed and linked.');
  });
});

// =====================================================================================================

describe('10. Reset the demo', () => {
  it('reloads the fixture, selects REQ-2026-0398, restores the source line and clears the alert, but keeps filters, search text, audit log and theme', async () => {
    const { user } = renderApp();
    const file = demoFile();
    await selectRequest(user, 'REQ-2026-0415');
    await clickAction(user, LABELS.startIdentityCheck);
    await pasteImport(user, serializeCaseFile(file));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(sourceText()).toContain('imported file (in memory)');
    await expectAuditCount(2);
    await user.click(screen.getByRole('radio', { name: 'Dark' }));
    await user.type(screen.getByRole('searchbox', { name: LABELS.searchRequests }), 'lark');
    await user.selectOptions(screen.getByLabelText(LABELS.sort), 'id');
    const panel = region(SECTIONS.extension); // REQ-2026-0411 is shown (first visible row after the import)
    expect(caseTitle()).toHaveTextContent(file.requests[0]!.id);
    setDateInput(within(panel).getByLabelText(LABELS.notifiedOn), '2026-12-01');
    await user.type(within(panel).getByLabelText(LABELS.extensionReason), 'Vendor archive retrieval (synthetic).');
    await user.click(within(panel).getByRole('button', { name: LABELS.recordExtension }));
    expect(screen.getByRole('alert')).toHaveTextContent(/^Refused\. INVALID_EXTENSION_INPUT/);
    await expectAuditCount(3);

    await clickAction(user, LABELS.resetDemo);
    expectStatusExact('Demo case file reloaded.');
    expect(caseTitle()).toHaveTextContent('REQ-2026-0398');
    expect(sourceText()).toBe(`Source: bundled synthetic fixture · ${file.requests.length} requests · no storage APIs, no network calls`);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('searchbox', { name: LABELS.searchRequests })).toHaveValue('lark');
    expect(screen.getByLabelText(LABELS.sort)).toHaveValue('id');
    expect(docketRowIds()).toEqual(['REQ-2026-0411', 'REQ-2026-0416']);
    expect(docketHeading()).toHaveTextContent(`Docket · 2 of ${file.requests.length}`);
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(screen.getByRole('button', { name: 'Audit log (3)' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: LABELS.clearFilters }));
    expect(docketRow('REQ-2026-0398')).toHaveAttribute('aria-current', 'true');
    await selectRequest(user, 'REQ-2026-0415');
    expect(currentStage()).toBe('Received');
    expect(within(region(SECTIONS.history)).getByText('0 transitions')).toBeInTheDocument();
  });
});

// =====================================================================================================

describe('11. Docket search, sort, summary and CSV', () => {
  it('search narrows rows and heading over id, pseudonym, email and account id (trimmed, case-insensitive); Clear filters restores everything', async () => {
    const { user } = renderApp();
    const total = demoFile().requests.length;
    const search = screen.getByRole('searchbox', { name: LABELS.searchRequests });
    expect(search).toHaveAttribute('type', 'search');
    expect(search).toHaveAttribute('placeholder', 'Search id, pseudonym, email, account');

    await user.type(search, '  LARK ');
    expect(docketRowIds()).toEqual(['REQ-2026-0411', 'REQ-2026-0416']);
    expect(docketHeading()).toHaveTextContent(`Docket · 2 of ${total}`);
    expect(caseTitle()).toHaveTextContent('REQ-2026-0398'); // the selection survives being filtered out of view
    await user.clear(search);
    await user.type(search, 'heron.6650@');
    expect(docketRowIds()).toEqual(['REQ-2026-0399']);
    await user.clear(search);
    await user.type(search, 'acc-88210');
    expect(docketRowIds()).toEqual(['REQ-2026-0375']);
    await user.clear(search);
    await user.type(search, '0423');
    expect(docketRowIds()).toEqual(['REQ-2026-0423']);
    await user.clear(search);
    await user.type(search, 'nobody-here');
    expect(screen.getByText(EMPTY_DOCKET)).toBeInTheDocument();
    expect(docketHeading()).toHaveTextContent(`Docket · 0 of ${total}`);

    await user.click(screen.getByRole('button', { name: LABELS.clearFilters }));
    expect(search).toHaveValue('');
    expect(docketHeading()).toHaveTextContent(`Docket · ${total} of ${total}`);
    expect(docketRowIds()[0]).toBe('REQ-2026-0398');
    expectStatusExact(DEMO_LOADED);
  });

  it('Sort by Received puts REQ-2026-0375 first; Id and Due date order accordingly; Urgency is the default and comes back with Clear filters', async () => {
    const { user } = renderApp();
    const file = demoFile();
    const sort = screen.getByLabelText(LABELS.sort);
    expect(optionLabels(sort)).toEqual(['Urgency', 'Received', 'Due date', 'Id']);
    expect(sort).toHaveValue('urgency');

    await user.selectOptions(sort, 'received');
    expect(docketRowIds()[0]).toBe('REQ-2026-0375');
    expect(docketRowIds().at(-1)).toBe('REQ-2026-0423');
    expect(docketRowIds()).toEqual([...file.requests].sort((a, b) => a.receivedOn.localeCompare(b.receivedOn) || a.id.localeCompare(b.id)).map((r) => r.id));

    await user.selectOptions(sort, 'id');
    expect(docketRowIds()).toEqual(file.requests.map((r) => r.id).sort());

    await user.selectOptions(sort, 'due');
    expect(docketRowIds()[0]).toBe('REQ-2026-0375');
    expect(docketRowIds().at(-1)).toBe('REQ-2026-0402'); // extended to 2026-12-01

    await user.click(screen.getByRole('button', { name: LABELS.clearFilters }));
    expect(sort).toHaveValue('urgency');
    expect(docketRowIds()[0]).toBe('REQ-2026-0398');
  });

  it('Export CSV downloads the visible rows in the visible order with the fixed header and the as-of date in the filename', async () => {
    const { user } = renderApp();
    await clickAction(user, LABELS.exportCsv);
    expect(readDownloads().map((d) => d.filename)).toEqual([`petitio-docket-${AS_OF}.csv`]);
    expect(readDownloads()[0]?.blob?.type).toBe('text/csv');
    const lines = (await readDownloadText()).split('\r\n');
    expect(lines.at(-1)).toBe('');
    expect(lines[0]).toBe('id,receivedOn,jurisdiction,type,stage,status,statutoryDueOn,effectiveDueOn,daysRemaining,extended,duplicateOf');
    expect(lines[0]).toBe(DOCKET_CSV_COLUMNS.join(','));
    expect(lines.slice(1, -1).map((line) => line.split(',')[0])).toEqual(docketRowIds());
    expect(lines[1]).toBe('REQ-2026-0398,2026-08-27,EU-GDPR,erasure,review,overdue,2026-09-27,2026-09-27,-4,false,');
    expect(lines.find((line) => line.startsWith('REQ-2026-0416,'))).toMatch(/,REQ-2026-0411$/);
    expect(lines.find((line) => line.startsWith('REQ-2026-0402,'))).toBe('REQ-2026-0402,2026-09-01,UK-GDPR,portability,collecting,on-track,2026-10-01,2026-12-01,61,true,');

    clearDownloads();
    await user.type(screen.getByRole('searchbox', { name: LABELS.searchRequests }), 'lark');
    await user.selectOptions(screen.getByLabelText(LABELS.sort), 'id');
    await clickAction(user, LABELS.exportCsv);
    const filtered = (await readDownloadText()).split('\r\n');
    expect(filtered.slice(1, -1).map((line) => line.split(',')[0])).toEqual(['REQ-2026-0411', 'REQ-2026-0416']);
    expect(screen.getByRole('button', { name: 'Audit log (0)' })).toBeInTheDocument(); // no audit entry for exports
  });

  it('rows form a roving-tabindex list: Enter on the focused row selects it like a click and clears the alert', async () => {
    const { user } = renderApp();
    await selectRequest(user, 'REQ-2026-0415');
    const panel = region(SECTIONS.extension);
    setDateInput(within(panel).getByLabelText(LABELS.notifiedOn), '2026-12-01');
    await user.type(within(panel).getByLabelText(LABELS.extensionReason), 'Vendor archive retrieval (synthetic).');
    await user.click(within(panel).getByRole('button', { name: LABELS.recordExtension }));
    expect(screen.getByRole('alert')).toBeInTheDocument();

    const rows = docketRows();
    expect(rows.filter((row) => row.tabIndex === 0).map((row) => row.querySelector('.id')?.textContent)).toEqual(['REQ-2026-0415']);
    rows[0]!.focus();
    await user.keyboard('{ArrowDown}');
    expect(rows[1]).toHaveFocus();
    await user.keyboard('{Enter}');
    const secondId = rows[1]!.querySelector('.id')?.textContent ?? '';
    expect(secondId).toBe('REQ-2026-0399');
    expect(caseTitle()).toHaveTextContent(secondId);
    expect(docketRow(secondId)).toHaveAttribute('aria-current', 'true');
    expect(docketRows().filter((row) => row.tabIndex === 0).map((row) => row.querySelector('.id')?.textContent)).toEqual([secondId]);
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

// =====================================================================================================

describe('12. Closure badge', () => {
  it('shows "Closed 7 days late" for REQ-2026-0375 and "Closed on time" for REQ-2026-0380, nothing for open requests, and derives "Closed 1 day late" live when a request is closed one day past due', async () => {
    const { user } = renderApp();
    await selectRequest(user, 'REQ-2026-0375');
    const late = screen.getByText('Closed 7 days late');
    expect(late).toHaveClass('badge', 'badge-overdue');
    expect(clockSummary()).toContainElement(late);
    expect(clockSummary()).toHaveTextContent('Statutory due 3 Sep 2026');
    expect(clockSummary()).toHaveTextContent('Closed 10 Sep 2026');
    expect(badge('REQ-2026-0375')).toHaveTextContent('closed');
    expect(screen.queryByText('Closed on time')).toBeNull();

    await selectRequest(user, 'REQ-2026-0380');
    const onTime = screen.getByText('Closed on time');
    expect(onTime).toHaveClass('badge', 'badge-closed');
    expect(clockSummary()).toHaveTextContent('Statutory due 24 Sep 2026');
    expect(clockSummary()).toHaveTextContent('Closed 15 Sep 2026');
    expect(screen.queryByText(/^Closed \d+ days? late$/)).toBeNull();

    await selectRequest(user, 'REQ-2026-0399');
    expect(screen.queryByText(/^Closed (on time|\d+ days? late)$/)).toBeNull();

    setDateInput(screen.getByLabelText(LABELS.asOfDate), '2026-10-06');
    expect(badge('REQ-2026-0399')).toHaveTextContent('1d over');
    await clickAction(user, LABELS.closeRequest);
    expectStatusExact('REQ-2026-0399: close recorded. Stage is now closed.');
    expect(screen.getByText('Closed 1 day late')).toBeInTheDocument();
    expect(clockSummary()).toHaveTextContent('Closed 6 Oct 2026');
    expect(badge('REQ-2026-0399')).toHaveTextContent('closed');
  });
});

// =====================================================================================================

describe('13. Colour theme', () => {
  it('the Colour theme radiogroup switches data-theme on <html>, Auto removes it, arrow keys move within the group, and no Web Storage API is ever called', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const getItem = vi.spyOn(Storage.prototype, 'getItem');
    const removeItem = vi.spyOn(Storage.prototype, 'removeItem');
    const { user } = renderApp();
    const toolbar = screen.getByRole('toolbar', { name: SECTIONS.toolbar });
    expect(within(toolbar).getAllByRole('button').map((b) => b.textContent)).toEqual(['Import case file', 'Export case file', 'Audit log (0)', 'Reset demo']);
    const group = within(toolbar).getByRole('radiogroup', { name: LABELS.colourTheme });
    expect(group.tagName).toBe('FIELDSET');
    expect(within(group).getAllByRole('radio').map((r) => r.getAttribute('value'))).toEqual(['auto', 'light', 'dark']);
    expect(within(group).getByRole('radio', { name: 'Auto' })).toBeChecked();
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);

    await user.click(within(group).getByRole('radio', { name: 'Dark' }));
    expect(within(group).getByRole('radio', { name: 'Dark' })).toBeChecked();
    expect(document.documentElement.dataset.theme).toBe('dark');
    await user.click(within(group).getByRole('radio', { name: 'Light' }));
    expect(document.documentElement.dataset.theme).toBe('light');
    await user.keyboard('{ArrowLeft}');
    expect(within(group).getByRole('radio', { name: 'Auto' })).toBeChecked();
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
    await user.keyboard('{ArrowRight}{ArrowRight}');
    expect(document.documentElement.dataset.theme).toBe('dark');

    expect(setItem).not.toHaveBeenCalled();
    expect(getItem).not.toHaveBeenCalled();
    expect(removeItem).not.toHaveBeenCalled();
    expectStatusExact(DEMO_LOADED);
    expect(screen.getByRole('button', { name: 'Audit log (0)' })).toBeInTheDocument();
  });
});
