import { describe, expect, it, vi } from 'vitest';
import { useState, type ComponentProps } from 'react';
import { configure, prettyDOM, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import demoJson from '../fixtures/demo-casefile.json';
import { parseCaseFile } from '../engine/casefile';
import { assessDeadline } from '../engine/deadline';
import { findDuplicates } from '../engine/duplicates';
import { buildResponsePacket } from '../engine/reconcile';
import { availableActions, transition } from '../engine/workflow';
import type { CaseFile, DeadlineAssessment, ExtensionEligibility, Hold, ResponsePacket, RightsRequest } from '../engine/types';
import { CaseDetail } from './CaseDetail';
import { ClockSummary } from './detail/ClockSummary';
import { ActionsPanel } from './detail/ActionsPanel';
import { IdentityPanel } from './detail/IdentityPanel';
import { ExtensionPanel } from './detail/ExtensionPanel';
import { SystemsPanel } from './detail/SystemsPanel';
import { RecordResultForm } from './detail/RecordResultForm';
import { HoldsPanel } from './detail/HoldsPanel';
import { PacketPanel } from './detail/PacketPanel';
import { HistoryPanel } from './detail/HistoryPanel';
import { downloadText } from './download';

// assessDeadline is wrapped, not replaced: every call still reaches the real engine, but the
// arguments CaseDetail passes (the optional DeadlineOptions) become observable.
vi.mock('../engine/deadline', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../engine/deadline')>();
  return { ...actual, assessDeadline: vi.fn(actual.assessDeadline) };
});

// Only the browser download itself is stubbed; safeFilename and the rest of the module stay real.
vi.mock('./download', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./download')>();
  return { ...actual, downloadText: vi.fn() };
});

/** The assessment as the engine returns it for a closed request, minus the closure fields (hand-built negative case). */
function withoutClosure(assessment: DeadlineAssessment): DeadlineAssessment {
  const copy = { ...assessment };
  delete copy.closureOutcome;
  delete copy.daysLateAtClose;
  return copy;
}

/** The packet minus the optional right-aware proposals, so the base rendering is tested on its own. */
function withoutProposals(packet: ResponsePacket): ResponsePacket {
  const copy = { ...packet };
  delete copy.actions;
  delete copy.summary;
  return copy;
}

/** The <time> rendered inside the clock-summary item whose own text starts with `label`. */
function timeIn(label: RegExp, scope: HTMLElement = document.body): HTMLElement | null {
  return within(scope).getByText(label).querySelector('time');
}

// The full case detail is a large DOM; keep "unable to find" errors readable by trimming the accessible-tree dump
// Testing Library appends and printing only a short excerpt of the container.
configure({
  getElementError(message, container) {
    const head = (message ?? 'Element not found').split('\n\nHere are the accessible roles')[0] ?? '';
    const error = new Error(`${head.slice(0, 400)}\n\n${prettyDOM(container, 300)}`);
    error.name = 'TestingLibraryElementError';
    return error;
  },
});

const parsed = parseCaseFile(JSON.stringify(demoJson));
if (!parsed.ok) throw new Error(`bundled fixture failed validation: ${parsed.errors.join('; ')}`);
const file: CaseFile = parsed.file;
const ASOF = file.asOf; // 2026-10-01 in the bundled fixture
const AT = `${ASOF}T12:00:00Z`;

function req(id: string): RightsRequest {
  const found = file.requests.find((r) => r.id === id);
  if (!found) throw new Error(`fixture has no ${id}`);
  return found;
}

type DetailProps = ComponentProps<typeof CaseDetail>;

function renderDetail(request: RightsRequest, extra: Partial<DetailProps> = {}) {
  const onAction = vi.fn();
  const onExtend = vi.fn();
  const props: DetailProps = { request, systems: file.systems, asOf: ASOF, duplicates: findDuplicates(file.requests, 30), onAction, onExtend, ...extra };
  const utils = render(<CaseDetail {...props} />);
  return { ...utils, onAction, onExtend, props };
}

/** CaseDetail driven by the real engine: every action goes through transition(), the way App does it. */
function Harness({ initial }: { initial: RightsRequest }) {
  const [request, setRequest] = useState(initial);
  return (
    <CaseDetail
      request={request}
      systems={file.systems}
      asOf={ASOF}
      duplicates={[]}
      onAction={(req) => setRequest((r) => transition(r, req.action, { at: AT, actor: 'analyst.demo', payload: req.payload, ...(req.note ? { note: req.note } : {}) }, file.systems))}
      onExtend={() => undefined}
    />
  );
}

const INELIGIBLE: ExtensionEligibility = {
  eligible: false,
  code: 'ALREADY_EXTENDED',
  reason: 'REQ-2026-0402 has already been extended once; the profile allows a single extension.',
  noticeDeadlineOn: '2026-10-01',
  maxDays: 61,
};
const ELIGIBLE: ExtensionEligibility = { eligible: true, noticeDeadlineOn: '2026-10-08', maxDays: 30 };

describe('CaseDetail composition root', () => {
  it('renders the heading, stage rail and every panel for a fixture request in review', () => {
    renderDetail(req('REQ-2026-0398'));
    expect(screen.getByRole('heading', { level: 2, name: 'REQ-2026-0398' })).toHaveAttribute('id', 'case-title');
    expect(screen.getByRole('list', { name: 'Request stages' })).toBeInTheDocument();
    for (const name of ['Next actions', 'Identity proofing', 'Extend the response window', 'Systems of record', 'Holds and exemptions', 'Response packet preview', 'History']) {
      expect(screen.getByRole('heading', { level: 3, name })).toBeInTheDocument();
    }
    expect(screen.getByText('Blocked actions explain themselves')).toBeInTheDocument();
    const citation = screen.getByText(/GDPR Art\. 12\(3\)/);
    expect(citation).toHaveTextContent('Educational model, not legal advice.');
    expect(citation.textContent?.match(/Educational model, not legal advice\./g)).toHaveLength(1); // once, whether or not the profile text already carries it
  });

  it('flags a possible duplicate with a badge and an explanatory note', () => {
    renderDetail(req('REQ-2026-0416'));
    expect(screen.getByText('possible duplicate of REQ-2026-0411')).toHaveClass('badge', 'badge-dup');
    const note = screen.getByText(/Duplicate check\./).closest('[role="note"]');
    expect(note).not.toBeNull();
    expect(note).toHaveTextContent(/Same pseudonymous requester and request type as REQ-2026-0411/);
  });

  it('uses no inline styles outside the ribbon (every former style={{…}} is a class in detail.css)', () => {
    const { container } = renderDetail(req('REQ-2026-0398'));
    const styled = Array.from(container.querySelectorAll('[style]')).filter((el) => !el.closest('.ribbon'));
    expect(styled.map((el) => `${el.tagName.toLowerCase()}[style="${el.getAttribute('style') ?? ''}"]`)).toEqual([]);
  });

  it('renders the statutory due date as a <time> element with the ISO date kept machine-readable', () => {
    const { container } = renderDetail(req('REQ-2026-0411')); // received 2026-09-08 → due 2026-10-08
    const summary = container.querySelector<HTMLElement>('.clock-summary');
    expect(summary).not.toBeNull();
    const due = timeIn(/^Statutory due/, summary as HTMLElement);
    expect(due).not.toBeNull();
    expect(due).toHaveTextContent('8 Oct 2026');
    expect(due).toHaveAttribute('datetime', '2026-10-08');
  });

  it('forwards atRiskDays to assessDeadline as DeadlineOptions', () => {
    const mock = vi.mocked(assessDeadline);
    mock.mockClear();
    const request = req('REQ-2026-0411');
    renderDetail(request, { atRiskDays: 10 });
    expect(mock).toHaveBeenCalledWith(request, ASOF, { atRiskDays: 10 });
  });

  it('calls assessDeadline without options when atRiskDays is not given', () => {
    const mock = vi.mocked(assessDeadline);
    mock.mockClear();
    renderDetail(req('REQ-2026-0411'));
    expect(mock).toHaveBeenCalled();
    expect(mock.mock.calls.every((call) => call.length === 2)).toBe(true);
  });

  it('moves focus to the case heading when the stage changes for the same request', () => {
    const request = req('REQ-2026-0415'); // received
    const { rerender, props } = renderDetail(request);
    expect(screen.getByRole('heading', { level: 2, name: request.id })).not.toHaveFocus();
    const next: RightsRequest = {
      ...request,
      stage: 'identity-check',
      identity: { ...request.identity, status: 'pending' },
      history: [{ at: AT, from: 'received', to: 'identity-check', action: 'start-identity-check', actor: 'analyst.demo' }],
    };
    rerender(<CaseDetail {...props} request={next} />);
    expect(screen.getByRole('heading', { level: 2, name: request.id })).toHaveFocus();
  });

  it('leaves focus alone when the request changes without a stage change', () => {
    const request = req('REQ-2026-0411'); // collecting
    const { rerender, props } = renderDetail(request);
    rerender(<CaseDetail {...props} request={{ ...request, notes: [...request.notes, 'Another note'] }} />);
    expect(screen.getByRole('heading', { level: 2, name: request.id })).not.toHaveFocus();
  });

  it('moves focus to the heading after a stage change made through the real action button', async () => {
    const user = userEvent.setup();
    render(<Harness initial={req('REQ-2026-0415')} />);
    await user.click(screen.getByRole('button', { name: 'Start identity check' }));
    expect(screen.getByRole('list', { name: 'Request stages' }).querySelector('[aria-current="step"]')).toHaveTextContent('Identity check');
    expect(screen.getByRole('heading', { level: 2, name: 'REQ-2026-0415' })).toHaveFocus();
  });

  it('moves focus to the heading when the pressed control unmounts without a stage change (release hold)', async () => {
    const user = userEvent.setup();
    render(<Harness initial={req('REQ-2026-0398')} />);
    await user.click(screen.getByRole('button', { name: 'Release hold' }));
    expect(screen.queryByRole('button', { name: 'Release hold' })).toBeNull();
    expect(screen.getByText('0 active')).toBeInTheDocument();
    expect(document.activeElement).not.toBe(document.body);
    expect(screen.getByRole('heading', { level: 2, name: 'REQ-2026-0398' })).toHaveFocus();
  });

  it('keeps focus on a control that survives the action (apply hold)', async () => {
    const user = userEvent.setup();
    render(<Harness initial={req('REQ-2026-0398')} />);
    await user.type(screen.getByLabelText(/^Justification/), 'Litigation hold (synthetic).');
    const apply = screen.getByRole('button', { name: 'Apply hold' });
    await user.click(apply);
    expect(screen.getByText('2 active')).toBeInTheDocument();
    expect(apply).toHaveFocus();
    expect(screen.getByRole('heading', { level: 2, name: 'REQ-2026-0398' })).not.toHaveFocus();
  });

  it('shows the extension form for an open unextended request and hides it once extended or closed (no eligibility given)', () => {
    const open = renderDetail(req('REQ-2026-0411'));
    expect(screen.getByRole('heading', { level: 3, name: 'Extend the response window' })).toBeInTheDocument();
    open.unmount();
    const extended = renderDetail(req('REQ-2026-0402'));
    expect(screen.queryByRole('heading', { level: 3, name: 'Extend the response window' })).toBeNull();
    extended.unmount();
    renderDetail(req('REQ-2026-0380'));
    expect(screen.queryByRole('heading', { level: 3, name: 'Extend the response window' })).toBeNull();
  });

  it('explains an ineligible extension before the click instead of showing the form', () => {
    renderDetail(req('REQ-2026-0411'), { eligibility: INELIGIBLE });
    const notice = screen.getByText(`Extension not available: ${INELIGIBLE.reason}`);
    expect(notice).toHaveAttribute('role', 'note');
    expect(notice).toHaveClass('notice');
    expect(screen.queryByRole('button', { name: 'Record extension' })).toBeNull();
    expect(screen.queryByLabelText('Extension (days)')).toBeNull();
  });

  it('passes extraExports through to the packet panel', async () => {
    const user = userEvent.setup();
    const onMarkdown = vi.fn();
    renderDetail(req('REQ-2026-0399'), { extraExports: [{ label: 'Export packet Markdown', onClick: onMarkdown }] });
    const button = screen.getByRole('button', { name: 'Export packet Markdown' });
    expect(button).toHaveClass('btn', 'btn-sm');
    await user.click(button);
    expect(onMarkdown).toHaveBeenCalledTimes(1);
  });
});

describe('ClockSummary', () => {
  it('summarises the window, the statutory due date and the days past due', () => {
    const request = req('REQ-2026-0398'); // received 2026-08-27 → due 2026-09-27; as of 2026-10-01 → 4 days past due
    render(<ClockSummary request={request} assessment={assessDeadline(request, ASOF)} />);
    expect(screen.getByText('one calendar month')).toBeInTheDocument(); // describeWindow(PROFILES['EU-GDPR'].window)
    const due = timeIn(/^Statutory due/);
    expect(due).toHaveTextContent('27 Sep 2026');
    expect(due).toHaveAttribute('datetime', '2026-09-27');
    // GDPR notice must fall inside the initial window, so the notice deadline is the statutory due date.
    expect(timeIn(/^Extension notice by/)).toHaveAttribute('datetime', '2026-09-27');
    expect(screen.getByText('4 days past due')).toHaveClass('clock-overdue');
  });

  it('shows the extended due date and the notice date for an extended request', () => {
    const request = req('REQ-2026-0402'); // UK GDPR received 2026-09-01 → statutory 2026-10-01, +61 days → 2026-12-01
    render(<ClockSummary request={request} assessment={assessDeadline(request, ASOF)} />);
    expect(screen.getByText('1 Dec 2026')).toHaveAttribute('datetime', '2026-12-01');
    expect(screen.getByText('20 Sep 2026')).toHaveAttribute('datetime', '2026-09-20');
    expect(screen.getByText(/61 days, notified/)).toBeInTheDocument();
  });

  it('shows a closure badge for a request closed on time', () => {
    const request = req('REQ-2026-0380'); // closed 2026-09-15, due 2026-09-24
    const assessment: DeadlineAssessment = { ...assessDeadline(request, ASOF), closureOutcome: 'on-time' };
    render(<ClockSummary request={request} assessment={assessment} />);
    expect(screen.getByText('Closed on time')).toHaveClass('badge', 'badge-closed');
    expect(screen.getByText('15 Sep 2026')).toHaveAttribute('datetime', '2026-09-15');
  });

  it('shows how many days late a request was closed', () => {
    const request: RightsRequest = { ...req('REQ-2026-0380'), closedOn: '2026-09-27' };
    const assessment: DeadlineAssessment = { ...assessDeadline(request, ASOF), closureOutcome: 'late', daysLateAtClose: 3 };
    render(<ClockSummary request={request} assessment={assessment} />);
    expect(screen.getByText('Closed 3 days late')).toHaveClass('badge', 'badge-overdue');
  });

  it('renders no closure badge when the assessment carries no closure outcome', () => {
    const request = req('REQ-2026-0380');
    render(<ClockSummary request={request} assessment={withoutClosure(assessDeadline(request, ASOF))} />);
    expect(screen.queryByText(/Closed on time|days late/)).toBeNull();
    expect(screen.queryByText(/^Extension notice by/)).toBeNull(); // the clock has stopped: nothing left to explain
  });

  it('derives "Closed 7 days late" from the engine assessment of the late-closed fixture request', () => {
    const request = req('REQ-2026-0375'); // EU GDPR received 2026-08-03 → due 2026-09-03; closed 2026-09-10
    render(<ClockSummary request={request} assessment={assessDeadline(request, ASOF)} />);
    expect(screen.getByText('Closed 7 days late')).toHaveClass('badge', 'badge-overdue');
    expect(timeIn(/^Closed$/)).toHaveAttribute('datetime', '2026-09-10');
  });

  it('derives "Closed on time" from the engine assessment of the on-time fixture request', () => {
    const request = req('REQ-2026-0380'); // closed 2026-09-15, due 2026-09-24
    render(<ClockSummary request={request} assessment={assessDeadline(request, ASOF)} />);
    expect(screen.getByText('Closed on time')).toHaveClass('badge', 'badge-closed');
  });

  it('describes a calendar-day window from the profile (CA-PIPEDA: 30 calendar days)', () => {
    const request = req('REQ-2026-0419');
    render(<ClockSummary request={request} assessment={assessDeadline(request, ASOF)} />);
    expect(screen.getByText('30 calendar days')).toBeInTheDocument();
  });
});

describe('ActionsPanel', () => {
  it('keeps the blocked-action pattern: aria-disabled, aria-describedby and a .why explanation', async () => {
    const user = userEvent.setup();
    const request = req('REQ-2026-0411');
    const onAction = vi.fn();
    render(<ActionsPanel actions={availableActions(request, file.systems)} request={request} onAction={onAction} />);
    const blocked = screen.getByRole('button', { name: 'Send to reviewer' });
    expect(blocked).toHaveAttribute('aria-disabled', 'true');
    expect(blocked).toHaveAttribute('aria-describedby', 'why-send-to-review');
    const why = document.getElementById('why-send-to-review');
    expect(why).toHaveClass('why');
    expect(why).toHaveTextContent('Lookups still outstanding for: support.');
    await user.click(blocked);
    expect(onAction).not.toHaveBeenCalled();
  });

  it('records an enabled action with the optional note and clears the note afterwards', async () => {
    const user = userEvent.setup();
    const request = req('REQ-2026-0415');
    const onAction = vi.fn();
    render(<ActionsPanel actions={availableActions(request, file.systems)} request={request} onAction={onAction} />);
    const note = screen.getByLabelText('Note for the history entry (optional)');
    await user.type(note, 'Letter scanned');
    const start = screen.getByRole('button', { name: 'Start identity check' });
    expect(start).toHaveAttribute('aria-disabled', 'false');
    expect(screen.getByText('Moves to identity check and marks the check pending.')).toHaveClass('ok');
    await user.click(start);
    expect(onAction).toHaveBeenCalledWith({ action: 'start-identity-check', note: 'Letter scanned' });
    expect(note).toHaveValue('');
  });

  it('rejects with the selected reason from the Reject request fieldset', async () => {
    const user = userEvent.setup();
    const request = req('REQ-2026-0415');
    const onAction = vi.fn();
    render(<ActionsPanel actions={availableActions(request, file.systems)} request={request} onAction={onAction} />);
    expect(screen.getByText('Reject request', { selector: 'legend' })).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Reason'), 'out-of-scope');
    await user.click(screen.getByRole('button', { name: 'Reject with this reason' }));
    expect(onAction).toHaveBeenCalledWith({ action: 'reject', payload: 'out-of-scope' });
  });

  it('explains that terminal stages accept no further actions', () => {
    const request = req('REQ-2026-0380');
    render(<ActionsPanel actions={availableActions(request, file.systems)} request={request} onAction={vi.fn()} />);
    expect(screen.getByText(/This request is closed\. Terminal stages accept no further actions/)).toHaveClass('muted-note');
    expect(screen.queryByRole('button')).toBeNull();
  });
});

describe('IdentityPanel', () => {
  it('shows the method, attempts, account id and age band with a status tag', () => {
    render(<IdentityPanel request={req('REQ-2026-0411')} />);
    expect(screen.getByRole('heading', { level: 3, name: 'Identity proofing' })).toBeInTheDocument();
    expect(screen.getByText('passed')).toHaveClass('tag', 'tag-green');
    expect(screen.getByText('account-login')).toBeInTheDocument();
    expect(screen.getByText('1 of 3')).toBeInTheDocument();
    expect(screen.getByText('ACC-10431')).toHaveClass('mono');
    expect(screen.getByText('adult')).toBeInTheDocument();
    expect(screen.getByText(/Identity proofing is simulated/)).toHaveClass('identity-note');
  });
});

describe('ExtensionPanel', () => {
  it('without eligibility, offers the profile maximum (EU GDPR: two further months = 61 days from 8 Oct 2026)', () => {
    render(<ExtensionPanel request={req('REQ-2026-0411')} asOf={ASOF} onExtend={vi.fn()} />);
    const days = screen.getByLabelText('Extension (days)');
    expect(days).toHaveValue(61);
    expect(days).toHaveAttribute('max', '61');
    expect(screen.getByLabelText('Requester notified on')).toHaveValue(ASOF);
    expect(screen.getByText(/notice must fall inside the initial window/)).toBeInTheDocument();
  });

  it('replaces the form with a role="note" explanation when eligibility says no', () => {
    render(<ExtensionPanel request={req('REQ-2026-0402')} asOf={ASOF} onExtend={vi.fn()} eligibility={INELIGIBLE} />);
    expect(screen.getByRole('heading', { level: 3, name: 'Extend the response window' })).toBeInTheDocument();
    const notice = screen.getByText(`Extension not available: ${INELIGIBLE.reason}`);
    expect(notice).toHaveAttribute('role', 'note');
    expect(screen.queryByLabelText('Extension (days)')).toBeNull();
    expect(screen.queryByLabelText('Why more time is necessary (10+ characters)')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Record extension' })).toBeNull();
  });

  it('uses maxDays from eligibility and names the notice deadline when eligible', () => {
    render(<ExtensionPanel request={req('REQ-2026-0411')} asOf={ASOF} onExtend={vi.fn()} eligibility={ELIGIBLE} />);
    const days = screen.getByLabelText('Extension (days)');
    expect(days).toHaveAttribute('max', '30');
    expect(days).toHaveValue(30);
    const deadline = screen.getByText('8 Oct 2026');
    expect(deadline.tagName).toBe('TIME');
    expect(deadline).toHaveAttribute('datetime', '2026-10-08');
    expect(screen.queryByRole('note')).toBeNull();
    expect(screen.getByRole('button', { name: 'Record extension' })).toBeInTheDocument();
  });

  it('submits the trimmed reason, the notice date and the day count, refusing reasons under 10 characters', async () => {
    const user = userEvent.setup();
    const onExtend = vi.fn();
    render(<ExtensionPanel request={req('REQ-2026-0411')} asOf={ASOF} onExtend={onExtend} />);
    const submit = screen.getByRole('button', { name: 'Record extension' });
    const reason = screen.getByLabelText('Why more time is necessary (10+ characters)');
    await user.type(reason, 'too short');
    expect(submit).toBeDisabled();
    await user.clear(reason);
    await user.type(reason, '  Archived attachments across three systems  ');
    expect(submit).toBeEnabled();
    const days = screen.getByLabelText('Extension (days)');
    await user.clear(days);
    await user.type(days, '30');
    await user.click(submit);
    expect(onExtend).toHaveBeenCalledWith({ reason: 'Archived attachments across three systems', notifiedOn: ASOF, days: 30 });
  });
});

describe('SystemsPanel and RecordResultForm', () => {
  it('lists outstanding systems and records a simulated "no record" result', async () => {
    const user = userEvent.setup();
    const onAction = vi.fn();
    render(<SystemsPanel request={req('REQ-2026-0411')} systems={file.systems} asOf={ASOF} onAction={onAction} />);
    expect(screen.getByRole('heading', { level: 3, name: 'Systems of record' })).toBeInTheDocument();
    expect(screen.getByText('2 of 3 looked up · outstanding: support')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'System lookup results' })).toBeInTheDocument();
    expect(screen.getByText('Record a lookup result (simulated — nothing is queried)')).toBeInTheDocument();
    const system = screen.getByLabelText('System') as HTMLSelectElement;
    expect(Array.from(system.options).map((o) => o.value)).toEqual(['support']);
    await user.selectOptions(screen.getByLabelText('Outcome'), 'none');
    expect(screen.queryByLabelText('Record id')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Record result' }));
    expect(onAction).toHaveBeenCalledWith({ action: 'record-system-result', payload: { systemId: 'support', found: false, fields: [], lookedUpAt: AT } });
  });

  it('shows the all-looked-up notice once every system has a result', () => {
    render(<SystemsPanel request={req('REQ-2026-0402')} systems={file.systems} asOf={ASOF} onAction={vi.fn()} />);
    expect(screen.getByText('All systems looked up. The request can go to the reviewer.')).toHaveClass('notice-green');
    expect(screen.queryByRole('button', { name: 'Record result' })).toBeNull();
  });

  it('tags identity conflicts and third-party fields in the results table', () => {
    render(<SystemsPanel request={req('REQ-2026-0399')} systems={file.systems} asOf={ASOF} onAction={vi.fn()} />);
    expect(screen.getByText('conflict')).toHaveClass('tag-red');
    expect(screen.getByText('third party')).toHaveClass('tag-red');
    expect(screen.getByText('found · tickets-66501')).toHaveClass('tag-green');
    expect(screen.getByText('no record')).toHaveClass('tag');
  });

  it('collects record id, subject email and fields (with third-party marks) for a found record', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<RecordResultForm systems={file.systems.filter((s) => s.id === 'support')} asOf={ASOF} onSubmit={onSubmit} />);
    await user.type(screen.getByLabelText('Record id'), 'tickets-10431');
    await user.type(screen.getByLabelText('Subject email on file'), 'lark.7731@people.example');
    await user.type(screen.getByLabelText('Field 1 name'), 'tickets');
    await user.type(screen.getByLabelText('Field 1 value'), '3 tickets');
    await user.click(screen.getByRole('button', { name: 'Add field' }));
    await user.click(screen.getByRole('button', { name: 'Remove field 2' }));
    expect(screen.queryByLabelText('Field 2 name')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Add field' }));
    await user.type(screen.getByLabelText('Field 2 name'), 'agentNote');
    await user.type(screen.getByLabelText('Field 2 value'), 'Spouse called about the refund');
    await user.click(screen.getAllByRole('checkbox', { name: 'third party' })[1]!);
    await user.click(screen.getByRole('button', { name: 'Record result' }));
    expect(onSubmit).toHaveBeenCalledWith({
      systemId: 'support',
      found: true,
      recordId: 'tickets-10431',
      subjectEmail: 'lark.7731@people.example',
      fields: [
        { name: 'tickets', value: '3 tickets' },
        { name: 'agentNote', value: 'Spouse called about the refund', thirdParty: true },
      ],
      lookedUpAt: AT,
    });
    expect(screen.getByLabelText('Field 1 name')).toHaveValue('');
    expect(screen.queryByLabelText('Field 2 name')).toBeNull();
  });
});

describe('HoldsPanel', () => {
  const hold = (over: Partial<Hold>): Hold => ({ id: 'HOLD-X-1', systemId: 'crm', reason: 'legal-hold', note: 'Litigation hold (synthetic).', appliedAt: '2026-09-20T15:10:00Z', ...over });

  it('excludes systems that already carry an active hold from the Apply a hold select', () => {
    render(<HoldsPanel request={req('REQ-2026-0398')} systems={file.systems} asOf={ASOF} onAction={vi.fn()} />);
    expect(screen.getByRole('heading', { level: 3, name: 'Holds and exemptions' })).toBeInTheDocument();
    const select = screen.getByLabelText('System') as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.value)).toEqual(['crm', 'support']);
  });

  it('offers a system again once its hold has been released', () => {
    const base = req('REQ-2026-0398');
    const request: RightsRequest = { ...base, holds: base.holds.map((h) => ({ ...h, releasedAt: '2026-09-30T10:00:00Z' })) };
    render(<HoldsPanel request={request} systems={file.systems} asOf={ASOF} onAction={vi.fn()} />);
    const select = screen.getByLabelText('System') as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.value)).toEqual(['crm', 'billing', 'support']);
    expect(screen.queryByRole('button', { name: 'Release hold' })).toBeNull();
    expect(screen.getByText('0 active')).toBeInTheDocument();
  });

  it('shows a note instead of the form when every system is already held', () => {
    const base = req('REQ-2026-0398');
    const request: RightsRequest = { ...base, holds: file.systems.map((s, i) => hold({ id: `HOLD-0398-${i + 1}`, systemId: s.id })) };
    render(<HoldsPanel request={request} systems={file.systems} asOf={ASOF} onAction={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Apply hold' })).toBeNull();
    expect(screen.queryByLabelText('System')).toBeNull();
    expect(screen.getByText(/already carries an active hold/)).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Release hold' })).toHaveLength(3);
  });

  it('releases a hold by id and applies a new hold on the first available system', async () => {
    const user = userEvent.setup();
    const onAction = vi.fn();
    render(<HoldsPanel request={req('REQ-2026-0398')} systems={file.systems} asOf={ASOF} onAction={onAction} />);
    expect(screen.getByText('1 active')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Release hold' }));
    expect(onAction).toHaveBeenCalledWith({ action: 'release-hold', payload: 'HOLD-0398-1' });
    await user.selectOptions(screen.getByLabelText('Reason'), 'fraud-prevention');
    await user.type(screen.getByLabelText(/^Justification/), 'Chargeback investigation open (synthetic).');
    await user.click(screen.getByRole('button', { name: 'Apply hold' }));
    expect(onAction).toHaveBeenLastCalledWith({
      action: 'apply-hold',
      payload: { id: 'HOLD-0398-2', systemId: 'crm', reason: 'fraud-prevention', note: 'Chargeback investigation open (synthetic).', appliedAt: AT },
    });
  });

  it('describes unjustified and released-unjustified holds in words', () => {
    const base = req('REQ-2026-0398');
    const request: RightsRequest = {
      ...base,
      holds: [hold({ id: 'HOLD-0398-1', systemId: 'crm', note: '' }), hold({ id: 'HOLD-0398-2', systemId: 'support', note: '', releasedAt: '2026-09-30T10:00:00Z' })],
    };
    render(<HoldsPanel request={request} systems={file.systems} asOf={ASOF} onAction={vi.fn()} />);
    expect(screen.getByText('No justification written yet — blocks the response.')).toBeInTheDocument();
    expect(screen.getByText('Released without a written justification.')).toBeInTheDocument();
    expect(screen.getByText(/released 2026-09-30/)).toBeInTheDocument();
  });
});

describe('PacketPanel', () => {
  it('previews disclosures, redactions and conflicts; the reveal toggle shows redacted values', async () => {
    const user = userEvent.setup();
    const request = req('REQ-2026-0399');
    render(<PacketPanel packet={withoutProposals(buildResponsePacket(request, ASOF))} request={request} />);
    expect(screen.getByRole('heading', { level: 3, name: 'Response packet preview' })).toBeInTheDocument();
    expect(screen.getByText('Partial — something is withheld')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Export packet JSON' })).toHaveClass('btn', 'btn-sm');
    expect(screen.getByText('Identity conflicts')).toBeInTheDocument();
    expect(screen.getByText('third-party-data')).toHaveClass('tag-red');
    expect(screen.queryByText('Neighbour Ines Farrow accepted the parcel on 3 June.')).toBeNull();
    await user.click(screen.getByRole('checkbox', { name: 'Reveal redacted values (reviewer only)' }));
    expect(screen.getByText('Neighbour Ines Farrow accepted the parcel on 3 June.')).toHaveClass('redacted', 'revealed');
  });

  it('renders extraExports as small buttons that call their handlers', async () => {
    const user = userEvent.setup();
    const request = req('REQ-2026-0399');
    const markdown = vi.fn();
    const html = vi.fn();
    render(
      <PacketPanel
        packet={buildResponsePacket(request, ASOF)}
        request={request}
        extraExports={[
          { label: 'Export packet Markdown', onClick: markdown },
          { label: 'Export packet HTML', onClick: html },
        ]}
      />,
    );
    const buttons = screen.getAllByRole('button', { name: /^Export packet/ });
    expect(buttons.map((b) => b.textContent)).toEqual(['Export packet JSON', 'Export packet Markdown', 'Export packet HTML']);
    for (const b of buttons) expect(b).toHaveClass('btn', 'btn-sm');
    await user.click(buttons[1]!);
    await user.click(buttons[2]!);
    expect(markdown).toHaveBeenCalledTimes(1);
    expect(html).toHaveBeenCalledTimes(1);
  });

  it('renders the proposed actions table and the summary when the packet carries them', () => {
    const request = req('REQ-2026-0399');
    const packet: ResponsePacket = {
      ...buildResponsePacket(request, ASOF),
      actions: [
        { systemId: 'crm', action: 'erase' },
        { systemId: 'support', action: 'withhold', reason: 'identity-conflict' },
      ],
      summary: 'Erase 1 record; withhold 1 pending re-verification (simulated).',
    };
    render(<PacketPanel packet={packet} request={request} />);
    expect(screen.getByText('Erase 1 record; withhold 1 pending re-verification (simulated).')).toBeInTheDocument();
    const table = screen.getByRole('table', { name: 'Proposed actions (simulated)' });
    const rows = within(table).getAllByRole('row');
    expect(rows).toHaveLength(3);
    expect(rows[1]).toHaveTextContent(/crm.*erase/);
    expect(rows[2]).toHaveTextContent(/support.*withhold.*identity-conflict/);
  });

  it('omits the actions table when the packet proposes none', () => {
    const request = req('REQ-2026-0399');
    render(<PacketPanel packet={withoutProposals(buildResponsePacket(request, ASOF))} request={request} />);
    expect(screen.queryByText('Proposed actions (simulated)')).toBeNull();
  });

  it('renders the engine-built proposals and summary for a fixture access request', () => {
    const request = req('REQ-2026-0411'); // crm and billing found, no holds or conflicts → disclose both
    render(<PacketPanel packet={buildResponsePacket(request, ASOF)} request={request} />);
    expect(screen.getByText(/^Access request:/)).toHaveClass('packet-summary');
    const table = screen.getByRole('table', { name: 'Proposed actions (simulated)' });
    const body = within(table).getAllByRole('row').slice(1).map((row) => within(row).getAllByRole('cell').map((cell) => cell.textContent));
    expect(body).toEqual([
      ['crm', 'disclose', '—'],
      ['billing', 'disclose', '—'],
    ]);
  });

  it('exports the packet JSON under a filename derived from the request id', async () => {
    const user = userEvent.setup();
    const request = req('REQ-2026-0399');
    const download = vi.mocked(downloadText);
    download.mockClear();
    render(<PacketPanel packet={buildResponsePacket(request, ASOF)} request={request} />);
    await user.click(screen.getByRole('button', { name: 'Export packet JSON' }));
    expect(download).toHaveBeenCalledTimes(1);
    const [filename, body] = download.mock.calls[0]!;
    expect(filename).toBe('REQ-2026-0399-response-packet.json');
    expect(JSON.parse(body)).toMatchObject({ requestId: 'REQ-2026-0399', type: 'erasure' });
  });

  it('sanitises a hostile request id before using it as the download filename', async () => {
    const user = userEvent.setup();
    const request: RightsRequest = { ...req('REQ-2026-0399'), id: '../etc/REQ:0399' };
    const download = vi.mocked(downloadText);
    download.mockClear();
    render(<PacketPanel packet={buildResponsePacket(request, ASOF)} request={request} />);
    await user.click(screen.getByRole('button', { name: 'Export packet JSON' }));
    const [filename] = download.mock.calls[0]!;
    expect(filename).not.toMatch(/[\\/:]/);
    expect(filename).toMatch(/-response-packet\.json$/);
  });

  it('explains an empty packet and offers no export at all', () => {
    const request = req('REQ-2026-0415');
    render(<PacketPanel packet={buildResponsePacket(request, ASOF)} request={request} extraExports={[{ label: 'Export packet Markdown', onClick: vi.fn() }]} />);
    expect(screen.getByText('Nothing collected yet')).toBeInTheDocument();
    expect(screen.getByText(/none exist yet/)).toHaveClass('muted-note');
    expect(screen.queryByRole('button', { name: /Export packet/ })).toBeNull();
  });
});

describe('HistoryPanel', () => {
  it('lists transitions with UTC timestamps, actors and notes, plus analyst notes', () => {
    render(<HistoryPanel request={req('REQ-2026-0411')} />);
    expect(screen.getByRole('heading', { level: 3, name: 'History' })).toBeInTheDocument();
    expect(screen.getByText('3 transitions')).toBeInTheDocument();
    const when = screen.getByText('2026-09-08 08:30:00 UTC');
    expect(when).toHaveClass('when');
    expect(when).toHaveAttribute('datetime', '2026-09-08T08:30:00Z');
    expect(screen.getByText('start-identity-check')).toBeInTheDocument();
    expect(screen.getByText('Signed-in account session matched')).toHaveClass('note');
    expect(screen.getByRole('heading', { level: 4, name: 'Analyst notes' })).toBeInTheDocument();
    expect(screen.getByText('Helpdesk lookup still outstanding.')).toBeInTheDocument();
  });

  it('explains an empty history', () => {
    // REQ-2026-0415 has no transitions but does carry one analyst note; drop it to exercise the fully empty panel.
    render(<HistoryPanel request={{ ...req('REQ-2026-0415'), notes: [] }} />);
    expect(screen.getByText('0 transitions')).toBeInTheDocument();
    expect(screen.getByText(/No transitions yet/)).toHaveClass('muted-note');
    expect(screen.queryByText('Analyst notes')).toBeNull();
  });
});
