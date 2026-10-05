import { describe, expect, it } from 'vitest';
import demo from '../fixtures/demo-casefile.json';
import { parseCaseFile } from '../engine/casefile';
import type { CaseFile, SystemResult } from '../engine/types';
import { DEFAULT_FILTERS, initialSession, reduceSession, type ReduceResult, type SessionDeps, type SessionEvent, type SessionState } from './session';

function loadDemo(): CaseFile {
  const parsed = parseCaseFile(JSON.stringify(demo));
  if (!parsed.ok) throw new Error(`Bundled fixture failed validation: ${parsed.errors.join('; ')}`);
  return parsed.file;
}

const NOW = '2026-10-01T09:00:00.000Z';
const ACTOR = 'analyst.test';
const deps: SessionDeps = { actor: ACTOR, now: () => NOW };
const LOADED = 'Demo case file loaded. All data is synthetic; state lives in memory and resets on refresh.';

function session(selectedId: string | null = 'REQ-2026-0398', patch: Partial<SessionState> = {}): SessionState {
  return { ...initialSession(loadDemo(), selectedId), ...patch };
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

const supportResult: SystemResult = { systemId: 'support', found: false, fields: [], lookedUpAt: '2026-10-01T10:00:00Z' };

interface Case {
  name: string;
  start: () => SessionState;
  event: SessionEvent | ((start: SessionState) => SessionEvent);
  check: (result: ReduceResult, start: SessionState) => void;
}

const cases: Case[] = [
  {
    name: 'select: sets selectedId and clears the error',
    start: () => session('REQ-2026-0398', { error: 'MISSING_REJECT_REASON: stale' }),
    event: { type: 'select', id: 'REQ-2026-0415' },
    check: ({ state, audit }, start) => {
      expect(state.selectedId).toBe('REQ-2026-0415');
      expect(state.error).toBeNull();
      expect(state.file).toBe(start.file);
      expect(state.status).toBe(LOADED);
      expect(audit).toEqual([]);
    },
  },
  {
    name: 'filter: replaces the filters object',
    start: () => session(),
    event: { type: 'filter', filters: { ...DEFAULT_FILTERS, query: 'lark', sort: 'due' } },
    check: ({ state, audit }, start) => {
      expect(state.filters).toEqual({ jurisdiction: '', type: '', status: '', query: 'lark', sort: 'due' });
      expect(state.file).toBe(start.file);
      expect(audit).toEqual([]);
    },
  },
  {
    name: "set-as-of: '' is ignored (the date input clears to '' while typing)",
    start: () => session(),
    event: { type: 'set-as-of', asOf: '' },
    check: ({ state, audit }, start) => {
      expect(state).toBe(start);
      expect(state.file.asOf).toBe('2026-10-01');
      expect(audit).toEqual([]);
    },
  },
  {
    name: 'set-as-of: a date moves file.asOf and leaves requests/systems untouched',
    start: () => session(),
    event: { type: 'set-as-of', asOf: '2026-10-20' },
    check: ({ state, audit }, start) => {
      expect(state.file.asOf).toBe('2026-10-20');
      expect(state.file.requests).toBe(start.file.requests);
      expect(state.file.systems).toBe(start.file.systems);
      expect(audit).toEqual([]);
    },
  },
  {
    name: 'action: success replaces the request, writes the status, clears the error and audits the stage change',
    start: () => session('REQ-2026-0415', { error: 'INVALID_TRANSITION: stale' }),
    event: { type: 'action', request: { action: 'start-identity-check' } },
    check: ({ state, audit }, start) => {
      const next = state.file.requests.find((r) => r.id === 'REQ-2026-0415')!;
      expect(next.stage).toBe('identity-check');
      expect(next.history[next.history.length - 1]).toEqual({ at: '2026-10-01T12:00:00Z', from: 'received', to: 'identity-check', action: 'start-identity-check', actor: ACTOR });
      expect(state.status).toBe('REQ-2026-0415: start-identity-check recorded. Stage is now identity-check.');
      expect(state.error).toBeNull();
      expect(state.selectedId).toBe('REQ-2026-0415');
      expect(state.file.requests.filter((r) => r.id !== 'REQ-2026-0415')).toEqual(start.file.requests.filter((r) => r.id !== 'REQ-2026-0415'));
      expect(audit).toEqual([{ at: NOW, actor: ACTOR, requestId: 'REQ-2026-0415', action: 'start-identity-check', detail: 'received → identity-check' }]);
    },
  },
  {
    name: 'action: a note becomes the history note and the audit detail',
    start: () => session('REQ-2026-0415'),
    event: { type: 'action', request: { action: 'start-identity-check', note: 'Phoned the requester to agree the method.' } },
    check: ({ state, audit }) => {
      const next = state.file.requests.find((r) => r.id === 'REQ-2026-0415')!;
      expect(next.history[next.history.length - 1]?.note).toBe('Phoned the requester to agree the method.');
      expect(audit[0]?.detail).toBe('Phoned the requester to agree the method.');
    },
  },
  {
    name: 'action: the transition timestamp follows the as-of date set earlier in the session',
    start: () => reduceSession(session('REQ-2026-0415'), { type: 'set-as-of', asOf: '2026-10-20' }, deps).state,
    event: { type: 'action', request: { action: 'start-identity-check' } },
    check: ({ state }) => {
      const next = state.file.requests.find((r) => r.id === 'REQ-2026-0415')!;
      expect(next.history[next.history.length - 1]?.at).toBe('2026-10-20T12:00:00Z');
    },
  },
  {
    name: 'action: a payload reaches the engine and the engine-generated note is the audit detail',
    start: () => session('REQ-2026-0411'),
    event: { type: 'action', request: { action: 'record-system-result', payload: supportResult } },
    check: ({ state, audit }) => {
      const next = state.file.requests.find((r) => r.id === 'REQ-2026-0411')!;
      expect(next.stage).toBe('collecting');
      expect(next.systemResults.map((r) => r.systemId)).toEqual(['crm', 'billing', 'support']);
      expect(state.status).toBe('REQ-2026-0411: record-system-result recorded. Stage is now collecting.');
      expect(audit).toEqual([{ at: NOW, actor: ACTOR, requestId: 'REQ-2026-0411', action: 'record-system-result', detail: 'support: no record' }]);
    },
  },
  {
    name: 'action: a refusal sets "CODE: message", keeps the file and status, and audits "<action> (refused)"',
    start: () => session('REQ-2026-0411'),
    event: { type: 'action', request: { action: 'send-to-review' } },
    check: ({ state, audit }, start) => {
      expect(state.error).toBe('MISSING_SYSTEM_RESULTS: Lookups still outstanding for: support.');
      expect(state.file).toBe(start.file);
      expect(state.status).toBe(LOADED);
      expect(audit).toEqual([{ at: NOW, actor: ACTOR, requestId: 'REQ-2026-0411', action: 'send-to-review (refused)', detail: 'Lookups still outstanding for: support.' }]);
    },
  },
  {
    name: 'action: with no selected request it is a no-op with no audit entry',
    start: () => session(null),
    event: { type: 'action', request: { action: 'start-identity-check' } },
    check: ({ state, audit }, start) => {
      expect(state).toBe(start);
      expect(audit).toEqual([]);
    },
  },
  {
    name: 'extend: success records the extension, moves the due date in the status and audits "extension"',
    start: () => session('REQ-2026-0415', { error: 'EXTENSION_TOO_LATE: stale' }),
    event: { type: 'extend', input: { reason: 'Archived attachments must be restored.', notifiedOn: '2026-10-01', days: 30 } },
    check: ({ state, audit }) => {
      const next = state.file.requests.find((r) => r.id === 'REQ-2026-0415')!;
      expect(next.extension).toEqual({ days: 30, reason: 'Archived attachments must be restored.', notifiedOn: '2026-10-01' });
      expect(state.status).toBe('REQ-2026-0415: extension recorded; due date moved to 2026-11-14.');
      expect(state.error).toBeNull();
      expect(audit).toEqual([{ at: NOW, actor: ACTOR, requestId: 'REQ-2026-0415', action: 'extension', detail: '30 days; notified 2026-10-01' }]);
    },
  },
  {
    name: 'extend: omitted days default to the profile maximum (61 for GDPR) in status and audit detail',
    start: () => session('REQ-2026-0415'),
    event: { type: 'extend', input: { reason: 'Complex request.', notifiedOn: '2026-10-01' } },
    check: ({ state, audit }) => {
      expect(state.status).toBe('REQ-2026-0415: extension recorded; due date moved to 2026-12-15.');
      expect(audit[0]?.detail).toBe('61 days; notified 2026-10-01');
    },
  },
  {
    name: 'extend: a refusal sets "CODE: message", keeps the file and audits "extension (refused)"',
    start: () => session('REQ-2026-0402'),
    event: { type: 'extend', input: { reason: 'Again.', notifiedOn: '2026-10-01' } },
    check: ({ state, audit }, start) => {
      expect(state.error).toBe('ALREADY_EXTENDED: REQ-2026-0402 has already been extended once; the profile allows a single extension.');
      expect(state.file).toBe(start.file);
      expect(state.status).toBe(LOADED);
      expect(audit).toEqual([{ at: NOW, actor: ACTOR, requestId: 'REQ-2026-0402', action: 'extension (refused)', detail: 'REQ-2026-0402 has already been extended once; the profile allows a single extension.' }]);
    },
  },
  {
    name: 'extend (lead request, asOf guard): a notice dated after file.asOf is refused as INVALID_EXTENSION_INPUT and audited as "extension (refused)"',
    start: () => session('REQ-2026-0415'),
    event: { type: 'extend', input: { reason: 'Notice dated in the future.', notifiedOn: '2026-10-05', days: 10 } },
    check: ({ state, audit }, start) => {
      expect(state.file).toBe(start.file);
      expect(state.file.requests.find((r) => r.id === 'REQ-2026-0415')?.extension).toBeUndefined();
      expect(state.error).toMatch(/^INVALID_EXTENSION_INPUT: /);
      expect(state.error).toContain('2026-10-05');
      expect(state.status).toBe(LOADED);
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ at: NOW, actor: ACTOR, requestId: 'REQ-2026-0415', action: 'extension (refused)' });
      expect(audit[0]?.detail).toContain('2026-10-05');
    },
  },
  {
    name: 'extend (lead request, asOf guard): a notice dated on file.asOf itself is still accepted (boundary)',
    start: () => reduceSession(session('REQ-2026-0415'), { type: 'set-as-of', asOf: '2026-10-05' }, deps).state,
    event: { type: 'extend', input: { reason: 'Dated today.', notifiedOn: '2026-10-05', days: 10 } },
    check: ({ state, audit }) => {
      expect(state.file.requests.find((r) => r.id === 'REQ-2026-0415')?.extension?.notifiedOn).toBe('2026-10-05');
      expect(state.error).toBeNull();
      expect(state.status).toBe('REQ-2026-0415: extension recorded; due date moved to 2026-10-25.');
      expect(audit[0]?.action).toBe('extension');
    },
  },
  {
    name: 'extend: with no selected request it is a no-op with no audit entry',
    start: () => session(null),
    event: { type: 'extend', input: { reason: 'x', notifiedOn: '2026-10-01' } },
    check: ({ state, audit }, start) => {
      expect(state).toBe(start);
      expect(audit).toEqual([]);
    },
  },
  {
    name: 'import: without warnings replaces the file, selects the first request, clears the error and audits "import"',
    start: () => session('REQ-2026-0398', { error: 'HOLD_NOT_FOUND: stale', filters: { ...DEFAULT_FILTERS, query: 'keep me' } }),
    event: () => {
      const file = loadDemo();
      return { type: 'import', file: { ...file, asOf: '2026-11-01', requests: [...file.requests].reverse() }, warnings: [] };
    },
    check: ({ state, audit }) => {
      const imported = { ...loadDemo(), asOf: '2026-11-01' };
      const firstId = imported.requests[imported.requests.length - 1]!.id;
      expect(state.file.asOf).toBe('2026-11-01');
      expect(state.file.requests[0]?.id).toBe(firstId);
      expect(state.source).toBe('imported');
      expect(state.selectedId).toBe(firstId);
      expect(state.error).toBeNull();
      expect(state.filters.query).toBe('keep me');
      expect(state.status).toBe(`Imported ${imported.requests.length} requests across ${imported.systems.length} systems (as of 2026-11-01).`);
      expect(audit).toEqual([{ at: NOW, actor: ACTOR, requestId: '—', action: 'import', detail: `${imported.requests.length} requests` }]);
    },
  },
  {
    name: 'import: one warning is appended to the status',
    start: () => session(),
    event: { type: 'import', file: loadDemo(), warnings: ['REQ-2026-0411: result for unknown system "legacy"'] },
    check: ({ state }) => {
      const file = loadDemo();
      expect(state.status).toBe(`Imported ${file.requests.length} requests across ${file.systems.length} systems (as of 2026-10-01). 1 warning(s): REQ-2026-0411: result for unknown system "legacy"`);
    },
  },
  {
    name: 'import: four warnings keep the full count but list only the first three',
    start: () => session(),
    event: { type: 'import', file: loadDemo(), warnings: ['w1', 'w2', 'w3', 'w4'] },
    check: ({ state }) => {
      const file = loadDemo();
      expect(state.status).toBe(`Imported ${file.requests.length} requests across ${file.systems.length} systems (as of 2026-10-01). 4 warning(s): w1; w2; w3`);
    },
  },
  {
    name: 'import: a file with no requests selects nothing',
    start: () => session(),
    event: { type: 'import', file: { ...loadDemo(), requests: [] }, warnings: [] },
    check: ({ state, audit }) => {
      expect(state.selectedId).toBeNull();
      expect(state.status).toBe(`Imported 0 requests across ${loadDemo().systems.length} systems (as of 2026-10-01).`);
      expect(audit[0]?.detail).toBe('0 requests');
    },
  },
  {
    name: 'reset: installs the caller-provided demo file, source and selection, keeps filters, writes no audit entry',
    start: () => session('REQ-2026-0411', { source: 'imported', error: 'INVALID_TRANSITION: stale', status: 'Imported 1 requests across 1 systems (as of 2026-01-01).', filters: { ...DEFAULT_FILTERS, status: 'open' } }),
    event: () => ({ type: 'reset', file: loadDemo(), selectedId: 'REQ-2026-0398' }),
    check: ({ state, audit }) => {
      expect(state.file).toEqual(loadDemo());
      expect(state.source).toBe('demo');
      expect(state.selectedId).toBe('REQ-2026-0398');
      expect(state.error).toBeNull();
      expect(state.status).toBe('Demo case file reloaded.');
      expect(state.filters).toEqual({ ...DEFAULT_FILTERS, status: 'open' });
      expect(audit).toEqual([]);
    },
  },
];

describe('initialSession', () => {
  it('starts on the demo source with default filters, no error and the loaded status', () => {
    const file = loadDemo();
    expect(initialSession(file, 'REQ-2026-0398')).toEqual({ file, source: 'demo', selectedId: 'REQ-2026-0398', filters: DEFAULT_FILTERS, status: LOADED, error: null });
    expect(initialSession(file, null).selectedId).toBeNull();
    expect(DEFAULT_FILTERS).toEqual({ jurisdiction: '', type: '', status: '', query: '', sort: 'urgency' });
  });
});

describe('reduceSession (table-driven, strings byte-for-byte from App.tsx)', () => {
  // A plain loop rather than it.each so vitest prints the full case name instead of a 40-character excerpt.
  for (const { name, start, event, check } of cases) {
    it(name, () => {
      const before = start();
      const snapshot = JSON.stringify(before);
      const result = reduceSession(before, typeof event === 'function' ? event(before) : event, deps);
      expect(result.audit.length).toBeLessThanOrEqual(1);
      check(result, before);
      expect(JSON.stringify(before)).toBe(snapshot);
    });
  }

  it('never mutates its inputs: deep-frozen state and events reduce without throwing', () => {
    const file = loadDemo();
    let state = deepFreeze(initialSession(file, 'REQ-2026-0415'));
    const events: SessionEvent[] = deepFreeze([
      { type: 'set-as-of', asOf: '2026-10-02' },
      { type: 'action', request: { action: 'start-identity-check', note: 'frozen' } },
      { type: 'action', request: { action: 'identity-passed' } },
      { type: 'extend', input: { reason: 'frozen', notifiedOn: '2026-10-01', days: 10 } },
      { type: 'select', id: 'REQ-2026-0411' },
      { type: 'action', request: { action: 'record-system-result', payload: supportResult } },
      { type: 'action', request: { action: 'send-to-review' } },
      { type: 'filter', filters: { ...DEFAULT_FILTERS, sort: 'id' } },
      { type: 'import', file: { ...file, asOf: '2026-10-03' }, warnings: ['w'] },
      { type: 'reset', file, selectedId: 'REQ-2026-0398' },
    ]);
    const entries: string[] = [];
    expect(() => {
      for (const event of events) {
        const result = reduceSession(deepFreeze(state), event, deps);
        entries.push(...result.audit.map((a) => a.action));
        state = result.state;
      }
    }).not.toThrow();
    expect(entries).toEqual(['start-identity-check', 'identity-passed', 'extension', 'record-system-result', 'send-to-review', 'import']);
    expect(file.requests.find((r) => r.id === 'REQ-2026-0415')?.stage).toBe('received');
    expect(state.status).toBe('Demo case file reloaded.');
  });

  it('rethrows errors that are not WorkflowError instead of turning them into refusals', () => {
    const broken = { ...session('REQ-2026-0415'), file: { ...loadDemo(), asOf: 'not-a-date' } };
    expect(() => reduceSession(broken, { type: 'extend', input: { reason: 'x', notifiedOn: '2026-10-01', days: 10 } }, deps)).toThrow(RangeError);
  });
});
