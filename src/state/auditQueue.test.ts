/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { appendEntry, verifyChain, type AuditInput } from '../engine/audit';
import type { AuditEntry } from '../engine/types';
import { createAuditQueue } from './auditQueue';

const A: AuditInput = { at: '2026-10-01T09:00:00.000Z', actor: 'analyst.test', requestId: 'REQ-2026-0415', action: 'start-identity-check', detail: 'received → identity-check' };
const B: AuditInput = { ...A, at: '2026-10-01T09:00:01.000Z', action: 'identity-passed', detail: 'identity-check → verified' };
const C: AuditInput = { ...A, at: '2026-10-01T09:00:02.000Z', action: 'begin-collection', detail: 'verified → collecting' };

afterEach(() => vi.restoreAllMocks());

describe('the race in App.tsx (demonstration with raw appendEntry; passes before and after the fix)', () => {
  it('two appends that start before the first resolves both compute seq 1', async () => {
    const base: AuditEntry[] = [];
    const results = await Promise.all([appendEntry(base, A), appendEntry(base, B)]);
    expect(results.map((log) => log.map((e) => e.seq))).toEqual([[1], [1]]);
  });

  it('with App.tsx\'s "await appendEntry(log) then setLog" pattern the later write wins and one entry is silently lost', async () => {
    let log: AuditEntry[] = [];
    // Equivalent of `const audit = useCallback(async (...) => setLog(await appendEntry(log, ...)), [log])`.
    const audit = async (input: AuditInput) => {
      const next = await appendEntry(log, input);
      log = next;
    };
    await Promise.all([audit(A), audit(B)]);
    expect(log).toHaveLength(1);
    expect(log[0]?.seq).toBe(1);
    expect([A.action, B.action]).toContain(log[0]?.action);
    // The chain cannot notice: the lost entry was never linked into it.
    expect(await verifyChain(log)).toEqual({ valid: true });
  });
});

describe('createAuditQueue', () => {
  it('two pushes before the first resolves yield seq 1 and 2 in push order, a valid chain and no lost entry', async () => {
    const changes: AuditEntry[][] = [];
    const q = createAuditQueue((log) => changes.push(log));
    const first = q.push(A);
    const second = q.push(B);
    expect(q.current()).toEqual([]); // hashing is asynchronous; nothing is applied synchronously
    await Promise.all([first, second]);
    const log = q.current();
    expect(log.map((e) => [e.seq, e.action])).toEqual([[1, A.action], [2, B.action]]);
    expect(log[0]?.prevHash).toBe('GENESIS');
    expect(log[1]?.prevHash).toBe(log[0]?.hash);
    expect(await verifyChain(log)).toEqual({ valid: true });
    expect(changes.map((l) => l.length)).toEqual([1, 2]); // onChange after each append, in order
    expect(changes[1]).toBe(log);
  });

  it('applies many concurrent pushes strictly in push order', async () => {
    const q = createAuditQueue(() => undefined);
    const inputs = Array.from({ length: 25 }, (_, i) => ({ ...A, at: `2026-10-01T09:00:${String(i).padStart(2, '0')}.000Z`, action: `action-${i}` }));
    await Promise.all(inputs.map((input) => q.push(input)));
    expect(q.current().map((e) => e.seq)).toEqual(inputs.map((_, i) => i + 1));
    expect(q.current().map((e) => e.action)).toEqual(inputs.map((input) => input.action));
    expect(await verifyChain(q.current())).toEqual({ valid: true });
  });

  it('idle() resolves only after every queued append has been applied', async () => {
    const q = createAuditQueue(() => undefined);
    void q.push(A);
    void q.push(B);
    void q.push(C);
    expect(q.current()).toEqual([]);
    await q.idle();
    expect(q.current().map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(await verifyChain(q.current())).toEqual({ valid: true });
    await expect(q.idle()).resolves.toBeUndefined(); // a quiet queue is idle immediately
  });

  it('extends an initial log instead of restarting the chain', async () => {
    const existing = await appendEntry(await appendEntry([], A), B);
    const q = createAuditQueue(() => undefined, existing);
    expect(q.current()).toBe(existing);
    await q.push(C);
    expect(q.current().map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(q.current()[2]?.prevHash).toBe(existing[1]?.hash);
    expect(existing).toHaveLength(2); // the initial array is not mutated
    expect(await verifyChain(q.current())).toEqual({ valid: true });
  });

  it('push() resolves once its own entry is visible in current()', async () => {
    const q = createAuditQueue(() => undefined);
    await q.push(A);
    expect(q.current().map((e) => e.action)).toEqual([A.action]);
    await q.push(B);
    expect(q.current().map((e) => e.action)).toEqual([A.action, B.action]);
    expect(q.failures()).toBe(0);
  });

  describe('lead finding F1: appendEntry rejects (e.g. crypto.subtle unavailable in a non-secure context)', () => {
    it('reports the failure to onError, counts it, skips the entry without breaking the chain, and push() still resolves', async () => {
      const digest = vi.spyOn(crypto.subtle, 'digest').mockRejectedValueOnce(new TypeError('digest unavailable'));
      const errors: Array<{ error: unknown; input: AuditInput }> = [];
      const changes: AuditEntry[][] = [];
      const q = createAuditQueue((log) => changes.push(log), [], (error, input) => errors.push({ error, input }));
      const first = q.push(A);
      const second = q.push(B);
      await expect(first).resolves.toBeUndefined();
      await expect(second).resolves.toBeUndefined();
      expect(digest).toHaveBeenCalled();
      expect(errors).toHaveLength(1);
      expect(errors[0]?.input).toEqual(A);
      expect(errors[0]?.error).toBeInstanceOf(TypeError);
      expect((errors[0]?.error as Error).message).toBe('digest unavailable');
      expect(q.failures()).toBe(1);
      expect(q.current().map((e) => [e.seq, e.action])).toEqual([[1, B.action]]);
      expect(await verifyChain(q.current())).toEqual({ valid: true });
      expect(changes).toHaveLength(1); // onChange only for appends that were actually recorded
    });

    it('a failure in the middle keeps later seq numbers contiguous and in push order', async () => {
      const q = createAuditQueue(() => undefined, [], () => undefined);
      await q.push(A);
      vi.spyOn(crypto.subtle, 'digest').mockRejectedValueOnce(new TypeError('digest unavailable'));
      void q.push(B);
      void q.push(C);
      await q.idle();
      expect(q.current().map((e) => [e.seq, e.action])).toEqual([[1, A.action], [2, C.action]]);
      expect(q.failures()).toBe(1);
      expect(await verifyChain(q.current())).toEqual({ valid: true });
    });

    it('without an onError callback the failure is still counted and nothing throws', async () => {
      vi.spyOn(crypto.subtle, 'digest').mockRejectedValueOnce(new TypeError('digest unavailable'));
      const q = createAuditQueue(() => undefined);
      await expect(q.push(A)).resolves.toBeUndefined();
      expect(q.failures()).toBe(1);
      expect(q.current()).toEqual([]);
    });
  });
});

describe('purity (PLAN §2.6; not red-first — a static guard)', () => {
  it('session.ts and auditQueue.ts import nothing from React or the DOM', () => {
    for (const name of ['session.ts', 'auditQueue.ts']) {
      // vitest's jsdom environment does not map import.meta.url to the filesystem; vitest runs from the repo root.
      const source = readFileSync(resolve(process.cwd(), 'src/state', name), 'utf8');
      expect(source, name).not.toMatch(/from ['"]react/);
      expect(source, name).not.toMatch(/\b(?:document|window|localStorage|sessionStorage|indexedDB|fetch)\b/);
    }
  });
});
