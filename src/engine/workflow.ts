import type { Action, FieldRecord, Hold, HoldReason, RejectReason, RightsRequest, Stage, SystemOfRecord, SystemResult, Transition, WorkflowErrorCode } from './types';
import { isTerminal, WorkflowError } from './types';

export interface TransitionContext {
  at: string; // ISO timestamp
  actor: string;
  note?: string;
  payload?: unknown;
}

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
const HOLD_REASONS: ReadonlySet<string> = new Set<HoldReason>(['legal-hold', 'ongoing-transaction', 'fraud-prevention', 'legal-obligation-retention', 'third-party-rights']);
const MATCHED_BY: ReadonlySet<string> = new Set<NonNullable<SystemResult['matchedBy']>[number]>(['email', 'accountId', 'pseudonym']);

// ---------------------------------------------------------------------------------------------------------
// Guard table — the single source of truth for "is this action allowed right now, and if not, why?".
// transition() throws the first refusal; explainAction()/availableActions() show it to the analyst before the
// click. Both evaluate the same functions in the same order, so the UI and the engine cannot disagree.
// ---------------------------------------------------------------------------------------------------------

/**
 * Why an action is refused. `message` is what transition() throws (and what the audit log records);
 * `blockedBecause`, when present, is the shorter pre-click wording the UI shows instead (defaults to `message`).
 */
export interface WorkflowRefusal {
  code: WorkflowErrorCode;
  message: string;
  blockedBecause?: string;
}

/**
 * One rule of the state machine: returns a refusal, or undefined when the rule is satisfied.
 * Guards read only the request, the payload (`ctx.payload`) and the systems of record — never `ctx.at` or
 * `ctx.actor` — so explainAction() can evaluate them with a synthetic context before the analyst clicks.
 * Each guard judges only its own rule and tolerates a malformed payload (the shape guard reports that).
 */
export type Guard = (request: RightsRequest, ctx: TransitionContext, systems: SystemOfRecord[]) => WorkflowRefusal | undefined;

/** Guards that cannot be evaluated until a payload exists; explainAction() skips them when called without one. */
const PAYLOAD_GUARDS = new Set<Guard>();
function payloadGuard(guard: Guard): Guard {
  PAYLOAD_GUARDS.add(guard);
  return guard;
}

function activeHolds(request: RightsRequest): Hold[] {
  return request.holds.filter((h) => !h.releasedAt);
}

function missingSystems(request: RightsRequest, systems: SystemOfRecord[]): string[] {
  const seen = new Set(request.systemResults.map((r) => r.systemId));
  return systems.filter((s) => !seen.has(s.id)).map((s) => s.id);
}

function unjustifiedHolds(request: RightsRequest): Hold[] {
  return activeHolds(request).filter((h) => h.note.trim().length === 0);
}

// --- Payload shapes. These mirror the importer (casefile.ts parseSystemResult/parseHold) so that a payload the
// --- engine accepts always produces a request the importer accepts again.

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string';
}

function isFieldRecord(value: unknown): value is FieldRecord {
  return isRecord(value) && isNonEmptyString(value.name) && typeof value.value === 'string' && (value.thirdParty === undefined || typeof value.thirdParty === 'boolean');
}

function isSystemResult(value: unknown): value is SystemResult {
  if (!isRecord(value)) return false;
  return (
    isNonEmptyString(value.systemId) &&
    typeof value.found === 'boolean' &&
    isOptionalString(value.recordId) &&
    (value.matchedBy === undefined || (Array.isArray(value.matchedBy) && value.matchedBy.every((m: unknown) => typeof m === 'string' && MATCHED_BY.has(m)))) &&
    Array.isArray(value.fields) &&
    value.fields.every(isFieldRecord) &&
    isOptionalString(value.subjectEmail) &&
    isNonEmptyString(value.lookedUpAt)
  );
}

function isHold(value: unknown): value is Hold {
  if (!isRecord(value)) return false;
  return (
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.systemId) &&
    typeof value.reason === 'string' &&
    HOLD_REASONS.has(value.reason) &&
    typeof value.note === 'string' &&
    isNonEmptyString(value.appliedAt) &&
    isOptionalString(value.releasedAt)
  );
}

function isRejectReason(value: unknown): value is RejectReason {
  return typeof value === 'string' && REJECT_REASONS.has(value);
}

/** A string property of an object payload (SystemResult/Hold), if the payload carries one. */
function payloadString(ctx: TransitionContext, key: 'systemId' | 'id'): string | undefined {
  const p = ctx.payload;
  return isRecord(p) && typeof p[key] === 'string' ? (p[key] as string) : undefined;
}

/** The hold id named by a release-hold payload ('' when the payload is not a string, as before). */
function holdId(ctx: TransitionContext): string {
  return typeof ctx.payload === 'string' ? ctx.payload : '';
}

const SYSTEM_RESULT_SHAPE: WorkflowRefusal = { code: 'INVALID_PAYLOAD', message: 'record-system-result needs a SystemResult payload.' };
const HOLD_SHAPE: WorkflowRefusal = { code: 'INVALID_PAYLOAD', message: 'apply-hold needs a Hold payload.' };
const REJECT_REASON_SHAPE: WorkflowRefusal = { code: 'MISSING_REJECT_REASON', message: 'A rejection needs one of: duplicate, manifestly-unfounded, identity-unverified, out-of-scope.' };

function unknownSystem(id: string, systems: SystemOfRecord[]): WorkflowRefusal {
  const known = systems.length > 0 ? systems.map((s) => s.id).join(', ') : 'none';
  return { code: 'UNKNOWN_SYSTEM', message: `System "${id}" is not one of the case file's systems of record. Known systems: ${known}.` };
}

function holdNotFound(id: string): WorkflowRefusal {
  return { code: 'HOLD_NOT_FOUND', message: `No active hold with id "${id}".` };
}

// --- Data guards (evaluable without a payload) ---

const attemptsRemain: Guard = (request) => {
  const { attempts, maxAttempts } = request.identity;
  return attempts < maxAttempts
    ? undefined
    : { code: 'IDENTITY_ATTEMPTS_EXHAUSTED', message: `Identity attempts are exhausted (${attempts} of ${maxAttempts}); record the final failed attempt or reject the request.` };
};

const identityPassed: Guard = (request) =>
  request.identity.status === 'passed'
    ? undefined
    : { code: 'IDENTITY_NOT_VERIFIED', message: 'System lookups cannot start until the requester identity check has passed.', blockedBecause: 'Identity check has not passed.' };

const lookupsComplete: Guard = (request, _ctx, systems) => {
  const missing = missingSystems(request, systems);
  return missing.length > 0 ? { code: 'MISSING_SYSTEM_RESULTS', message: `Lookups still outstanding for: ${missing.join(', ')}.` } : undefined;
};

const anyActiveHold: Guard = (request, ctx) => (activeHolds(request).length > 0 ? undefined : { ...holdNotFound(holdId(ctx)), blockedBecause: 'There are no active holds to release.' });

const holdsJustified: Guard = (request) => {
  const bad = unjustifiedHolds(request);
  if (bad.length === 0) return undefined;
  const ids = bad.map((h) => h.id).join(', ');
  return {
    code: 'UNRESOLVED_HOLDS',
    message: `Every active hold needs a written justification before a response can be prepared: ${ids}.`,
    blockedBecause: `Holds without a written justification: ${ids}.`,
  };
};

// --- Payload guards (skipped by explainAction() until a payload exists) ---

const systemResultShape: Guard = payloadGuard((_request, ctx) => (isSystemResult(ctx.payload) ? undefined : SYSTEM_RESULT_SHAPE));

const holdShape: Guard = payloadGuard((_request, ctx) => (isHold(ctx.payload) ? undefined : HOLD_SHAPE));

/** Hold ids are unique within a request (an integrity rule); re-using one would silently overwrite the earlier record. */
const holdIdUnused: Guard = payloadGuard((request, ctx) => {
  const id = payloadString(ctx, 'id');
  return id !== undefined && request.holds.some((h) => h.id === id)
    ? { code: 'INVALID_PAYLOAD', message: `Hold id "${id}" is already used on this request; choose a new id.` }
    : undefined;
});

/** The payload's systemId must be one of the case file's systems of record (shared by record-system-result and apply-hold). */
const systemKnown: Guard = payloadGuard((_request, ctx, systems) => {
  const id = payloadString(ctx, 'systemId');
  return id === undefined || systems.some((s) => s.id === id) ? undefined : unknownSystem(id, systems);
});

const noDuplicateHold: Guard = payloadGuard((request, ctx) => {
  const id = payloadString(ctx, 'systemId');
  const existing = id === undefined ? undefined : activeHolds(request).find((h) => h.systemId === id);
  return existing
    ? { code: 'DUPLICATE_HOLD', message: `Hold "${existing.id}" is already active on ${id}; release it first before applying another hold to that system.` }
    : undefined;
});

const holdIsActive: Guard = payloadGuard((request, ctx) => {
  const id = holdId(ctx);
  return request.holds.some((h) => h.id === id && !h.releasedAt) ? undefined : holdNotFound(id);
});

const rejectReasonGiven: Guard = payloadGuard((_request, ctx) => (isRejectReason(ctx.payload) ? undefined : REJECT_REASON_SHAPE));

/**
 * Guards per action, evaluated in order after the STAGE_ACTIONS structural check (INVALID_TRANSITION).
 * Actions with an empty list are always allowed from their stages. This table is what the README means by
 * "the UI and the engine cannot disagree":
 *
 *   identity-passed        attemptsRemain → IDENTITY_ATTEMPTS_EXHAUSTED
 *   begin-collection       identityPassed → IDENTITY_NOT_VERIFIED
 *   record-system-result   systemResultShape → INVALID_PAYLOAD · systemKnown → UNKNOWN_SYSTEM
 *   send-to-review         lookupsComplete → MISSING_SYSTEM_RESULTS
 *   apply-hold             holdShape → INVALID_PAYLOAD · holdIdUnused → INVALID_PAYLOAD · systemKnown → UNKNOWN_SYSTEM · noDuplicateHold → DUPLICATE_HOLD
 *   release-hold           anyActiveHold → HOLD_NOT_FOUND (data) · holdIsActive → HOLD_NOT_FOUND (payload)
 *   prepare-response       holdsJustified → UNRESOLVED_HOLDS
 *   reject                 rejectReasonGiven → MISSING_REJECT_REASON
 *   start-identity-check, identity-failed, close: none
 */
export const GUARDS: Readonly<Record<Action, readonly Guard[]>> = Object.freeze({
  'start-identity-check': Object.freeze([]),
  'identity-passed': Object.freeze([attemptsRemain]),
  'identity-failed': Object.freeze([]),
  'begin-collection': Object.freeze([identityPassed]),
  'record-system-result': Object.freeze([systemResultShape, systemKnown]),
  'send-to-review': Object.freeze([lookupsComplete]),
  'apply-hold': Object.freeze([holdShape, holdIdUnused, systemKnown, noDuplicateHold]),
  'release-hold': Object.freeze([anyActiveHold, holdIsActive]),
  'prepare-response': Object.freeze([holdsJustified]),
  close: Object.freeze([]),
  reject: Object.freeze([rejectReasonGiven]),
});

function stageRefusal(request: RightsRequest, action: Action): WorkflowRefusal | undefined {
  return STAGE_ACTIONS[request.stage].includes(action)
    ? undefined
    : { code: 'INVALID_TRANSITION', message: `"${ACTION_LABELS[action]}" is not available while the request is in stage "${request.stage}".` };
}

/** The first refusal for an action: the structural stage check, then GUARDS[action] in table order. */
function firstRefusal(request: RightsRequest, action: Action, ctx: TransitionContext, systems: SystemOfRecord[], withPayload: boolean): WorkflowRefusal | undefined {
  const structural = stageRefusal(request, action);
  if (structural) return structural;
  for (const guard of GUARDS[action]) {
    if (!withPayload && PAYLOAD_GUARDS.has(guard)) continue;
    const refusal = guard(request, ctx, systems);
    if (refusal) return refusal;
  }
  return undefined;
}

function refusalError(refusal: WorkflowRefusal): WorkflowError {
  return new WorkflowError(refusal.code, refusal.message);
}

/** Re-narrows a payload the guards have already accepted, so the apply step stays typed without a cast. */
function narrow<T>(value: unknown, is: (v: unknown) => v is T, refusal: WorkflowRefusal): T {
  if (!is(value)) throw refusalError(refusal);
  return value;
}

function record(request: RightsRequest, to: Stage, action: Action, ctx: TransitionContext): Transition {
  return { at: ctx.at, from: request.stage, to, action, actor: ctx.actor, ...(ctx.note ? { note: ctx.note } : {}) };
}

/**
 * Pure state-machine step. Returns a new request; never mutates the input.
 * Runs the structural stage check and GUARDS[action]; throws WorkflowError with a stable code for the first refusal,
 * then applies the action.
 */
export function transition(request: RightsRequest, action: Action, ctx: TransitionContext, systems: SystemOfRecord[]): RightsRequest {
  const refused = firstRefusal(request, action, ctx, systems, true);
  if (refused) throw refusalError(refused);

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
      const to: Stage = 'collecting';
      return { ...request, stage: to, history: [...request.history, record(request, to, action, ctx)] };
    }
    case 'record-system-result': {
      const payload = narrow(ctx.payload, isSystemResult, SYSTEM_RESULT_SHAPE);
      const others = request.systemResults.filter((r) => r.systemId !== payload.systemId);
      return {
        ...request,
        systemResults: [...others, payload],
        history: [...request.history, record(request, request.stage, action, { ...ctx, note: ctx.note ?? `${payload.systemId}: ${payload.found ? 'record found' : 'no record'}` })],
      };
    }
    case 'send-to-review': {
      const to: Stage = 'review';
      return { ...request, stage: to, history: [...request.history, record(request, to, action, ctx)] };
    }
    case 'apply-hold': {
      const hold = narrow(ctx.payload, isHold, HOLD_SHAPE);
      return {
        ...request,
        holds: [...request.holds, hold], // ids are unique per request (holdIdUnused), so nothing is ever replaced
        history: [...request.history, record(request, request.stage, action, { ...ctx, note: ctx.note ?? `${hold.reason} on ${hold.systemId}` })],
      };
    }
    case 'release-hold': {
      const id = holdId(ctx);
      const hold = request.holds.find((h) => h.id === id && !h.releasedAt);
      if (!hold) throw refusalError(holdNotFound(id)); // already excluded by GUARDS; keeps the narrowing explicit
      return {
        ...request,
        holds: request.holds.map((h) => (h.id === id ? { ...h, releasedAt: ctx.at } : h)),
        history: [...request.history, record(request, request.stage, action, { ...ctx, note: ctx.note ?? `released ${hold.reason} on ${hold.systemId}` })],
      };
    }
    case 'prepare-response': {
      const to: Stage = 'response-ready';
      return { ...request, stage: to, history: [...request.history, record(request, to, action, ctx)] };
    }
    case 'close': {
      const to: Stage = 'closed';
      return { ...request, stage: to, closedOn: ctx.at.slice(0, 10), history: [...request.history, record(request, to, action, ctx)] };
    }
    case 'reject': {
      const reason = narrow(ctx.payload, isRejectReason, REJECT_REASON_SHAPE);
      const to: Stage = 'rejected';
      return { ...request, stage: to, rejectReason: reason, history: [...request.history, record(request, to, action, ctx)] };
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
  /** The WorkflowError code transition() would throw for this action right now. */
  code?: WorkflowErrorCode;
}

/** Guards never read `at`/`actor`, so a pre-click evaluation can use an empty context. */
const PREVIEW_CONTEXT: TransitionContext = { at: '', actor: '' };

/**
 * Explains one action with exactly the guards transition() enforces. Without a payload, guards that need one
 * (payload shape, hold id re-use, unknown system, duplicate hold, hold id, reject reason) are skipped so the UI can
 * list actions before the analyst has filled in a form; the data guards still run.
 */
export function explainAction(request: RightsRequest, action: Action, systems: SystemOfRecord[], payload?: unknown): ActionAvailability {
  const refused = firstRefusal(request, action, { ...PREVIEW_CONTEXT, payload }, systems, payload !== undefined);
  const base = { action, label: ACTION_LABELS[action] };
  return refused ? { ...base, enabled: false, blockedBecause: refused.blockedBecause ?? refused.message, code: refused.code } : { ...base, enabled: true };
}

/** Explains, for the UI, which actions are possible now and why the others are blocked. */
export function availableActions(request: RightsRequest, systems: SystemOfRecord[]): ActionAvailability[] {
  if (isTerminal(request.stage)) return [];
  return STAGE_ACTIONS[request.stage].map((action) => explainAction(request, action, systems));
}
