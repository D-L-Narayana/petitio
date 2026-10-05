/**
 * Docket engine: sort, filter, search, summary and CSV export for the request list.
 * Pure TypeScript — imports nothing from React or the DOM (PLAN §2.6). All deadline maths is
 * delegated to assessDeadline() and is relative to the case file's asOf date.
 */
import type { CaseFile, DeadlineAssessment, DeadlineOptions, DeadlineStatus, DocketFilters, DocketSort, DocketSummary, RightsRequest } from './types';
import type { DuplicateFlag } from './duplicates';
import { assessDeadline } from './deadline';

export interface DocketItem {
  request: RightsRequest;
  assessment: DeadlineAssessment;
  /** Id of the earlier request this one appears to repeat (from findDuplicates). */
  duplicateOf?: string;
}

/** The unfiltered docket: every request, urgency order. Equivalent to the session store's DEFAULT_FILTERS. */
export const DEFAULT_DOCKET_FILTERS: DocketFilters = { jurisdiction: '', type: '', status: '', query: '', sort: 'urgency' };

export const DOCKET_SORTS: readonly DocketSort[] = ['urgency', 'received', 'due', 'id'];

export function isDocketSort(value: unknown): value is DocketSort {
  return typeof value === 'string' && (DOCKET_SORTS as readonly string[]).includes(value);
}

/** Urgency order: overdue first, then at-risk, on-track, closed, rejected. Also the order of the summary strip. */
export const DOCKET_STATUS_ORDER: readonly DeadlineStatus[] = ['overdue', 'at-risk', 'on-track', 'closed', 'rejected'];

const STATUS_RANK: Record<DeadlineStatus, number> = { overdue: 0, 'at-risk': 1, 'on-track': 2, closed: 3, rejected: 4 };

export const DOCKET_CSV_COLUMNS = ['id', 'receivedOn', 'jurisdiction', 'type', 'stage', 'status', 'statutoryDueOn', 'effectiveDueOn', 'daysRemaining', 'extended', 'duplicateOf'] as const;

/**
 * True when the trimmed, lower-cased query is a substring of the request id, the requester's
 * pseudonym, email or account id. An empty (or whitespace-only) query matches every request.
 */
export function matchesQuery(request: RightsRequest, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === '') return true;
  const { pseudonym, email, accountId } = request.requester;
  return [request.id, pseudonym, email, accountId ?? ''].some((field) => field.toLowerCase().includes(needle));
}

function byId(a: DocketItem, b: DocketItem): number {
  return a.request.id.localeCompare(b.request.id);
}

function byIsoDate(a: string, b: string): number {
  // YYYY-MM-DD strings order lexically; no Date parsing needed.
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Comparator for one sort mode. Every mode ends with the id so the order is total and stable
 * across renders. 'urgency' is the pre-upgrade App.tsx order: status rank, fewer days remaining, id.
 * Unknown values fall back to 'urgency'.
 */
export function compareDocketItems(a: DocketItem, b: DocketItem, sort: DocketSort): number {
  switch (sort) {
    case 'received':
      return byIsoDate(a.request.receivedOn, b.request.receivedOn) || byId(a, b);
    case 'due':
      return byIsoDate(a.assessment.effectiveDueOn, b.assessment.effectiveDueOn) || byId(a, b);
    case 'id':
      return byId(a, b);
    case 'urgency':
    default:
      return STATUS_RANK[a.assessment.status] - STATUS_RANK[b.assessment.status] || a.assessment.daysRemaining - b.assessment.daysRemaining || byId(a, b);
  }
}

function matchesFilters(item: DocketItem, filters: DocketFilters): boolean {
  const { request, assessment } = item;
  if (filters.jurisdiction && request.jurisdiction !== filters.jurisdiction) return false;
  if (filters.type && request.type !== filters.type) return false;
  if (filters.status === 'open') {
    if (assessment.status === 'closed' || assessment.status === 'rejected') return false;
  } else if (filters.status && assessment.status !== filters.status) return false;
  return matchesQuery(request, filters.query);
}

/**
 * Builds the docket: one assessment per request (computed once), duplicate flags attached, rows
 * filtered then sorted, and a summary whose byStatus/duplicates counts cover ALL requests while
 * `visible` counts the rows that survived the filters.
 */
export function buildDocket(file: CaseFile, duplicates: DuplicateFlag[], filters: DocketFilters, options?: DeadlineOptions): { rows: DocketItem[]; summary: DocketSummary } {
  const duplicateOf = new Map<string, string>();
  for (const flag of duplicates) {
    if (!duplicateOf.has(flag.requestId)) duplicateOf.set(flag.requestId, flag.duplicateOf);
  }

  const byStatus: Record<DeadlineStatus, number> = { overdue: 0, 'at-risk': 0, 'on-track': 0, closed: 0, rejected: 0 };
  let flagged = 0;
  const items: DocketItem[] = file.requests.map((request) => {
    const assessment = assessDeadline(request, file.asOf, options);
    byStatus[assessment.status] += 1;
    const original = duplicateOf.get(request.id);
    if (original === undefined) return { request, assessment };
    flagged += 1;
    return { request, assessment, duplicateOf: original };
  });

  const rows = items.filter((item) => matchesFilters(item, filters)).sort((a, b) => compareDocketItems(a, b, filters.sort));
  return {
    rows,
    summary: { total: file.requests.length, visible: rows.length, byStatus, duplicates: flagged },
  };
}

const FORMULA_LEAD = /^[=+\-@\t\r]/;
const NEEDS_QUOTING = /[",\r\n]/;

/**
 * Spreadsheet formula-injection guard: a text cell beginning with = + - @ TAB or CR is prefixed
 * with an apostrophe so it is read as text. Applied to every text column, never to engine numbers.
 */
export function guardCsvCell(value: string): string {
  return FORMULA_LEAD.test(value) ? `'${value}` : value;
}

/** RFC 4180 cell: strings are guarded, then quoted when they contain a quote, comma or line break (quotes doubled). */
export function csvCell(value: string | number | boolean): string {
  if (typeof value !== 'string') return String(value);
  const guarded = guardCsvCell(value);
  return NEEDS_QUOTING.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

/** RFC 4180 document: fixed header, one CRLF-terminated record per row, in the order given. */
export function docketToCsv(rows: DocketItem[]): string {
  const header = DOCKET_CSV_COLUMNS.map((column) => csvCell(column)).join(',');
  const records = rows.map(({ request, assessment, duplicateOf }) =>
    [
      request.id,
      request.receivedOn,
      request.jurisdiction,
      request.type,
      request.stage,
      assessment.status,
      assessment.statutoryDueOn,
      assessment.effectiveDueOn,
      assessment.daysRemaining,
      assessment.extended,
      duplicateOf ?? '',
    ]
      .map((cell) => csvCell(cell))
      .join(','),
  );
  return [header, ...records].map((line) => `${line}\r\n`).join('');
}
