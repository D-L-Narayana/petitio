import type { Action, Hold, RejectReason, RightsRequest, Stage, SystemOfRecord, SystemResult, Transition } from './types';
import { WorkflowError } from './types';

export interface TransitionContext {
  at: string; // ISO timestamp
  actor: string;
  note?: string;
  payload?: unknown;
}

const TERMINAL: ReadonlySet<Stage> = new Set(['closed', 'rejected']);

/** Which actions are structurally allowed from each stage (before guards run). */
export const STAGE_ACTIONS: Record<Stage, Action[]> = {
  received: ['start-identity-check', 'reject'],
  'identity-check': ['identity-passed', 'identity-failed', 'reject'],
  verified: ['begin-collection', 'reject'],
  collecting: ['record-system-result', 'send-to-review', 'reject'],
  review: ['apply-hold', 'release-hold', 'prepare-response', 'reject'],
  'response-ready': ['close', 'reject'],
  closed: [],
  rejected: [],
};

export const ACTION_LABELS: Record<Action, string> = {
  'start-identity-check': 'Start identity check',
  'identity-passed': 'Record identity passed',
  'identity-failed': 'Record failed attempt',
  'begin-collection': 'Begin system lookups',
  'record-system-result': 'Record system result',
  'send-to-review': 'Send to reviewer',
  'apply-hold': 'Apply hold',
  'release-hold': 'Release hold',
  'prepare-response': 'Prepare response packet',
  close: 'Close request',
  reject: 'Reject request',
};

const REJECT_REASONS: ReadonlySet<string> = new Set<RejectReason>(['duplicate', 'manifestly-unfounded', 'identity-unverified', 'out-of-scope']);

function record(request: RightsRequest, to: Stage, action: Action, ctx: TransitionContext): Transition {
  return { at: ctx.at, from: request.stage, to, action, actor: ctx.actor, ...(ctx.note ? { note: ctx.note } : {}) };
}

function missingSystems(request: RightsRequest, systems: SystemOfRecord[]): string[] {
  const seen = new Set(request.systemResults.map((r) => r.systemId));
  return systems.filter((s) => !seen.has(s.id)).map((s) => s.id);
}

function unjustifiedHolds(request: RightsRequest): Hold[] {
  return request.holds.filter((h) => !h.releasedAt && h.note.trim().length === 0);
}

function isSystemResult(value: unknown): value is SystemResult {
  return typeof value === 'object' && value !== null && typeof (value as SystemResult).systemId === 'string' && Array.isArray((value as SystemResult).fields);
}

function isHold(value: unknown): value is Hold {
  return typeof value === 'object' && value !== null && typeof (value as Hold).id === 'string' && typeof (value as Hold).systemId === 'string';
}

/**
 * Pure state-machine step. Returns a new request; never mutates the input.
 * Guards throw WorkflowError with a stable code so the UI can explain refusals.
 */
export function transition(request: RightsRequest, action: Action, ctx: TransitionContext, systems: SystemOfRecord[]): RightsRequest {
  if (!STAGE_ACTIONS[request.stage].includes(action)) {
    throw new WorkflowError('INVALID_TRANSITION', `"${ACTION_LABELS[action]}" is not available while the request is in stage "${request.stage}".`);
  }

  switch (action) {
    case 'start-identity-check': {
      const to: Stage = 'identity-check';
      return { ...request, stage: to, identity: { ...request.identity, status: 'pending' }, history: [...request.history, record(request, to, action, ctx)] };
    }
    case 'identity-passed': {
      const to: Stage = 'verified';
      return {
        ...request,
        stage: to,
        identity: { ...request.identity, attempts: request.identity.attempts + 1, status: 'passed' },
        history: [...request.history, record(request, to, action, ctx)],
      };
    }
    case 'identity-failed': {
      const attempts = request.identity.attempts + 1;
      if (attempts >= request.identity.maxAttempts) {
        const to: Stage = 'rejected';
        return {
          ...request,
          stage: to,
          rejectReason: 'identity-unverified',
          identity: { ...request.identity, attempts, status: 'failed' },
          history: [...request.history, record(request, to, action, { ...ctx, note: ctx.note ?? `Identity could not be verified after ${attempts} attempts.` })],
        };
      }
      return {
        ...request,
        identity: { ...request.identity, attempts, status: 'pending' },
        history: [...request.history, record(request, request.stage, action, ctx)],
      };
    }
    case 'begin-collection': {
      if (request.identity.status !== 'passed') {
        throw new WorkflowError('IDENTITY_NOT_VERIFIED', 'System lookups cannot start until the requester identity check has passed.');
      }
      const to: Stage = 'collecting';
      return { ...request, stage: to, history: [...request.history, record(request, to, action, ctx)] };
    }
    case 'record-system-result': {
      if (!isSystemResult(ctx.payload)) {
        throw new WorkflowError('INVALID_TRANSITION', 'record-system-result needs a SystemResult payload.');
      }
      const payload = ctx.payload;
      const others = request.systemResults.filter((r) => r.systemId !== payload.systemId);
      return {
        ...request,
        systemResults: [...others, payload],
        history: [...request.history, record(request, request.stage, action, { ...ctx, note: ctx.note ?? `${payload.systemId}: ${payload.found ? 'record found' : 'no record'}` })],
      };
    }
    case 'send-to-review': {
      const missing = missingSystems(request, systems);
      if (missing.length > 0) {
        throw new WorkflowError('MISSING_SYSTEM_RESULTS', `Lookups still outstanding for: ${missing.join(', ')}.`);
      }
      const to: Stage = 'review';
      return { ...request, stage: to, history: [...request.history, record(request, to, action, ctx)] };
    }
    case 'apply-hold': {
      if (!isHold(ctx.payload)) throw new WorkflowError('INVALID_TRANSITION', 'apply-hold needs a Hold payload.');
      const hold = ctx.payload;
      return {
        ...request,
        holds: [...request.holds.filter((h) => h.id !== hold.id), hold],
        history: [...request.history, record(request, request.stage, action, { ...ctx, note: ctx.note ?? `${hold.reason} on ${hold.systemId}` })],
      };
    }
    case 'release-hold': {
      const id = typeof ctx.payload === 'string' ? ctx.payload : '';
      const hold = request.holds.find((h) => h.id === id && !h.releasedAt);
      if (!hold) throw new WorkflowError('HOLD_NOT_FOUND', `No active hold with id "${id}".`);
      return {
        ...request,
        holds: request.holds.map((h) => (h.id === id ? { ...h, releasedAt: ctx.at } : h)),
        history: [...request.history, record(request, request.stage, action, { ...ctx, note: ctx.note ?? `released ${hold.reason} on ${hold.systemId}` })],
      };
    }
    case 'prepare-response': {
      const bad = unjustifiedHolds(request);
      if (bad.length > 0) {
        throw new WorkflowError('UNRESOLVED_HOLDS', `Every active hold needs a written justification before a response can be prepared: ${bad.map((h) => h.id).join(', ')}.`);
      }
      const to: Stage = 'response-ready';
      return { ...request, stage: to, history: [...request.history, record(request, to, action, ctx)] };
    }
    case 'close': {
      const to: Stage = 'closed';
      return { ...request, stage: to, closedOn: ctx.at.slice(0, 10), history: [...request.history, record(request, to, action, ctx)] };
    }
    case 'reject': {
      const reason = typeof ctx.payload === 'string' ? ctx.payload : '';
      if (!REJECT_REASONS.has(reason)) {
        throw new WorkflowError('MISSING_REJECT_REASON', 'A rejection needs one of: duplicate, manifestly-unfounded, identity-unverified, out-of-scope.');
      }
      const to: Stage = 'rejected';
      return { ...request, stage: to, rejectReason: reason as RejectReason, history: [...request.history, record(request, to, action, ctx)] };
    }
    default: {
      const never: never = action;
      throw new WorkflowError('INVALID_TRANSITION', `Unknown action ${String(never)}`);
    }
  }
}

export interface ActionAvailability {
  action: Action;
  label: string;
  enabled: boolean;
  blockedBecause?: string;
}

/** Explains, for the UI, which actions are possible now and why the others are blocked. */
export function availableActions(request: RightsRequest, systems: SystemOfRecord[]): ActionAvailability[] {
  if (TERMINAL.has(request.stage)) return [];
  return STAGE_ACTIONS[request.stage].map((action) => {
    let blockedBecause: string | undefined;
    if (action === 'begin-collection' && request.identity.status !== 'passed') {
      blockedBecause = 'Identity check has not passed.';
    }
    if (action === 'send-to-review') {
      const missing = missingSystems(request, systems);
      if (missing.length > 0) blockedBecause = `Lookups still outstanding for: ${missing.join(', ')}.`;
    }
    if (action === 'prepare-response') {
      const bad = unjustifiedHolds(request);
      if (bad.length > 0) blockedBecause = `Holds without a written justification: ${bad.map((h) => h.id).join(', ')}.`;
    }
    if (action === 'release-hold' && request.holds.every((h) => h.releasedAt)) {
      blockedBecause = 'There are no active holds to release.';
    }
    return { action, label: ACTION_LABELS[action], enabled: !blockedBecause, ...(blockedBecause ? { blockedBecause } : {}) };
  });
}
