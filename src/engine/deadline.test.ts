import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  addCalendarDays,
  addCalendarMonths,
  assessDeadline,
  AT_RISK_DAYS,
  daysBetween,
  describeExtension,
  describeWindow,
  extensionEligibility,
  isJurisdiction,
  JURISDICTION_IDS,
  maxExtensionDays,
  noticeDeadlineOn,
  PROFILES,
  requestExtension,
  statutoryDueOn,
} from './deadline';
import type { RightsRequest, Stage, WorkflowErrorCode } from './types';
import { WorkflowError } from './types';

function baseRequest(overrides: Partial<RightsRequest> = {}): RightsRequest {
  return {
    id: 'REQ-1',
    receivedOn: '2026-01-15',
    jurisdiction: 'EU-GDPR',
    type: 'access',
    requester: { pseudonym: 'subject-a', email: 'a@people.example' },
    stage: 'collecting',
    identity: { method: 'email-loop', attempts: 1, maxAttempts: 3, status: 'passed' },
    holds: [],
    systemResults: [],
    history: [],
    notes: [],
    ...overrides,
  };
}

describe('calendar arithmetic', () => {
  it('adds calendar days across a month boundary', () => {
    expect(addCalendarDays('2026-01-30', 5)).toBe('2026-02-04');
  });

  it('adds a calendar month to the corresponding date', () => {
    expect(addCalendarMonths('2026-03-15', 1)).toBe('2026-04-15');
  });

  it('falls back to the last day when the next month is shorter (ICO-style rule)', () => {
    expect(addCalendarMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addCalendarMonths('2024-01-31', 1)).toBe('2024-02-29');
  });

  it('counts whole days between two dates, signed', () => {
    expect(daysBetween('2026-01-01', '2026-01-31')).toBe(30);
    expect(daysBetween('2026-01-31', '2026-01-01')).toBe(-30);
  });

  it('day arithmetic round-trips for any date and offset (property)', () => {
    fc.assert(
      fc.property(
        fc.date({ min: new Date('2000-01-01T00:00:00Z'), max: new Date('2099-12-31T00:00:00Z'), noInvalidDate: true }),
        fc.integer({ min: -5000, max: 5000 }),
        (d, n) => {
          const iso = d.toISOString().slice(0, 10);
          const moved = addCalendarDays(iso, n);
          return daysBetween(iso, moved) === n;
        },
      ),
    );
  });
});

describe('jurisdiction profiles', () => {
  it('encodes the GDPR one-month window with a two-month extension', () => {
    expect(PROFILES['EU-GDPR'].window).toEqual({ kind: 'calendar-months', months: 1 });
    expect(PROFILES['EU-GDPR'].extension).toEqual({ kind: 'calendar-months', months: 2 });
  });

  it('encodes the CCPA 45-day window with a single 45-day extension', () => {
    expect(PROFILES['US-CA-CCPA'].window).toEqual({ kind: 'calendar-days', days: 45 });
    expect(PROFILES['US-CA-CCPA'].extension).toEqual({ kind: 'calendar-days', days: 45 });
  });
});

describe('assessDeadline', () => {
  it('computes a GDPR statutory due date one month after receipt', () => {
    const a = assessDeadline(baseRequest(), '2026-01-20');
    expect(a.statutoryDueOn).toBe('2026-02-15');
    expect(a.effectiveDueOn).toBe('2026-02-15');
    expect(a.extended).toBe(false);
    expect(a.daysRemaining).toBe(26);
    expect(a.status).toBe('on-track');
  });

  it('computes a CCPA due date 45 days after receipt', () => {
    const a = assessDeadline(baseRequest({ jurisdiction: 'US-CA-CCPA', receivedOn: '2026-01-01' }), '2026-01-02');
    expect(a.statutoryDueOn).toBe('2026-02-15');
    expect(a.totalWindowDays).toBe(45);
  });

  it('marks a request at-risk inside the final five days', () => {
    const a = assessDeadline(baseRequest(), '2026-02-11');
    expect(a.daysRemaining).toBe(4);
    expect(a.status).toBe('at-risk');
  });

  it('marks a request overdue after the effective due date', () => {
    const a = assessDeadline(baseRequest(), '2026-02-20');
    expect(a.daysRemaining).toBe(-5);
    expect(a.status).toBe('overdue');
    expect(a.progress).toBe(1);
  });

  it('reports closed and rejected requests without a live clock', () => {
    expect(assessDeadline(baseRequest({ stage: 'closed' }), '2026-03-01').status).toBe('closed');
    expect(assessDeadline(baseRequest({ stage: 'rejected' }), '2026-03-01').status).toBe('rejected');
  });

  it('uses the extended due date once an extension is recorded', () => {
    const extended = requestExtension(baseRequest(), { reason: 'Complex multi-system request', notifiedOn: '2026-02-01' });
    const a = assessDeadline(extended, '2026-03-01');
    expect(a.extended).toBe(true);
    expect(a.effectiveDueOn).toBe('2026-04-15');
    expect(a.status).toBe('on-track');
  });
});

describe('requestExtension input validation (review finding)', () => {
  const ccpa = () => baseRequest({ jurisdiction: 'US-CA-CCPA', receivedOn: '2026-01-01' });
  it('rejects non-finite or non-integer day counts', () => {
    for (const days of [Number.NaN, Number.POSITIVE_INFINITY, 1.5, -3, 0]) {
      expect(() => requestExtension(ccpa(), { reason: 'x', notifiedOn: '2026-01-10', days }), String(days)).toThrowError(WorkflowError);
    }
  });
  it('rejects a blank reason', () => {
    expect(() => requestExtension(ccpa(), { reason: '   ', notifiedOn: '2026-01-10', days: 10 })).toThrowError(/reason/i);
  });
  it('rejects a malformed notice date or one before the request was received', () => {
    expect(() => requestExtension(ccpa(), { reason: 'x', notifiedOn: '2026-02-30', days: 10 })).toThrowError(/notifiedOn|date/i);
    expect(() => requestExtension(ccpa(), { reason: 'x', notifiedOn: 'soon', days: 10 })).toThrowError(/notifiedOn|date/i);
    expect(() => requestExtension(ccpa(), { reason: 'x', notifiedOn: '2025-12-31', days: 10 })).toThrowError(/before|received/i);
  });
});

describe('requestExtension', () => {
  it('rejects a GDPR extension notified after the first month has ended', () => {
    expect(() => requestExtension(baseRequest(), { reason: 'late', notifiedOn: '2026-02-16' })).toThrowError(WorkflowError);
    try {
      requestExtension(baseRequest(), { reason: 'late', notifiedOn: '2026-02-16' });
    } catch (e) {
      expect((e as WorkflowError).code).toBe('EXTENSION_TOO_LATE');
    }
  });

  it('rejects a second extension', () => {
    const once = requestExtension(baseRequest(), { reason: 'complex', notifiedOn: '2026-02-01' });
    expect(() => requestExtension(once, { reason: 'again', notifiedOn: '2026-02-02' })).toThrowError(/already/i);
  });

  it('rejects a CCPA extension longer than 45 days', () => {
    const req = baseRequest({ jurisdiction: 'US-CA-CCPA', receivedOn: '2026-01-01' });
    expect(() => requestExtension(req, { reason: 'x', notifiedOn: '2026-01-10', days: 60 })).toThrowError(/45/);
  });

  it('allows a shorter CCPA extension and records the days', () => {
    const req = baseRequest({ jurisdiction: 'US-CA-CCPA', receivedOn: '2026-01-01' });
    const ext = requestExtension(req, { reason: 'vendor lookup', notifiedOn: '2026-01-10', days: 20 });
    expect(ext.extension?.days).toBe(20);
    expect(assessDeadline(ext, '2026-01-11').effectiveDueOn).toBe('2026-03-07');
  });
});

// ---------------------------------------------------------------------------------------------
// Deadline engine v2 (W01). Everything below is additive to the twenty tests above.
// ---------------------------------------------------------------------------------------------

/** The WorkflowError code a call refuses with, or 'no refusal' when it succeeds (so a missing guard reads as an assertion failure). */
function codeOf(fn: () => unknown): WorkflowErrorCode | 'no refusal' {
  try {
    fn();
    return 'no refusal';
  } catch (e) {
    if (e instanceof WorkflowError) return e.code;
    throw e;
  }
}

function messageOf(fn: () => unknown): string {
  try {
    fn();
    return 'no refusal';
  } catch (e) {
    if (e instanceof WorkflowError) return e.message;
    throw e;
  }
}

const ALL_STAGES: readonly Stage[] = ['received', 'identity-check', 'verified', 'collecting', 'review', 'response-ready', 'closed', 'rejected'];

describe('notice deadline and eligibility', () => {
  it('noticeDeadlineOn equals the statutory due date for every shipped profile (all require notice inside the initial window)', () => {
    expect(JURISDICTION_IDS.length).toBeGreaterThan(0);
    for (const jurisdiction of JURISDICTION_IDS) {
      const r = baseRequest({ jurisdiction, receivedOn: '2026-03-31' });
      expect(PROFILES[jurisdiction].extensionNoticeWithinInitialWindow, jurisdiction).toBe(true);
      expect(noticeDeadlineOn(r), jurisdiction).toBe(statutoryDueOn(r));
    }
    expect(noticeDeadlineOn(baseRequest())).toBe('2026-02-15');
  });

  it('models a profile without the initial-window rule as allowing notice until the maximum extended window ends', () => {
    // PROFILES is documented as an editable fixture; the flag is flipped on the GDPR profile and restored in `finally`.
    const profile = PROFILES['EU-GDPR'];
    profile.extensionNoticeWithinInitialWindow = false;
    try {
      expect(noticeDeadlineOn(baseRequest())).toBe('2026-04-15'); // 2026-02-15 statutory + two further calendar months
      expect(extensionEligibility(baseRequest(), '2026-04-15').eligible).toBe(true);
      expect(extensionEligibility(baseRequest(), '2026-04-16')).toMatchObject({ eligible: false, code: 'EXTENSION_TOO_LATE', noticeDeadlineOn: '2026-04-15' });
      expect(codeOf(() => requestExtension(baseRequest(), { reason: 'x', notifiedOn: '2026-04-16' }))).toBe('EXTENSION_TOO_LATE');
      expect(requestExtension(baseRequest(), { reason: 'x', notifiedOn: '2026-04-15' }).extension?.days).toBe(59);
    } finally {
      profile.extensionNoticeWithinInitialWindow = true;
    }
  });

  it('is eligible before the notice deadline and always fills noticeDeadlineOn and maxDays', () => {
    const verdict = extensionEligibility(baseRequest(), '2026-02-01');
    expect(verdict).toEqual({ eligible: true, noticeDeadlineOn: '2026-02-15', maxDays: 59 });
    expect(verdict.code).toBeUndefined();
    expect(verdict.reason).toBeUndefined();
  });

  it('reports ALREADY_EXTENDED once an extension is recorded', () => {
    const once = requestExtension(baseRequest(), { reason: 'complex', notifiedOn: '2026-02-01' });
    const verdict = extensionEligibility(once, '2026-02-02');
    expect(verdict).toMatchObject({ eligible: false, code: 'ALREADY_EXTENDED', noticeDeadlineOn: '2026-02-15', maxDays: 59 });
    expect(verdict.reason).toMatch(/already/i);
  });

  it('reports EXTENSION_TOO_LATE the day after the notice deadline and stays eligible on the deadline itself', () => {
    expect(extensionEligibility(baseRequest(), '2026-02-15').eligible).toBe(true);
    const verdict = extensionEligibility(baseRequest(), '2026-02-16');
    expect(verdict).toMatchObject({ eligible: false, code: 'EXTENSION_TOO_LATE', noticeDeadlineOn: '2026-02-15', maxDays: 59 });
    expect(verdict.reason).toContain('2026-02-15');
  });

  it('reports EXTENSION_NOT_ALLOWED for terminal stages, ahead of the already-extended check', () => {
    expect(extensionEligibility(baseRequest({ stage: 'closed', closedOn: '2026-02-10' }), '2026-02-01')).toMatchObject({ eligible: false, code: 'EXTENSION_NOT_ALLOWED', noticeDeadlineOn: '2026-02-15', maxDays: 59 });
    expect(extensionEligibility(baseRequest({ stage: 'rejected', rejectReason: 'duplicate' }), '2026-02-01')).toMatchObject({ eligible: false, code: 'EXTENSION_NOT_ALLOWED' });
    const closedAndExtended = baseRequest({ stage: 'closed', closedOn: '2026-02-10', extension: { days: 10, reason: 'x', notifiedOn: '2026-01-20' } });
    expect(extensionEligibility(closedAndExtended, '2026-03-01').code).toBe('EXTENSION_NOT_ALLOWED');
    for (const stage of ALL_STAGES.filter((s) => s !== 'closed' && s !== 'rejected')) {
      expect(extensionEligibility(baseRequest({ stage }), '2026-02-01').eligible, stage).toBe(true);
    }
  });

  it('phrases reasons as full sentences in the WorkflowError voice', () => {
    const notAllowed = extensionEligibility(baseRequest({ stage: 'closed', closedOn: '2026-02-10' }), '2026-02-01').reason ?? '';
    const already = extensionEligibility(baseRequest({ extension: { days: 10, reason: 'x', notifiedOn: '2026-01-20' } }), '2026-02-01').reason ?? '';
    const tooLate = extensionEligibility(baseRequest(), '2026-02-16').reason ?? '';
    for (const reason of [notAllowed, already, tooLate]) expect(reason).toMatch(/^[A-Z].*\.$/);
    expect(notAllowed).toContain('REQ-1');
    expect(notAllowed).toContain('closed');
    expect(already).toContain('REQ-1');
    expect(tooLate).toContain('EU GDPR');
    expect(tooLate).toContain('2026-02-16');
  });
});

describe('requestExtension stage and as-of guards', () => {
  it('refuses to extend a request in a terminal stage with EXTENSION_NOT_ALLOWED', () => {
    const closed = baseRequest({ stage: 'closed', closedOn: '2026-02-10' });
    expect(codeOf(() => requestExtension(closed, { reason: 'late paperwork', notifiedOn: '2026-02-01' }))).toBe('EXTENSION_NOT_ALLOWED');
    expect(messageOf(() => requestExtension(closed, { reason: 'late paperwork', notifiedOn: '2026-02-01' }))).toMatch(/closed/);
    expect(codeOf(() => requestExtension(baseRequest({ stage: 'rejected', rejectReason: 'out-of-scope' }), { reason: 'x', notifiedOn: '2026-02-01' }))).toBe('EXTENSION_NOT_ALLOWED');
  });

  it('refuses a notice dated after asOf when asOf is given, accepts a notice dated on asOf, and ignores the clock when asOf is omitted', () => {
    const r = baseRequest();
    expect(codeOf(() => requestExtension(r, { reason: 'vendor lookup', notifiedOn: '2026-01-20' }, '2026-01-15'))).toBe('INVALID_EXTENSION_INPUT');
    expect(messageOf(() => requestExtension(r, { reason: 'vendor lookup', notifiedOn: '2026-01-20' }, '2026-01-15'))).toMatch(/as-of/);
    expect(requestExtension(r, { reason: 'vendor lookup', notifiedOn: '2026-01-15' }, '2026-01-15').extension?.notifiedOn).toBe('2026-01-15');
    expect(requestExtension(r, { reason: 'vendor lookup', notifiedOn: '2026-01-20' }).extension?.days).toBe(59);
  });

  it('applies guards in the documented order: terminal, extended, input, too long, too late', () => {
    const closedAndExtended = baseRequest({ stage: 'closed', closedOn: '2026-02-10', extension: { days: 10, reason: 'x', notifiedOn: '2026-01-20' } });
    expect(codeOf(() => requestExtension(closedAndExtended, { reason: 'x', notifiedOn: '2026-01-21' }))).toBe('EXTENSION_NOT_ALLOWED');
    const extended = baseRequest({ extension: { days: 10, reason: 'x', notifiedOn: '2026-01-20' } });
    expect(codeOf(() => requestExtension(extended, { reason: '', notifiedOn: 'garbage', days: -1 }))).toBe('ALREADY_EXTENDED');
    expect(codeOf(() => requestExtension(baseRequest(), { reason: 'x', notifiedOn: '2026-02-16', days: 0 }))).toBe('INVALID_EXTENSION_INPUT');
    expect(codeOf(() => requestExtension(baseRequest(), { reason: 'x', notifiedOn: '2026-02-16', days: 100 }))).toBe('EXTENSION_TOO_LONG');
    expect(codeOf(() => requestExtension(baseRequest(), { reason: 'x', notifiedOn: '2026-02-16' }))).toBe('EXTENSION_TOO_LATE');
  });

  it('derives the too-long wording from the profile instead of a hard-coded 45-or-GDPR switch', () => {
    expect(messageOf(() => requestExtension(baseRequest(), { reason: 'x', notifiedOn: '2026-02-01', days: 70 }))).toMatch(/59-day maximum for EU GDPR \(two further calendar months\)/);
    const vcdpa = baseRequest({ jurisdiction: 'US-VA-VCDPA', receivedOn: '2026-09-29' });
    expect(messageOf(() => requestExtension(vcdpa, { reason: 'x', notifiedOn: '2026-10-01', days: 46 }))).toMatch(/45-day maximum for Virginia VCDPA \(45 additional days\)/);
  });
});

describe('assessDeadline closure outcome', () => {
  const closed = (closedOn: string) => baseRequest({ stage: 'closed', closedOn });

  it('marks a request closed before its effective due date as on-time', () => {
    const a = assessDeadline(closed('2026-02-10'), '2026-03-01');
    expect(a.status).toBe('closed');
    expect(a.closureOutcome).toBe('on-time');
    expect(a.daysLateAtClose).toBeUndefined();
  });

  it('marks a request closed after its effective due date as late and counts the days', () => {
    const a = assessDeadline(closed('2026-02-20'), '2026-03-01');
    expect(a.closureOutcome).toBe('late');
    expect(a.daysLateAtClose).toBe(5);
  });

  it('treats closing on the effective due date itself as on-time (boundary)', () => {
    const a = assessDeadline(closed('2026-02-15'), '2026-03-01');
    expect(a.effectiveDueOn).toBe('2026-02-15');
    expect(a.closureOutcome).toBe('on-time');
    expect(a.daysLateAtClose).toBeUndefined();
  });

  it('omits the outcome for open requests and closed requests without closedOn, and measures against the extended due date', () => {
    expect(assessDeadline(baseRequest(), '2026-03-01').closureOutcome).toBeUndefined();
    expect(assessDeadline(baseRequest({ stage: 'closed' }), '2026-03-01').closureOutcome).toBeUndefined();
    expect(assessDeadline(baseRequest({ stage: 'rejected', rejectReason: 'duplicate' }), '2026-03-01').closureOutcome).toBeUndefined();
    const extended = requestExtension(baseRequest(), { reason: 'complex', notifiedOn: '2026-02-01' });
    const a = assessDeadline({ ...extended, stage: 'closed', closedOn: '2026-03-01' }, '2026-03-05');
    expect(a.effectiveDueOn).toBe('2026-04-15');
    expect(a.closureOutcome).toBe('on-time');
  });
});

describe('assessDeadline options', () => {
  it('lets atRiskDays widen or narrow the at-risk band, defaulting to AT_RISK_DAYS', () => {
    const r = baseRequest(); // due 2026-02-15
    expect(AT_RISK_DAYS).toBe(5);
    expect(assessDeadline(r, '2026-02-05').daysRemaining).toBe(10);
    expect(assessDeadline(r, '2026-02-05').status).toBe('on-track');
    expect(assessDeadline(r, '2026-02-05', { atRiskDays: 10 }).status).toBe('at-risk');
    expect(assessDeadline(r, '2026-02-05', { atRiskDays: 9 }).status).toBe('on-track');
    expect(assessDeadline(r, '2026-02-10', {}).status).toBe('at-risk');
  });

  it('with atRiskDays 0 only the due day itself is at-risk', () => {
    const r = baseRequest();
    expect(assessDeadline(r, '2026-02-12', { atRiskDays: 0 }).status).toBe('on-track'); // 3 days left: at-risk under the default band
    expect(assessDeadline(r, '2026-02-14', { atRiskDays: 0 }).status).toBe('on-track');
    expect(assessDeadline(r, '2026-02-15', { atRiskDays: 0 }).status).toBe('at-risk');
    expect(assessDeadline(r, '2026-02-16', { atRiskDays: 0 }).status).toBe('overdue');
  });

  it('rejects a negative or non-finite atRiskDays with a RangeError', () => {
    expect(() => assessDeadline(baseRequest(), '2026-02-05', { atRiskDays: -1 })).toThrow(RangeError);
    expect(() => assessDeadline(baseRequest(), '2026-02-05', { atRiskDays: Number.NaN })).toThrow(RangeError);
    expect(() => assessDeadline(baseRequest(), '2026-02-05', { atRiskDays: Number.POSITIVE_INFINITY })).toThrow(RangeError);
  });

  it('reports noticeDeadlineOn on every assessment, unchanged by a recorded extension', () => {
    expect(assessDeadline(baseRequest(), '2026-02-05').noticeDeadlineOn).toBe('2026-02-15');
    const extended = requestExtension(baseRequest(), { reason: 'complex', notifiedOn: '2026-02-01' });
    const a = assessDeadline(extended, '2026-03-01');
    expect(a.noticeDeadlineOn).toBe('2026-02-15');
    expect(a.effectiveDueOn).toBe('2026-04-15');
    expect(assessDeadline(baseRequest({ stage: 'closed', closedOn: '2026-02-10' }), '2026-03-01').noticeDeadlineOn).toBe('2026-02-15');
  });
});

describe('jurisdiction profiles v2', () => {
  it('US-VA-VCDPA: 45 calendar days, one 45-day extension, notice inside the initial period (Va. Code § 59.1-577(B))', () => {
    expect(PROFILES['US-VA-VCDPA']).toMatchObject({ id: 'US-VA-VCDPA', window: { kind: 'calendar-days', days: 45 }, extension: { kind: 'calendar-days', days: 45 }, extensionNoticeWithinInitialWindow: true });
    expect(PROFILES['US-VA-VCDPA'].citation).toMatch(/59\.1-577\(B\)/);
    const r = baseRequest({ jurisdiction: 'US-VA-VCDPA', receivedOn: '2026-09-29' });
    expect(statutoryDueOn(r)).toBe('2026-11-13');
    expect(maxExtensionDays(r)).toBe(45);
    expect(assessDeadline(r, '2026-10-04')).toMatchObject({ statutoryDueOn: '2026-11-13', effectiveDueOn: '2026-11-13', noticeDeadlineOn: '2026-11-13', totalWindowDays: 45, daysRemaining: 40, status: 'on-track' });
    expect(codeOf(() => requestExtension(r, { reason: 'x', notifiedOn: '2026-10-04', days: 46 }))).toBe('EXTENSION_TOO_LONG');
    expect(codeOf(() => requestExtension(r, { reason: 'x', notifiedOn: '2026-11-14' }))).toBe('EXTENSION_TOO_LATE');
    expect(extensionEligibility(r, '2026-11-14')).toMatchObject({ eligible: false, code: 'EXTENSION_TOO_LATE', noticeDeadlineOn: '2026-11-13', maxDays: 45 });
    const ext = requestExtension(r, { reason: 'archived attachments across three systems', notifiedOn: '2026-11-13' }, '2026-11-13');
    expect(ext.extension?.days).toBe(45);
    expect(assessDeadline(ext, '2026-11-14').effectiveDueOn).toBe('2026-12-28');
  });

  it('US-CO-CPA: 45 days, one 45-day extension, notice inside the initial period (C.R.S. § 6-1-1306(2)(a))', () => {
    expect(PROFILES['US-CO-CPA']).toMatchObject({ id: 'US-CO-CPA', window: { kind: 'calendar-days', days: 45 }, extension: { kind: 'calendar-days', days: 45 }, extensionNoticeWithinInitialWindow: true });
    expect(PROFILES['US-CO-CPA'].citation).toMatch(/6-1-1306\(2\)\(a\)/);
    const r = baseRequest({ jurisdiction: 'US-CO-CPA', receivedOn: '2026-01-01' });
    expect(statutoryDueOn(r)).toBe('2026-02-15');
    expect(maxExtensionDays(r)).toBe(45);
    expect(codeOf(() => requestExtension(r, { reason: 'x', notifiedOn: '2026-01-10', days: 46 }))).toBe('EXTENSION_TOO_LONG');
    expect(codeOf(() => requestExtension(r, { reason: 'x', notifiedOn: '2026-02-16' }))).toBe('EXTENSION_TOO_LATE');
    expect(extensionEligibility(r, '2026-02-15')).toEqual({ eligible: true, noticeDeadlineOn: '2026-02-15', maxDays: 45 });
    expect(assessDeadline(requestExtension(r, { reason: 'x', notifiedOn: '2026-02-15' }), '2026-02-16').effectiveDueOn).toBe('2026-04-01');
  });

  it('CA-PIPEDA: 30 days, extension of up to 30 days with notice in the first 30 days, open-ended format-conversion extension declared unmodelled (PIPEDA s. 8(3)-(5))', () => {
    expect(PROFILES['CA-PIPEDA']).toMatchObject({ id: 'CA-PIPEDA', window: { kind: 'calendar-days', days: 30 }, extension: { kind: 'calendar-days', days: 30 }, extensionNoticeWithinInitialWindow: true });
    expect(PROFILES['CA-PIPEDA'].citation).toMatch(/s\. 8\(3\)/);
    expect(PROFILES['CA-PIPEDA'].citation).toMatch(/8\(4\)\(b\)/);
    expect(PROFILES['CA-PIPEDA'].citation).toMatch(/not modelled/);
    const r = baseRequest({ jurisdiction: 'CA-PIPEDA', receivedOn: '2026-01-15' });
    expect(statutoryDueOn(r)).toBe('2026-02-14');
    expect(maxExtensionDays(r)).toBe(30);
    expect(codeOf(() => requestExtension(r, { reason: 'x', notifiedOn: '2026-01-20', days: 31 }))).toBe('EXTENSION_TOO_LONG');
    expect(codeOf(() => requestExtension(r, { reason: 'x', notifiedOn: '2026-02-15' }))).toBe('EXTENSION_TOO_LATE');
    expect(extensionEligibility(r, '2026-02-14')).toEqual({ eligible: true, noticeDeadlineOn: '2026-02-14', maxDays: 30 });
    expect(assessDeadline(requestExtension(r, { reason: 'x', notifiedOn: '2026-02-14' }), '2026-02-15').effectiveDueOn).toBe('2026-03-16');
  });

  it('JURISDICTION_IDS lists every profile key in declaration order and each profile carries its own key as id', () => {
    expect(JURISDICTION_IDS).toEqual(['EU-GDPR', 'UK-GDPR', 'US-CA-CCPA', 'US-VA-VCDPA', 'US-CO-CPA', 'CA-PIPEDA']);
    expect([...JURISDICTION_IDS]).toEqual(Object.keys(PROFILES));
    for (const id of JURISDICTION_IDS) expect(PROFILES[id].id, id).toBe(id);
  });

  it('isJurisdiction accepts exactly the profile keys and rejects inherited property names', () => {
    for (const id of JURISDICTION_IDS) expect(isJurisdiction(id), id).toBe(true);
    for (const bad of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf', '', 'eu-gdpr', ' EU-GDPR', 'EU-GDPR ']) {
      expect(isJurisdiction(bad), JSON.stringify(bad)).toBe(false);
    }
    for (const bad of [null, undefined, 42, {}, ['EU-GDPR'], Symbol('EU-GDPR')]) expect(isJurisdiction(bad)).toBe(false);
  });

  it('every profile citation names a statute section and ends with the educational-model disclaimer', () => {
    for (const id of JURISDICTION_IDS) {
      const { citation } = PROFILES[id];
      expect(citation.endsWith('Educational model, not legal advice.'), `${id}: ${citation}`).toBe(true);
      expect(citation, id).toMatch(/Art\. 12\(3\)|1798\.130\(a\)\(2\)|§ 59\.1-577\(B\)|§ 6-1-1306\(2\)\(a\)|s\. 8\(3\)/);
    }
  });

  it('describes windows and extensions in words derived from the profile data', () => {
    expect(describeWindow({ kind: 'calendar-months', months: 1 })).toBe('one calendar month');
    expect(describeWindow({ kind: 'calendar-days', days: 45 })).toBe('45 calendar days');
    expect(describeExtension(PROFILES['EU-GDPR'])).toBe('two further calendar months');
    expect(describeExtension(PROFILES['US-CA-CCPA'])).toBe('45 additional days');
    expect(describeExtension(PROFILES['CA-PIPEDA'])).toBe('30 additional days');
  });
});

describe('eligibility refusal property', () => {
  it('extensionEligibility agrees with requestExtension for any profile, receipt date, stage, clock and extension presence', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...JURISDICTION_IDS),
        fc.integer({ min: -3000, max: 3000 }),
        fc.integer({ min: 0, max: 400 }),
        fc.boolean(),
        fc.constantFrom(...ALL_STAGES),
        (jurisdiction, receivedOffset, asOfOffset, extended, stage) => {
          const receivedOn = addCalendarDays('2026-01-01', receivedOffset);
          const asOf = addCalendarDays(receivedOn, asOfOffset);
          const r = baseRequest({
            jurisdiction,
            receivedOn,
            stage,
            ...(extended ? { extension: { days: 1, reason: 'x', notifiedOn: receivedOn } } : {}),
            ...(stage === 'closed' ? { closedOn: asOf } : {}),
          });
          const verdict = extensionEligibility(r, asOf);
          let refusal: WorkflowError | undefined;
          try {
            requestExtension(r, { reason: 'x', notifiedOn: asOf }, asOf);
          } catch (e) {
            if (!(e instanceof WorkflowError)) throw e;
            refusal = e;
          }
          expect(verdict.eligible).toBe(refusal === undefined);
          if (refusal) expect(verdict.code).toBe(refusal.code);
          expect(verdict.noticeDeadlineOn).toBe(noticeDeadlineOn(r));
          expect(verdict.maxDays).toBe(maxExtensionDays(r));
        },
      ),
      { numRuns: 300 },
    );
  });
});
