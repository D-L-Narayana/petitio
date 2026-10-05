import { describe, expect, it, vi } from 'vitest';
import { useState, type ComponentProps } from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import demoJson from '../fixtures/demo-casefile.json';
import { parseCaseFile } from '../engine/casefile';
import { PROFILES } from '../engine/deadline';
import { findDuplicates } from '../engine/duplicates';
import { buildDocket, DEFAULT_DOCKET_FILTERS } from '../engine/docket';
import type { CaseFile, DocketFilters, DocketSummary } from '../engine/types';
import { Docket } from './Docket';

const parsed = parseCaseFile(JSON.stringify(demoJson));
if (!parsed.ok) throw new Error(`bundled fixture failed validation: ${parsed.errors.join('; ')}`);
const FILE: CaseFile = parsed.file;
const { rows: ROWS, summary: SUMMARY } = buildDocket(FILE, findDuplicates(FILE.requests, 30), DEFAULT_DOCKET_FILTERS);

const EMPTY_TEXT = 'No requests match these filters. Clear a filter or import a case file.';

type Props = ComponentProps<typeof Docket>;

function renderDocket(over: Partial<Props> = {}) {
  const onSelect = vi.fn();
  const onFilter = vi.fn();
  const props: Props = { rows: ROWS, summary: SUMMARY, selectedId: 'REQ-2026-0398', onSelect, onFilter, filters: DEFAULT_DOCKET_FILTERS, ...over };
  const utils = render(<Docket {...props} />);
  return { ...utils, onSelect, onFilter };
}

/** Keeps the filters in React state, as App does, so typing accumulates instead of being reset by a constant prop. */
function Harness({ initial, onFilter, ...rest }: Omit<Props, 'filters'> & { initial: DocketFilters }) {
  const [current, setCurrent] = useState(initial);
  return (
    <Docket
      {...rest}
      filters={current}
      onFilter={(next) => {
        setCurrent(next);
        onFilter(next);
      }}
    />
  );
}

function docket(): HTMLElement {
  return screen.getByRole('complementary', { name: /docket/i });
}

function row(id: string): HTMLElement {
  return within(docket()).getByRole('button', { name: new RegExp(id) });
}

function rowButtons(): HTMLButtonElement[] {
  return Array.from(docket().querySelectorAll<HTMLButtonElement>('button.docket-row'));
}

function assessmentOf(id: string) {
  const found = ROWS.find((r) => r.request.id === id);
  if (!found) throw new Error(`docket has no ${id}`);
  return found.assessment;
}

function summaryOf(over: Partial<DocketSummary>): DocketSummary {
  return { ...SUMMARY, ...over };
}

function optionValues(select: HTMLElement | null): string[] {
  return Array.from((select as HTMLSelectElement).options).map((o) => o.value);
}

function optionLabels(select: HTMLElement | null): string[] {
  return Array.from((select as HTMLSelectElement).options).map((o) => o.textContent);
}

describe('Docket: preserved structure and strings', () => {
  it('renders the aside, the heading and each row with the preserved structure', () => {
    const { container } = renderDocket();
    const aside = docket();
    expect(aside.tagName).toBe('ASIDE');
    expect(aside).toHaveClass('docket');
    expect(aside).toHaveAttribute('aria-labelledby', 'docket-title');
    expect(within(aside).getByRole('heading', { level: 2, name: `Docket · ${SUMMARY.visible} of ${SUMMARY.total}` })).toHaveAttribute('id', 'docket-title');

    const items = Array.from(container.querySelector('ul.docket-list')?.children ?? []);
    expect(items).toHaveLength(ROWS.length);
    expect(items.every((li) => li.tagName === 'LI' && li.children.length === 1 && li.firstElementChild?.matches('button[type="button"].docket-row'))).toBe(true);
    expect(rowButtons().map((b) => b.querySelector('.id')?.textContent)).toEqual(ROWS.map((r) => r.request.id));

    const first = row('REQ-2026-0398');
    expect(first).toHaveAttribute('aria-current', 'true');
    expect(row('REQ-2026-0411')).toHaveAttribute('aria-current', 'false');
    const badge = first.querySelector('.badge');
    expect(badge).toHaveClass('badge-overdue');
    expect(badge?.textContent).toBe(`${-assessmentOf('REQ-2026-0398').daysRemaining}d over`);
    expect(first.querySelector('.meta')?.textContent).toBe('EU-GDPR · erasure · review');
    expect(first.querySelector('.ribbon [role="img"]')).not.toBeNull();
  });

  it('uses the preserved badge wording for closed, rejected and on-track rows', () => {
    renderDocket();
    expect(row('REQ-2026-0380').querySelector('.badge.badge-closed')?.textContent).toBe('closed');
    expect(row('REQ-2026-0390').querySelector('.badge.badge-rejected')?.textContent).toBe('rejected');
    expect(row('REQ-2026-0411').querySelector('.badge.badge-on-track')?.textContent).toBe(`${assessmentOf('REQ-2026-0411').daysRemaining}d left`);
  });

  it("appends ' · possible duplicate' to flagged rows only", () => {
    renderDocket();
    expect(row('REQ-2026-0416').querySelector('.meta')?.textContent).toBe('EU-GDPR · access · received · possible duplicate');
    expect(row('REQ-2026-0411').querySelector('.meta')?.textContent).not.toMatch(/possible duplicate/);
  });

  it('keeps the row buttons first in DOM order so App.test.tsx can read rows[0] (the new controls follow the list)', () => {
    renderDocket({ onExportCsv: vi.fn() });
    const buttons = within(docket()).getAllByRole('button');
    expect(buttons[0]).toHaveTextContent('REQ-2026-0398');
    expect(buttons.slice(0, ROWS.length).map((b) => b.querySelector('.id')?.textContent)).toEqual(ROWS.map((r) => r.request.id));
    expect(buttons.slice(ROWS.length).map((b) => b.textContent)).toEqual(['Clear filters', 'Export CSV']);
  });

  it('selects a row on click', async () => {
    const user = userEvent.setup();
    const { onSelect } = renderDocket();
    await user.click(row('REQ-2026-0411'));
    expect(onSelect).toHaveBeenCalledWith('REQ-2026-0411');
  });

  it('renders the empty state when no rows match', () => {
    const { container } = renderDocket({ rows: [], summary: summaryOf({ visible: 0 }) });
    expect(screen.getByText(EMPTY_TEXT)).toHaveClass('docket-empty');
    expect(container.querySelector('.docket-list')).toBeNull();
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(`Docket · 0 of ${SUMMARY.total}`);
  });

  it('keeps the type and clock option values and calls onFilter with the changed field', async () => {
    const user = userEvent.setup();
    const { onFilter } = renderDocket();
    expect(optionValues(screen.getByLabelText('Type'))).toEqual(['', 'access', 'erasure', 'rectification', 'portability', 'opt-out-sale']);
    expect(optionValues(screen.getByLabelText('Clock'))).toEqual(['', 'open', 'overdue', 'at-risk', 'on-track', 'closed', 'rejected']);
    await user.selectOptions(screen.getByLabelText('Jurisdiction'), 'US-CA-CCPA');
    expect(onFilter).toHaveBeenLastCalledWith({ ...DEFAULT_DOCKET_FILTERS, jurisdiction: 'US-CA-CCPA' });
    await user.selectOptions(screen.getByLabelText('Type'), 'erasure');
    expect(onFilter).toHaveBeenLastCalledWith({ ...DEFAULT_DOCKET_FILTERS, type: 'erasure' });
    await user.selectOptions(screen.getByLabelText('Clock'), 'open');
    expect(onFilter).toHaveBeenLastCalledWith({ ...DEFAULT_DOCKET_FILTERS, status: 'open' });
  });
});

describe('Docket: summary strip', () => {
  it('renders one item per status with a count plus the duplicates item', () => {
    renderDocket({ summary: { total: 9, visible: 9, byStatus: { overdue: 1, 'at-risk': 2, 'on-track': 4, closed: 1, rejected: 1 }, duplicates: 3 } });
    const strip = within(docket()).queryByRole('list', { name: 'Clock summary' });
    expect(strip).not.toBeNull();
    expect(strip?.tagName).toBe('UL');
    expect(strip).toHaveClass('docket-summary');
    expect(within(strip as HTMLElement).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['1 overdue', '2 at risk', '4 on track', '1 closed', '1 rejected', '3 possible duplicates']);
  });

  it('omits zero-count statuses and the duplicates item when there are none, and uses the singular for one duplicate', () => {
    const { rerender } = renderDocket({ summary: { total: 2, visible: 2, byStatus: { overdue: 0, 'at-risk': 0, 'on-track': 2, closed: 0, rejected: 0 }, duplicates: 0 } });
    const strip = within(docket()).queryByRole('list', { name: 'Clock summary' });
    expect(strip).not.toBeNull();
    expect(within(strip as HTMLElement).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['2 on track']);

    rerender(<Docket rows={ROWS} summary={{ total: 2, visible: 2, byStatus: { overdue: 0, 'at-risk': 0, 'on-track': 1, closed: 1, rejected: 0 }, duplicates: 1 }} selectedId={null} onSelect={vi.fn()} filters={DEFAULT_DOCKET_FILTERS} onFilter={vi.fn()} />);
    expect(within(docket()).getAllByRole('listitem').filter((li) => li.closest('.docket-summary')).map((li) => li.textContent)).toEqual(['1 on track', '1 closed', '1 possible duplicate']);
  });

  it('reflects the real fixture counts', () => {
    renderDocket();
    const strip = within(docket()).queryByRole('list', { name: 'Clock summary' });
    expect(strip).not.toBeNull();
    const texts = within(strip as HTMLElement).getAllByRole('listitem').map((li) => li.textContent);
    expect(texts).toContain(`${SUMMARY.byStatus.overdue} overdue`);
    expect(texts).toContain(`${SUMMARY.byStatus['at-risk']} at risk`);
    expect(texts).toContain(`${SUMMARY.byStatus['on-track']} on track`);
    expect(texts).toContain(`${SUMMARY.byStatus.closed} closed`);
    expect(texts).toContain(`${SUMMARY.byStatus.rejected} rejected`);
    expect(texts.some((t) => /possible duplicate/.test(t ?? ''))).toBe(SUMMARY.duplicates > 0);
  });
});

describe('Docket: search, sort, clear, export', () => {
  it('derives the jurisdiction options from PROFILES with an All option first', () => {
    renderDocket();
    const select = screen.getByLabelText('Jurisdiction');
    expect(optionValues(select)).toEqual(['', ...Object.keys(PROFILES)]);
    expect(optionLabels(select)).toEqual(['All', ...Object.values(PROFILES).map((p) => p.label)]);
  });

  it('searches as the analyst types and reports the query through onFilter', async () => {
    const user = userEvent.setup();
    const onFilter = vi.fn();
    render(<Harness rows={ROWS} summary={SUMMARY} selectedId={null} onSelect={vi.fn()} onFilter={onFilter} initial={DEFAULT_DOCKET_FILTERS} />);
    const box = screen.queryByRole('searchbox', { name: 'Search requests' });
    expect(box).not.toBeNull();
    expect(box).toHaveAttribute('type', 'search');
    expect(box).toHaveAttribute('placeholder', 'Search id, pseudonym, email, account');
    await user.type(box as HTMLElement, 'lark');
    expect(onFilter).toHaveBeenLastCalledWith({ ...DEFAULT_DOCKET_FILTERS, query: 'lark' });
    expect(box).toHaveValue('lark');
  });

  it('offers urgency, received, due date and id sorts and reports the choice through onFilter', async () => {
    const user = userEvent.setup();
    const { onFilter } = renderDocket();
    const sort = screen.queryByLabelText('Sort');
    expect(sort).not.toBeNull();
    expect(optionValues(sort)).toEqual(['urgency', 'received', 'due', 'id']);
    expect(optionLabels(sort)).toEqual(['Urgency', 'Received', 'Due date', 'Id']);
    expect(sort).toHaveValue('urgency');
    await user.selectOptions(sort as HTMLElement, 'due');
    expect(onFilter).toHaveBeenLastCalledWith({ ...DEFAULT_DOCKET_FILTERS, sort: 'due' });
  });

  it('clears every filter back to the defaults', async () => {
    const user = userEvent.setup();
    const onFilter = vi.fn();
    const initial: DocketFilters = { jurisdiction: 'EU-GDPR', type: 'access', status: 'open', query: 'lark', sort: 'due' };
    render(<Harness rows={ROWS} summary={SUMMARY} selectedId={null} onSelect={vi.fn()} onFilter={onFilter} initial={initial} />);
    expect(screen.getByLabelText('Jurisdiction')).toHaveValue('EU-GDPR');
    const clear = screen.queryByRole('button', { name: 'Clear filters' });
    expect(clear).not.toBeNull();
    await user.click(clear as HTMLElement);
    expect(onFilter).toHaveBeenCalledTimes(1);
    expect(onFilter).toHaveBeenLastCalledWith({ jurisdiction: '', type: '', status: '', query: '', sort: 'urgency' });
    expect(screen.getByLabelText('Jurisdiction')).toHaveValue('');
    expect(screen.getByLabelText('Clock')).toHaveValue('');
    expect(screen.getByLabelText('Sort')).toHaveValue('urgency');
    expect(screen.getByRole('searchbox', { name: 'Search requests' })).toHaveValue('');
  });

  it('does not render Export CSV without a handler', () => {
    renderDocket();
    expect(screen.queryByRole('button', { name: 'Export CSV' })).toBeNull();
  });

  it('calls onExportCsv when Export CSV is clicked', async () => {
    const user = userEvent.setup();
    const onExportCsv = vi.fn();
    renderDocket({ onExportCsv });
    const button = screen.queryByRole('button', { name: 'Export CSV' });
    expect(button).not.toBeNull();
    await user.click(button as HTMLElement);
    expect(onExportCsv).toHaveBeenCalledTimes(1);
  });

  it('gives every control in the docket an accessible name', () => {
    renderDocket({ onExportCsv: vi.fn() });
    const controls = Array.from(docket().querySelectorAll('button, input, select'));
    expect(controls.length).toBeGreaterThan(ROWS.length + 4);
    for (const control of controls) expect(control).toHaveAccessibleName();
  });
});

describe('Docket: keyboard navigation', () => {
  it('gives only the selected row a tab stop, or the first row when nothing visible is selected', () => {
    const { rerender } = renderDocket({ selectedId: 'REQ-2026-0411' });
    const tabbable = () => rowButtons().filter((b) => b.getAttribute('tabindex') === '0').map((b) => b.querySelector('.id')?.textContent);
    const others = () => rowButtons().filter((b) => b.getAttribute('tabindex') !== '0');
    expect(tabbable()).toEqual(['REQ-2026-0411']);
    expect(others()).toHaveLength(ROWS.length - 1);
    expect(others().every((b) => b.getAttribute('tabindex') === '-1')).toBe(true);

    rerender(<Docket rows={ROWS} summary={SUMMARY} selectedId={null} onSelect={vi.fn()} filters={DEFAULT_DOCKET_FILTERS} onFilter={vi.fn()} />);
    expect(tabbable()).toEqual([ROWS[0]?.request.id]);

    rerender(<Docket rows={ROWS} summary={SUMMARY} selectedId="REQ-NOT-VISIBLE" onSelect={vi.fn()} filters={DEFAULT_DOCKET_FILTERS} onFilter={vi.fn()} />);
    expect(tabbable()).toEqual([ROWS[0]?.request.id]);
  });

  it('moves focus with ArrowDown, ArrowUp, Home and End without changing the selection', async () => {
    const user = userEvent.setup();
    const { onSelect } = renderDocket();
    const buttons = rowButtons();
    expect(buttons.length).toBeGreaterThanOrEqual(3);
    buttons[0]?.focus();
    expect(buttons[0]).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(buttons[1]).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(buttons[2]).toHaveFocus();
    await user.keyboard('{ArrowUp}');
    expect(buttons[1]).toHaveFocus();
    await user.keyboard('{End}');
    expect(buttons[buttons.length - 1]).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(buttons[buttons.length - 1]).toHaveFocus();
    await user.keyboard('{Home}');
    expect(buttons[0]).toHaveFocus();
    await user.keyboard('{ArrowUp}');
    expect(buttons[0]).toHaveFocus();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('selects the focused row with Enter and with Space', async () => {
    const user = userEvent.setup();
    const { onSelect } = renderDocket();
    const buttons = rowButtons();
    buttons[1]?.focus();
    await user.keyboard('{Enter}');
    expect(onSelect).toHaveBeenLastCalledWith(ROWS[1]?.request.id);
    buttons[2]?.focus();
    await user.keyboard(' ');
    expect(onSelect).toHaveBeenLastCalledWith(ROWS[2]?.request.id);
    expect(onSelect).toHaveBeenCalledTimes(2);
  });
});
