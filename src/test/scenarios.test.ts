/**
 * Engine-only scenario tests (no React). They drive the real modules end to end the way App.tsx does —
 * transition context `${asOf}T12:00:00Z`, actor `analyst.demo`, audit detail = last history note or
 * `${from} → ${to}` — so a later UI journey can be checked against the same expectations.
 *
 * Most blocks are characterisation tests of behaviour that already exists and were green on first run
 * (stated honestly in workers/W09/REPORT.md). The block named "payload and attempt guards (lead finding
 * F8)" encodes the guard contract of PLAN §4.1 / §5 W02 plus lead finding F8; four of its cases were red
 * on the shared tree before W02 landed F8 (exact output in workers/W09/red-strict-guards.log).
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { ACTION_LABELS, STAGE_ACTIONS, availableActions, transition, type TransitionContext } from '../engine/workflow';
import { addCalendarDays, assessDeadline, maxExtensionDays, requestExtension, statutoryDueOn } from '../engine/deadline';
import { buildResponsePacket } from '../engine/reconcile';
import { appendEntry, verifyChain, type AuditInput } from '../engine/audit';
import { parseCaseFile, serializeCaseFile } from '../engine/casefile';
import { isTerminal, WorkflowError } from '../engine/types';
import type {
  Action,
  AuditEntry,
  Hold,
  HoldReason,
  IdentityCheck,
  Jurisdiction,
  RejectReason,
  RequestType,
  RightsRequest,
  Stage,
  Transition,
  WorkflowErrorCode,
} from '../engine/types';
import { AS_OF, REQUESTER_EMAIL, SYSTEMS, demoFile, makeCaseFile, makeHold, makeRequest, makeResult, passedIdentity } from './fixtures/build';
import { HOSTILE_SAMPLES, protoKeys } from './fixtures/hostile';

const AT = `${AS_OF}T12:00:00Z`;
const ACTOR = 'analyst.demo';
const ctx: TransitionContext = { at: AT, actor: ACTOR };
const SYSTEM_IDS = SYSTEMS.map((s) => s.id);
const ALL_ACTIONS = Object.keys(ACTION_LABELS) as Action[];
const HOLD_REASONS: HoldReason[] = ['legal-hold', 'ongoing-transaction', 'fraud-prevention', 'legal-obligation-retention', 'third-party-rights'];
const REJECT_REASONS: RejectReason[] = ['duplicate', 'manifestly-unfounded', 'identity-unverified', 'out-of-scope'];
const JURISDICTIONS: Jurisdiction[] = ['EU-GDPR', 'UK-GDPR', 'US-CA-CCPA'];
const TYPES: RequestType[] = ['access', 'erasure', 'rectification', 'portability', 'opt-out-sale'];
const NON_TERMINAL: Stage[] = ['received', 'identity-check', 'verified', 'collecting', 'review', 'response-ready'];
const PATH: Stage[] = ['received', 'identity-check', 'verified', 'collecting', 'review', 'response-ready'];
const PATH_ACTIONS: Action[] = ['start-identity-check', 'identity-passed', 'begin-collection', 'send-to-review', 'prepare-response'];

// ---------------------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------------------

function catchWorkflowError(fn: () => unknown): WorkflowError {
  try {
    fn();
  } catch (e) {
    if (e instanceof WorkflowError) return e;
    throw e;
  }
  throw new Error('expected a WorkflowError but nothing was thrown');
}

function expectCode(fn: () => unknown, code: WorkflowErrorCode, context?: string): WorkflowError {
  const err = catchWorkflowError(fn);
  expect(err.code, context ?? err.message).toBe(code);
  return err;
}

function withPayload(payload: unknown, note?: string): TransitionContext {
  return { ...ctx, ...(note ? { note } : {}), ...(payload !== undefined ? { payload } : {}) };
}

/** [] when the request imports with no errors and no warnings; otherwise the importer's complaints. */
function importProblems(request: RightsRequest): string[] {
  const parsed = parseCaseFile(serializeCaseFile(makeCaseFile({ requests: [request] })));
  if (!parsed.ok) return parsed.errors.map((e) => `error: ${e}`);
  return parsed.warnings.map((w) => `warning: ${w}`);
}

/** Plausible history for a request that reached `stage` along the canonical path (ends with to === stage). */
function canonicalHistory(stage: Stage): Transition[] {
  const idx = PATH.indexOf(stage);
  return PATH_ACTIONS.slice(0, idx).map((action, i) => ({
    at: `${AS_OF}T0${i}:00:00Z`,
    from: PATH[i]!,
    to: PATH[i + 1]!,
    action,
    actor: 'analyst.synthetic',
  }));
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

interface Step {
  action: Action;
  payload?: unknown;
  note?: string;
}

/** The happy path App.tsx walks: received → … → closed, with every system looked up and one justified hold. */
const LIFECYCLE: readonly Step[] = [
  { action: 'start-identity-check' },
  { action: 'identity-passed', note: 'Email loop completed (synthetic).' },
  { action: 'begin-collection' },
  {
    action: 'record-system-result',
    payload: makeResult('crm', {
      fields: [
        { name: 'displayName', value: 'Wren Example' },
        { name: 'agentNote', value: "Caller's neighbour Idris accepted the parcel.", thirdParty: true },
      ],
    }),
  },
  { action: 'record-system-result', payload: makeResult('billing') },
  { action: 'record-system-result', payload: makeResult('support', { found: false }) },
  { action: 'send-to-review' },
  { action: 'apply-hold', payload: makeHold('billing') },
  { action: 'prepare-response' },
  { action: 'close', note: 'Packet delivered through the simulated portal.' },
];

function runLifecycle(start: RightsRequest = makeRequest()): { request: RightsRequest; stages: Stage[] } {
  const stages: Stage[] = [];
  let request = start;
  for (const step of LIFECYCLE) {
    request = transition(request, step.action, withPayload(step.payload, step.note), SYSTEMS);
    stages.push(request.stage);
  }
  return { request, stages };
}

// ---------------------------------------------------------------------------------------------------
// (a) full lifecycle → packet → serialize → parse
// ---------------------------------------------------------------------------------------------------

describe('scenario: full lifecycle received → closed', () => {
  it('walks every stage in order and records one history entry per action', () => {
    const { request, stages } = runLifecycle();
    expect(stages).toEqual(['identity-check', 'verified', 'collecting', 'collecting', 'collecting', 'collecting', 'review', 'review', 'response-ready', 'closed']);
    expect(request.history).toHaveLength(LIFECYCLE.length);
    expect(request.history.map((t) => t.action)).toEqual(LIFECYCLE.map((s) => s.action));
    expect(request.history.every((t) => t.at === AT && t.actor === ACTOR)).toBe(true);
    expect(request.history[1]?.note).toBe('Email loop completed (synthetic).');
    expect(request.history[3]?.note).toBe('crm: record found');
    expect(request.history[5]?.note).toBe('support: no record');
    expect(request.history[7]?.note).toBe('legal-obligation-retention on billing');
    expect(request.identity).toEqual({ method: 'email-loop', attempts: 1, maxAttempts: 3, status: 'passed' });
    expect(request.closedOn).toBe(AS_OF);
    expect(request.rejectReason).toBeUndefined();
    expect(assessDeadline(request, AS_OF).status).toBe('closed');
  });

  it('is terminal afterwards: no available actions and every action is refused with INVALID_TRANSITION', () => {
    const { request } = runLifecycle();
    expect(isTerminal(request.stage)).toBe(true);
    expect(availableActions(request, SYSTEMS)).toEqual([]);
    for (const action of ALL_ACTIONS) {
      expectCode(() => transition(request, action, withPayload(makeResult('crm')), SYSTEMS), 'INVALID_TRANSITION', action);
    }
  });

  it('builds a partial packet: third-party field redacted, held system retained/excluded, empty lookup omitted; right-aware actions and summary pinned', () => {
    const { request } = runLifecycle();
    const packet = buildResponsePacket(request, AS_OF);
    expect(packet).toEqual({
      requestId: request.id,
      type: 'access',
      generatedOn: AS_OF,
      disclosures: [{ systemId: 'crm', recordId: 'crm-9001', fields: [{ name: 'displayName', value: 'Wren Example' }] }],
      redactions: [{ systemId: 'crm', field: 'agentNote', reason: 'third-party-data' }],
      exclusions: [{ systemId: 'billing', reason: 'legal-obligation-retention', note: 'Records retained under the synthetic fiscal retention rule.' }],
      conflicts: [],
      partial: true,
      actions: [
        { systemId: 'crm', action: 'disclose' },
        { systemId: 'billing', action: 'retain', reason: 'legal-obligation-retention' },
      ],
      summary: 'Access request: disclose 1 system, retain 1 system under legal-obligation-retention, 1 redaction (third-party data); partial response.',
    });
    expect(packet.summary).not.toMatch(/compliant|lawful/i);
  });

  it('round-trips through serializeCaseFile → parseCaseFile with deep equality, and a second pass is byte-identical', () => {
    const { request } = runLifecycle();
    const file = makeCaseFile({ requests: [request] });
    const once = parseCaseFile(serializeCaseFile(file));
    expect(once.ok).toBe(true);
    if (!once.ok) return;
    expect(once.warnings).toEqual([]);
    expect(once.file).toEqual(file);
    const twice = parseCaseFile(serializeCaseFile(once.file));
    expect(twice.ok).toBe(true);
    if (!twice.ok) return;
    expect(serializeCaseFile(twice.file)).toBe(serializeCaseFile(once.file));
  });

  it('can be rejected from every non-terminal stage, and only from those', () => {
    for (const stage of NON_TERMINAL) {
      const request = makeRequest({ stage, identity: stage === 'received' ? makeRequest().identity : passedIdentity(), history: canonicalHistory(stage) });
      const rejected = transition(request, 'reject', withPayload('out-of-scope', 'Outside the synthetic scope.'), SYSTEMS);
      expect(rejected.stage, stage).toBe('rejected');
      expect(rejected.rejectReason).toBe('out-of-scope');
      expect(rejected.history.at(-1)).toMatchObject({ from: stage, to: 'rejected', action: 'reject', note: 'Outside the synthetic scope.' });
      expect(availableActions(rejected, SYSTEMS)).toEqual([]);
      expect(importProblems(rejected), stage).toEqual([]);
    }
    for (const stage of ['closed', 'rejected'] as Stage[]) {
      expectCode(() => transition(makeRequest({ stage }), 'reject', withPayload('duplicate'), SYSTEMS), 'INVALID_TRANSITION', stage);
    }
    expectCode(() => transition(makeRequest(), 'reject', withPayload('because'), SYSTEMS), 'MISSING_REJECT_REASON');
  });
});

// ---------------------------------------------------------------------------------------------------
// (b) identity exhaustion
// ---------------------------------------------------------------------------------------------------

describe('scenario: identity exhaustion', () => {
  it('rejects with identity-unverified exactly on the maxAttempts-th failed attempt and never earlier', () => {
    for (const maxAttempts of [1, 2, 3, 5]) {
      let request = transition(
        makeRequest({ identity: { method: 'document-upload', attempts: 0, maxAttempts, status: 'not-started' } }),
        'start-identity-check',
        ctx,
        SYSTEMS,
      );
      expect(request.identity.status).toBe('pending');
      for (let n = 1; n < maxAttempts; n += 1) {
        request = transition(request, 'identity-failed', withPayload(undefined, `Attempt ${n} rejected (synthetic).`), SYSTEMS);
        expect(request.stage, `max ${maxAttempts}, attempt ${n}`).toBe('identity-check');
        expect(request.identity).toEqual({ method: 'document-upload', attempts: n, maxAttempts, status: 'pending' });
        expect(request.rejectReason).toBeUndefined();
        expect(request.history.at(-1)).toMatchObject({ from: 'identity-check', to: 'identity-check', action: 'identity-failed', note: `Attempt ${n} rejected (synthetic).` });
      }
      request = transition(request, 'identity-failed', ctx, SYSTEMS);
      expect(request.stage, `max ${maxAttempts}`).toBe('rejected');
      expect(request.rejectReason).toBe('identity-unverified');
      expect(request.identity).toEqual({ method: 'document-upload', attempts: maxAttempts, maxAttempts, status: 'failed' });
      expect(request.history).toHaveLength(maxAttempts + 1);
      expect(request.history.at(-1)).toMatchObject({
        from: 'identity-check',
        to: 'rejected',
        action: 'identity-failed',
        note: `Identity could not be verified after ${maxAttempts} attempts.`,
      });
      expect(availableActions(request, SYSTEMS)).toEqual([]);
      expectCode(() => transition(request, 'identity-passed', ctx, SYSTEMS), 'INVALID_TRANSITION');
      expectCode(() => transition(request, 'identity-failed', ctx, SYSTEMS), 'INVALID_TRANSITION');
      expect(importProblems(request)).toEqual([]);
    }
  });

  it('a pass after failed attempts counts as an attempt and unlocks collection', () => {
    let request = transition(makeRequest(), 'start-identity-check', ctx, SYSTEMS);
    request = transition(request, 'identity-failed', ctx, SYSTEMS);
    request = transition(request, 'identity-failed', ctx, SYSTEMS);
    expectCode(() => transition({ ...request, stage: 'verified' }, 'begin-collection', ctx, SYSTEMS), 'IDENTITY_NOT_VERIFIED');
    request = transition(request, 'identity-passed', ctx, SYSTEMS);
    expect(request.stage).toBe('verified');
    expect(request.identity).toEqual({ method: 'email-loop', attempts: 3, maxAttempts: 3, status: 'passed' });
    expect(transition(request, 'begin-collection', ctx, SYSTEMS).stage).toBe('collecting');
  });
});

// ---------------------------------------------------------------------------------------------------
// (c) extension accept / refuse chain
// ---------------------------------------------------------------------------------------------------

describe('scenario: extension accept, then every refusal in the chain', () => {
  // EU-GDPR received 2026-09-10 → statutory due 2026-10-10 → at most 61 further days (→ 2026-12-10).
  const fresh = () => makeRequest({ stage: 'collecting', identity: passedIdentity(), history: canonicalHistory('collecting') });
  const reason = 'Archived attachments across three systems (synthetic).';

  it('accepts one in-window extension, moves the effective due date and notes it', () => {
    const request = fresh();
    expect(statutoryDueOn(request)).toBe('2026-10-10');
    expect(maxExtensionDays(request)).toBe(61);
    const extended = requestExtension(request, { reason, notifiedOn: AS_OF });
    expect(extended.extension).toEqual({ days: 61, reason, notifiedOn: AS_OF });
    expect(extended.notes).toEqual([`Extension of 61 days recorded; requester notified on ${AS_OF}.`]);
    expect(extended.history).toEqual(request.history);
    const assessment = assessDeadline(extended, AS_OF);
    expect(assessment).toMatchObject({ statutoryDueOn: '2026-10-10', effectiveDueOn: '2026-12-10', extended: true, daysRemaining: 70, status: 'on-track' });
    expect(importProblems(extended)).toEqual([]);
  });

  it('refuses a second extension with ALREADY_EXTENDED', () => {
    const extended = requestExtension(fresh(), { reason, notifiedOn: AS_OF });
    expectCode(() => requestExtension(extended, { reason, notifiedOn: AS_OF, days: 1 }), 'ALREADY_EXTENDED');
  });

  it('refuses a notice dated after the initial window with EXTENSION_TOO_LATE and accepts the boundary day', () => {
    expectCode(() => requestExtension(fresh(), { reason, notifiedOn: '2026-10-11' }), 'EXTENSION_TOO_LATE');
    expect(requestExtension(fresh(), { reason, notifiedOn: '2026-10-10' }).extension?.notifiedOn).toBe('2026-10-10');
  });

  it('refuses more days than the profile allows with EXTENSION_TOO_LONG (GDPR 61, CCPA 45) and accepts the maximum', () => {
    expectCode(() => requestExtension(fresh(), { reason, notifiedOn: AS_OF, days: 62 }), 'EXTENSION_TOO_LONG');
    expect(requestExtension(fresh(), { reason, notifiedOn: AS_OF, days: 61 }).extension?.days).toBe(61);

    const ccpa = makeRequest({ jurisdiction: 'US-CA-CCPA', stage: 'collecting', identity: passedIdentity(), history: canonicalHistory('collecting') });
    expect(statutoryDueOn(ccpa)).toBe('2026-10-25');
    const tooLong = expectCode(() => requestExtension(ccpa, { reason, notifiedOn: AS_OF, days: 46 }), 'EXTENSION_TOO_LONG');
    expect(tooLong.message).toMatch(/45/);
    expect(assessDeadline(requestExtension(ccpa, { reason, notifiedOn: AS_OF, days: 45 }), AS_OF).effectiveDueOn).toBe('2026-12-09');
  });

  it('checks ALREADY_EXTENDED before anything else and EXTENSION_TOO_LONG before EXTENSION_TOO_LATE', () => {
    const extended = requestExtension(fresh(), { reason, notifiedOn: AS_OF });
    expectCode(() => requestExtension(extended, { reason, notifiedOn: '2030-01-01', days: 999 }), 'ALREADY_EXTENDED');
    expectCode(() => requestExtension(fresh(), { reason, notifiedOn: '2026-10-11', days: 999 }), 'EXTENSION_TOO_LONG');
    expectCode(() => requestExtension(fresh(), { reason: '   ', notifiedOn: '2026-10-11', days: 999 }), 'INVALID_EXTENSION_INPUT');
  });
});

// ---------------------------------------------------------------------------------------------------
// (d) audit chain over a journey
// ---------------------------------------------------------------------------------------------------

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** The documented canonical form (README "Audit chain"): SHA-256 over JSON[seq, at, actor, requestId, action, detail, prevHash]. */
function rehash(entry: Omit<AuditEntry, 'hash'>): Promise<string> {
  return sha256Hex(JSON.stringify([entry.seq, entry.at, entry.actor, entry.requestId, entry.action, entry.detail, entry.prevHash]));
}

function tamper(entry: AuditEntry, field: keyof AuditEntry): AuditEntry {
  const copy: Record<keyof AuditEntry, string | number> = { ...entry };
  copy[field] = field === 'seq' ? entry.seq + 1 : `${entry[field]} (edited)`;
  return copy as AuditEntry;
}

async function recordJourney(): Promise<{ log: AuditEntry[]; inputs: AuditInput[]; request: RightsRequest }> {
  let request = makeRequest();
  let log: AuditEntry[] = [];
  const inputs: AuditInput[] = [];
  const push = async (action: string, detail: string) => {
    const input: AuditInput = { at: `${AS_OF}T12:${String(inputs.length).padStart(2, '0')}:00Z`, actor: ACTOR, requestId: request.id, action, detail };
    inputs.push(input);
    log = await appendEntry(log, input);
  };
  for (const step of LIFECYCLE) {
    if (step.action === 'record-system-result' && request.systemResults.length === 0) {
      // Mirror App.tsx: a premature "Send to reviewer" is refused and the refusal is logged…
      const refusal = catchWorkflowError(() => transition(request, 'send-to-review', ctx, SYSTEMS));
      expect(refusal.code).toBe('MISSING_SYSTEM_RESULTS');
      await push('send-to-review (refused)', refusal.message);
      // …and an extension recorded mid-journey is logged too.
      request = requestExtension(request, { reason: 'Archive retrieval across systems (synthetic).', notifiedOn: AS_OF });
      await push('extension', `${request.extension?.days} days; notified ${AS_OF}`);
    }
    const next = transition(request, step.action, withPayload(step.payload, step.note), SYSTEMS);
    await push(step.action, next.history.at(-1)?.note ?? `${request.stage} → ${next.stage}`);
    request = next;
  }
  return { log, inputs, request };
}

describe('scenario: audit chain over a journey', () => {
  it('appends exactly one entry per action, refusal and extension, contiguously chained from GENESIS', async () => {
    const { log, inputs, request } = await recordJourney();
    expect(request.stage).toBe('closed');
    expect(inputs).toHaveLength(LIFECYCLE.length + 2);
    expect(log).toHaveLength(inputs.length);
    expect(log.map((e) => e.seq)).toEqual(inputs.map((_, i) => i + 1));
    expect(log[0]?.prevHash).toBe('GENESIS');
    for (let i = 1; i < log.length; i += 1) expect(log[i]?.prevHash).toBe(log[i - 1]?.hash);
    for (const [i, entry] of log.entries()) {
      expect(entry).toMatchObject(inputs[i]!);
      expect(entry.hash).toMatch(/^[0-9a-f]{64}$/);
      await expect(rehash(entry)).resolves.toBe(entry.hash);
    }
    expect(log.map((e) => e.action)).toEqual([
      'start-identity-check',
      'identity-passed',
      'begin-collection',
      'send-to-review (refused)',
      'extension',
      'record-system-result',
      'record-system-result',
      'record-system-result',
      'send-to-review',
      'apply-hold',
      'prepare-response',
      'close',
    ]);
    expect(log[0]?.detail).toBe('received → identity-check');
    expect(log[3]?.detail).toBe('Lookups still outstanding for: crm, billing, support.');
    expect(log[4]?.detail).toBe(`61 days; notified ${AS_OF}`);
    await expect(verifyChain(log)).resolves.toEqual({ valid: true });
  });

  it('detects tampering with ANY field at ANY index, reporting that index', async () => {
    const { log } = await recordJourney();
    const fields: Array<keyof AuditEntry> = ['detail', 'actor', 'seq', 'prevHash', 'at', 'requestId', 'action', 'hash'];
    for (let i = 0; i < log.length; i += 1) {
      for (const field of fields) {
        const tampered = log.map((e, j) => (j === i ? tamper(e, field) : e));
        await expect(verifyChain(tampered), `${field} at index ${i}`).resolves.toEqual({ valid: false, brokenAt: i + 1 });
      }
    }
  });

  it('detects a removed or swapped interior entry at the first position that no longer links', async () => {
    const { log } = await recordJourney();
    for (let i = 0; i < log.length - 1; i += 1) {
      const removed = log.filter((_, j) => j !== i);
      await expect(verifyChain(removed), `removed ${i}`).resolves.toEqual({ valid: false, brokenAt: i + 1 });
      const swapped = log.map((e, j) => (j === i ? log[i + 1]! : j === i + 1 ? log[i]! : e));
      await expect(verifyChain(swapped), `swapped ${i}`).resolves.toEqual({ valid: false, brokenAt: i + 1 });
    }
  });

  it('detects an interior entry that was edited and re-hashed at the next entry (its prevHash no longer links)', async () => {
    const { log } = await recordJourney();
    for (let i = 0; i < log.length - 1; i += 1) {
      const edited = { ...log[i]!, detail: 'rewritten' };
      const rehashed = [...log];
      rehashed[i] = { ...edited, hash: await rehash(edited) };
      await expect(verifyChain(rehashed), `re-hashed ${i}`).resolves.toEqual({ valid: false, brokenAt: i + 2 });
    }
  });

  it('CHARACTERISATION: truncating the tail, or editing and re-hashing the final entry, is not detectable by verifyChain alone', async () => {
    // Inherent to a hash chain without an external anchor (README: tamper-evident, not tamper-proof).
    const { log } = await recordJourney();
    await expect(verifyChain(log.slice(0, -3))).resolves.toEqual({ valid: true });
    const last = { ...log.at(-1)!, detail: 'rewritten' };
    const forged = [...log.slice(0, -1), { ...last, hash: await rehash(last) }];
    await expect(verifyChain(forged)).resolves.toEqual({ valid: true });
  });
});

// ---------------------------------------------------------------------------------------------------
// (e) model-based test of the state machine
// ---------------------------------------------------------------------------------------------------

interface HoldSpec {
  system: string;
  justified: boolean;
  released: boolean;
  reason: HoldReason;
}

interface RequestSpec {
  stage: Stage;
  jurisdiction: Jurisdiction;
  type: RequestType;
  daysBeforeAsOf: number;
  maxAttempts: number;
  failed: number;
  passedAtVerified: boolean;
  resultMask: boolean[];
  foundMask: boolean[];
  holdSpecs: HoldSpec[];
  extended: boolean;
}

function identityFor(spec: RequestSpec): IdentityCheck {
  const priorFailures = Math.min(spec.failed, spec.maxAttempts - 1);
  if (spec.stage === 'received') return { method: 'none', attempts: 0, maxAttempts: spec.maxAttempts, status: 'not-started' };
  if (spec.stage === 'identity-check' || (spec.stage === 'verified' && !spec.passedAtVerified)) {
    return { method: 'email-loop', attempts: priorFailures, maxAttempts: spec.maxAttempts, status: 'pending' };
  }
  return { method: 'email-loop', attempts: Math.min(priorFailures + 1, spec.maxAttempts), maxAttempts: spec.maxAttempts, status: 'passed' };
}

/** Builds an importer-valid, integrity-consistent, non-terminal request from a random spec. */
function buildRequest(spec: RequestSpec): RightsRequest {
  const receivedOn = addCalendarDays(AS_OF, -spec.daysBeforeAsOf);
  const withResults = spec.stage === 'collecting' || spec.stage === 'review' || spec.stage === 'response-ready';
  const withHolds = spec.stage === 'review' || spec.stage === 'response-ready';
  const systemResults = withResults
    ? SYSTEM_IDS.filter((_, i) => spec.resultMask[i]).map((id) => makeResult(id, { found: spec.foundMask[SYSTEM_IDS.indexOf(id)] ?? true, lookedUpAt: `${AS_OF}T05:00:00Z` }))
    : [];
  const holds: Hold[] = [];
  if (withHolds) {
    for (const [i, h] of spec.holdSpecs.entries()) {
      const activeOnSystem = holds.some((x) => x.systemId === h.system && !x.releasedAt);
      const released = h.released || activeOnSystem; // at most one active hold per system
      holds.push({
        id: `HOLD-${i + 1}`,
        systemId: h.system,
        reason: h.reason,
        note: h.justified ? 'Retention rule applies (synthetic).' : '',
        appliedAt: `${AS_OF}T06:00:00Z`,
        ...(released ? { releasedAt: `${AS_OF}T07:00:00Z` } : {}),
      });
    }
  }
  const base = makeRequest({
    id: 'REQ-2026-7001',
    receivedOn,
    jurisdiction: spec.jurisdiction,
    type: spec.type,
    stage: spec.stage,
    identity: identityFor(spec),
    systemResults,
    holds,
    history: canonicalHistory(spec.stage),
  });
  return spec.extended
    ? { ...base, extension: { days: Math.min(30, maxExtensionDays(base)), reason: 'Archive retrieval (synthetic).', notifiedOn: receivedOn } }
    : base;
}

const arbGenerated: fc.Arbitrary<RightsRequest> = fc
  .record<RequestSpec>({
    stage: fc.constantFrom(...NON_TERMINAL),
    jurisdiction: fc.constantFrom(...JURISDICTIONS),
    type: fc.constantFrom(...TYPES),
    daysBeforeAsOf: fc.integer({ min: 0, max: 60 }),
    maxAttempts: fc.integer({ min: 1, max: 5 }),
    failed: fc.integer({ min: 0, max: 4 }),
    passedAtVerified: fc.boolean(),
    resultMask: fc.array(fc.boolean(), { minLength: SYSTEM_IDS.length, maxLength: SYSTEM_IDS.length }),
    foundMask: fc.array(fc.boolean(), { minLength: SYSTEM_IDS.length, maxLength: SYSTEM_IDS.length }),
    holdSpecs: fc.array(
      fc.record<HoldSpec>({ system: fc.constantFrom(...SYSTEM_IDS), justified: fc.boolean(), released: fc.boolean(), reason: fc.constantFrom(...HOLD_REASONS) }),
      { maxLength: 3 },
    ),
    extended: fc.boolean(),
  })
  .map(buildRequest);

/** Fixture-like: either a generated request or one of the bundled fixture's open requests. */
const DEMO_OPEN = demoFile().requests.filter((r) => !isTerminal(r.stage));
const arbRequest: fc.Arbitrary<RightsRequest> = fc.oneof({ weight: 3, arbitrary: arbGenerated }, { weight: 1, arbitrary: fc.constantFrom(...DEMO_OPEN) });

interface Choice {
  pick: number;
  payload: number;
  found: boolean;
  reason: HoldReason;
  rejectReason: RejectReason;
}

const arbChoices: fc.Arbitrary<Choice[]> = fc.array(
  fc.record<Choice>({
    pick: fc.nat({ max: 1000 }),
    payload: fc.nat({ max: 1000 }),
    found: fc.boolean(),
    reason: fc.constantFrom(...HOLD_REASONS),
    rejectReason: fc.constantFrom(...REJECT_REASONS),
  }),
  { maxLength: 25 },
);

function freeSystems(request: RightsRequest): string[] {
  return SYSTEM_IDS.filter((id) => !request.holds.some((h) => h.systemId === id && !h.releasedAt));
}

function freshHoldId(request: RightsRequest): string {
  let n = request.holds.length + 1;
  while (request.holds.some((h) => h.id === `HOLD-${n}`)) n += 1;
  return `HOLD-${n}`;
}

/** Whether a payload exists that the intended guard table (incl. W02's DUPLICATE_HOLD) would accept. */
function hasValidPayload(request: RightsRequest, action: Action): boolean {
  if (action === 'apply-hold') return freeSystems(request).length > 0;
  if (action === 'release-hold') return request.holds.some((h) => !h.releasedAt);
  return true;
}

function payloadFor(request: RightsRequest, action: Action, choice: Choice): unknown {
  switch (action) {
    case 'record-system-result': {
      const missing = SYSTEM_IDS.filter((id) => !request.systemResults.some((r) => r.systemId === id));
      const pool = missing.length ? missing : SYSTEM_IDS;
      return makeResult(pool[choice.payload % pool.length]!, { found: choice.found, lookedUpAt: AT });
    }
    case 'apply-hold': {
      const free = freeSystems(request);
      return makeHold(free[choice.payload % free.length]!, { id: freshHoldId(request), reason: choice.reason, appliedAt: AT });
    }
    case 'release-hold': {
      const active = request.holds.filter((h) => !h.releasedAt);
      return active[choice.payload % active.length]!.id;
    }
    case 'reject':
      return choice.rejectReason;
    default:
      return undefined;
  }
}

/** A well-formed payload for probing a *blocked* action; the refusal must come from the guard, not the shape. */
function probePayloadFor(request: RightsRequest, action: Action): unknown {
  switch (action) {
    case 'record-system-result':
      return makeResult(SYSTEM_IDS[0]!, { lookedUpAt: AT });
    case 'apply-hold':
      return makeHold(SYSTEM_IDS[0]!, { id: freshHoldId(request), appliedAt: AT });
    case 'release-hold':
      return 'HOLD-missing';
    case 'reject':
      return 'duplicate';
    default:
      return undefined;
  }
}

/** Codes a blocked action may refuse with — the baseline's four guards plus the ones PLAN §5 W02 adds. */
const REFUSAL_CODES: Partial<Record<Action, WorkflowErrorCode[]>> = {
  'begin-collection': ['IDENTITY_NOT_VERIFIED'],
  'send-to-review': ['MISSING_SYSTEM_RESULTS'],
  'prepare-response': ['UNRESOLVED_HOLDS'],
  'release-hold': ['HOLD_NOT_FOUND'],
  'apply-hold': ['DUPLICATE_HOLD', 'UNKNOWN_SYSTEM'],
  'record-system-result': ['UNKNOWN_SYSTEM'],
  'identity-passed': ['IDENTITY_ATTEMPTS_EXHAUSTED'],
  'identity-failed': ['IDENTITY_ATTEMPTS_EXHAUSTED'],
  reject: ['MISSING_REJECT_REASON'],
};

describe('model-based: random sequences of enabled actions with valid payloads', () => {
  it('never throws, grows history by exactly one per step, never mutates its input, stays importable and ends absorbing', () => {
    fc.assert(
      fc.property(arbRequest, arbChoices, (initial, choices) => {
        let request = deepFreeze(initial);
        expect(importProblems(request), 'generated request must import cleanly').toEqual([]);
        let executed = 0;
        for (const choice of choices) {
          if (isTerminal(request.stage)) break;
          const availability = availableActions(request, SYSTEMS);
          expect(availability.map((a) => a.action)).toEqual(STAGE_ACTIONS[request.stage]);

          // ⇐ an action explained as blocked is really refused by transition(), with a guard code.
          for (const blocked of availability.filter((a) => !a.enabled)) {
            expect(blocked.blockedBecause, `${blocked.action} blocked without explanation`).toBeTruthy();
            const err = catchWorkflowError(() => transition(request, blocked.action, withPayload(probePayloadFor(request, blocked.action)), SYSTEMS));
            expect(REFUSAL_CODES[blocked.action] ?? [], `${blocked.action} from ${request.stage} refused with ${err.code}`).toContain(err.code);
          }

          // ⇒ an action explained as enabled succeeds with a valid payload.
          const candidates = availability.filter((a) => a.enabled && hasValidPayload(request, a.action));
          expect(candidates.length, `no executable action in ${request.stage}`).toBeGreaterThan(0);
          const action = candidates[choice.pick % candidates.length]!.action;
          const payload = payloadFor(request, action, choice);
          const before = JSON.stringify(request);
          const next = transition(request, action, withPayload(payload), SYSTEMS);
          const label = `${action} from ${request.stage}`;

          expect(JSON.stringify(request), `${label} mutated its input`).toBe(before);
          expect(next, label).not.toBe(request);
          expect(next.history, label).toHaveLength(request.history.length + 1);
          expect(next.history.at(-1), label).toMatchObject({ at: AT, from: request.stage, to: next.stage, action, actor: ACTOR });
          expect(next.history.slice(0, -1), label).toEqual(request.history);
          expect(STAGE_ACTIONS[request.stage], label).toContain(action);
          expect(
            { id: next.id, receivedOn: next.receivedOn, jurisdiction: next.jurisdiction, type: next.type, requester: next.requester, extension: next.extension },
            label,
          ).toEqual({ id: request.id, receivedOn: request.receivedOn, jurisdiction: request.jurisdiction, type: request.type, requester: request.requester, extension: request.extension });
          expect(isTerminal(next.stage), label).toBe(next.stage === 'closed' || next.stage === 'rejected');
          expect(() => availableActions(next, SYSTEMS), label).not.toThrow();
          expect(importProblems(next), `${label} produced a request the importer refuses`).toEqual([]);

          request = deepFreeze(next);
          executed += 1;
        }
        expect(request.history).toHaveLength(initial.history.length + executed);
        if (isTerminal(request.stage)) {
          expect(availableActions(request, SYSTEMS)).toEqual([]);
          for (const action of ALL_ACTIONS) {
            expectCode(() => transition(request, action, withPayload(probePayloadFor(request, action)), SYSTEMS), 'INVALID_TRANSITION', `${action} on ${request.stage}`);
          }
        }
      }),
      { numRuns: 200 },
    );
  });
});

// ---------------------------------------------------------------------------------------------------
// strict guard contract — PLAN §4.1 / §5 W02 and lead finding F8 (payload shapes, hold-id reuse,
// exhausted identity attempts). Plain `it` on purpose: nothing here is weakened or skipped; the four
// cases that were red before W02 landed F8 are documented verbatim in workers/W09/red-strict-guards.log.
// ---------------------------------------------------------------------------------------------------

const collecting = () => makeRequest({ stage: 'collecting', identity: passedIdentity(), history: canonicalHistory('collecting') });
const review = () =>
  makeRequest({
    stage: 'review',
    identity: passedIdentity(),
    systemResults: SYSTEM_IDS.map((id) => makeResult(id)),
    holds: [makeHold('billing')],
    history: canonicalHistory('review'),
  });

describe('payload and attempt guards (lead finding F8)', () => {
  it('record-system-result without a payload is refused with INVALID_PAYLOAD, not INVALID_TRANSITION', () => {
    expectCode(() => transition(collecting(), 'record-system-result', ctx, SYSTEMS), 'INVALID_PAYLOAD');
  });

  it('apply-hold without a payload is refused with INVALID_PAYLOAD, not INVALID_TRANSITION', () => {
    expectCode(() => transition(review(), 'apply-hold', ctx, SYSTEMS), 'INVALID_PAYLOAD');
  });

  it('a result for a system that is not a system of record is refused with UNKNOWN_SYSTEM', () => {
    expectCode(() => transition(collecting(), 'record-system-result', withPayload(makeResult('shadow-db')), SYSTEMS), 'UNKNOWN_SYSTEM');
  });

  it('a hold on a system that is not a system of record is refused with UNKNOWN_SYSTEM', () => {
    expectCode(() => transition(review(), 'apply-hold', withPayload(makeHold('shadow-db', { id: 'HOLD-shadow-1' })), SYSTEMS), 'UNKNOWN_SYSTEM');
  });

  it('a second active hold on a held system is refused with DUPLICATE_HOLD; after release it is allowed again', () => {
    expectCode(() => transition(review(), 'apply-hold', withPayload(makeHold('billing', { id: 'HOLD-billing-2' })), SYSTEMS), 'DUPLICATE_HOLD');
    const released = transition(review(), 'release-hold', withPayload('HOLD-billing-1'), SYSTEMS);
    const again = transition(released, 'apply-hold', withPayload(makeHold('billing', { id: 'HOLD-billing-2' })), SYSTEMS);
    expect(again.holds.filter((h) => !h.releasedAt).map((h) => h.id)).toEqual(['HOLD-billing-2']);
    expect(again.holds).toHaveLength(2);
  });

  it('a hold payload without a note is refused with INVALID_PAYLOAD instead of making availableActions throw a TypeError later', () => {
    const noNote: Omit<Hold, 'note'> = { id: 'HOLD-crm-9', systemId: 'crm', reason: 'legal-hold', appliedAt: AT };
    expectCode(() => transition(review(), 'apply-hold', withPayload(noNote), SYSTEMS), 'INVALID_PAYLOAD');
  });

  it('a result payload the importer would reject (no found, no lookedUpAt) is refused with INVALID_PAYLOAD', () => {
    expectCode(() => transition(collecting(), 'record-system-result', withPayload({ systemId: 'crm', fields: [] }), SYSTEMS), 'INVALID_PAYLOAD');
  });

  it('F8/W09-1: a hold id already used on the request is refused instead of silently replacing the earlier hold record', () => {
    const released = transition(review(), 'release-hold', withPayload('HOLD-billing-1'), SYSTEMS);
    const err = catchWorkflowError(() => transition(released, 'apply-hold', withPayload(makeHold('crm', { id: 'HOLD-billing-1' })), SYSTEMS));
    expect(['INVALID_PAYLOAD', 'DUPLICATE_HOLD']).toContain(err.code);
  });

  it('F8/W09-2: identity-passed with no attempts left is refused with IDENTITY_ATTEMPTS_EXHAUSTED (the code exists but is never thrown today)', () => {
    const exhausted = makeRequest({ stage: 'identity-check', identity: { method: 'email-loop', attempts: 3, maxAttempts: 3, status: 'pending' }, history: canonicalHistory('identity-check') });
    expectCode(() => transition(exhausted, 'identity-passed', ctx, SYSTEMS), 'IDENTITY_ATTEMPTS_EXHAUSTED');
  });

  const arbResultPayload = fc.record(
    {
      systemId: fc.constantFrom<unknown>(...SYSTEM_IDS, 'shadow-db', 7),
      found: fc.constantFrom<unknown>(true, false, 'yes'),
      fields: fc.constantFrom<unknown>([], [{ name: 'displayName', value: 'Wren Example' }], [{ name: 3 }], 'none'),
      lookedUpAt: fc.constantFrom<unknown>(AT, 12),
      recordId: fc.constantFrom<unknown>('crm-1', 9),
      subjectEmail: fc.constantFrom<unknown>(REQUESTER_EMAIL, 'other@people.example', 5),
    },
    { requiredKeys: [] },
  );

  it('F8/W09-3 property: record-system-result either refuses a payload with a WorkflowError or yields a request the importer accepts', () => {
    fc.assert(
      fc.property(arbResultPayload, (payload) => {
        let next: RightsRequest;
        try {
          next = transition(collecting(), 'record-system-result', withPayload(payload), SYSTEMS);
        } catch (e) {
          expect(e, `payload ${JSON.stringify(payload)} threw a non-WorkflowError`).toBeInstanceOf(WorkflowError);
          return;
        }
        expect(() => availableActions(next, SYSTEMS), `payload ${JSON.stringify(payload)}`).not.toThrow();
        expect(importProblems(next), `accepted payload ${JSON.stringify(payload)}`).toEqual([]);
      }),
      { numRuns: 200, seed: 20261004 },
    );
  });

  const arbHoldPayload = fc.record(
    {
      id: fc.constantFrom<unknown>('HOLD-new', 3),
      systemId: fc.constantFrom<unknown>(...SYSTEM_IDS, 'shadow-db', 1),
      reason: fc.constantFrom<unknown>(...HOLD_REASONS, 'because'),
      note: fc.constantFrom<unknown>('Retention rule (synthetic).', '', 42),
      appliedAt: fc.constantFrom<unknown>(AT, 0),
    },
    { requiredKeys: [] },
  );

  it('F8/W09-4 property: apply-hold either refuses a payload with a WorkflowError or adds exactly one importable hold with one active hold per system', () => {
    fc.assert(
      fc.property(arbHoldPayload, (payload) => {
        const start = review();
        let next: RightsRequest;
        try {
          next = transition(start, 'apply-hold', withPayload(payload), SYSTEMS);
        } catch (e) {
          expect(e, `payload ${JSON.stringify(payload)} threw a non-WorkflowError`).toBeInstanceOf(WorkflowError);
          return;
        }
        const label = `accepted payload ${JSON.stringify(payload)}`;
        expect(() => availableActions(next, SYSTEMS), label).not.toThrow();
        expect(next.holds, label).toHaveLength(start.holds.length + 1);
        const activeSystems = next.holds.filter((h) => !h.releasedAt).map((h) => h.systemId);
        expect(new Set(activeSystems).size, label).toBe(activeSystems.length);
        expect(importProblems(next), label).toEqual([]);
      }),
      { numRuns: 200, seed: 20261004 },
    );
  });
});

// ---------------------------------------------------------------------------------------------------
// hostile case files (exercises src/test/fixtures/hostile.ts)
// ---------------------------------------------------------------------------------------------------

describe('hostile case files are refused with a readable error, never an exception', () => {
  for (const sample of HOSTILE_SAMPLES) {
    it(`refuses ${sample.name}`, () => {
      let result: ReturnType<typeof parseCaseFile> | undefined;
      expect(() => {
        result = parseCaseFile(sample.text());
      }).not.toThrow();
      expect(result?.ok).toBe(false);
      if (result && !result.ok) {
        expect(result.errors.length).toBeGreaterThan(0);
        expect(result.errors.join(' ')).toMatch(sample.expect);
      }
    });
  }

  it('drops __proto__ and constructor keys without polluting Object.prototype', () => {
    const result = parseCaseFile(protoKeys());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.file)).toEqual(['schema', 'version', 'asOf', 'systems', 'requests']);
    expect(Object.keys(result.file.systems[0]!)).toEqual(['id', 'name', 'description']);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(Object.prototype, 'polluted')).toBe(false);
  });
});
