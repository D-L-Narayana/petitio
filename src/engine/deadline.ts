import type { DeadlineAssessment, Jurisdiction, JurisdictionProfile, RightsRequest } from './types';
import { WorkflowError } from './types';

/**
 * Jurisdiction profiles. These encode statutory windows as documented in the README
 * (GDPR Art. 12(3), CCPA Cal. Civ. Code 1798.130(a)(2)). They are educational defaults,
 * not legal advice, and are deliberately editable fixtures rather than hidden constants.
 */
export const PROFILES: Record<Jurisdiction, JurisdictionProfile> = {
  'EU-GDPR': {
    id: 'EU-GDPR',
    label: 'EU GDPR',
    window: { kind: 'calendar-months', months: 1 },
    extension: { kind: 'calendar-months', months: 2 },
    extensionNoticeWithinInitialWindow: true,
    citation: 'GDPR Art. 12(3): one month of receipt, extendable by two further months where necessary.',
  },
  'UK-GDPR': {
    id: 'UK-GDPR',
    label: 'UK GDPR',
    window: { kind: 'calendar-months', months: 1 },
    extension: { kind: 'calendar-months', months: 2 },
    extensionNoticeWithinInitialWindow: true,
    citation: 'UK GDPR Art. 12(3) mirrors the EU text; ICO guidance uses the corresponding calendar date rule.',
  },
  'US-CA-CCPA': {
    id: 'US-CA-CCPA',
    label: 'California CCPA/CPRA',
    window: { kind: 'calendar-days', days: 45 },
    extension: { kind: 'calendar-days', days: 45 },
    extensionNoticeWithinInitialWindow: true,
    citation: 'Cal. Civ. Code 1798.130(a)(2): 45 days, extendable once by 45 days with notice in the first 45-day period.',
  },
};

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

function addWindow(iso: string, w: JurisdictionProfile['window']): string {
  return w.kind === 'calendar-months' ? addCalendarMonths(iso, w.months) : addCalendarDays(iso, w.days);
}

export function statutoryDueOn(request: RightsRequest): string {
  return addWindow(request.receivedOn, PROFILES[request.jurisdiction].window);
}

export function maxExtensionDays(request: RightsRequest): number {
  const due = statutoryDueOn(request);
  return daysBetween(due, addWindow(due, PROFILES[request.jurisdiction].extension));
}

export const AT_RISK_DAYS = 5;

export function assessDeadline(request: RightsRequest, asOf: string): DeadlineAssessment {
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
  else if (daysRemaining <= AT_RISK_DAYS) status = 'at-risk';
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
  };
}

export interface ExtensionInput {
  reason: string;
  notifiedOn: string;
  /** Optional shorter extension in days; defaults to the profile maximum. */
  days?: number;
}

function isCalendarDate(v: unknown): v is string {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const [y, m, d] = v.split('-').map(Number) as [number, number, number];
  const probe = new Date(Date.UTC(y, m - 1, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d;
}

export function requestExtension(request: RightsRequest, input: ExtensionInput): RightsRequest {
  if (request.extension) {
    throw new WorkflowError('ALREADY_EXTENDED', `${request.id} has already been extended once; the profile allows a single extension.`);
  }
  const profile = PROFILES[request.jurisdiction];
  const statutory = statutoryDueOn(request);
  const max = maxExtensionDays(request);
  const days = input.days ?? max;
  if (!Number.isInteger(days) || days <= 0) {
    throw new WorkflowError('INVALID_EXTENSION_INPUT', `Extension days must be a positive whole number; received ${String(days)}.`);
  }
  if (!input.reason || !input.reason.trim()) {
    throw new WorkflowError('INVALID_EXTENSION_INPUT', 'An extension needs a stated reason; the reason is what the requester is told.');
  }
  if (!isCalendarDate(input.notifiedOn)) {
    throw new WorkflowError('INVALID_EXTENSION_INPUT', `notifiedOn "${String(input.notifiedOn).slice(0, 20)}" is not a real calendar date (YYYY-MM-DD).`);
  }
  if (daysBetween(request.receivedOn, input.notifiedOn) < 0) {
    throw new WorkflowError('INVALID_EXTENSION_INPUT', `Extension notice dated ${input.notifiedOn} is before the request was received on ${request.receivedOn}.`);
  }
  if (days > max) {
    throw new WorkflowError('EXTENSION_TOO_LONG', `Extension of ${days} days exceeds the ${max}-day maximum for ${profile.label} (${max === 45 ? '45 days' : 'two further months'}).`);
  }
  if (profile.extensionNoticeWithinInitialWindow && daysBetween(input.notifiedOn, statutory) < 0) {
    throw new WorkflowError('EXTENSION_TOO_LATE', `Extension notice dated ${input.notifiedOn} is after the initial due date ${statutory}; ${profile.label} requires notice within the initial window.`);
  }
  return {
    ...request,
    extension: { days, reason: input.reason, notifiedOn: input.notifiedOn },
    notes: [...request.notes, `Extension of ${days} days recorded; requester notified on ${input.notifiedOn}.`],
  };
}
