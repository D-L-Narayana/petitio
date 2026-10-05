import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import demo from '../fixtures/demo-casefile.json';
import { parseCaseFile } from '../engine/casefile';
import { verifyChain } from '../engine/audit';
import type { CaseFile } from '../engine/types';
import { DEFAULT_FILTERS, type SessionDeps } from './session';
import { useSession } from './useSession';

function loadDemo(): CaseFile {
  const parsed = parseCaseFile(JSON.stringify(demo));
  if (!parsed.ok) throw new Error(`Bundled fixture failed validation: ${parsed.errors.join('; ')}`);
  return parsed.file;
}

const NOW = '2026-10-01T09:00:00.000Z';
const ACTOR = 'analyst.test';
const deps: SessionDeps = { actor: ACTOR, now: () => NOW };

function mount(selectedId: string | null = 'REQ-2026-0415') {
  const file = loadDemo();
  return renderHook(() => useSession(file, deps, selectedId));
}

afterEach(() => vi.restoreAllMocks());

describe('useSession', () => {
  it('starts from initialSession with an empty log, the selected request and no audit failures', () => {
    const { result } = mount('REQ-2026-0398');
    expect(result.current.state.source).toBe('demo');
    expect(result.current.state.selectedId).toBe('REQ-2026-0398');
    expect(result.current.state.filters).toEqual(DEFAULT_FILTERS);
    expect(result.current.state.error).toBeNull();
    expect(result.current.state.status).toBe('Demo case file loaded. All data is synthetic; state lives in memory and resets on refresh.');
    expect(result.current.log).toEqual([]);
    expect(result.current.selected?.id).toBe('REQ-2026-0398');
    expect(result.current.auditFailures).toBe(0);
  });

  it('two synchronous dispatches apply state in order and produce two chained entries with deterministic `at`', async () => {
    const { result } = mount();
    act(() => {
      result.current.dispatch({ type: 'action', request: { action: 'start-identity-check' } });
      result.current.dispatch({ type: 'action', request: { action: 'identity-passed' } });
    });
    // State is synchronous: the second action only succeeds because the first was already applied.
    expect(result.current.selected?.stage).toBe('verified');
    expect(result.current.state.status).toBe('REQ-2026-0415: identity-passed recorded. Stage is now verified.');
    expect(result.current.state.error).toBeNull();
    await act(async () => {
      await result.current.idle();
    });
    expect(result.current.log.map((e) => [e.seq, e.action, e.detail])).toEqual([
      [1, 'start-identity-check', 'received → identity-check'],
      [2, 'identity-passed', 'identity-check → verified'],
    ]);
    expect(result.current.log.map((e) => e.at)).toEqual([NOW, NOW]);
    expect(result.current.log.map((e) => e.actor)).toEqual([ACTOR, ACTOR]);
    expect(result.current.log.map((e) => e.requestId)).toEqual(['REQ-2026-0415', 'REQ-2026-0415']);
    expect(await verifyChain(result.current.log)).toEqual({ valid: true });
    expect(result.current.auditFailures).toBe(0);
  });

  it('a refusal sets the error, leaves the request unchanged and logs "<action> (refused)"', async () => {
    const { result } = mount('REQ-2026-0411');
    act(() => {
      result.current.dispatch({ type: 'action', request: { action: 'send-to-review' } });
    });
    expect(result.current.state.error).toBe('MISSING_SYSTEM_RESULTS: Lookups still outstanding for: support.');
    expect(result.current.selected?.stage).toBe('collecting');
    await act(async () => {
      await result.current.idle();
    });
    expect(result.current.log.map((e) => [e.seq, e.action, e.detail])).toEqual([[1, 'send-to-review (refused)', 'Lookups still outstanding for: support.']]);
  });

  it('select moves `selected`, clears the error and keeps a stable dispatch identity', async () => {
    const { result } = mount('REQ-2026-0411');
    const dispatch = result.current.dispatch;
    act(() => {
      result.current.dispatch({ type: 'action', request: { action: 'send-to-review' } });
    });
    expect(result.current.state.error).not.toBeNull();
    act(() => {
      result.current.dispatch({ type: 'select', id: 'REQ-2026-0398' });
    });
    expect(result.current.selected?.id).toBe('REQ-2026-0398');
    expect(result.current.state.error).toBeNull();
    expect(result.current.dispatch).toBe(dispatch);
    await act(async () => {
      await result.current.idle();
    });
  });

  it('import logs one "import" entry for requestId "—" and selects the first imported request', async () => {
    const { result } = mount();
    const file = loadDemo();
    const imported: CaseFile = { ...file, asOf: '2026-11-01', requests: [file.requests[1]!, file.requests[0]!] };
    act(() => {
      result.current.dispatch({ type: 'import', file: imported, warnings: ['w1', 'w2', 'w3', 'w4'] });
    });
    expect(result.current.state.source).toBe('imported');
    expect(result.current.selected?.id).toBe('REQ-2026-0398');
    expect(result.current.state.status).toBe('Imported 2 requests across 3 systems (as of 2026-11-01). 4 warning(s): w1; w2; w3');
    await act(async () => {
      await result.current.idle();
    });
    expect(result.current.log.map((e) => [e.seq, e.requestId, e.action, e.detail])).toEqual([[1, '—', 'import', '2 requests']]);
  });

  it('reset installs the caller-provided file without an audit entry; `selected` is null when nothing is selected', async () => {
    const { result } = mount();
    act(() => {
      result.current.dispatch({ type: 'import', file: { ...loadDemo(), requests: [] }, warnings: [] });
    });
    expect(result.current.selected).toBeNull();
    expect(result.current.state.selectedId).toBeNull();
    act(() => {
      result.current.dispatch({ type: 'reset', file: loadDemo(), selectedId: 'REQ-2026-0398' });
    });
    expect(result.current.state.source).toBe('demo');
    expect(result.current.state.status).toBe('Demo case file reloaded.');
    expect(result.current.selected?.id).toBe('REQ-2026-0398');
    await act(async () => {
      await result.current.idle();
    });
    expect(result.current.log.map((e) => e.action)).toEqual(['import']);
  });

  it('lead finding F1: a failed append raises auditFailures and an error while the reducer status still applies, and later entries continue', async () => {
    vi.spyOn(crypto.subtle, 'digest').mockRejectedValueOnce(new TypeError('digest unavailable'));
    const { result } = mount();
    act(() => {
      result.current.dispatch({ type: 'action', request: { action: 'start-identity-check' } });
    });
    await act(async () => {
      await result.current.idle();
    });
    expect(result.current.auditFailures).toBe(1);
    expect(result.current.state.error).toBe('Audit entry could not be recorded (start-identity-check on REQ-2026-0415): digest unavailable');
    expect(result.current.state.status).toBe('REQ-2026-0415: start-identity-check recorded. Stage is now identity-check.');
    expect(result.current.selected?.stage).toBe('identity-check');
    expect(result.current.log).toEqual([]);
    act(() => {
      result.current.dispatch({ type: 'action', request: { action: 'identity-passed' } });
    });
    expect(result.current.state.error).toBeNull(); // the next successful action clears the error channel as today
    await act(async () => {
      await result.current.idle();
    });
    expect(result.current.log.map((e) => [e.seq, e.action])).toEqual([[1, 'identity-passed']]);
    expect(await verifyChain(result.current.log)).toEqual({ valid: true });
    expect(result.current.auditFailures).toBe(1);
  });
});
