import type { DeadlineAssessment, DeadlineOptions, ExtensionEligibility, Jurisdiction, JurisdictionProfile, RightsRequest, WorkflowErrorCode } from './types';
import { isTerminal, WorkflowError } from './types';

/**
 * Jurisdiction profiles. These encode statutory windows as documented in the README
 * (GDPR Art. 12(3), CCPA Cal. Civ. Code 1798.130(a)(2), Va. Code § 59.1-577(B), C.R.S. § 6-1-1306(2)(a),
 * PIPEDA s. 8(3)–(5)). They are educational defaults, not legal advice, and are deliberately editable
 * fixtures rather than hidden constants. Everything else — due dates, extension limits, refusal wording,
 * `JURISDICTION_IDS`, `isJurisdiction()` — is derived from this object, so adding a profile here is the
 * whole change. Every profile models a single extension; the notice rule is per profile.
 */
export const PROFILES: Record<Jurisdiction, JurisdictionProfile> = {
  'EU-GDPR': {
    id: 'EU-GDPR',
    label: 'EU GDPR',
    window: { kind: 'calendar-months', months: 1 },
    extension: { kind: 'calendar-months', months: 2 },
    extensionNoticeWithinInitialWindow: true,
    citation: 'GDPR Art. 12(3): one month of receipt, extendable by two further months where necessary. Educational model, not legal advice.',
  },
  'UK-GDPR': {
    id: 'UK-GDPR',
    label: 'UK GDPR',
    window: { kind: 'calendar-months', months: 1 },
    extension: { kind: 'calendar-months', months: 2 },
    extensionNoticeWithinInitialWindow: true,
    citation: 'UK GDPR Art. 12(3) mirrors the EU text; ICO guidance uses the corresponding calendar date rule. Educational model, not legal advice.',
  },
  'US-CA-CCPA': {
    id: 'US-CA-CCPA',
    label: 'California CCPA/CPRA',
    window: { kind: 'calendar-days', days: 45 },
    extension: { kind: 'calendar-days', days: 45 },
    extensionNoticeWithinInitialWindow: true,
    citation: 'Cal. Civ. Code 1798.130(a)(2): 45 days, extendable once by 45 days with notice in the first 45-day period. Educational model, not legal advice.',
  },
  'US-VA-VCDPA': {
    id: 'US-VA-VCDPA',
    label: 'Virginia VCDPA',
    window: { kind: 'calendar-days', days: 45 },
    extension: { kind: 'calendar-days', days: 45 },
    extensionNoticeWithinInitialWindow: true,
    citation: 'Va. Code § 59.1-577(B): respond within 45 days of receipt; the period may be extended once by 45 additional days when reasonably necessary, provided the consumer is informed within the initial 45-day period. Educational model, not legal advice.',
  },
  'US-CO-CPA': {
    id: 'US-CO-CPA',
    label: 'Colorado CPA',
    window: { kind: 'calendar-days', days: 45 },
    extension: { kind: 'calendar-days', days: 45 },
    extensionNoticeWithinInitialWindow: true,
    citation: 'C.R.S. § 6-1-1306(2)(a): respond within 45 days of receipt; the period may be extended by 45 additional days when reasonably necessary, provided the consumer is informed within the initial 45-day period (modelled as a single extension). Educational model, not legal advice.',
  },
  'CA-PIPEDA': {
    id: 'CA-PIPEDA',
    label: 'Canada PIPEDA',
    window: { kind: 'calendar-days', days: 30 },
    extension: { kind: 'calendar-days', days: 30 },
    extensionNoticeWithinInitialWindow: true,
    citation: 'PIPEDA s. 8(3)–(5): respond no later than 30 days after receipt; s. 8(4)(a) allows an extension of at most 30 days (where the time limit would unreasonably interfere with the organization\'s activities, or necessary consultations make it impracticable), with the notice of extension sent within the first 30 days (measured here from the receipt date); s. 8(5) deems an unanswered request refused. Only that single capped 30-day extension is modelled; the open-ended s. 8(4)(b) extension for converting information into an alternative format is not modelled, and consultations are modelled only within the 30-day cap. Educational model, not legal advice.',
  },
};

/** Every profile key in declaration order — the single source for selects, importers and validators. */
export const JURISDICTION_IDS: readonly Jurisdiction[] = Object.freeze(Object.keys(PROFILES) as Jurisdiction[]);

const JURISDICTION_SET: ReadonlySet<string> = new Set<string>(JURISDICTION_IDS);

/** True only for a declared profile key. A Set lookup, so inherited names such as "constructor" or "__proto__" are rejected. */
export function isJurisdiction(v: unknown): v is Jurisdiction {
  return typeof v === 'string' && JURISDICTION_SET.has(v);
}

// ---------------------------------------------------------------------------------------------
// Wording derived from profile data (used in refusal messages; available to the UI)
// ---------------------------------------------------------------------------------------------

const NUMBER_WORDS: readonly string[] = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];

function numberWord(n: number): string {
  return (Number.isInteger(n) && n >= 0 ? NUMBER_WORDS[n] : undefined) ?? String(n);
}

function plural(n: number, noun: string): string {
  return n === 1 ? noun : `${noun}s`;
}

/** "one calendar month" / "45 calendar days": the statutory response window in words. */
export function describeWindow(w: JurisdictionProfile['window']): string {
  return w.kind === 'calendar-months' ? `${numberWord(w.months)} calendar ${plural(w.months, 'month')}` : `${w.days} calendar ${plural(w.days, 'day')}`;
}

/** "two further calendar months" / "45 additional days": the maximum extension in words. */
export function describeExtension(profile: JurisdictionProfile): string {
  const e = profile.extension;
  return e.kind === 'calendar-months' ? `${numberWord(e.months)} further calendar ${plural(e.months, 'month')}` : `${e.days} additional ${plural(e.days, 'day')}`;
}

// ---------------------------------------------------------------------------------------------
// Calendar arithmetic (unchanged semantics)
// ---------------------------------------------------------------------------------------------

const DAY_MS = 86_400_000;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function toUtc(iso: string): Date {
  if (!ISO_DATE.test(iso)) throw new RangeError(`Expected YYYY-MM-DD, got "${iso}"`);
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) {
    throw new RangeError(`Not a real calendar date: "${iso}"`);
  }
  return date;
}

function fromUtc(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function addCalendarDays(iso: string, days: number): string {
  const d = toUtc(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return fromUtc(d);
}

/**
 * Adds calendar months using the "corresponding date" rule: 15 March + 1 month = 15 April;
 * when the target month is shorter the last day of that month is used (31 Jan + 1 month = 28/29 Feb).
 */
export function addCalendarMonths(iso: string, months: number): string {
  const d = toUtc(iso);
  const day = d.getUTCDate();
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return fromUtc(target);
}

/** Whole days from `a` to `b` (positive when `b` is later). */
export function daysBetween(a: string, b: string): number {
  return Math.round((toUtc(b).getTime() - toUtc(a).getTime()) / DAY_MS);
}

/** True only for a real calendar date in YYYY-MM-DD form (2026-02-30 is rejected). */
function isCalendarDate(v: unknown): v is string {
  if (typeof v !== 'string' || !ISO_DATE.test(v)) return false;
  const [y, m, d] = v.split('-').map(Number) as [number, number, number];
  const probe = new Date(Date.UTC(y, m - 1, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d;
}

function addWindow(iso: string, w: JurisdictionProfile['window']): string {
  return w.kind === 'calendar-months' ? addCalendarMonths(iso, w.months) : addCalendarDays(iso, w.days);
}

// ---------------------------------------------------------------------------------------------
// Due dates
// ---------------------------------------------------------------------------------------------

export function statutoryDueOn(request: RightsRequest): string {
  return addWindow(request.receivedOn, PROFILES[request.jurisdiction].window);
}

export function maxExtensionDays(request: RightsRequest): number {
  const due = statutoryDueOn(request);
  return daysBetween(due, addWindow(due, PROFILES[request.jurisdiction].extension));
}

/**
 * Last day on which an extension notice may be given. Profiles with `extensionNoticeWithinInitialWindow`
 * (every shipped profile) require it on or before the statutory due date. For a profile without that rule
 * the model allows notice up to the last day of the maximum extended window (statutory due date plus the
 * profile's extension) — the latest possible effective due date; a notice after it could extend nothing.
 */
function noticeDeadlineFrom(profile: JurisdictionProfile, statutory: string): string {
  return profile.extensionNoticeWithinInitialWindow ? statutory : addWindow(statutory, profile.extension);
}

export function noticeDeadlineOn(request: RightsRequest): string {
  return noticeDeadlineFrom(PROFILES[request.jurisdiction], statutoryDueOn(request));
}

// ---------------------------------------------------------------------------------------------
// Assessment
// ---------------------------------------------------------------------------------------------

export const AT_RISK_DAYS = 5;

/** Closed requests with a real `closedOn`: on time when closed on or before the effective due date, otherwise late by N whole days. */
function closureOutcomeOf(request: RightsRequest, effectiveDueOn: string): Pick<DeadlineAssessment, 'closureOutcome' | 'daysLateAtClose'> {
  if (request.stage !== 'closed' || !isCalendarDate(request.closedOn)) return {};
  const daysLate = daysBetween(effectiveDueOn, request.closedOn);
  return daysLate > 0 ? { closureOutcome: 'late', daysLateAtClose: daysLate } : { closureOutcome: 'on-time' };
}

/**
 * Deadline position relative to `asOf`. `options.atRiskDays` (default `AT_RISK_DAYS`) sets how many days
 * before the effective due date count as at-risk; the due day itself is always at-risk when not overdue.
 */
export function assessDeadline(request: RightsRequest, asOf: string, options?: DeadlineOptions): DeadlineAssessment {
  const atRiskDays = options?.atRiskDays ?? AT_RISK_DAYS;
  if (!Number.isFinite(atRiskDays) || atRiskDays < 0) {
    throw new RangeError(`atRiskDays must be a finite number of days >= 0, got ${String(atRiskDays)}`);
  }
  const profile = PROFILES[request.jurisdiction];
  const statutory = statutoryDueOn(request);
  const effective = request.extension ? addCalendarDays(statutory, request.extension.days) : statutory;
  const totalWindowDays = daysBetween(request.receivedOn, effective);
  const daysElapsed = daysBetween(request.receivedOn, asOf);
  const daysRemaining = daysBetween(asOf, effective);
  const progress = totalWindowDays <= 0 ? 1 : Math.min(1, Math.max(0, daysElapsed / totalWindowDays));

  let status: DeadlineAssessment['status'];
  if (request.stage === 'closed') status = 'closed';
  else if (request.stage === 'rejected') status = 'rejected';
  else if (daysRemaining < 0) status = 'overdue';
  else if (daysRemaining <= atRiskDays) status = 'at-risk';
  else status = 'on-track';

  return {
    statutoryDueOn: statutory,
    effectiveDueOn: effective,
    extended: Boolean(request.extension),
    daysRemaining,
    daysElapsed,
    totalWindowDays,
    status,
    progress,
    noticeDeadlineOn: noticeDeadlineFrom(profile, statutory),
    ...closureOutcomeOf(request, effective),
  };
}

// ---------------------------------------------------------------------------------------------
// Extensions: one guard table shared by extensionEligibility() and requestExtension()
// ---------------------------------------------------------------------------------------------

export interface ExtensionInput {
  reason: string;
  notifiedOn: string;
  /** Optional shorter extension in days; defaults to the profile maximum. */
  days?: number;
}

type EligibilityCode = NonNullable<ExtensionEligibility['code']>;

interface Refusal<C extends WorkflowErrorCode = WorkflowErrorCode> {
  code: C;
  message: string;
}

interface ExtensionGuardContext {
  request: RightsRequest;
  profile: JurisdictionProfile;
  statutory: string;
  noticeDeadline: string;
  /** Profile maximum in days, measured from the statutory due date. */
  max: number;
  /** Requested length in days (defaults to the maximum). */
  days: number;
  /** Raw analyst input; validated by the input guards before any date arithmetic touches it. */
  reason: unknown;
  notifiedOn: unknown;
  /** Session clock. When present, a notice may not be dated after it. */
  asOf: string | undefined;
}

type Guard<C extends WorkflowErrorCode = WorkflowErrorCode> = (ctx: ExtensionGuardContext) => Refusal<C> | undefined;

/** Request is still open: closed and rejected requests cannot be extended. */
const notTerminal: Guard<'EXTENSION_NOT_ALLOWED'> = ({ request }) =>
  isTerminal(request.stage)
    ? { code: 'EXTENSION_NOT_ALLOWED', message: `${request.id} is ${request.stage} and cannot be extended; an extension can only be recorded on an open request.` }
    : undefined;

/** Every profile allows a single extension. */
const notAlreadyExtended: Guard<'ALREADY_EXTENDED'> = ({ request }) =>
  request.extension ? { code: 'ALREADY_EXTENDED', message: `${request.id} has already been extended once; the profile allows a single extension.` } : undefined;

const daysArePositiveInteger: Guard<'INVALID_EXTENSION_INPUT'> = ({ days }) =>
  !Number.isInteger(days) || days <= 0 ? { code: 'INVALID_EXTENSION_INPUT', message: `Extension days must be a positive whole number; received ${String(days)}.` } : undefined;

const reasonIsStated: Guard<'INVALID_EXTENSION_INPUT'> = ({ reason }) =>
  typeof reason !== 'string' || !reason.trim() ? { code: 'INVALID_EXTENSION_INPUT', message: 'An extension needs a stated reason; the reason is what the requester is told.' } : undefined;

const noticeIsCalendarDate: Guard<'INVALID_EXTENSION_INPUT'> = ({ notifiedOn }) =>
  !isCalendarDate(notifiedOn) ? { code: 'INVALID_EXTENSION_INPUT', message: `notifiedOn "${String(notifiedOn).slice(0, 20)}" is not a real calendar date (YYYY-MM-DD).` } : undefined;

const noticeNotBeforeReceipt: Guard<'INVALID_EXTENSION_INPUT'> = ({ request, notifiedOn }) =>
  daysBetween(request.receivedOn, String(notifiedOn)) < 0
    ? { code: 'INVALID_EXTENSION_INPUT', message: `Extension notice dated ${String(notifiedOn)} is before the request was received on ${request.receivedOn}.` }
    : undefined;

/** Only when the caller passes the session clock: a notice cannot be dated in the future. */
const noticeNotAfterAsOf: Guard<'INVALID_EXTENSION_INPUT'> = ({ notifiedOn, asOf }) =>
  asOf !== undefined && daysBetween(asOf, String(notifiedOn)) > 0
    ? { code: 'INVALID_EXTENSION_INPUT', message: `Extension notice dated ${String(notifiedOn)} is after the as-of date ${asOf}; a notice cannot be dated in the future.` }
    : undefined;

const withinMaximum: Guard<'EXTENSION_TOO_LONG'> = ({ days, max, profile }) =>
  days > max ? { code: 'EXTENSION_TOO_LONG', message: `Extension of ${days} days exceeds the ${max}-day maximum for ${profile.label} (${describeExtension(profile)}).` } : undefined;

/** The notice (or, for eligibility, the as-of date) is on or before the profile's notice deadline. */
const noticeWithinWindow: Guard<'EXTENSION_TOO_LATE'> = ({ profile, statutory, noticeDeadline, notifiedOn }) => {
  const notice = String(notifiedOn);
  if (daysBetween(notice, noticeDeadline) >= 0) return undefined;
  return {
    code: 'EXTENSION_TOO_LATE',
    message: profile.extensionNoticeWithinInitialWindow
      ? `Extension notice dated ${notice} is after the initial due date ${statutory}; ${profile.label} requires notice within the initial window.`
      : `Extension notice dated ${notice} is after ${noticeDeadline}, the last day of the maximum extended window for ${profile.label}; a later notice could not extend the request.`,
  };
};

/**
 * The guard table, in refusal order. `state` guards depend only on the request and the clock and are the
 * ones `extensionEligibility()` evaluates (with the as-of date standing in for the notice date); `input`
 * guards need the analyst's input and run only in `requestExtension()`. Both functions walk this one list,
 * so the pre-emptive explanation and the actual refusal can never disagree.
 */
const EXTENSION_GUARDS: readonly ({ scope: 'state'; guard: Guard<EligibilityCode> } | { scope: 'input'; guard: Guard })[] = [
  { scope: 'state', guard: notTerminal },
  { scope: 'state', guard: notAlreadyExtended },
  { scope: 'input', guard: daysArePositiveInteger },
  { scope: 'input', guard: reasonIsStated },
  { scope: 'input', guard: noticeIsCalendarDate },
  { scope: 'input', guard: noticeNotBeforeReceipt },
  { scope: 'input', guard: noticeNotAfterAsOf },
  { scope: 'input', guard: withinMaximum },
  { scope: 'state', guard: noticeWithinWindow },
];

function guardContext(request: RightsRequest, input: { days?: number; reason: unknown; notifiedOn: unknown }, asOf: string | undefined): ExtensionGuardContext {
  const profile = PROFILES[request.jurisdiction];
  const statutory = statutoryDueOn(request);
  const max = maxExtensionDays(request);
  return { request, profile, statutory, noticeDeadline: noticeDeadlineFrom(profile, statutory), max, days: input.days ?? max, reason: input.reason, notifiedOn: input.notifiedOn, asOf };
}

function firstStateRefusal(ctx: ExtensionGuardContext): Refusal<EligibilityCode> | undefined {
  for (const entry of EXTENSION_GUARDS) {
    if (entry.scope !== 'state') continue;
    const refusal = entry.guard(ctx);
    if (refusal) return refusal;
  }
  return undefined;
}

function firstRefusal(ctx: ExtensionGuardContext): Refusal | undefined {
  for (const entry of EXTENSION_GUARDS) {
    const refusal = entry.guard(ctx);
    if (refusal) return refusal;
  }
  return undefined;
}

/**
 * Explains, before the analyst clicks, whether an extension can still be recorded as of `asOf`
 * (terminal stage → EXTENSION_NOT_ALLOWED, already extended → ALREADY_EXTENDED, past the notice
 * deadline → EXTENSION_TOO_LATE). `noticeDeadlineOn` and `maxDays` are always filled in. Throws a
 * RangeError when `asOf` is not a real calendar date.
 */
export function extensionEligibility(request: RightsRequest, asOf: string): ExtensionEligibility {
  toUtc(asOf); // the session clock must be a real date whatever the stage; fail the same way assessDeadline does
  const ctx = guardContext(request, { reason: 'eligibility check', notifiedOn: asOf }, asOf);
  const refusal = firstStateRefusal(ctx);
  const verdict: ExtensionEligibility = { eligible: refusal === undefined, noticeDeadlineOn: ctx.noticeDeadline, maxDays: ctx.max };
  return refusal ? { ...verdict, code: refusal.code, reason: refusal.message } : verdict;
}

/**
 * Records a single extension after every guard in `EXTENSION_GUARDS` passes, in order: terminal stage,
 * already extended, days a positive whole number, reason stated, notice a real date, notice not before
 * receipt, notice not after `asOf` (only when `asOf` is given), days within the profile maximum, notice on
 * or before the notice deadline. Refusals are `WorkflowError`s with the codes above.
 */
export function requestExtension(request: RightsRequest, input: ExtensionInput, asOf?: string): RightsRequest {
  const ctx = guardContext(request, input, asOf);
  const refusal = firstRefusal(ctx);
  if (refusal) throw new WorkflowError(refusal.code, refusal.message);
  const notifiedOn = String(ctx.notifiedOn);
  return {
    ...request,
    extension: { days: ctx.days, reason: input.reason, notifiedOn },
    notes: [...request.notes, `Extension of ${ctx.days} days recorded; requester notified on ${notifiedOn}.`],
  };
}
