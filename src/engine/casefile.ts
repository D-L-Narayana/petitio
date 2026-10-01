import type { CaseFile, FieldRecord, Hold, RightsRequest, SystemOfRecord, SystemResult, Transition } from './types';
import { daysBetween, maxExtensionDays, PROFILES, statutoryDueOn } from './deadline';

export interface ImportLimits {
  maxBytes: number;
  maxRequests: number;
  maxSystems: number;
  maxDepth: number;
  maxStringLength: number;
}

export const DEFAULT_LIMITS: ImportLimits = {
  maxBytes: 1_000_000,
  maxRequests: 500,
  maxSystems: 50,
  maxDepth: 8,
  maxStringLength: 4_000,
};

export type ParseResult = { ok: true; file: CaseFile; warnings: string[] } | { ok: false; errors: string[] };

const JURISDICTIONS = new Set(['EU-GDPR', 'UK-GDPR', 'US-CA-CCPA']);
const TYPES = new Set(['access', 'erasure', 'rectification', 'portability', 'opt-out-sale']);
const STAGES = new Set(['received', 'identity-check', 'verified', 'collecting', 'review', 'response-ready', 'closed', 'rejected']);
const ACTIONS = new Set(['start-identity-check', 'identity-passed', 'identity-failed', 'begin-collection', 'record-system-result', 'send-to-review', 'apply-hold', 'release-hold', 'prepare-response', 'close', 'reject']);
const HOLD_REASONS = new Set(['legal-hold', 'ongoing-transaction', 'fraud-prevention', 'legal-obligation-retention', 'third-party-rights']);
const REJECT_REASONS = new Set(['duplicate', 'manifestly-unfounded', 'identity-unverified', 'out-of-scope']);
const ID_METHODS = new Set(['account-login', 'email-loop', 'document-upload', 'none']);
const ID_STATUS = new Set(['not-started', 'pending', 'passed', 'failed']);
const AGE_BANDS = new Set(['adult', 'minor', 'unknown']);
const MATCHED_BY = new Set(['email', 'accountId', 'pseudonym']);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
/** True only for a real calendar date in YYYY-MM-DD form (2026-02-30 is rejected). */
export function isStrictDate(v: string): boolean {
  if (!ISO_DATE.test(v)) return false;
  const [y, m, d] = v.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * Iterative, bounded nesting check. Stops as soon as `max` is exceeded and never recurses, so a
 * hostile document with tens of thousands of nested arrays cannot overflow the call stack.
 */
function exceedsDepth(root: unknown, max: number): boolean {
  const stack: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 0 }];
  while (stack.length) {
    const { value, depth } = stack.pop()!;
    if (value === null || typeof value !== 'object') continue;
    if (depth + 1 > max) return true;
    for (const child of Object.values(value as Record<string, unknown>)) {
      if (child !== null && typeof child === 'object') stack.push({ value: child, depth: depth + 1 });
    }
  }
  return false;
}

class Ctx {
  errors: string[] = [];
  warnings: string[] = [];
  constructor(private readonly limits: ImportLimits) {}

  str(obj: Record<string, unknown>, key: string, path: string, opts: { optional?: boolean; pattern?: RegExp; enumSet?: Set<string>; allowEmpty?: boolean } = {}): string | undefined {
    const v = obj[key];
    if (v === undefined) {
      if (!opts.optional) this.errors.push(`${path}.${key} is required`);
      return undefined;
    }
    if (typeof v !== 'string') {
      this.errors.push(`${path}.${key} must be a string`);
      return undefined;
    }
    if (v.length > this.limits.maxStringLength) {
      this.errors.push(`${path}.${key} exceeds ${this.limits.maxStringLength} characters`);
      return undefined;
    }
    if (!opts.allowEmpty && v.length === 0 && !opts.optional) this.errors.push(`${path}.${key} must not be empty`);
    if (opts.pattern === ISO_DATE && !isStrictDate(v)) this.errors.push(`${path}.${key} "${v.slice(0, 40)}" is not a real calendar date (YYYY-MM-DD)`);
    else if (opts.pattern && opts.pattern !== ISO_DATE && !opts.pattern.test(v)) this.errors.push(`${path}.${key} "${v.slice(0, 40)}" is not in the expected format`);
    if (opts.enumSet && !opts.enumSet.has(v)) this.errors.push(`${path}.${key} "${v.slice(0, 40)}" is not an allowed value`);
    return v;
  }

  bool(obj: Record<string, unknown>, key: string, path: string, optional = false): boolean | undefined {
    const v = obj[key];
    if (v === undefined) {
      if (!optional) this.errors.push(`${path}.${key} is required`);
      return undefined;
    }
    if (typeof v !== 'boolean') this.errors.push(`${path}.${key} must be true or false`);
    return v as boolean;
  }

  int(obj: Record<string, unknown>, key: string, path: string, min: number, max: number): number {
    const v = obj[key];
    if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
      this.errors.push(`${path}.${key} must be an integer between ${min} and ${max}`);
      return min;
    }
    return v;
  }

  obj(value: unknown, path: string): Record<string, unknown> | undefined {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      this.errors.push(`${path} must be an object`);
      return undefined;
    }
    return value as Record<string, unknown>;
  }

  arr(obj: Record<string, unknown>, key: string, path: string, max: number): unknown[] {
    const v = obj[key];
    if (v === undefined) return [];
    if (!Array.isArray(v)) {
      this.errors.push(`${path}.${key} must be an array`);
      return [];
    }
    if (v.length > max) {
      this.errors.push(`${path}.${key} has ${v.length} items; the limit is ${max}`);
      return v.slice(0, max);
    }
    return v;
  }
}

function parseField(ctx: Ctx, raw: unknown, path: string): FieldRecord | undefined {
  const o = ctx.obj(raw, path);
  if (!o) return undefined;
  const name = ctx.str(o, 'name', path);
  const value = ctx.str(o, 'value', path, { allowEmpty: true });
  const thirdParty = ctx.bool(o, 'thirdParty', path, true);
  if (name === undefined || value === undefined) return undefined;
  return { name, value, ...(thirdParty ? { thirdParty: true } : {}) };
}

function parseSystemResult(ctx: Ctx, raw: unknown, path: string): SystemResult | undefined {
  const o = ctx.obj(raw, path);
  if (!o) return undefined;
  const systemId = ctx.str(o, 'systemId', path);
  const found = ctx.bool(o, 'found', path);
  const recordId = ctx.str(o, 'recordId', path, { optional: true });
  const subjectEmail = ctx.str(o, 'subjectEmail', path, { optional: true });
  const lookedUpAt = ctx.str(o, 'lookedUpAt', path);
  const matchedBy = ctx.arr(o, 'matchedBy', path, 3).map((m, i) => {
    if (typeof m !== 'string' || !MATCHED_BY.has(m)) ctx.errors.push(`${path}.matchedBy[${i}] is not an allowed value`);
    return m as SystemResult['matchedBy'] extends Array<infer T> | undefined ? T : never;
  });
  const fields = ctx.arr(o, 'fields', path, 100).map((f, i) => parseField(ctx, f, `${path}.fields[${i}]`)).filter((f): f is FieldRecord => Boolean(f));
  if (systemId === undefined || found === undefined || lookedUpAt === undefined) return undefined;
  return {
    systemId,
    found,
    fields,
    lookedUpAt,
    ...(recordId !== undefined ? { recordId } : {}),
    ...(subjectEmail !== undefined ? { subjectEmail } : {}),
    ...(matchedBy.length ? { matchedBy } : {}),
  };
}

function parseHold(ctx: Ctx, raw: unknown, path: string): Hold | undefined {
  const o = ctx.obj(raw, path);
  if (!o) return undefined;
  const id = ctx.str(o, 'id', path);
  const systemId = ctx.str(o, 'systemId', path);
  const reason = ctx.str(o, 'reason', path, { enumSet: HOLD_REASONS });
  const note = ctx.str(o, 'note', path, { allowEmpty: true });
  const appliedAt = ctx.str(o, 'appliedAt', path);
  const releasedAt = ctx.str(o, 'releasedAt', path, { optional: true });
  if (!id || !systemId || !reason || note === undefined || !appliedAt) return undefined;
  return { id, systemId, reason: reason as Hold['reason'], note, appliedAt, ...(releasedAt ? { releasedAt } : {}) };
}

function parseTransition(ctx: Ctx, raw: unknown, path: string): Transition | undefined {
  const o = ctx.obj(raw, path);
  if (!o) return undefined;
  const at = ctx.str(o, 'at', path, { pattern: ISO_TIMESTAMP });
  const from = ctx.str(o, 'from', path, { enumSet: STAGES });
  const to = ctx.str(o, 'to', path, { enumSet: STAGES });
  const action = ctx.str(o, 'action', path, { enumSet: ACTIONS });
  const actor = ctx.str(o, 'actor', path);
  const note = ctx.str(o, 'note', path, { optional: true });
  if (!at || !from || !to || !action || !actor) return undefined;
  return { at, from: from as Transition['from'], to: to as Transition['to'], action: action as Transition['action'], actor, ...(note ? { note } : {}) };
}

function parseRequest(ctx: Ctx, raw: unknown, path: string): RightsRequest | undefined {
  const o = ctx.obj(raw, path);
  if (!o) return undefined;
  const id = ctx.str(o, 'id', path);
  const receivedOn = ctx.str(o, 'receivedOn', path, { pattern: ISO_DATE });
  const jurisdiction = ctx.str(o, 'jurisdiction', path, { enumSet: JURISDICTIONS });
  const type = ctx.str(o, 'type', path, { enumSet: TYPES });
  const stage = ctx.str(o, 'stage', path, { enumSet: STAGES });
  const rejectReason = ctx.str(o, 'rejectReason', path, { optional: true, enumSet: REJECT_REASONS });
  const closedOn = ctx.str(o, 'closedOn', path, { optional: true, pattern: ISO_DATE });

  const requesterObj = ctx.obj(o['requester'], `${path}.requester`);
  const requester = requesterObj
    ? {
        pseudonym: ctx.str(requesterObj, 'pseudonym', `${path}.requester`) ?? '',
        email: ctx.str(requesterObj, 'email', `${path}.requester`) ?? '',
        accountId: ctx.str(requesterObj, 'accountId', `${path}.requester`, { optional: true }),
        ageBand: ctx.str(requesterObj, 'ageBand', `${path}.requester`, { optional: true, enumSet: AGE_BANDS }),
      }
    : undefined;

  const identityObj = ctx.obj(o['identity'], `${path}.identity`);
  const identity = identityObj
    ? {
        method: ctx.str(identityObj, 'method', `${path}.identity`, { enumSet: ID_METHODS }) ?? 'none',
        attempts: ctx.int(identityObj, 'attempts', `${path}.identity`, 0, 20),
        maxAttempts: ctx.int(identityObj, 'maxAttempts', `${path}.identity`, 1, 20),
        status: ctx.str(identityObj, 'status', `${path}.identity`, { enumSet: ID_STATUS }) ?? 'not-started',
      }
    : undefined;

  let extension: RightsRequest['extension'];
  if (o['extension'] !== undefined) {
    const e = ctx.obj(o['extension'], `${path}.extension`);
    if (e) {
      extension = {
        days: ctx.int(e, 'days', `${path}.extension`, 1, 366),
        reason: ctx.str(e, 'reason', `${path}.extension`) ?? '',
        notifiedOn: ctx.str(e, 'notifiedOn', `${path}.extension`, { pattern: ISO_DATE }) ?? '',
      };
      // The import path must obey the same statutory guards as requestExtension(); an imported file is not a way around them.
      // ctx.str/ctx.int return the raw value even after logging an error, so the cross-field arithmetic
      // (which throws on malformed dates and unknown profiles) runs only when every input is independently valid.
      const inputsValid = receivedOn !== undefined && isStrictDate(receivedOn) && jurisdiction !== undefined && JURISDICTIONS.has(jurisdiction) && isStrictDate(extension.notifiedOn) && Number.isInteger(extension.days) && extension.days >= 1;
      if (inputsValid) {
        const probe = { receivedOn, jurisdiction: jurisdiction as RightsRequest['jurisdiction'] } as RightsRequest;
        const max = maxExtensionDays(probe);
        const statutory = statutoryDueOn(probe);
        if (extension.days > max) ctx.errors.push(`${path}.extension.days (${extension.days}) on request ${id ?? '?'} exceeds the ${max}-day maximum for ${PROFILES[probe.jurisdiction].label} on a request received ${receivedOn}`);
        if (daysBetween(receivedOn, extension.notifiedOn) < 0) ctx.errors.push(`${path}.extension.notifiedOn (${extension.notifiedOn}) is before the request was received (${receivedOn})`);
        if (PROFILES[probe.jurisdiction].extensionNoticeWithinInitialWindow && daysBetween(extension.notifiedOn, statutory) < 0) ctx.errors.push(`${path}.extension.notifiedOn (${extension.notifiedOn}) is after the initial due date ${statutory}; notice must be given within the initial window`);
      }
      if (!extension.reason.trim()) ctx.errors.push(`${path}.extension.reason must state why the extension was taken`);
    }
  }

  const holds = ctx.arr(o, 'holds', path, 50).map((h, i) => parseHold(ctx, h, `${path}.holds[${i}]`)).filter((h): h is Hold => Boolean(h));
  const systemResults = ctx.arr(o, 'systemResults', path, 50).map((r, i) => parseSystemResult(ctx, r, `${path}.systemResults[${i}]`)).filter((r): r is SystemResult => Boolean(r));
  const history = ctx.arr(o, 'history', path, 200).map((t, i) => parseTransition(ctx, t, `${path}.history[${i}]`)).filter((t): t is Transition => Boolean(t));
  const notes = ctx.arr(o, 'notes', path, 100).map((n, i) => {
    if (typeof n !== 'string') {
      ctx.errors.push(`${path}.notes[${i}] must be a string`);
      return '';
    }
    return n.slice(0, 2_000);
  });

  if (!id || !receivedOn || !jurisdiction || !type || !stage || !requester || !identity) return undefined;
  const request: RightsRequest = {
    id,
    receivedOn,
    jurisdiction: jurisdiction as RightsRequest['jurisdiction'],
    type: type as RightsRequest['type'],
    requester: {
      pseudonym: requester.pseudonym,
      email: requester.email,
      ...(requester.accountId ? { accountId: requester.accountId } : {}),
      ...(requester.ageBand ? { ageBand: requester.ageBand as 'adult' | 'minor' | 'unknown' } : {}),
    },
    stage: stage as RightsRequest['stage'],
    identity: identity as RightsRequest['identity'],
    holds,
    systemResults,
    history,
    notes,
    ...(extension ? { extension } : {}),
    ...(rejectReason ? { rejectReason: rejectReason as RightsRequest['rejectReason'] } : {}),
    ...(closedOn ? { closedOn } : {}),
  };
  return request;
}

/**
 * Parses and validates a case file. Checks size and nesting before trusting the structure,
 * validates every enum and date, rejects duplicate ids, and copies only known properties so
 * unexpected keys never flow into application state.
 */
export function parseCaseFile(text: string, overrides: Partial<ImportLimits> = {}): ParseResult {
  const limits = { ...DEFAULT_LIMITS, ...overrides };
  const bytes = new TextEncoder().encode(text).length;
  if (bytes > limits.maxBytes) {
    return { ok: false, errors: [`File is ${bytes.toLocaleString('en-US')} bytes; the limit is ${limits.maxBytes.toLocaleString('en-US')} bytes.`] };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { ok: false, errors: [`Not valid JSON: ${(e as Error).message}`] };
  }
  if (exceedsDepth(raw, limits.maxDepth)) {
    return { ok: false, errors: [`Object nesting deeper than ${limits.maxDepth} levels is not accepted.`] };
  }
  const ctx = new Ctx(limits);
  const root = ctx.obj(raw, 'casefile');
  if (!root) return { ok: false, errors: ctx.errors };
  ctx.str(root, 'schema', 'casefile', { enumSet: new Set(['petitio.casefile']) });
  ctx.int(root, 'version', 'casefile', 1, 1);
  const asOf = ctx.str(root, 'asOf', 'casefile', { pattern: ISO_DATE }) ?? '';

  const systems = ctx.arr(root, 'systems', 'casefile', limits.maxSystems).map((s, i): SystemOfRecord | undefined => {
    const o = ctx.obj(s, `casefile.systems[${i}]`);
    if (!o) return undefined;
    const id = ctx.str(o, 'id', `casefile.systems[${i}]`);
    const name = ctx.str(o, 'name', `casefile.systems[${i}]`);
    const description = ctx.str(o, 'description', `casefile.systems[${i}]`, { allowEmpty: true }) ?? '';
    return id && name ? { id, name, description } : undefined;
  }).filter((s): s is SystemOfRecord => Boolean(s));
  if (systems.length === 0) ctx.errors.push('casefile.systems must list at least one system of record');

  const requestsRaw = root['requests'];
  if (!Array.isArray(requestsRaw)) {
    ctx.errors.push('casefile.requests must be an array');
    return { ok: false, errors: ctx.errors };
  }
  if (requestsRaw.length > limits.maxRequests) {
    return { ok: false, errors: [`casefile.requests has ${requestsRaw.length} items; the limit is ${limits.maxRequests}.`] };
  }
  const requests = requestsRaw.map((r, i) => parseRequest(ctx, r, `casefile.requests[${i}]`)).filter((r): r is RightsRequest => Boolean(r));

  const seen = new Set<string>();
  for (const r of requests) {
    if (seen.has(r.id)) ctx.errors.push(`Duplicate request id "${r.id}"`);
    seen.add(r.id);
    for (const result of r.systemResults) {
      if (!systems.some((s) => s.id === result.systemId)) ctx.warnings.push(`${r.id}: result for unknown system "${result.systemId}"`);
    }
  }

  if (ctx.errors.length > 0) return { ok: false, errors: ctx.errors.slice(0, 50) };
  return { ok: true, file: { schema: 'petitio.casefile', version: 1, asOf, systems, requests }, warnings: ctx.warnings };
}

export function serializeCaseFile(file: CaseFile): string {
  return JSON.stringify(file, null, 2);
}
