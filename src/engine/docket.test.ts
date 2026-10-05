import { describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';
import demoJson from '../fixtures/demo-casefile.json';
import { parseCaseFile } from './casefile';
import { assessDeadline } from './deadline';
import { findDuplicates } from './duplicates';
import type { CaseFile, DeadlineStatus, DocketFilters, DocketSort, RightsRequest } from './types';
import { buildDocket, DEFAULT_DOCKET_FILTERS, docketToCsv, matchesQuery, type DocketItem } from './docket';

// assessDeadline is wrapped, not replaced: every call still reaches the real engine, but the
// arguments buildDocket passes (request, asOf, DeadlineOptions) become observable.
vi.mock('./deadline', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./deadline')>();
  return { ...actual, assessDeadline: vi.fn(actual.assessDeadline) };
});

const parsed = parseCaseFile(JSON.stringify(demoJson));
if (!parsed.ok) throw new Error(`bundled fixture failed validation: ${parsed.errors.join('; ')}`);
const FILE: CaseFile = parsed.file;
const AS_OF = FILE.asOf; // 2026-10-01 in the bundled fixture
const DUPS = findDuplicates(FILE.requests, 30);

const CSV_HEADER = 'id,receivedOn,jurisdiction,type,stage,status,statutoryDueOn,effectiveDueOn,daysRemaining,extended,duplicateOf';

function filters(over: Partial<DocketFilters> = {}): DocketFilters {
  return { ...DEFAULT_DOCKET_FILTERS, ...over };
}

function ids(rows: DocketItem[]): string[] {
  return rows.map((row) => row.request.id);
}

function fixture(id: string): RightsRequest {
  const found = FILE.requests.find((r) => r.id === id);
  if (!found) throw new Error(`fixture has no ${id}`);
  return found;
}

/** Hand-built request: an EU-GDPR access request in collecting, received 2026-09-01 unless overridden. */
function makeRequest(over: Partial<RightsRequest> & { id: string }): RightsRequest {
  return {
    receivedOn: '2026-09-01',
    jurisdiction: 'EU-GDPR',
    type: 'access',
    requester: { pseudonym: `subject-${over.id}`, email: `${over.id}@people.example` },
    stage: 'collecting',
    identity: { method: 'email-loop', attempts: 1, maxAttempts: 3, status: 'passed' },
    holds: [],
    systemResults: [],
    history: [],
    notes: [],
    ...over,
  };
}

function fileOf(requests: RightsRequest[], asOf = '2026-10-01'): CaseFile {
  return { schema: 'petitio.casefile', version: 1, asOf, systems: [{ id: 'crm', name: 'Northwind CRM (synthetic)', description: '' }], requests };
}

function rowsOf(requests: RightsRequest[], asOf = '2026-10-01'): DocketItem[] {
  return requests.map((request) => ({ request, assessment: assessDeadline(request, asOf) }));
}

/** The pre-upgrade App.tsx ordering, kept here verbatim as the oracle for the default sort. */
function legacyUrgencyOrder(file: CaseFile): string[] {
  const items = file.requests.map((request) => ({ request, assessment: assessDeadline(request, file.asOf) }));
  const rank: Record<string, number> = { overdue: 0, 'at-risk': 1, 'on-track': 2, closed: 3, rejected: 4 };
  items.sort((a, b) => (rank[a.assessment.status]! - rank[b.assessment.status]!) || a.assessment.daysRemaining - b.assessment.daysRemaining || a.request.id.localeCompare(b.request.id));
  return items.map((i) => i.request.id);
}

/** Minimal RFC 4180 reader (CRLF records, double-quote escaping) used only to check that the CSV parses back. */
function parseCsv(text: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let quoted = false;
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i += 1;
        continue;
      }
      field += c;
      i += 1;
      continue;
    }
    if (c === '"' && field === '') {
      quoted = true;
      i += 1;
      continue;
    }
    if (c === ',') {
      record.push(field);
      field = '';
      i += 1;
      continue;
    }
    if (c === '\r' && text[i + 1] === '\n') {
      record.push(field);
      records.push(record);
      record = [];
      field = '';
      i += 2;
      continue;
    }
    field += c;
    i += 1;
  }
  if (field !== '' || record.length > 0) {
    record.push(field);
    records.push(record);
  }
  return records;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

describe('matchesQuery', () => {
  it('matches every request on an empty or whitespace-only query', () => {
    for (const request of FILE.requests) {
      expect(matchesQuery(request, '')).toBe(true);
      expect(matchesQuery(request, '   \t ')).toBe(true);
    }
  });

  it('matches id, pseudonym, email and accountId case-insensitively, ignoring surrounding whitespace', () => {
    const request = fixture('REQ-2026-0411'); // lark-7731, lark.7731@people.example, ACC-10431
    expect(matchesQuery(request, 'req-2026-0411')).toBe(true);
    expect(matchesQuery(request, '  0411 ')).toBe(true);
    expect(matchesQuery(request, 'LARK-7731')).toBe(true);
    expect(matchesQuery(request, 'Lark.7731@PEOPLE.example')).toBe(true);
    expect(matchesQuery(request, 'acc-10431')).toBe(true);
    expect(matchesQuery(request, 'ACC-99999')).toBe(false);
    expect(matchesQuery(request, 'quill')).toBe(false);
  });

  it('does not match an account query when the request has no accountId', () => {
    const request = fixture('REQ-2026-0420'); // fern-5109, no accountId
    expect(request.requester.accountId).toBeUndefined();
    expect(matchesQuery(request, 'acc-')).toBe(false);
    expect(matchesQuery(request, 'fern')).toBe(true);
  });

  it('matches any substring of the email in any casing (property)', () => {
    fc.assert(
      fc.property(fc.constantFrom(...FILE.requests), fc.nat(), fc.nat(), fc.boolean(), fc.constantFrom('', ' ', '\t '), (request, a, b, upper, pad) => {
        const email = request.requester.email;
        const [start, end] = [a % (email.length + 1), b % (email.length + 1)].sort((x, y) => x - y) as [number, number];
        const sub = email.slice(start, end);
        return matchesQuery(request, `${pad}${upper ? sub.toUpperCase() : sub}${pad}`) === true;
      }),
      { numRuns: 200 },
    );
  });
});

describe('buildDocket sorting', () => {
  it('reproduces the pre-upgrade urgency order on the demo fixture by default', () => {
    const { rows } = buildDocket(FILE, DUPS, DEFAULT_DOCKET_FILTERS);
    expect(ids(rows)).toEqual(legacyUrgencyOrder(FILE));
    expect(rows[0]?.request.id).toBe('REQ-2026-0398');
    expect(rows[0]?.assessment.status).toBe('overdue');
  });

  it('ranks overdue → at-risk → on-track → closed → rejected, then fewer days remaining, then id', () => {
    const file = fileOf([
      makeRequest({ id: 'REQ-REJECT', receivedOn: '2026-09-25', stage: 'rejected', rejectReason: 'out-of-scope' }),
      makeRequest({ id: 'REQ-TRACK', receivedOn: '2026-09-20' }), // due 2026-10-20, 19 days left
      makeRequest({ id: 'REQ-OVER-NEAR', receivedOn: '2026-08-25' }), // due 2026-09-25, 6 days over
      makeRequest({ id: 'REQ-CLOSED', receivedOn: '2026-08-01', stage: 'closed', closedOn: '2026-09-10' }),
      makeRequest({ id: 'REQ-RISK', receivedOn: '2026-09-03' }), // due 2026-10-03, 2 days left
      makeRequest({ id: 'REQ-OVER-FAR', receivedOn: '2026-07-01' }), // due 2026-08-01, 61 days over
    ]);
    const { rows } = buildDocket(file, [], filters({ sort: 'urgency' }));
    expect(rows.map((r) => r.assessment.status)).toEqual<DeadlineStatus[]>(['overdue', 'overdue', 'at-risk', 'on-track', 'closed', 'rejected']);
    expect(ids(rows)).toEqual(['REQ-OVER-FAR', 'REQ-OVER-NEAR', 'REQ-RISK', 'REQ-TRACK', 'REQ-CLOSED', 'REQ-REJECT']);

    const tie = fileOf([makeRequest({ id: 'REQ-B', receivedOn: '2026-09-20' }), makeRequest({ id: 'REQ-A', receivedOn: '2026-09-20' })]);
    expect(ids(buildDocket(tie, [], filters({ sort: 'urgency' })).rows)).toEqual(['REQ-A', 'REQ-B']);
  });

  it('orders by receivedOn ascending and then id for the received sort, regardless of clock status', () => {
    const file = fileOf([
      makeRequest({ id: 'REQ-C', receivedOn: '2026-09-10' }),
      makeRequest({ id: 'REQ-B', receivedOn: '2026-07-01', stage: 'closed', closedOn: '2026-07-20' }),
      makeRequest({ id: 'REQ-A', receivedOn: '2026-09-10' }),
      makeRequest({ id: 'REQ-D', receivedOn: '2026-08-01' }), // overdue, but received after REQ-B
    ]);
    expect(ids(buildDocket(file, [], filters({ sort: 'received' })).rows)).toEqual(['REQ-B', 'REQ-D', 'REQ-A', 'REQ-C']);
  });

  it('orders by effectiveDueOn ascending and then id for the due sort, with extensions moving a request later', () => {
    const file = fileOf([
      makeRequest({ id: 'REQ-EXT', receivedOn: '2026-08-20', extension: { days: 20, reason: 'archive retrieval', notifiedOn: '2026-09-01' } }), // statutory 2026-09-20 → effective 2026-10-10
      makeRequest({ id: 'REQ-EU', receivedOn: '2026-09-01' }), // due 2026-10-01
      makeRequest({ id: 'REQ-CA', receivedOn: '2026-08-17', jurisdiction: 'US-CA-CCPA' }), // 45 days → due 2026-10-01
      makeRequest({ id: 'REQ-EARLY', receivedOn: '2026-08-25' }), // due 2026-09-25
    ]);
    const { rows } = buildDocket(file, [], filters({ sort: 'due' }));
    expect(rows.map((r) => r.assessment.effectiveDueOn)).toEqual(['2026-09-25', '2026-10-01', '2026-10-01', '2026-10-10']);
    expect(ids(rows)).toEqual(['REQ-EARLY', 'REQ-CA', 'REQ-EU', 'REQ-EXT']);
  });

  it('orders by id for the id sort', () => {
    const file = fileOf([makeRequest({ id: 'REQ-2026-0003' }), makeRequest({ id: 'REQ-2026-0001', receivedOn: '2026-07-01' }), makeRequest({ id: 'REQ-2026-0002' })]);
    expect(ids(buildDocket(file, [], filters({ sort: 'id' })).rows)).toEqual(['REQ-2026-0001', 'REQ-2026-0002', 'REQ-2026-0003']);
  });

  it('orders the demo fixture by received and by due with expectations derived from the parsed fixture', () => {
    const byReceived = [...FILE.requests].sort((a, b) => a.receivedOn.localeCompare(b.receivedOn) || a.id.localeCompare(b.id)).map((r) => r.id);
    expect(ids(buildDocket(FILE, DUPS, filters({ sort: 'received' })).rows)).toEqual(byReceived);
    const byDue = FILE.requests.map((r) => ({ id: r.id, due: assessDeadline(r, AS_OF).effectiveDueOn }))
      .sort((a, b) => a.due.localeCompare(b.due) || a.id.localeCompare(b.id))
      .map((r) => r.id);
    expect(ids(buildDocket(FILE, DUPS, filters({ sort: 'due' })).rows)).toEqual(byDue);
    expect(byReceived).not.toEqual(legacyUrgencyOrder(FILE));
  });

  it('falls back to the urgency order for an unknown sort value', () => {
    const { rows } = buildDocket(FILE, DUPS, filters({ sort: 'bogus' as DocketSort }));
    expect(ids(rows)).toEqual(legacyUrgencyOrder(FILE));
  });
});

describe('buildDocket filters', () => {
  it('applies jurisdiction, type and exact clock filters', () => {
    const ccpa = buildDocket(FILE, DUPS, filters({ jurisdiction: 'US-CA-CCPA' })).rows;
    expect(ccpa.length).toBeGreaterThan(0);
    expect(ccpa.every((r) => r.request.jurisdiction === 'US-CA-CCPA')).toBe(true);
    expect(ids(ccpa)).toEqual(expect.arrayContaining(['REQ-2026-0420', 'REQ-2026-0380']));

    const erasure = buildDocket(FILE, DUPS, filters({ type: 'erasure' })).rows;
    expect(erasure.every((r) => r.request.type === 'erasure')).toBe(true);
    expect(ids(erasure)).toEqual(expect.arrayContaining(['REQ-2026-0398', 'REQ-2026-0399']));

    const closed = buildDocket(FILE, DUPS, filters({ status: 'closed' })).rows;
    expect(closed.every((r) => r.assessment.status === 'closed')).toBe(true);
    expect(ids(closed)).toContain('REQ-2026-0380');
  });

  it("treats the 'open' clock filter as not closed and not rejected", () => {
    const { rows, summary } = buildDocket(FILE, DUPS, filters({ status: 'open' }));
    expect(rows.every((r) => r.assessment.status !== 'closed' && r.assessment.status !== 'rejected')).toBe(true);
    expect(ids(rows)).toContain('REQ-2026-0411');
    expect(ids(rows)).not.toContain('REQ-2026-0380');
    expect(ids(rows)).not.toContain('REQ-2026-0390');
    expect(rows.length).toBe(summary.total - summary.byStatus.closed - summary.byStatus.rejected);
  });

  it('applies the free-text query through matchesQuery', () => {
    const { rows } = buildDocket(FILE, DUPS, filters({ query: '  LARK ' }));
    expect(ids(rows)).toEqual(expect.arrayContaining(['REQ-2026-0411', 'REQ-2026-0416']));
    expect(rows.every((r) => matchesQuery(r.request, 'lark'))).toBe(true);
    expect(buildDocket(FILE, DUPS, filters({ query: 'acc-10431' })).rows.map((r) => r.request.id)).toEqual(['REQ-2026-0411']);
    expect(buildDocket(FILE, DUPS, filters({ query: 'nobody-here' })).rows).toEqual([]);
  });

  it('combines filters conjunctively', () => {
    const { rows } = buildDocket(FILE, DUPS, filters({ jurisdiction: 'EU-GDPR', type: 'access', status: 'open' }));
    expect(rows.every((r) => r.request.jurisdiction === 'EU-GDPR' && r.request.type === 'access' && r.request.stage !== 'closed' && r.request.stage !== 'rejected')).toBe(true);
    expect(ids(rows)).toEqual(expect.arrayContaining(['REQ-2026-0411', 'REQ-2026-0416']));
    expect(ids(rows)).not.toContain('REQ-2026-0390'); // rejected EU-GDPR access request
  });
});

describe('buildDocket summary and rows', () => {
  it('counts byStatus and duplicates over all requests while visible follows the filters', () => {
    const { rows, summary } = buildDocket(FILE, DUPS, filters({ status: 'overdue' }));
    const expected: Record<DeadlineStatus, number> = { 'on-track': 0, 'at-risk': 0, overdue: 0, closed: 0, rejected: 0 };
    for (const request of FILE.requests) expected[assessDeadline(request, AS_OF).status] += 1;

    expect(summary.total).toBe(FILE.requests.length);
    expect(summary.visible).toBe(rows.length);
    expect(rows.length).toBe(expected.overdue);
    expect(summary.visible).toBeLessThan(summary.total);
    expect(summary.byStatus).toEqual(expected);
    expect(Object.values(summary.byStatus).reduce((a, b) => a + b, 0)).toBe(summary.total);
    expect(summary.duplicates).toBe(new Set(DUPS.map((d) => d.requestId)).size);
    expect(summary.duplicates).toBeGreaterThanOrEqual(1);

    const unfiltered = buildDocket(FILE, DUPS, DEFAULT_DOCKET_FILTERS).summary;
    expect(unfiltered.visible).toBe(unfiltered.total);
    expect(unfiltered.byStatus).toEqual(summary.byStatus);
  });

  it('attaches duplicateOf to flagged rows only', () => {
    const { rows } = buildDocket(FILE, DUPS, DEFAULT_DOCKET_FILTERS);
    expect(rows.find((r) => r.request.id === 'REQ-2026-0416')?.duplicateOf).toBe('REQ-2026-0411');
    expect(rows.find((r) => r.request.id === 'REQ-2026-0411')?.duplicateOf).toBeUndefined();
    expect(rows.filter((r) => r.duplicateOf !== undefined).length).toBe(new Set(DUPS.map((d) => d.requestId)).size);
  });

  it('assesses each request once and passes DeadlineOptions through to assessDeadline', () => {
    const spy = vi.mocked(assessDeadline);
    spy.mockClear();
    buildDocket(FILE, DUPS, DEFAULT_DOCKET_FILTERS, { atRiskDays: 10 });
    expect(spy).toHaveBeenCalledTimes(FILE.requests.length);
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ id: 'REQ-2026-0398' }), AS_OF, { atRiskDays: 10 });
    spy.mockClear();
    buildDocket(FILE, DUPS, DEFAULT_DOCKET_FILTERS);
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ id: 'REQ-2026-0398' }), AS_OF, undefined);
  });

  it('does not mutate the case file or the duplicate flags', () => {
    const frozen = deepFreeze(JSON.parse(JSON.stringify(FILE)) as CaseFile);
    const frozenDups = deepFreeze(JSON.parse(JSON.stringify(DUPS)) as typeof DUPS);
    const before = frozen.requests.map((r) => r.id);
    expect(() => buildDocket(frozen, frozenDups, filters({ sort: 'id', query: 'req' }))).not.toThrow();
    expect(frozen.requests.map((r) => r.id)).toEqual(before);
  });
});

describe('docketToCsv', () => {
  it('writes the fixed header and one CRLF-terminated record per row', () => {
    const { rows } = buildDocket(FILE, DUPS, DEFAULT_DOCKET_FILTERS);
    const csv = docketToCsv(rows);
    const lines = csv.split('\r\n');
    expect(lines[0]).toBe(CSV_HEADER);
    expect(csv.endsWith('\r\n')).toBe(true);
    expect(lines).toHaveLength(rows.length + 2); // header, rows, trailing empty string after the final CRLF
    expect(csv).not.toMatch(/[^\r]\n/);
    expect(lines).toContain('REQ-2026-0416,2026-09-16,EU-GDPR,access,received,on-track,2026-10-16,2026-10-16,15,false,REQ-2026-0411');
    expect(lines).toContain('REQ-2026-0402,2026-09-01,UK-GDPR,portability,collecting,on-track,2026-10-01,2026-12-01,61,true,');
  });

  it('quotes fields containing commas, quotes or line breaks and doubles embedded quotes', () => {
    const csv = docketToCsv(rowsOf([makeRequest({ id: 'REQ,1' }), makeRequest({ id: 'REQ "quoted"' }), makeRequest({ id: 'REQ\nline' }), makeRequest({ id: 'REQ\r\nboth' }), makeRequest({ id: 'plain' })]));
    const records = parseCsv(csv);
    expect(records.map((r) => r[0])).toEqual([CSV_HEADER.split(',')[0], 'REQ,1', 'REQ "quoted"', 'REQ\nline', 'REQ\r\nboth', 'plain']);
    expect(csv).toContain('\r\n"REQ,1",');
    expect(csv).toContain('\r\n"REQ ""quoted""",');
    expect(csv).toContain('\r\n"REQ\nline",');
    expect(csv).toContain('\r\nplain,');
  });

  it("prefixes text cells that start with = + - @ tab or CR with an apostrophe ('=SUM(1)' → \"'=SUM(1)\")", () => {
    const csv = docketToCsv(rowsOf([makeRequest({ id: '=SUM(1)' }), makeRequest({ id: '+1' }), makeRequest({ id: '-1' }), makeRequest({ id: '@cmd' }), makeRequest({ id: '\tx' }), makeRequest({ id: '\rx' }), makeRequest({ id: 'safe=1' })]));
    const records = csv.split('\r\n').slice(1, -1);
    expect(records[0]?.startsWith("'=SUM(1),")).toBe(true);
    expect(records[1]?.startsWith("'+1,")).toBe(true);
    expect(records[2]?.startsWith("'-1,")).toBe(true);
    expect(records[3]?.startsWith("'@cmd,")).toBe(true);
    expect(records[4]?.startsWith("'\tx,")).toBe(true);
    expect(csv).toContain('"\'\rx",'); // guarded first, then quoted because it contains a CR
    expect(records[6]?.startsWith('safe=1,')).toBe(true);
    expect(parseCsv(csv).map((r) => r[0])).toEqual(['id', "'=SUM(1)", "'+1", "'-1", "'@cmd", "'\tx", "'\rx", 'safe=1']);
  });

  it('guards the duplicateOf column too, but leaves engine-computed numbers such as a negative daysRemaining alone', () => {
    const hostile = rowsOf([makeRequest({ id: 'REQ-OK' })]).map((row) => ({ ...row, duplicateOf: '=HYPERLINK("x")' }));
    expect(parseCsv(docketToCsv(hostile))[1]?.[10]).toBe('\'=HYPERLINK("x")');

    const { rows } = buildDocket(FILE, DUPS, DEFAULT_DOCKET_FILTERS);
    const overdue = docketToCsv(rows).split('\r\n').find((line) => line.startsWith('REQ-2026-0398,'));
    const daysRemaining = overdue?.split(',')[8];
    expect(daysRemaining).toMatch(/^-\d+$/);
    expect(daysRemaining).toBe(String(assessDeadline(fixture('REQ-2026-0398'), AS_OF).daysRemaining));
  });

  it('round-trips any id through an RFC 4180 reader, apart from the guard apostrophe (property)', () => {
    fc.assert(
      fc.property(fc.oneof(fc.string({ unit: 'binary-ascii' }), fc.string({ unit: 'grapheme' })), (id) => {
        const records = parseCsv(docketToCsv(rowsOf([makeRequest({ id })])));
        const expected = /^[=+\-@\t\r]/.test(id) ? `'${id}` : id;
        return records.length === 2 && records[0]!.length === 11 && records[1]!.length === 11 && records[1]![0] === expected;
      }),
      { numRuns: 300 },
    );
  });
});
