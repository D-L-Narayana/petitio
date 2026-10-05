import { describe, expect, it } from 'vitest';
import { formatDate, formatTimestamp } from './format';

describe('formatDate', () => {
  it('renders an ISO calendar date as day, short month and year, independent of the ICU abbreviation ("Sept" vs "Sep")', () => {
    expect(formatDate('2026-09-27')).toBe('27 Sep 2026');
    expect(formatDate('2026-01-05')).toBe('5 Jan 2026');
    expect(formatDate('2024-02-29')).toBe('29 Feb 2024');
    expect(formatDate('2026-12-31')).toBe('31 Dec 2026');
  });

  it('takes the UTC calendar date from a full timestamp', () => {
    expect(formatDate('2026-09-15T23:30:00Z')).toBe('15 Sep 2026');
  });

  it('returns anything that is not a real calendar date unchanged', () => {
    expect(formatDate('')).toBe('');
    expect(formatDate('soon')).toBe('soon');
    expect(formatDate('2026-02-30')).toBe('2026-02-30');
  });
});

describe('formatTimestamp', () => {
  it('keeps history timestamps machine-shaped with an explicit UTC suffix', () => {
    expect(formatTimestamp('2026-09-08T08:30:00Z')).toBe('2026-09-08 08:30:00 UTC');
  });
});
