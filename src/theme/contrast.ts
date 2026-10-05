/**
 * WCAG 2.x contrast arithmetic for sRGB hex colours (#rgb or #rrggbb).
 * Relative luminance follows WCAG 2.1 §1.4.3 (sRGB linearisation, 0.2126/0.7152/0.0722 weights);
 * the ratio is (L1 + 0.05) / (L2 + 0.05) with the lighter colour as L1, so it is symmetric.
 */
const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

function linearise(channel8: number): number {
  const c = channel8 / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** Parses `#rgb` / `#rrggbb` into 0–255 channels; throws RangeError on anything else. */
export function parseHex(hex: string): [r: number, g: number, b: number] {
  const value = hex.trim();
  if (!HEX.test(value)) throw new RangeError(`Expected a #rgb or #rrggbb colour, got ${JSON.stringify(hex)}`);
  const digits = value.slice(1);
  const full = digits.length === 3 ? digits.split('').map((d) => d + d).join('') : digits;
  const n = Number.parseInt(full, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Relative luminance in [0, 1]. */
export function relativeLuminance(hex: string): number {
  const [r, g, b] = parseHex(hex);
  return 0.2126 * linearise(r) + 0.7152 * linearise(g) + 0.0722 * linearise(b);
}

/** Contrast ratio in [1, 21]; order of arguments does not matter. */
export function contrastRatio(hexA: string, hexB: string): number {
  const la = relativeLuminance(hexA);
  const lb = relativeLuminance(hexB);
  const [lighter, darker] = la >= lb ? [la, lb] : [lb, la];
  return (lighter + 0.05) / (darker + 0.05);
}
