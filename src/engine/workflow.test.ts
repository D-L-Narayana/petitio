import { describe, expect, it } from 'vitest';
import { availableActions, transition } from './workflow';
import type { RightsRequest, SystemOfRecord, SystemResult } from './types';
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
