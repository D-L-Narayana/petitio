import { describe, expect, it } from 'vitest';
import { appendEntry, parseAuditLog, serializeAuditLog, verifyChain } from './audit';
import type { AuditEntry } from './types';

describe('hash-chained audit log', () => {
  it('links each entry to the previous hash and verifies', async () => {
    let log = await appendEntry([], { at: '2026-09-01T00:00:00Z', actor: 'a', requestId: 'R1', action: 'start-identity-check', detail: '' });
    log = await appendEntry(log, { at: '2026-09-01T00:01:00Z', actor: 'a', requestId: 'R1', action: 'identity-passed', detail: 'email loop' });
    expect(log).toHaveLength(2);
    expect(log[0]?.prevHash).toBe('GENESIS');
    expect(log[1]?.prevHash).toBe(log[0]?.hash);
    expect(log[1]?.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(await verifyChain(log)).toEqual({ valid: true });
  });

  it('detects a tampered detail field', async () => {
    let log = await appendEntry([], { at: '2026-09-01T00:00:00Z', actor: 'a', requestId: 'R1', action: 'x', detail: 'original' });
    log = await appendEntry(log, { at: '2026-09-01T00:01:00Z', actor: 'a', requestId: 'R1', action: 'y', detail: '' });
    const tampered = log.map((e, i) => (i === 0 ? { ...e, detail: 'edited' } : e));
    expect(await verifyChain(tampered)).toEqual({ valid: false, brokenAt: 1 });
  });

  it('detects a removed entry in the middle', async () => {
    let log = await appendEntry([], { at: 't1', actor: 'a', requestId: 'R1', action: 'x', detail: '' });
    log = await appendEntry(log, { at: 't2', actor: 'a', requestId: 'R1', action: 'y', detail: '' });
    log = await appendEntry(log, { at: 't3', actor: 'a', requestId: 'R1', action: 'z', detail: '' });
    const cut = [log[0]!, log[2]!];
    expect((await verifyChain(cut)).valid).toBe(false);
  });

  it('is deterministic for identical inputs', async () => {
    const a = await appendEntry([], { at: 't', actor: 'a', requestId: 'R', action: 'x', detail: 'd' });
    const b = await appendEntry([], { at: 't', actor: 'a', requestId: 'R', action: 'x', detail: 'd' });
    expect(a[0]?.hash).toBe(b[0]?.hash);
  });
});

async function sampleLog(n: number): Promise<AuditEntry[]> {
  let log: AuditEntry[] = [];
  for (let i = 1; i <= n; i += 1) {
    log = await appendEntry(log, { at: `2026-09-0${i}T00:00:00Z`, actor: 'analyst.demo', requestId: `R${i}`, action: 'x', detail: `d${i}` });
  }
  return log;
}

describe('audit log envelope (W03)', () => {
  it('serializes a petitio.auditlog v1 envelope as 2-space JSON and parses it back with legacy:false', async () => {
    const log = await sampleLog(3);
    const text = serializeAuditLog(log, '2026-10-04T12:00:00Z');
    expect(text).toBe(JSON.stringify({ schema: 'petitio.auditlog', version: 1, exportedAt: '2026-10-04T12:00:00Z', entries: log }, null, 2));
    const parsed = parseAuditLog(text);
    expect(parsed).toEqual({ ok: true, entries: log, legacy: false });
    if (parsed.ok) expect(await verifyChain(parsed.entries)).toEqual({ valid: true });
  });

  it('accepts a legacy bare-array export and flags it as legacy', async () => {
    const log = await sampleLog(2);
    const parsed = parseAuditLog(JSON.stringify(log, null, 2));
    expect(parsed).toEqual({ ok: true, entries: log, legacy: true });
  });

  it('copies only the known entry fields', async () => {
    const log = await sampleLog(1);
    const parsed = parseAuditLog(JSON.stringify([{ ...log[0]!, extra: 'dropped' }]));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.entries).toEqual(log);
      expect('extra' in parsed.entries[0]!).toBe(false);
    }
  });

  it('refuses oversized text before parsing, with the default and a custom byte limit', () => {
    const big = parseAuditLog('x'.repeat(2_000_001));
    expect(big.ok).toBe(false);
    if (!big.ok) expect(big.errors[0]).toMatch(/2,000,000 bytes/);
    const small = parseAuditLog('[]', { maxBytes: 1 });
    expect(small.ok).toBe(false);
  });

  it('refuses more entries than the limit, 10,000 by default', async () => {
    const log = await sampleLog(3);
    const r = parseAuditLog(JSON.stringify(log), { maxEntries: 2 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toMatch(/3 items; the limit is 2/);
    const many = Array.from({ length: 10_001 }, (_, i) => ({ ...log[0]!, seq: i + 1 }));
    const tooMany = parseAuditLog(JSON.stringify(many), { maxBytes: 50_000_000 });
    expect(tooMany.ok).toBe(false);
    if (!tooMany.ok) expect(tooMany.errors[0]).toMatch(/10,001 items; the limit is 10,000/);
  });

  it('rejects wrong types, malformed hashes, non-contiguous seq and foreign shapes with ok:false and never throws', async () => {
    const log = await sampleLog(3);
    const [a, , c] = log as [AuditEntry, AuditEntry, AuditEntry];
    const hostile: Array<[string, unknown]> = [
      ['seq as string', [{ ...a, seq: '1' }]],
      ['seq zero', [{ ...a, seq: 0 }]],
      ['seq fractional', [{ ...a, seq: 1.5 }]],
      ['non-contiguous seq', [a, c]],
      ['missing actor', [{ ...a, actor: undefined }]],
      ['detail as number', [{ ...a, detail: 7 }]],
      ['at as object', [{ ...a, at: { $date: 1 } }]],
      ['hash too short', [{ ...a, hash: a.hash.slice(1) }]],
      ['hash non-hex', [{ ...a, hash: 'g'.repeat(64) }]],
      ['hash upper-case hex', [{ ...a, hash: a.hash.toUpperCase() }]],
      ['hash as number', [{ ...a, hash: 1 }]],
      ['prevHash neither GENESIS nor hex', [{ ...a, prevHash: 'genesis' }]],
      ['entry null', [null]],
      ['entry array', [[]]],
      ['entries not an array', { schema: 'petitio.auditlog', version: 1, exportedAt: 'x', entries: {} }],
      ['wrong schema', { schema: 'petitio.casefile', version: 1, exportedAt: 'x', entries: [] }],
      ['wrong version', { schema: 'petitio.auditlog', version: 2, exportedAt: 'x', entries: [] }],
      ['exportedAt missing', { schema: 'petitio.auditlog', version: 1, entries: [] }],
      ['root string', 'hello'],
      ['root null', null],
      ['root number', 42],
    ];
    for (const [name, value] of hostile) {
      let r: ReturnType<typeof parseAuditLog> | undefined;
      expect(() => { r = parseAuditLog(JSON.stringify(value)); }, name).not.toThrow();
      expect(r?.ok, name).toBe(false);
      if (r && !r.ok) expect(r.errors.length, name).toBeGreaterThan(0);
    }
  });

  it('reports invalid JSON readably', () => {
    const r = parseAuditLog('{not json');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toMatch(/JSON/);
  });

  it('is shape-only: an edited but well-formed export parses, and verifyChain then locates the edit', async () => {
    const log = await sampleLog(3);
    const edited = log.map((e, i) => (i === 1 ? { ...e, detail: 'edited' } : e));
    const parsed = parseAuditLog(serializeAuditLog(edited, '2026-10-04T12:00:00Z'));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(await verifyChain(parsed.entries)).toEqual({ valid: false, brokenAt: 2 });
  });
});
