/**
 * Date presentation for the case detail. Pure functions, no React.
 *
 * `formatDate` renders a calendar date the way a desk reads it ("27 Sep 2026"); callers keep the ISO
 * form machine-readable in `<time dateTime>`. `formatTimestamp` keeps history timestamps in their
 * exact `YYYY-MM-DD HH:MM:SS UTC` shape because there the value is an identifier, not a reading aid.
 */

const DATE_PREFIX = /^(\d{4})-(\d{2})-(\d{2})(?:$|T)/;

/** en-GB puts the day first; the UTC time zone keeps the output independent of the viewer's clock. */
const FORMATTER = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

/** "2026-09-27" (or any ISO timestamp) → "27 Sep 2026". Anything that is not a real UTC calendar date comes back unchanged. */
export function formatDate(iso: string): string {
  const match = DATE_PREFIX.exec(iso);
  if (!match) return iso;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return iso;
  const parts = FORMATTER.formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? '';
  // CLDR 42+ abbreviates September as "Sept" in en-GB; a fixed three-letter month keeps the text identical across ICU versions.
  return `${part('day')} ${part('month').slice(0, 3)} ${part('year')}`;
}

/** "2026-09-08T08:30:00Z" → "2026-09-08 08:30:00 UTC" (the history panel's existing rendering). */
export function formatTimestamp(at: string): string {
  return at.replace('T', ' ').replace('Z', ' UTC');
}
