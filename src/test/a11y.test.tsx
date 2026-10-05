/**
 * Accessibility expectations shared by every workflow (docs/workflows.md, last section), checked on the
 * rendered <App/>: names on every control, the live-region policy, blocked actions as described buttons,
 * focus management after actions, the docket's roving tabindex and the dialogs' focus behaviour.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { setThemePreference } from '../theme/useTheme';
import { LABELS, SECTIONS, caseTitle, clickAction, docketRow, docketRows, region, renderApp, selectRequest, setDateInput } from './helpers';

afterEach(() => {
  setThemePreference('auto');
  document.documentElement.removeAttribute('data-theme');
});

const CONTROL_SELECTOR = 'button, input, select, textarea';

function describeControl(control: Element): string {
  return control.outerHTML.slice(0, 160);
}

function expectAllNamed(root: ParentNode, atLeast: number): void {
  const controls = Array.from(root.querySelectorAll<HTMLElement>(CONTROL_SELECTOR));
  expect(controls.length).toBeGreaterThanOrEqual(atLeast);
  for (const control of controls) expect(control, describeControl(control)).toHaveAccessibleName();
}

describe('accessible names', () => {
  it('every button, input, select and textarea on the main page has an accessible name — for requests in review, collecting (with extra field rows) and received', async () => {
    const { user, view } = renderApp();
    expectAllNamed(view.container, 25); // REQ-2026-0398: hold form, release button, packet exports, reveal checkbox
    await selectRequest(user, 'REQ-2026-0411'); // record-result form with field rows
    await user.click(screen.getByRole('button', { name: 'Add field' }));
    expectAllNamed(view.container, 25);
    await selectRequest(user, 'REQ-2026-0415'); // extension form and reject fieldset
    expectAllNamed(view.container, 25);
    await selectRequest(user, 'REQ-2026-0380'); // terminal request: no forms at all
    expectAllNamed(view.container, 15);
  });

  it('every ribbon is an image with a label and every scrollable table or list is a named, focusable region', async () => {
    const { user } = renderApp();
    for (const img of screen.getAllByRole('img')) expect(img, describeControl(img)).toHaveAccessibleName(/^(overdue|at risk|on track|closed|rejected): /);
    const lookups = screen.getByRole('region', { name: SECTIONS.lookupResults });
    expect(lookups).toHaveAttribute('tabindex', '0');
    const rail = screen.getByRole('list', { name: SECTIONS.stages });
    expect(rail).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('list', { name: SECTIONS.clockSummary })).toBeInTheDocument();
    for (const name of [SECTIONS.actions, SECTIONS.identity, SECTIONS.extension, SECTIONS.systems, SECTIONS.holds, SECTIONS.packet, SECTIONS.history]) {
      expect(region(name), name).toBeInTheDocument();
    }
    await selectRequest(user, 'REQ-2026-0415');
    await clickAction(user, LABELS.startIdentityCheck);
    await user.click(await screen.findByRole('button', { name: 'Audit log (1)' }));
    const dialog = screen.getByRole('dialog', { name: SECTIONS.auditDialog });
    expect(within(dialog).getByRole('region', { name: SECTIONS.auditEntries })).toHaveAttribute('tabindex', '0');
  });

  it('both dialogs have a title and a description, and every control inside them is named', async () => {
    const { user } = renderApp();
    for (const [trigger, title] of [[LABELS.importCaseFile, SECTIONS.importDialog], ['Audit log (0)', SECTIONS.auditDialog]] as const) {
      await user.click(screen.getByRole('button', { name: trigger }));
      const dialog = screen.getByRole('dialog', { name: title });
      expect(within(dialog).getByRole('heading', { level: 2, name: title })).toBeInTheDocument();
      const describedBy = dialog.getAttribute('aria-describedby');
      expect(describedBy).toBeTruthy();
      expect(document.getElementById(describedBy ?? '')).toHaveTextContent(/\S/);
      expectAllNamed(dialog, 5);
      await user.keyboard('{Escape}');
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    }
  });
});

describe('live regions', () => {
  it('exactly one role="status" (the footer) while no dialog is open; the audit dialog adds its verification notice only while it is open', async () => {
    const { user } = renderApp();
    const statuses = screen.getAllByRole('status');
    expect(statuses).toHaveLength(1);
    expect(statuses[0]?.closest('footer')).not.toBeNull();
    expect(statuses[0]).toHaveAttribute('aria-live', 'polite');

    await selectRequest(user, 'REQ-2026-0415');
    await clickAction(user, LABELS.startIdentityCheck);
    expect(screen.getAllByRole('status', { hidden: true })).toHaveLength(1);

    await user.click(await screen.findByRole('button', { name: 'Audit log (1)' }));
    const dialog = screen.getByRole('dialog', { name: SECTIONS.auditDialog });
    expect(screen.getAllByRole('status', { hidden: true })).toHaveLength(1); // nothing verified yet
    await user.click(within(dialog).getByRole('button', { name: LABELS.verifyChain }));
    const verdict = await within(dialog).findByRole('status');
    expect(verdict).toHaveTextContent(/^Chain intact: /);
    expect(screen.getAllByRole('status', { hidden: true })).toHaveLength(2);

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getAllByRole('status', { hidden: true })).toHaveLength(1);
    expect(screen.getAllByRole('status')[0]?.closest('footer')).not.toBeNull();
  });

  it('role="alert" is absent until a refusal, names the code, and is cleared when another request is selected', async () => {
    const { user } = renderApp();
    expect(screen.queryByRole('alert')).toBeNull();
    await selectRequest(user, 'REQ-2026-0415');
    const panel = region(SECTIONS.extension);
    setDateInput(within(panel).getByLabelText(LABELS.notifiedOn), '2026-12-01');
    await user.type(within(panel).getByLabelText(LABELS.extensionReason), 'Archived attachments across systems.');
    await user.click(within(panel).getByRole('button', { name: LABELS.recordExtension }));
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(/^Refused\. INVALID_EXTENSION_INPUT: /);
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(screen.getAllByRole('status')).toHaveLength(1);
    await selectRequest(user, 'REQ-2026-0411');
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('blocked actions', () => {
  it('stay in the DOM as real buttons with aria-disabled="true" and an aria-describedby explanation; enabled ones say aria-disabled="false"', async () => {
    const { user } = renderApp();
    await selectRequest(user, 'REQ-2026-0411');
    const send = screen.getByRole('button', { name: LABELS.sendToReviewer });
    expect(send).toHaveAttribute('aria-disabled', 'true');
    expect(send).not.toBeDisabled();
    const why = document.getElementById(send.getAttribute('aria-describedby') ?? '');
    expect(why).toHaveTextContent('Lookups still outstanding for: support.');
    expect(send).toHaveAccessibleDescription('Lookups still outstanding for: support.');
    for (const button of within(region(SECTIONS.actions)).getAllByRole('button')) {
      if (button.textContent === LABELS.rejectWithThisReason) continue;
      expect(button, button.textContent ?? '').toHaveAttribute('aria-disabled');
    }
    await user.selectOptions(screen.getByLabelText(LABELS.outcome), 'none');
    await clickAction(user, LABELS.recordResult);
    expect(screen.getByRole('button', { name: LABELS.sendToReviewer })).toHaveAttribute('aria-disabled', 'false');
    expect(screen.getByRole('button', { name: LABELS.sendToReviewer })).not.toHaveAttribute('aria-describedby');
  });
});

describe('focus management', () => {
  it('moves focus to the request heading after a stage change and never leaves it on <body> after an action', async () => {
    const { user } = renderApp();
    await selectRequest(user, 'REQ-2026-0411');
    expect(caseTitle()).toHaveAttribute('tabindex', '-1');
    await user.selectOptions(screen.getByLabelText(LABELS.outcome), 'none');
    await clickAction(user, LABELS.recordResult); // same stage; the form unmounts
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement).not.toBeNull();
    await clickAction(user, LABELS.sendToReviewer); // stage change
    expect(caseTitle()).toHaveFocus();
    await clickAction(user, LABELS.applyHold); // same stage; the form survives
    expect(document.activeElement).not.toBe(document.body);
    await clickAction(user, LABELS.releaseHold); // same stage; the pressed button unmounts
    expect(document.activeElement).not.toBe(document.body);
    await clickAction(user, LABELS.prepareResponsePacket); // stage change
    expect(caseTitle()).toHaveFocus();
    await selectRequest(user, 'REQ-2026-0415'); // a different request: focus stays on the clicked row
    expect(docketRow('REQ-2026-0415')).toHaveFocus();
  });
});

describe('docket keyboard navigation', () => {
  it('exactly one row is in the tab order; ArrowDown/ArrowUp/Home/End move focus without selecting; Space selects', async () => {
    const { user } = renderApp();
    const rows = docketRows();
    expect(rows.length).toBeGreaterThanOrEqual(3);
    expect(rows.filter((row) => row.tabIndex === 0)).toHaveLength(1);
    expect(rows.find((row) => row.tabIndex === 0)).toHaveAttribute('aria-current', 'true');

    rows[0]!.focus();
    await user.keyboard('{ArrowDown}');
    expect(rows[1]).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(rows[2]).toHaveFocus();
    await user.keyboard('{ArrowUp}');
    expect(rows[1]).toHaveFocus();
    await user.keyboard('{End}');
    expect(rows.at(-1)).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(rows.at(-1)).toHaveFocus();
    await user.keyboard('{Home}');
    expect(rows[0]).toHaveFocus();
    await user.keyboard('{ArrowUp}');
    expect(rows[0]).toHaveFocus();
    await user.keyboard('{Control>}{ArrowDown}{/Control}'); // modifier combinations are left to the browser
    expect(rows[0]).toHaveFocus();
    await user.keyboard('{Alt>}{End}{/Alt}');
    expect(rows[0]).toHaveFocus();
    expect(caseTitle()).toHaveTextContent('REQ-2026-0398'); // moving focus did not select

    await user.keyboard('{ArrowDown}{ArrowDown}');
    await user.keyboard(' ');
    const thirdId = rows[2]!.querySelector('.id')?.textContent ?? '';
    expect(caseTitle()).toHaveTextContent(thirdId);
    expect(docketRows().filter((row) => row.tabIndex === 0).map((row) => row.querySelector('.id')?.textContent)).toEqual([thirdId]);
  });
});

describe('dialogs', () => {
  for (const [trigger, title] of [[LABELS.importCaseFile, SECTIONS.importDialog], ['Audit log (0)', SECTIONS.auditDialog]] as const) {
    it(`${title}: focus lands inside on open, Tab stays inside, Escape closes and returns focus to the trigger`, async () => {
      const { user } = renderApp();
      const button = screen.getByRole('button', { name: trigger });
      await user.click(button);
      const dialog = screen.getByRole('dialog', { name: title });
      expect(dialog.contains(document.activeElement)).toBe(true);
      for (let i = 0; i < 12; i += 1) {
        await user.tab();
        expect(dialog.contains(document.activeElement), `after ${i + 1} tabs: ${describeControl(document.activeElement ?? document.body)}`).toBe(true);
      }
      for (let i = 0; i < 3; i += 1) {
        await user.tab({ shift: true });
        expect(dialog.contains(document.activeElement), `after shift-tab ${i + 1}`).toBe(true);
      }
      await user.keyboard('{Escape}');
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(button).toHaveFocus();
    });
  }
});
