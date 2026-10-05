/** Triggers a browser download of a text blob. No storage API is involved. */
export function downloadText(filename: string, text: string, type = 'application/json'): void {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** Same download path as downloadText, typed as an HTML page (the exported response packet). */
export function downloadHtml(filename: string, html: string): void {
  downloadText(filename, html, 'text/html');
}

/**
 * C0/C1 control characters plus the invisible Unicode formatting characters that can disguise a
 * filename: zero-width spaces and joiners (U+200B-U+200F), line/paragraph separators and bidi
 * controls (U+2028-U+202E), word joiner and invisible operators (U+2060-U+2064), bidi isolates
 * (U+2066-U+2069) and the byte-order mark (U+FEFF). Expressed as code-point ranges rather than a
 * regex literal: a raw U+2028 inside a regex literal is a line terminator and does not compile.
 */
const INVISIBLE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x0000, 0x001f],
  [0x007f, 0x009f],
  [0x200b, 0x200f],
  [0x2028, 0x202e],
  [0x2060, 0x2064],
  [0x2066, 0x2069],
  [0xfeff, 0xfeff],
];

function isInvisible(codePoint: number): boolean {
  return INVISIBLE_RANGES.some(([from, to]) => codePoint >= from && codePoint <= to);
}

/** Path separators, quotes and the punctuation reserved by common filesystems. */
const RESERVED = /[\\/:*?"<>|'`]/g;

/**
 * Makes a user-controlled string (a request id, a date) safe to use as a download filename:
 * control and invisible formatting characters are removed; path separators, quotes and reserved
 * punctuation become '-'; whitespace collapses to '-'; leading dots are dropped (no hidden files,
 * no '..'); the result is capped at 80 characters and falls back to 'export' when nothing usable
 * remains.
 */
export function safeFilename(input: string): string {
  const visible = Array.from(input)
    .filter((ch) => !isInvisible(ch.codePointAt(0) ?? 0))
    .join('');
  const cleaned = visible
    .replace(RESERVED, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '');
  const capped = cleaned.slice(0, 80).replace(/[.-]+$/g, '');
  return capped || 'export';
}
