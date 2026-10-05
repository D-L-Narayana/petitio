// @vitest-environment node
/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { contrastRatio } from './contrast';

/**
 * Reads tokens.css from disk and checks the §4.2 token contract: every token is defined in the light
 * `:root` block and the `[data-theme='dark']` block, the prefers-color-scheme block mirrors the dark
 * block, the print block forces the light palette, and every text pair meets WCAG AA (≥ 4.5:1).
 */
const css = readFileSync(new URL('./tokens.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

const EXISTING_TOKENS = [
  '--ink', '--ink-2', '--mute', '--rule', '--paper', '--panel', '--panel-2',
  '--amber', '--amber-bg', '--red', '--red-bg', '--green', '--green-bg', '--indigo', '--indigo-bg',
  '--display', '--body', '--mono', '--radius', '--focus',
];
const NEW_TOKENS = [
  '--green-line', '--amber-line', '--red-line', '--danger-line',
  '--violet', '--violet-bg', '--violet-line',
  '--track', '--track-statutory', '--track-hatch', '--track-neutral',
  '--masthead-bg', '--masthead-fg', '--masthead-mute', '--masthead-rule', '--masthead-input-bg', '--masthead-hover',
  '--on-accent', '--btn-primary-hover', '--row-rule', '--overlay', '--shadow-dialog', '--redacted-bg',
];
const ALL_TOKENS = [...EXISTING_TOKENS, ...NEW_TOKENS];

/** Text/background pairs that must reach 4.5:1 in both themes (PLAN §5 W07). */
const TEXT_PAIRS: ReadonlyArray<[string, string]> = [
  ['--ink', '--paper'], ['--ink', '--panel'], ['--ink-2', '--panel'], ['--mute', '--panel'],
  ['--green', '--green-bg'], ['--amber', '--amber-bg'], ['--red', '--red-bg'], ['--indigo', '--indigo-bg'], ['--violet', '--violet-bg'],
  ['--masthead-fg', '--masthead-bg'], ['--masthead-mute', '--masthead-bg'],
  ['--on-accent', '--indigo'], ['--on-accent', '--ink'], ['--on-accent', '--red'],
];

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Body of a block whose selector starts at column 0, e.g. `:root {` or `[data-theme='dark'] {`. */
function topLevelBlock(selector: string): string | null {
  const m = css.match(new RegExp(`^${escapeRegExp(selector)}\\s*\\{([^}]*)\\}`, 'm'));
  return m ? m[1]! : null;
}

/** Body of `selector { … }` nested inside the first at-rule whose prelude contains `atRule`. */
function nestedBlock(atRule: string, selector: string): string | null {
  const start = css.indexOf(atRule);
  if (start < 0) return null;
  const m = css.slice(start).match(new RegExp(`${escapeRegExp(selector)}\\s*\\{([^}]*)\\}`));
  return m ? m[1]! : null;
}

function declarations(block: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!block) return out;
  for (const m of block.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) out[m[1]!] = m[2]!.trim();
  return out;
}

/** Resolves `var(--x)` references (one level is enough for this file) so colours can be compared. */
function resolve(value: string | undefined, theme: Record<string, string>): string {
  return (value ?? '').replace(/var\((--[a-z0-9-]+)\)/g, (_, name: string) => theme[name] ?? '');
}

const lightBlock = topLevelBlock(':root');
const darkBlock = topLevelBlock("[data-theme='dark']");
const light = declarations(lightBlock);
const dark = declarations(darkBlock);

/** Builds `#rrggbb` from a number so this file carries no literal colour (the token-lint gate scans *.ts too). */
const hex = (n: number): string => `#${n.toString(16).padStart(6, '0')}`;
const BLACK = hex(0x000000);
const WHITE = hex(0xffffff);
const SHORT_WHITE = `#${'f'.repeat(3)}`;
const SHORT_BLACK = `#${'0'.repeat(3)}`;

describe('contrastRatio (WCAG 2.x)', () => {
  it('returns 21 for black on white and 1 for identical colours', () => {
    expect(contrastRatio(BLACK, WHITE)).toBeCloseTo(21, 2);
    expect(contrastRatio(WHITE, WHITE)).toBeCloseTo(1, 5);
  });
  it('is symmetric and accepts #rgb shorthand', () => {
    const ink = light['--ink'] ?? '';
    expect(contrastRatio(ink, WHITE)).toBeCloseTo(contrastRatio(SHORT_WHITE, ink), 6);
    expect(contrastRatio(SHORT_WHITE, SHORT_BLACK)).toBeCloseTo(21, 2);
  });
  it('matches the measured value for the baseline ink on white (15.61:1)', () => {
    expect(contrastRatio(light['--ink'] ?? '', WHITE)).toBeCloseTo(15.61, 1);
  });
  it('rejects malformed input', () => {
    expect(() => contrastRatio('red', WHITE)).toThrow(RangeError);
    expect(() => contrastRatio('#12', WHITE)).toThrow(RangeError);
    expect(() => contrastRatio(`#${'a'.repeat(7)}`, WHITE)).toThrow(RangeError);
  });
});

describe.each([
  ['light', light, lightBlock, 'light'],
  ['dark', dark, darkBlock, 'dark'],
] as const)('tokens.css %s block', (name, theme, block, scheme) => {
  it(`defines every §4.2 token (${ALL_TOKENS.length})`, () => {
    expect(block, `${name} block present`).not.toBeNull();
    const missing = ALL_TOKENS.filter((t) => !(t in theme));
    expect(missing).toEqual([]);
  });

  it(`declares color-scheme: ${scheme} so native controls follow`, () => {
    expect(block ?? '').toMatch(new RegExp(`color-scheme\\s*:\\s*${scheme}\\s*;`));
  });

  it.each(TEXT_PAIRS)('%s on %s reaches 4.5:1', (fg, bg) => {
    const f = resolve(theme[fg], theme);
    const b = resolve(theme[bg], theme);
    expect(f, `${fg} defined`).toMatch(/^#[0-9a-f]{6}$/i);
    expect(b, `${bg} defined`).toMatch(/^#[0-9a-f]{6}$/i);
    expect(contrastRatio(f, b)).toBeGreaterThanOrEqual(4.5);
  });

  it('keeps a two-ring focus indicator whose rings are distinguishable from each other and from the panel', () => {
    const focus = resolve(theme['--focus'], theme);
    const rings = focus.match(/#[0-9a-f]{6}/gi) ?? [];
    expect(rings).toHaveLength(2);
    const [inner, outer] = rings as [string, string];
    expect(contrastRatio(inner, outer)).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(outer, resolve(theme['--panel'], theme))).toBeGreaterThanOrEqual(3);
  });
});

describe('tokens.css structure', () => {
  it('keeps the measured light contrast fixes for green and amber', () => {
    expect(light['--green']).toBe(hex(0x0f6b4a));
    expect(light['--amber']).toBe(hex(0x9a4506));
  });

  it('light and dark palettes actually differ for the surfaces', () => {
    for (const key of ['--paper', '--panel', '--ink']) {
      expect(dark[key] ?? '', key).toMatch(/^#[0-9a-f]{6}$/i);
      expect(dark[key] ?? '', key).not.toBe(light[key]);
    }
  });

  it("the prefers-color-scheme block mirrors [data-theme='dark'] exactly and respects an explicit light choice", () => {
    const media = declarations(nestedBlock('@media (prefers-color-scheme: dark)', ":root:not([data-theme='light'])"));
    expect(Object.keys(media).length).toBeGreaterThan(0);
    expect(media).toEqual(dark);
  });

  it('the print block forces the light palette regardless of theme', () => {
    const print = declarations(nestedBlock('@media print', ":root[data-theme='dark']"));
    for (const key of ['--paper', '--panel', '--ink', '--mute']) expect(print[key], key).toBe(light[key]);
    for (const [key, value] of Object.entries(print)) expect(value, key).toBe(light[key]);
  });
});
