import { formatDate } from './format';

/** A calendar date as people read it ("27 Sep 2026"), with the ISO form kept machine-readable in `dateTime`. */
export function DateText({ iso }: { iso: string }) {
  return <time dateTime={iso}>{formatDate(iso)}</time>;
}
