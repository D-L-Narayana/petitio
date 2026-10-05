import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { ACTION_LABELS, availableActions, explainAction, GUARDS, STAGE_ACTIONS, transition } from './workflow';
import type { Action, Hold, HoldReason, RejectReason, RightsRequest, Stage, SystemOfRecord, SystemResult } from './types';
import { WorkflowError } from './types';

const systems: SystemOfRecord[] = [
  { id: 'crm', name: 'CRM', description: 'profiles' },
  { id: 'billing', name: 'Billing', description: 'invoices' },
];

function req(overrides: Partial<RightsRequest> = {}): RightsRequest {
  return {
    id: 'REQ-9',
    receivedOn: '2026-09-01',
    jurisdiction: 'EU-GDPR',
    type: 'erasure',
    requester: { pseudonym: 'subject-z', email: 'z@people.example' },
    stage: 'received',
    identity: { method: 'email-loop', attempts: 0, maxAttempts: 3, status: 'not-started' },
    holds: [],
    systemResults: [],
    history: [],
    notes: [],
    ...overrides,
  };
}

const ctx = { at: '2026-09-02T09:00:00Z', actor: 'analyst.one' };

function result(systemId: string): SystemResult {
  return { systemId, found: true, recordId: `${systemId}-1`, fields: [], lookedUpAt: ctx.at };
}

function expectCode(fn: () => unknown, code: string) {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(WorkflowError);
    expect((e as WorkflowError).code).toBe(code);
    return;
  }
  throw new Error(`expected WorkflowError ${code}`);
}

describe('transition', () => {
  it('moves received -> identity-check and records history', () => {
    const next = transition(req(), 'start-identity-check', ctx, systems);
    expect(next.stage).toBe('identity-check');
    expect(next.identity.status).toBe('pending');
    expect(next.history).toHaveLength(1);
    expect(next.history[0]).toMatchObject({ from: 'received', to: 'identity-check', actor: 'analyst.one' });
  });

  it('does not mutate the input request', () => {
    const original = req();
    transition(original, 'start-identity-check', ctx, systems);
    expect(original.stage).toBe('received');
    expect(original.history).toHaveLength(0);
  });

  it('rejects an action that is not valid for the current stage', () => {
    expectCode(() => transition(req(), 'prepare-response', ctx, systems), 'INVALID_TRANSITION');
  });

  it('a failed identity attempt stays in identity-check and counts the attempt', () => {
    const pending = transition(req(), 'start-identity-check', ctx, systems);
    const failed = transition(pending, 'identity-failed', ctx, systems);
    expect(failed.stage).toBe('identity-check');
    expect(failed.identity.attempts).toBe(1);
    expect(failed.identity.status).toBe('pending');
  });

  it('exhausting identity attempts rejects the request with identity-unverified', () => {
    let r = transition(req(), 'start-identity-check', ctx, systems);
    r = transition(r, 'identity-failed', ctx, systems);
    r = transition(r, 'identity-failed', ctx, systems);
    r = transition(r, 'identity-failed', ctx, systems);
    expect(r.stage).toBe('rejected');
    expect(r.rejectReason).toBe('identity-unverified');
    expect(r.identity.status).toBe('failed');
  });

  it('cannot begin collection without a verified identity', () => {
    expectCode(() => transition(req({ stage: 'verified', identity: { method: 'none', attempts: 0, maxAttempts: 3, status: 'not-started' } }), 'begin-collection', ctx, systems), 'IDENTITY_NOT_VERIFIED');
  });

  it('records a system result and replaces a previous result for the same system', () => {
    let r = req({ stage: 'collecting', identity: { method: 'email-loop', attempts: 1, maxAttempts: 3, status: 'passed' } });
    r = transition(r, 'record-system-result', { ...ctx, payload: result('crm') }, systems);
    r = transition(r, 'record-system-result', { ...ctx, payload: { ...result('crm'), recordId: 'crm-2' } }, systems);
    expect(r.systemResults).toHaveLength(1);
    expect(r.systemResults[0]?.recordId).toBe('crm-2');
  });

  it('refuses to send to review until every system of record has been looked up', () => {
    let r = req({ stage: 'collecting', identity: { method: 'email-loop', attempts: 1, maxAttempts: 3, status: 'passed' } });
    r = transition(r, 'record-system-result', { ...ctx, payload: result('crm') }, systems);
    expectCode(() => transition(r, 'send-to-review', ctx, systems), 'MISSING_SYSTEM_RESULTS');
    r = transition(r, 'record-system-result', { ...ctx, payload: result('billing') }, systems);
    expect(transition(r, 'send-to-review', ctx, systems).stage).toBe('review');
  });

  it('a hold without a written justification blocks the response', () => {
    let r = req({ stage: 'review', identity: { method: 'email-loop', attempts: 1, maxAttempts: 3, status: 'passed' }, systemResults: [result('crm'), result('billing')] });
    r = transition(r, 'apply-hold', { ...ctx, payload: { id: 'H1', systemId: 'billing', reason: 'legal-obligation-retention', note: '', appliedAt: ctx.at } }, systems);
    expectCode(() => transition(r, 'prepare-response', ctx, systems), 'UNRESOLVED_HOLDS');
  });

  it('a justified hold allows a (partial) response', () => {
    let r = req({ stage: 'review', identity: { method: 'email-loop', attempts: 1, maxAttempts: 3, status: 'passed' }, systemResults: [result('crm'), result('billing')] });
    r = transition(r, 'apply-hold', { ...ctx, payload: { id: 'H1', systemId: 'billing', reason: 'legal-obligation-retention', note: 'Invoices retained 7 years under tax rules (synthetic).', appliedAt: ctx.at } }, systems);
    expect(transition(r, 'prepare-response', ctx, systems).stage).toBe('response-ready');
  });

  it('releasing an unknown hold fails loudly', () => {
    const r = req({ stage: 'review', identity: { method: 'email-loop', attempts: 1, maxAttempts: 3, status: 'passed' } });
    expectCode(() => transition(r, 'release-hold', { ...ctx, payload: 'nope' }, systems), 'HOLD_NOT_FOUND');
  });

  it('closing sets closedOn from the context timestamp', () => {
    const r = transition(req({ stage: 'response-ready' }), 'close', ctx, systems);
    expect(r.stage).toBe('closed');
    expect(r.closedOn).toBe('2026-09-02');
  });

  it('reject requires a reason and is terminal', () => {
    expectCode(() => transition(req(), 'reject', ctx, systems), 'MISSING_REJECT_REASON');
    const rejected = transition(req(), 'reject', { ...ctx, payload: 'duplicate' }, systems);
    expect(rejected.stage).toBe('rejected');
    expectCode(() => transition(rejected, 'start-identity-check', ctx, systems), 'INVALID_TRANSITION');
  });
});

describe('availableActions', () => {
  it('explains why blocked actions are blocked', () => {
    const r = req({ stage: 'collecting', identity: { method: 'email-loop', attempts: 1, maxAttempts: 3, status: 'passed' } });
    const actions = availableActions(r, systems);
    const review = actions.find((a) => a.action === 'send-to-review');
    expect(review?.enabled).toBe(false);
    expect(review?.blockedBecause).toMatch(/crm, billing/);
    expect(actions.find((a) => a.action === 'record-system-result')?.enabled).toBe(true);
    expect(actions.find((a) => a.action === 'close')).toBeUndefined();
  });

  it('offers nothing for terminal stages', () => {
    expect(availableActions(req({ stage: 'closed' }), systems)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------
// Guard table (W02). Helpers below are shared by the new describe blocks only; the 15 tests above are unchanged.
// ---------------------------------------------------------------------------------------------------------

const passed: RightsRequest['identity'] = { method: 'email-loop', attempts: 1, maxAttempts: 3, status: 'passed' };

function hold(id: string, systemId: string, note = 'Retained under a synthetic retention rule.', extra: Partial<Hold> = {}): Hold {
  return { id, systemId, reason: 'legal-obligation-retention', note, appliedAt: ctx.at, ...extra };
}

/** A request in review with every system looked up, so hold/response guards are the only thing in the way. */
function inReview(overrides: Partial<RightsRequest> = {}): RightsRequest {
  return req({ stage: 'review', identity: passed, systemResults: [result('crm'), result('billing')], ...overrides });
}

/** Returns the WorkflowError a call throws, or undefined when it succeeds; anything else propagates. */
function refusal(fn: () => unknown): WorkflowError | undefined {
  try {
    fn();
    return undefined;
  } catch (e) {
    if (e instanceof WorkflowError) return e;
    throw e;
  }
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const inner of Object.values(value)) deepFreeze(inner);
  }
  return value;
}

describe('guard UNKNOWN_SYSTEM', () => {
  it('record-system-result refuses a result for a system the case file does not know, naming it and the known systems', () => {
    const r = req({ stage: 'collecting', identity: passed });
    const e = refusal(() => transition(r, 'record-system-result', { ...ctx, payload: result('warehouse') }, systems));
    expect(e?.code).toBe('UNKNOWN_SYSTEM');
    expect(e?.message).toContain('warehouse');
    expect(e?.message).toContain('crm');
    expect(e?.message).toContain('billing');
    expect(explainAction(r, 'record-system-result', systems, result('warehouse'))).toMatchObject({ enabled: false, code: 'UNKNOWN_SYSTEM', blockedBecause: e?.message });
  });

  it('record-system-result accepts a result for a known system', () => {
    const r = req({ stage: 'collecting', identity: passed });
    expect(explainAction(r, 'record-system-result', systems, result('billing'))).toEqual({ action: 'record-system-result', label: 'Record system result', enabled: true });
    expect(transition(r, 'record-system-result', { ...ctx, payload: result('billing') }, systems).systemResults.map((x) => x.systemId)).toEqual(['billing']);
  });

  it('apply-hold refuses a hold on an unknown system', () => {
    const r = inReview();
    const e = refusal(() => transition(r, 'apply-hold', { ...ctx, payload: hold('H1', 'warehouse') }, systems));
    expect(e?.code).toBe('UNKNOWN_SYSTEM');
    expect(e?.message).toMatch(/warehouse/);
    expect(e?.message).toMatch(/crm, billing/);
    expect(explainAction(r, 'apply-hold', systems, hold('H1', 'warehouse')).code).toBe('UNKNOWN_SYSTEM');
  });
});

describe('guard DUPLICATE_HOLD', () => {
  it('refuses a second active hold on the same system and says to release the existing one first', () => {
    const r = inReview({ holds: [hold('H1', 'billing')] });
    const e = refusal(() => transition(r, 'apply-hold', { ...ctx, payload: hold('H2', 'billing') }, systems));
    expect(e?.code).toBe('DUPLICATE_HOLD');
    expect(e?.message).toMatch(/release/i);
    expect(e?.message).toContain('H1');
    expect(explainAction(r, 'apply-hold', systems, hold('H2', 'billing'))).toMatchObject({ enabled: false, code: 'DUPLICATE_HOLD', blockedBecause: e?.message });
  });

  it('allows a hold on a different system while another system is held', () => {
    const r = inReview({ holds: [hold('H1', 'billing')] });
    expect(explainAction(r, 'apply-hold', systems, hold('H2', 'crm')).enabled).toBe(true);
    expect(transition(r, 'apply-hold', { ...ctx, payload: hold('H2', 'crm') }, systems).holds.map((h) => h.id)).toEqual(['H1', 'H2']);
  });

  it('allows a new hold on a system whose earlier hold was released (release, then re-apply)', () => {
    let r = inReview();
    r = transition(r, 'apply-hold', { ...ctx, payload: hold('H1', 'billing') }, systems);
    r = transition(r, 'release-hold', { ...ctx, payload: 'H1' }, systems);
    expect(explainAction(r, 'apply-hold', systems, hold('H2', 'billing')).enabled).toBe(true);
    r = transition(r, 'apply-hold', { ...ctx, payload: hold('H2', 'billing') }, systems);
    expect(r.holds.map((h) => [h.id, Boolean(h.releasedAt)])).toEqual([['H1', true], ['H2', false]]);
  });

  it('refuses to re-use a hold id already on the request (INVALID_PAYLOAD) instead of silently replacing the earlier record', () => {
    let r = inReview();
    r = transition(r, 'apply-hold', { ...ctx, payload: hold('H1', 'billing') }, systems);
    r = transition(r, 'release-hold', { ...ctx, payload: 'H1' }, systems);
    const e = refusal(() => transition(r, 'apply-hold', { ...ctx, payload: hold('H1', 'crm') }, systems));
    expect(e?.code).toBe('INVALID_PAYLOAD');
    expect(e?.message).toBe('Hold id "H1" is already used on this request; choose a new id.');
    expect(explainAction(r, 'apply-hold', systems, hold('H1', 'crm'))).toMatchObject({ enabled: false, code: 'INVALID_PAYLOAD', blockedBecause: e?.message });
    expect(r.holds.map((h) => [h.id, Boolean(h.releasedAt)])).toEqual([['H1', true]]);
  });

  it('evaluates apply-hold guards in order: shape → id re-use → known system → active hold on that system', () => {
    const held = inReview({ holds: [hold('H1', 'billing')] });
    const code = (payload: unknown) => refusal(() => transition(held, 'apply-hold', { ...ctx, payload }, systems))?.code;
    expect(code({ id: 'H1', systemId: 'billing' })).toBe('INVALID_PAYLOAD'); // shape, even though the id is also re-used
    expect(code(hold('H1', 'billing'))).toBe('INVALID_PAYLOAD'); // id re-use beats the duplicate active hold
    expect(code(hold('H1', 'warehouse'))).toBe('INVALID_PAYLOAD'); // id re-use beats the unknown system
    expect(code(hold('H2', 'warehouse'))).toBe('UNKNOWN_SYSTEM');
    expect(code(hold('H2', 'billing'))).toBe('DUPLICATE_HOLD');
    expect(code(hold('H2', 'crm'))).toBeUndefined();
  });
});

describe('guard IDENTITY_ATTEMPTS_EXHAUSTED', () => {
  const exhausted = () => req({ stage: 'identity-check', identity: { method: 'email-loop', attempts: 3, maxAttempts: 3, status: 'pending' } });

  it('identity-passed is refused once every attempt has been used, before and after the click', () => {
    const e = refusal(() => transition(exhausted(), 'identity-passed', ctx, systems));
    expect(e?.code).toBe('IDENTITY_ATTEMPTS_EXHAUSTED');
    expect(e?.message).toBe('Identity attempts are exhausted (3 of 3); record the final failed attempt or reject the request.');
    expect(explainAction(exhausted(), 'identity-passed', systems)).toMatchObject({ enabled: false, code: 'IDENTITY_ATTEMPTS_EXHAUSTED', blockedBecause: e?.message });
    expect(availableActions(exhausted(), systems).map((a) => [a.action, a.enabled])).toEqual([
      ['identity-passed', false],
      ['identity-failed', true],
      ['reject', true],
    ]);
  });

  it('identity-passed stays allowed while an attempt remains, and the pass uses it', () => {
    const lastChance = req({ stage: 'identity-check', identity: { method: 'email-loop', attempts: 2, maxAttempts: 3, status: 'pending' } });
    expect(explainAction(lastChance, 'identity-passed', systems).enabled).toBe(true);
    const next = transition(lastChance, 'identity-passed', ctx, systems);
    expect(next.stage).toBe('verified');
    expect(next.identity).toEqual({ method: 'email-loop', attempts: 3, maxAttempts: 3, status: 'passed' });
  });

  it('identity-failed keeps its behaviour so the analyst can still record the final failure, which rejects the request', () => {
    expect(explainAction(exhausted(), 'identity-failed', systems).enabled).toBe(true);
    const next = transition(exhausted(), 'identity-failed', ctx, systems);
    expect(next.stage).toBe('rejected');
    expect(next.rejectReason).toBe('identity-unverified');
    expect(next.identity.status).toBe('failed');
  });
});

describe('guard INVALID_PAYLOAD', () => {
  it('a malformed SystemResult payload is refused as INVALID_PAYLOAD with the existing message', () => {
    const r = req({ stage: 'collecting', identity: passed });
    for (const payload of [undefined, 'crm', { systemId: 'crm' }, { fields: [] }]) {
      const e = refusal(() => transition(r, 'record-system-result', { ...ctx, payload }, systems));
      expect(e?.code, JSON.stringify(payload)).toBe('INVALID_PAYLOAD');
      expect(e?.message).toBe('record-system-result needs a SystemResult payload.');
    }
  });

  it('a malformed Hold payload is refused as INVALID_PAYLOAD with the existing message', () => {
    const r = inReview();
    for (const payload of [undefined, 'billing', { id: 'H1' }, { systemId: 'billing' }]) {
      const e = refusal(() => transition(r, 'apply-hold', { ...ctx, payload }, systems));
      expect(e?.code, JSON.stringify(payload)).toBe('INVALID_PAYLOAD');
      expect(e?.message).toBe('apply-hold needs a Hold payload.');
    }
  });

  it('a Hold payload without a string note is refused as INVALID_PAYLOAD rather than crashing a later guard', () => {
    // unjustifiedHolds() calls hold.note.trim(); a hold that slipped through without a note would make
    // availableActions() throw a TypeError on every render. The shape guard must catch it at apply time.
    const r = inReview();
    const payload = { id: 'H1', systemId: 'billing', reason: 'legal-hold', appliedAt: ctx.at };
    const e = refusal(() => transition(r, 'apply-hold', { ...ctx, payload }, systems));
    expect(e?.code).toBe('INVALID_PAYLOAD');
    expect(e?.message).toBe('apply-hold needs a Hold payload.');
    expect(explainAction(r, 'apply-hold', systems, payload)).toMatchObject({ enabled: false, code: 'INVALID_PAYLOAD' });
  });

  it('a SystemResult payload the importer would refuse is INVALID_PAYLOAD (every optional field must have its documented type)', () => {
    const r = req({ stage: 'collecting', identity: passed });
    const bad: unknown[] = [
      { ...result('crm'), recordId: 9 },
      { ...result('crm'), subjectEmail: 5 },
      { ...result('crm'), matchedBy: ['phone'] },
      { ...result('crm'), matchedBy: 'email' },
      { ...result('crm'), fields: [{ name: 3 }] },
      { ...result('crm'), fields: [{ name: '', value: 'x' }] },
      { ...result('crm'), fields: [{ name: 'a', value: 'b', thirdParty: 'yes' }] },
      { ...result('crm'), fields: ['displayName'] },
      { ...result('crm'), found: 'yes' },
      { ...result('crm'), systemId: '' },
      { ...result('crm'), lookedUpAt: '' },
      { ...result('crm'), lookedUpAt: 12 },
    ];
    for (const payload of bad) {
      const label = JSON.stringify(payload);
      const e = refusal(() => transition(r, 'record-system-result', { ...ctx, payload }, systems));
      expect(e?.code, label).toBe('INVALID_PAYLOAD');
      expect(e?.message, label).toBe('record-system-result needs a SystemResult payload.');
      expect(explainAction(r, 'record-system-result', systems, payload).code, label).toBe('INVALID_PAYLOAD');
    }
  });

  it('accepts every optional SystemResult field in its documented shape', () => {
    const r = req({ stage: 'collecting', identity: passed });
    const full: SystemResult = {
      ...result('crm'),
      matchedBy: ['email', 'accountId', 'pseudonym'],
      subjectEmail: 'z@people.example',
      fields: [
        { name: 'displayName', value: 'Zed Example' },
        { name: 'agentNote', value: '', thirdParty: true },
      ],
    };
    const minimal: SystemResult = { systemId: 'billing', found: false, fields: [], lookedUpAt: ctx.at };
    for (const payload of [full, minimal]) {
      expect(explainAction(r, 'record-system-result', systems, payload).enabled, payload.systemId).toBe(true);
      expect(transition(r, 'record-system-result', { ...ctx, payload }, systems).systemResults).toEqual([payload]);
    }
  });

  it('a Hold payload with an unknown reason, an empty id/system/appliedAt or a non-string releasedAt is INVALID_PAYLOAD', () => {
    const r = inReview();
    const bad: unknown[] = [
      { ...hold('H1', 'billing'), reason: 'because' },
      { ...hold('H1', 'billing'), id: '' },
      { ...hold('H1', 'billing'), systemId: '' }, // shape, not UNKNOWN_SYSTEM
      { ...hold('H1', 'billing'), appliedAt: '' },
      { ...hold('H1', 'billing'), appliedAt: 0 },
      { ...hold('H1', 'billing'), releasedAt: 5 },
      { ...hold('H1', 'billing'), note: 42 },
    ];
    for (const payload of bad) {
      const label = JSON.stringify(payload);
      const e = refusal(() => transition(r, 'apply-hold', { ...ctx, payload }, systems));
      expect(e?.code, label).toBe('INVALID_PAYLOAD');
      expect(e?.message, label).toBe('apply-hold needs a Hold payload.');
      expect(explainAction(r, 'apply-hold', systems, payload).code, label).toBe('INVALID_PAYLOAD');
    }
  });

  it('accepts every HoldReason', () => {
    const reasons: HoldReason[] = ['legal-hold', 'ongoing-transaction', 'fraud-prevention', 'legal-obligation-retention', 'third-party-rights'];
    for (const reason of reasons) {
      const payload = hold('H1', 'billing', 'Justified (synthetic).', { reason });
      expect(explainAction(inReview(), 'apply-hold', systems, payload).enabled, reason).toBe(true);
      expect(transition(inReview(), 'apply-hold', { ...ctx, payload }, systems).holds).toEqual([payload]);
    }
  });

  it('checks the payload shape before the system it names', () => {
    const r = req({ stage: 'collecting', identity: passed });
    expect(refusal(() => transition(r, 'record-system-result', { ...ctx, payload: { systemId: 'warehouse' } }, systems))?.code).toBe('INVALID_PAYLOAD');
    expect(explainAction(inReview(), 'apply-hold', systems, { systemId: 'warehouse' }).code).toBe('INVALID_PAYLOAD');
  });

  it('well-formed payloads pass the shape guards', () => {
    expect(explainAction(req({ stage: 'collecting', identity: passed }), 'record-system-result', systems, result('crm')).enabled).toBe(true);
    expect(explainAction(inReview(), 'apply-hold', systems, hold('H1', 'billing')).enabled).toBe(true);
  });
});

describe('explainAction', () => {
  it('reports the same code transition() throws', () => {
    const cases: Array<{ name: string; request: RightsRequest; action: Action; payload?: unknown; code: string }> = [
      { name: 'identity', request: req({ stage: 'verified' }), action: 'begin-collection', code: 'IDENTITY_NOT_VERIFIED' },
      { name: 'exhausted', request: req({ stage: 'identity-check', identity: { method: 'email-loop', attempts: 3, maxAttempts: 3, status: 'pending' } }), action: 'identity-passed', code: 'IDENTITY_ATTEMPTS_EXHAUSTED' },
      { name: 'id re-use', request: inReview({ holds: [hold('H1', 'billing')] }), action: 'apply-hold', payload: hold('H1', 'crm'), code: 'INVALID_PAYLOAD' },
      { name: 'lookups', request: req({ stage: 'collecting', identity: passed }), action: 'send-to-review', code: 'MISSING_SYSTEM_RESULTS' },
      { name: 'holds', request: inReview({ holds: [hold('H1', 'billing', '')] }), action: 'prepare-response', code: 'UNRESOLVED_HOLDS' },
      { name: 'no holds', request: inReview(), action: 'release-hold', payload: 'H1', code: 'HOLD_NOT_FOUND' },
      { name: 'wrong hold', request: inReview({ holds: [hold('H1', 'billing')] }), action: 'release-hold', payload: 'H9', code: 'HOLD_NOT_FOUND' },
      { name: 'reason', request: req(), action: 'reject', payload: 'because', code: 'MISSING_REJECT_REASON' },
      { name: 'stage', request: req(), action: 'close', code: 'INVALID_TRANSITION' },
      { name: 'terminal', request: req({ stage: 'closed' }), action: 'reject', payload: 'duplicate', code: 'INVALID_TRANSITION' },
    ];
    for (const c of cases) {
      const explained = explainAction(c.request, c.action, systems, c.payload);
      const thrown = refusal(() => transition(c.request, c.action, { ...ctx, payload: c.payload }, systems));
      expect(explained.enabled, c.name).toBe(false);
      expect(explained.code, c.name).toBe(c.code);
      expect(thrown?.code, c.name).toBe(c.code);
    }
  });

  it('keeps the pre-click explanations and the thrown messages byte-for-byte', () => {
    const unverified = req({ stage: 'verified' });
    expect(explainAction(unverified, 'begin-collection', systems).blockedBecause).toBe('Identity check has not passed.');
    expect(refusal(() => transition(unverified, 'begin-collection', ctx, systems))?.message).toBe('System lookups cannot start until the requester identity check has passed.');

    const collecting = req({ stage: 'collecting', identity: passed });
    expect(explainAction(collecting, 'send-to-review', systems).blockedBecause).toBe('Lookups still outstanding for: crm, billing.');
    expect(refusal(() => transition(collecting, 'send-to-review', ctx, systems))?.message).toBe('Lookups still outstanding for: crm, billing.');

    const held = inReview({ holds: [hold('H1', 'billing', '')] });
    expect(explainAction(held, 'prepare-response', systems).blockedBecause).toBe('Holds without a written justification: H1.');
    expect(refusal(() => transition(held, 'prepare-response', ctx, systems))?.message).toBe('Every active hold needs a written justification before a response can be prepared: H1.');

    const noHolds = inReview();
    expect(explainAction(noHolds, 'release-hold', systems).blockedBecause).toBe('There are no active holds to release.');
    expect(refusal(() => transition(noHolds, 'release-hold', { ...ctx, payload: 'H1' }, systems))?.message).toBe('No active hold with id "H1".');

    expect(explainAction(req(), 'close', systems).blockedBecause).toBe('"Close request" is not available while the request is in stage "received".');
    expect(refusal(() => transition(req(), 'close', ctx, systems))?.message).toBe('"Close request" is not available while the request is in stage "received".');
  });

  it('without a payload it skips shape guards but still reports data guards', () => {
    const held = inReview({ holds: [hold('H1', 'billing', '')] });
    expect(explainAction(held, 'apply-hold', systems)).toEqual({ action: 'apply-hold', label: 'Apply hold', enabled: true });
    expect(explainAction(held, 'release-hold', systems).enabled).toBe(true);
    expect(explainAction(held, 'reject', systems).enabled).toBe(true);
    expect(explainAction(req({ stage: 'collecting', identity: passed }), 'record-system-result', systems).enabled).toBe(true);
    expect(explainAction(held, 'prepare-response', systems)).toMatchObject({ enabled: false, code: 'UNRESOLVED_HOLDS' });
    expect(explainAction(inReview(), 'release-hold', systems)).toMatchObject({ enabled: false, code: 'HOLD_NOT_FOUND', blockedBecause: 'There are no active holds to release.' });
    expect(explainAction(req({ stage: 'verified' }), 'begin-collection', systems)).toMatchObject({ enabled: false, code: 'IDENTITY_NOT_VERIFIED' });
    expect(explainAction(req({ stage: 'collecting', identity: passed }), 'send-to-review', systems)).toMatchObject({ enabled: false, code: 'MISSING_SYSTEM_RESULTS' });
    const exhausted = req({ stage: 'identity-check', identity: { method: 'email-loop', attempts: 3, maxAttempts: 3, status: 'pending' } });
    expect(explainAction(exhausted, 'identity-passed', systems)).toMatchObject({ enabled: false, code: 'IDENTITY_ATTEMPTS_EXHAUSTED' });
  });

  it('with a payload it evaluates the payload guards as well', () => {
    const held = inReview({ holds: [hold('H1', 'billing')] });
    expect(explainAction(held, 'release-hold', systems, 'H1').enabled).toBe(true);
    expect(explainAction(held, 'release-hold', systems, 'nope')).toMatchObject({ enabled: false, code: 'HOLD_NOT_FOUND', blockedBecause: 'No active hold with id "nope".' });
    expect(explainAction(held, 'reject', systems, 'duplicate').enabled).toBe(true);
    expect(explainAction(held, 'reject', systems, 'because')).toMatchObject({ enabled: false, code: 'MISSING_REJECT_REASON' });
    expect(explainAction(held, 'apply-hold', systems, { id: 'H2' })).toMatchObject({ enabled: false, code: 'INVALID_PAYLOAD', blockedBecause: 'apply-hold needs a Hold payload.' });
  });

  it('availableActions is explainAction over the stage table and empty for terminal stages', () => {
    const r = inReview({ holds: [hold('H1', 'billing', '')] });
    expect(availableActions(r, systems)).toEqual(STAGE_ACTIONS.review.map((a) => explainAction(r, a, systems)));
    expect(availableActions(r, systems).map((a) => [a.action, a.enabled, a.code])).toEqual([
      ['apply-hold', true, undefined],
      ['release-hold', true, undefined],
      ['prepare-response', false, 'UNRESOLVED_HOLDS'],
      ['reject', true, undefined],
    ]);
    expect(availableActions(req({ stage: 'closed' }), systems)).toEqual([]);
    expect(availableActions(req({ stage: 'rejected' }), systems)).toEqual([]);
  });
});

describe('GUARDS table', () => {
  it('covers every action, is frozen, and each guard can be run on its own', () => {
    const actions = (Object.keys(ACTION_LABELS) as Action[]).sort();
    expect((Object.keys(GUARDS) as Action[]).sort()).toEqual(actions);
    expect(Object.isFrozen(GUARDS)).toBe(true);
    for (const action of actions) expect(Object.isFrozen(GUARDS[action]), action).toBe(true);
    expect(GUARDS['start-identity-check']).toEqual([]);
    expect(GUARDS.close).toEqual([]);

    const collecting = req({ stage: 'collecting', identity: passed });
    expect(GUARDS['send-to-review'].map((g) => g(collecting, ctx, systems))).toEqual([{ code: 'MISSING_SYSTEM_RESULTS', message: 'Lookups still outstanding for: crm, billing.' }]);

    const exhausted = req({ stage: 'identity-check', identity: { method: 'email-loop', attempts: 3, maxAttempts: 3, status: 'pending' } });
    expect(GUARDS['identity-passed'].map((g) => g(exhausted, ctx, systems)?.code)).toEqual(['IDENTITY_ATTEMPTS_EXHAUSTED']);

    // apply-hold: shape → id re-use → known system → active hold on that system; each guard judges only its own rule.
    const held = inReview({ holds: [hold('H1', 'billing')] });
    const applyCodes = (payload: unknown) => GUARDS['apply-hold'].map((g) => g(held, { ...ctx, payload }, systems)?.code);
    expect(applyCodes(hold('H2', 'billing'))).toEqual([undefined, undefined, undefined, 'DUPLICATE_HOLD']);
    expect(applyCodes(hold('H1', 'crm'))).toEqual([undefined, 'INVALID_PAYLOAD', undefined, undefined]);
    expect(applyCodes(hold('H2', 'warehouse'))).toEqual([undefined, undefined, 'UNKNOWN_SYSTEM', undefined]);
    expect(applyCodes(hold('H1', 'billing'))).toEqual([undefined, 'INVALID_PAYLOAD', undefined, 'DUPLICATE_HOLD']);
    expect(GUARDS['release-hold'].map((g) => g(held, { ...ctx, payload: 'H9' }, systems)?.code)).toEqual([undefined, 'HOLD_NOT_FOUND']);
  });
});

describe('property: the pre-click explanation and the engine refusal always agree', () => {
  const STAGES: Stage[] = ['received', 'identity-check', 'verified', 'collecting', 'review', 'response-ready', 'closed', 'rejected'];
  const ACTIONS = Object.keys(ACTION_LABELS) as Action[];
  const STATUSES: Array<RightsRequest['identity']['status']> = ['not-started', 'pending', 'passed', 'failed'];
  const HOLD_REASONS: HoldReason[] = ['legal-hold', 'ongoing-transaction', 'fraud-prevention', 'legal-obligation-retention', 'third-party-rights'];
  const REJECT_REASONS: RejectReason[] = ['duplicate', 'manifestly-unfounded', 'identity-unverified', 'out-of-scope'];
  const ids = systems.map((s) => s.id);

  // Every stage × every action, with the structurally valid actions for the stage weighted twice.
  const stageAndAction = fc.constantFrom(...STAGES).chain((stage) => fc.tuple(fc.constant(stage), fc.constantFrom(...STAGE_ACTIONS[stage], ...ACTIONS)));

  const caseArb = fc
    .record({
      stageAndAction,
      status: fc.constantFrom(...STATUSES),
      attempts: fc.integer({ min: 0, max: 3 }),
      holds: fc.array(fc.record({ systemId: fc.constantFrom(...ids), note: fc.constantFrom('', 'Retention rule (synthetic).'), released: fc.boolean() }), { maxLength: 3 }),
      results: fc.subarray(ids),
    })
    .map(({ stageAndAction: [stage, action], status, attempts, holds, results }) => ({
      action,
      request: req({
        stage,
        identity: { method: 'email-loop', attempts, maxAttempts: 3, status },
        holds: holds.map((h, i) => hold(`H${i + 1}`, h.systemId, h.note, h.released ? { releasedAt: ctx.at } : {})),
        systemResults: results.map((id) => result(id)),
      }),
    }));

  // Payload generators per action. Valid payloads (a SystemResult for a known system, a Hold with a fresh id, a hold id
  // string, a reject reason) are weighted 3:1 against hostile ones that exercise every payload guard: unknown or empty
  // system ids, re-used hold ids (H1–H3 may exist on the request), wrong field types, unknown reasons, non-string ids.
  const validResult = fc.record({ systemId: fc.constantFrom(...ids), found: fc.boolean() }).map(({ systemId, found }) => ({ ...result(systemId), found }));
  const hostileResult = fc.record(
    {
      systemId: fc.constantFrom<unknown>(...ids, 'warehouse', '', 7),
      found: fc.constantFrom<unknown>(true, false, 'yes'),
      recordId: fc.constantFrom<unknown>('crm-1', 9),
      matchedBy: fc.constantFrom<unknown>(['email'], ['email', 'accountId', 'pseudonym'], ['phone'], 'email'),
      subjectEmail: fc.constantFrom<unknown>('z@people.example', 5),
      fields: fc.constantFrom<unknown>([], [{ name: 'displayName', value: 'Zed Example' }], [{ name: 'a', value: 'b', thirdParty: true }], [{ name: 3 }], [{ name: '', value: 'x' }], 'none'),
      lookedUpAt: fc.constantFrom<unknown>(ctx.at, '', 12),
    },
    { requiredKeys: [] },
  );
  const validHold = fc
    .record({ systemId: fc.constantFrom(...ids), reason: fc.constantFrom(...HOLD_REASONS), note: fc.constantFrom('', 'Justified (synthetic).') })
    .map(({ systemId, reason, note }) => hold('H-new', systemId, note, { reason }));
  const hostileHold = fc.record(
    {
      id: fc.constantFrom<unknown>('H-new', 'H1', 'H2', 'H3', '', 3),
      systemId: fc.constantFrom<unknown>(...ids, 'warehouse', '', 1),
      reason: fc.constantFrom<unknown>(...HOLD_REASONS, 'because'),
      note: fc.constantFrom<unknown>('Justified (synthetic).', '', 42),
      appliedAt: fc.constantFrom<unknown>(ctx.at, '', 0),
      releasedAt: fc.constantFrom<unknown>(ctx.at, 5),
    },
    { requiredKeys: [] },
  );
  const payloadBag = fc.record({
    result: fc.oneof({ arbitrary: validResult, weight: 3 }, { arbitrary: hostileResult, weight: 1 }),
    hold: fc.oneof({ arbitrary: validHold, weight: 3 }, { arbitrary: hostileHold, weight: 1 }),
    holdId: fc.constantFrom<unknown>('H1', 'H2', 'H3', 'nope', 7),
    reason: fc.constantFrom<unknown>(...REJECT_REASONS, 'because', 7),
  });

  function payloadFor(action: Action, bag: { result: unknown; hold: unknown; holdId: unknown; reason: unknown }): unknown {
    switch (action) {
      case 'record-system-result': return bag.result;
      case 'apply-hold': return bag.hold;
      case 'release-hold': return bag.holdId;
      case 'reject': return bag.reason;
      default: return undefined;
    }
  }

  it('explainAction(...).enabled ⇔ transition(...) does not throw, and the codes match when it does', () => {
    fc.assert(
      fc.property(caseArb, payloadBag, ({ request, action }, bag) => {
        const payload = payloadFor(action, bag);
        const explained = explainAction(request, action, systems, payload);
        const thrown = refusal(() => transition(request, action, { ...ctx, payload }, systems));
        expect(explained.enabled, `${request.stage} × ${action}`).toBe(thrown === undefined);
        if (thrown) {
          expect(explained.code, `${request.stage} × ${action}`).toBe(thrown.code);
          expect(explained.blockedBecause).toBeTypeOf('string');
        } else {
          expect(explained.code).toBeUndefined();
          expect(explained.blockedBecause).toBeUndefined();
        }
      }),
      { numRuns: 500 },
    );
  });
});

describe('immutability', () => {
  it('transition() and availableActions() never mutate deep-frozen inputs along a full journey', () => {
    const frozenSystems = deepFreeze(systems.map((s) => ({ ...s })));
    const steps: Array<[Action, unknown?]> = [
      ['start-identity-check'],
      ['identity-failed'],
      ['identity-passed'],
      ['begin-collection'],
      ['record-system-result', result('crm')],
      ['record-system-result', result('billing')],
      ['send-to-review'],
      ['apply-hold', hold('H1', 'billing', '')],
      ['release-hold', 'H1'],
      ['apply-hold', hold('H2', 'billing')],
      ['prepare-response'],
      ['close'],
    ];
    let current = deepFreeze(req());
    for (const [action, payload] of steps) {
      const before = JSON.stringify(current);
      const frozenCtx = deepFreeze({ ...ctx, payload });
      expect(availableActions(current, frozenSystems).some((a) => a.action === action && a.enabled), action).toBe(true);
      const next = transition(current, action, frozenCtx, frozenSystems);
      expect(next).not.toBe(current);
      expect(JSON.stringify(current)).toBe(before);
      current = deepFreeze(next);
    }
    expect(current.stage).toBe('closed');
    expect(current.history).toHaveLength(steps.length);
    expect(current.holds.map((h) => [h.id, Boolean(h.releasedAt)])).toEqual([['H1', true], ['H2', false]]);
  });
});
