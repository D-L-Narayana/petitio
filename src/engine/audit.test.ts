import { describe, expect, it } from 'vitest';
import { appendEntry, verifyChain } from './audit';
import { parseCaseFile, serializeCaseFile } from './casefile';
import demo from '../fixtures/demo-casefile.json';

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

describe('case file import', () => {
  it('accepts the bundled demo fixture and round-trips through serialize', () => {
    const parsed = parseCaseFile(JSON.stringify(demo));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.file.requests.length).toBeGreaterThanOrEqual(6);
    expect(parsed.file.systems.map((s) => s.id)).toEqual(['crm', 'billing', 'support']);
    const again = parseCaseFile(serializeCaseFile(parsed.file));
    expect(again.ok).toBe(true);
  });

  it('rejects invalid JSON with a readable error', () => {
    const r = parseCaseFile('{not json');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors[0]).toMatch(/JSON/);
  });

  it('rejects files above the byte limit before parsing', () => {
    const r = parseCaseFile('x'.repeat(2_000_001), { maxBytes: 2_000_000 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors[0]).toMatch(/2,000,000 bytes/);
  });

  it('rejects the wrong schema marker and unknown enum values', () => {
    const bad = { ...demo, schema: 'other' };
    const r = parseCaseFile(JSON.stringify(bad));
    expect(r.ok).toBe(false);
    const badStage = { ...demo, requests: [{ ...demo.requests[0], stage: 'teleported' }] };
    const r2 = parseCaseFile(JSON.stringify(badStage));
    expect(r2.ok).toBe(false);
    if (r2.ok) return;
    expect(r2.errors.join(' ')).toMatch(/stage/);
  });

  it('rejects too many requests and excessive nesting', () => {
    const many = { ...demo, requests: Array.from({ length: 501 }, (_, i) => ({ ...demo.requests[0], id: `R${i}` })) };
    expect(parseCaseFile(JSON.stringify(many)).ok).toBe(false);
    let deep: unknown = 'leaf';
    for (let i = 0; i < 20; i += 1) deep = { deep };
    const nested = { ...demo, requests: [{ ...demo.requests[0], notes: [JSON.stringify(deep)], requester: { ...demo.requests[0]!.requester, extra: deep } }] };
    const r = parseCaseFile(JSON.stringify(nested));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.join(' ')).toMatch(/nesting/i);
  });

  it('rejects duplicate request ids and malformed dates', () => {
    const dup = { ...demo, requests: [demo.requests[0], demo.requests[0]] };
    const r = parseCaseFile(JSON.stringify(dup));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(' ')).toMatch(/duplicate/i);
    const badDate = { ...demo, requests: [{ ...demo.requests[0], receivedOn: '01/09/2026' }] };
    const r2 = parseCaseFile(JSON.stringify(badDate));
    expect(r2.ok).toBe(false);
  });

  it('strips unknown top-level and request-level properties instead of carrying them along', () => {
    const extra = { ...demo, mystery: true, requests: [{ ...demo.requests[0], mystery: 1 }] };
    const r = parseCaseFile(JSON.stringify(extra));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect('mystery' in r.file).toBe(false);
    expect('mystery' in r.file.requests[0]!).toBe(false);
  });
});

describe('hostile nesting (review finding)', () => {
  it('returns a validation error, not a RangeError, for 20,000 nested arrays inside the byte limit', () => {
    const deep = '['.repeat(20_000) + ']'.repeat(20_000);
    const text = `{"schema":"petitio.casefile","version":1,"asOf":"2026-10-01","systems":[],"requests":[],"extra":${deep}}`;
    let result: ReturnType<typeof parseCaseFile> | undefined;
    expect(() => { result = parseCaseFile(text); }).not.toThrow();
    expect(result?.ok).toBe(false);
    if (result && !result.ok) expect(result.errors[0]).toMatch(/nesting deeper than 8/i);
  });
});

describe('strict dates (review finding)', () => {
  it('rejects impossible calendar dates that match the YYYY-MM-DD pattern', () => {
    const bad = { ...demo, requests: [{ ...demo.requests[0], receivedOn: '2026-02-30' }] };
    const r = parseCaseFile(JSON.stringify(bad));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(' ')).toMatch(/receivedOn/);
    expect(parseCaseFile(JSON.stringify({ ...demo, asOf: '2026-99-99' })).ok).toBe(false);
  });
});

describe('imported extensions obey the same guards as requestExtension (sixth-Fable finding)', () => {
  const withExt = (ext: Record<string, unknown>, pick?: (r: typeof demo.requests[number]) => boolean) => {
    const file = JSON.parse(JSON.stringify(demo)) as typeof demo;
    const r = file.requests.find(pick ?? ((x) => x.jurisdiction === 'EU-GDPR' && !x.extension && x.stage !== 'closed'))!;
    (r as unknown as Record<string, unknown>)['extension'] = ext;
    return { text: JSON.stringify(file), r };
  };
  it('rejects a 300-day extension on a GDPR request and names the field and the maximum', () => {
    const { text, r } = withExt({ days: 300, reason: 'imported', notifiedOn: '2026-09-02' }, (x) => x.id === 'REQ-2026-0001' || (x.jurisdiction === 'EU-GDPR' && !x.extension && x.stage !== 'closed'));
    const res = parseCaseFile(text);
    expect(res.ok).toBe(false);
    if (!res.ok) { const msg = res.errors.join(' '); expect(msg).toContain(r.id); expect(msg).toContain('extension.days'); expect(msg).toMatch(/61-day maximum/); }
  });
  it('rejects a notice dated before receipt, after the initial window, a blank reason and a non-integer day count', () => {
    const base = demo.requests.find((x) => x.jurisdiction === 'EU-GDPR' && !x.extension && x.stage !== 'closed')!;
    expect(parseCaseFile(withExt({ days: 30, reason: 'x', notifiedOn: '2020-01-01' }).text).ok).toBe(false);
    expect(parseCaseFile(withExt({ days: 30, reason: 'x', notifiedOn: '2030-01-01' }).text).ok).toBe(false);
    expect(parseCaseFile(withExt({ days: 30, reason: '   ', notifiedOn: base.receivedOn }).text).ok).toBe(false);
    expect(parseCaseFile(withExt({ days: 30.5, reason: 'x', notifiedOn: base.receivedOn }).text).ok).toBe(false);
  });
  it('still accepts an extension within the profile maximum and round-trips it', () => {
    const base = demo.requests.find((x) => x.jurisdiction === 'EU-GDPR' && !x.extension && x.stage !== 'closed')!;
    const res = parseCaseFile(withExt({ days: 30, reason: 'complex request', notifiedOn: base.receivedOn }).text);
    expect(res.ok).toBe(true);
    if (res.ok) expect(parseCaseFile(serializeCaseFile(res.file)).ok).toBe(true);
  });
});

describe('cross-field extension arithmetic only runs on valid inputs (regression)', () => {
  const file = () => JSON.parse(JSON.stringify(demo)) as typeof demo;
  const first = (f: typeof demo) => f.requests[0] as unknown as Record<string, unknown>;
  it('an invalid jurisdiction with an extension returns ok:false instead of throwing', () => {
    const f = file(); first(f)['extension'] = { days: 1, reason: 'test', notifiedOn: '2026-10-01' }; first(f)['jurisdiction'] = 'INVALID';
    let r!: ReturnType<typeof parseCaseFile>;
    expect(() => { r = parseCaseFile(JSON.stringify(f)); }).not.toThrow();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(' ')).toMatch(/jurisdiction/);
  });
  it('an inherited object-property name as jurisdiction (constructor, toString, __proto__) returns ok:false instead of throwing', () => {
    for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      const f = file(); first(f)['extension'] = { days: 1, reason: 'test', notifiedOn: '2026-10-01' }; first(f)['jurisdiction'] = name;
      let r!: ReturnType<typeof parseCaseFile>;
      expect(() => { r = parseCaseFile(JSON.stringify(f)); }, name).not.toThrow();
      expect(r.ok, name).toBe(false);
    }
  });
  it('a malformed receivedOn or notifiedOn with an extension returns ok:false instead of throwing', () => {
    const a = file(); first(a)['extension'] = { days: 1, reason: 'test', notifiedOn: '2026-10-01' }; first(a)['receivedOn'] = 'garbage';
    const b = file(); first(b)['extension'] = { days: 1, reason: 'test', notifiedOn: 'next week' };
    const c = file(); first(c)['extension'] = { days: 1, reason: 'test', notifiedOn: '2026-02-30' };
    for (const f of [a, b, c]) {
      let r!: ReturnType<typeof parseCaseFile>;
      expect(() => { r = parseCaseFile(JSON.stringify(f)); }).not.toThrow();
      expect(r.ok).toBe(false);
    }
  });
});
