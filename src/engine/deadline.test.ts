import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { addCalendarDays, addCalendarMonths, assessDeadline, daysBetween, PROFILES, requestExtension } from './deadline';
import type { RightsRequest } from './types';
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
