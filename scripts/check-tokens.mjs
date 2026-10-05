#!/usr/bin/env node
/**
 * check-tokens.mjs — design-token gate.
 *
 * Fails when a literal colour (#hex, rgb(), rgba(), hsl(), hsla()) appears in any .css, .ts or .tsx
 * file under src/ other than src/theme/tokens.css, or when an inline `style={{` appears in a .tsx
 * file other than src/ui/Ribbon.tsx (its computed track widths are the one agreed exception).
 * Comments are stripped before matching; string literals are not, so a colour inside a style prop,
 * a CSS-in-JS string or a generated-HTML stylesheet still counts.
 *
 * Scope: production sources only. Test files (*.test.ts, *.test.tsx) and everything under src/test/
 * are skipped, because tests legitimately pass hex colours as inputs (for example the WCAG contrast
 * utility tests). The matcher itself is shown in `--self-test`.
 *
 * Usage:
 *   node scripts/check-tokens.mjs               scan src/; exit code 1 on any violation
 *   node scripts/check-tokens.mjs --self-test   run the matchers against built-in samples
 *   node scripts/check-tokens.mjs --src <dir>   scan another tree laid out like src/
 *
 * Output: <file>:<line>: <reason>. Dependency-free; Node >= 20 (ESM).
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** Paths are relative to the scanned src/ directory, POSIX separators. */
const TOKENS_FILE = 'theme/tokens.css';
const INLINE_STYLE_EXEMPT = new Set(['ui/Ribbon.tsx']);
const COLOUR_FILES = /\.(?:css|ts|tsx)$/;
const INLINE_STYLE_FILES = /\.tsx$/;
const COLOUR_RE = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?)\(/g;
const INLINE_STYLE_RE = /style=\{\{/g;

function toPosix(p) {
  return p.split(sep).join('/');
}

function display(file) {
  const rel = relative(ROOT, file);
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? toPosix(rel) : file;
}

function optionValue(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

/** Test code is out of scope: `src/test/**` and any `*.test.ts(x)` (paths relative to src/, POSIX). */
function isTestPath(relPath) {
  return relPath.startsWith('test/') || /\.test\.(?:ts|tsx)$/.test(relPath);
}

function* walk(dir) {
  const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.isFile()) yield full;
  }
}

/** Removes CSS block comments while preserving line numbers. */
function stripCssComments(text) {
  let out = '';
  let i = 0;
  while (i < text.length) {
    if (text[i] === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end < 0 ? text.length : end + 2;
      out += text.slice(i, stop).replace(/[^\n]/g, '');
      i = stop;
    } else {
      out += text[i];
      i += 1;
    }
  }
  return out;
}

/**
 * Removes block and line comments from TS/TSX while preserving line numbers. Strings are kept.
 * Conservative: a `//` only starts a comment at line start or after whitespace, so URLs survive;
 * quoted strings end at a newline so an apostrophe in JSX text cannot swallow a file.
 */
function stripJsComments(text) {
  let out = '';
  let mode = 'code'; // code | sq | dq | tpl | block | line
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    const next = text[i + 1];
    if (mode === 'code') {
      if (c === '/' && next === '*') { mode = 'block'; i += 1; continue; }
      if (c === '/' && next === '/' && (i === 0 || /\s/.test(text[i - 1]))) { mode = 'line'; i += 1; continue; }
      if (c === '\\') { out += c + (next ?? ''); i += 1; continue; }
      if (c === "'") mode = 'sq';
      else if (c === '"') mode = 'dq';
      else if (c === '`') mode = 'tpl';
      out += c;
      continue;
    }
    if (mode === 'block') {
      if (c === '*' && next === '/') { mode = 'code'; i += 1; continue; }
      if (c === '\n') out += '\n';
      continue;
    }
    if (mode === 'line') {
      if (c === '\n') { mode = 'code'; out += '\n'; }
      continue;
    }
    if (c === '\\') { out += c + (next ?? ''); i += 1; continue; }
    if ((mode === 'sq' && c === "'") || (mode === 'dq' && c === '"') || (mode === 'tpl' && c === '`')) mode = 'code';
    else if (c === '\n' && mode !== 'tpl') mode = 'code';
    out += c;
  }
  return out;
}

function matchesOf(line, re) {
  return [...line.matchAll(re)].map((m) => m[0]);
}

/** Returns [{ line, kind: 'colour' | 'inline-style', found: string[] }] for one file. */
function scanSource(text, relPath) {
  const violations = [];
  const checkColours = COLOUR_FILES.test(relPath) && relPath !== TOKENS_FILE;
  const checkInline = INLINE_STYLE_FILES.test(relPath) && !INLINE_STYLE_EXEMPT.has(relPath);
  if (!checkColours && !checkInline) return violations;
  const stripped = relPath.endsWith('.css') ? stripCssComments(text) : stripJsComments(text);
  stripped.split('\n').forEach((line, index) => {
    if (checkColours) {
      const found = matchesOf(line, COLOUR_RE);
      if (found.length) violations.push({ line: index + 1, kind: 'colour', found });
    }
    if (checkInline) {
      const found = matchesOf(line, INLINE_STYLE_RE);
      if (found.length) violations.push({ line: index + 1, kind: 'inline-style', found });
    }
  });
  return violations;
}

function describe(v) {
  if (v.kind === 'colour') {
    const plural = v.found.length > 1;
    return `literal colour${plural ? 's' : ''} ${v.found.join(', ')} — use ${plural ? 'tokens' : 'a token'} from src/theme/tokens.css`;
  }
  return 'inline style={{ … }} — move it to a class in a tokens-only stylesheet (only src/ui/Ribbon.tsx computed widths are exempt)';
}

function scanTree(srcDir) {
  const violations = [];
  let scanned = 0;
  for (const file of walk(srcDir)) {
    const rel = toPosix(relative(srcDir, file));
    if (!COLOUR_FILES.test(rel) || isTestPath(rel)) continue;
    scanned += 1;
    for (const v of scanSource(readFileSync(file, 'utf8'), rel)) {
      violations.push({ ...v, text: `${display(file)}:${v.line}: ${describe(v)}` });
    }
  }
  return { scanned, violations };
}

// [description, path relative to src/, source, expected "kind@line" entries in order]
const SELF_TEST = [
  ['hex colour in a stylesheet', 'styles.css', '.a { color: #fff; }', ['colour@1']],
  ['eight-digit hex in a stylesheet', 'ui/docket.css', '.a { border-color: #efb4ad80; }', ['colour@1']],
  ['rgba() in a stylesheet', 'styles.css', '.overlay { background: rgba(27, 36, 50, 0.55); }', ['colour@1']],
  ['hsl() in a stylesheet', 'styles.css', '.x { color: hsl(210 20% 50%); }', ['colour@1']],
  ['token references are fine', 'styles.css', '.a { color: var(--ink); background: var(--panel); }', []],
  ['colour inside a CSS comment is ignored', 'styles.css', '.a { color: var(--ink); } /* was #1b2432 */', []],
  ['multi-line CSS comment keeps line numbers', 'styles.css', '/* #fff\n   #000 */\n.a { color: #abc; }', ['colour@3']],
  ['id selectors that are not hex are fine', 'styles.css', '#root { display: grid; } #case-title { margin: 0; }', []],
  ['tokens.css may define colours', 'theme/tokens.css', ':root { --ink: #1b2432; --overlay: rgba(27, 36, 50, 0.55); }', []],
  ['hex string in a component', 'ui/Docket.tsx', "const c = '#1b2432';", ['colour@1']],
  ['rgb() string built in TypeScript', 'theme/contrast.ts', 'const s = `rgb(${r}, ${g}, ${b})`;', ['colour@1']],
  ['hex in a JS comment is ignored', 'ui/Docket.tsx', '// fallback used to be #fff\nconst c = tokens.ink;', []],
  ['CSS id selector in a query string is not a colour', 'ui/detail/useFocusAfterTransition.ts', "document.querySelector('#case-title')?.focus();", []],
  ['hex-parsing regex is not a colour', 'theme/contrast.ts', 'const HEX = /^#([0-9a-f]{6})$/i;', []],
  ['identifiers containing rgb are not rgb(', 'theme/contrast.ts', 'const [r, g, b] = hexToRgb(hex); const t = torgb(x);', []],
  ['inline style in a component', 'ui/CaseDetail.tsx', '<p style={{ margin: 0 }}>x</p>', ['inline-style@1']],
  ['inline style in the ribbon is exempt', 'ui/Ribbon.tsx', '<div className="ribbon-elapsed" style={{ width: `${pct}%` }} />', []],
  ['a colour inside the ribbon is still reported', 'ui/Ribbon.tsx', "<div style={{ width: `${pct}%`, background: '#b42318' }} />", ['colour@1']],
  ['inline style and a colour on one line are both reported', 'ui/detail/PacketPanel.tsx', "<strong style={{ color: '#b42318' }}>late</strong>", ['colour@1', 'inline-style@1']],
  ['a .ts file is checked for colours but not inline styles', 'engine/exports.ts', "const css = 'body { color: #111 }'; const s = 'style={{';", ['colour@1']],
  ['the matcher itself flags a hex colour in a test file (the scanner skips the file, see path checks)', 'theme/tokens.test.ts', "expect(contrastRatio('#1b2432', '#ffffff')).toBeGreaterThan(4.5);", ['colour@1']],
  ['violations on later lines carry their line number', 'ui/detail/detail.css', '.a { color: var(--ink); }\n.b { color: var(--mute); }\n.c { color: #abc; }\n.d { background: rgb(1 2 3); }', ['colour@3', 'colour@4']],
  ['other file types are ignored', 'fixtures/demo-casefile.json', '{ "colour": "#abcdef" }', []],
];

// Scope checks: which paths the tree scan visits. [description, relative path, expected scanned?]
const SCOPE_TEST = [
  ['src/styles.css is scanned', 'styles.css', true],
  ['src/ui/docket.css is scanned', 'ui/docket.css', true],
  ['src/ui/CaseDetail.tsx is scanned', 'ui/CaseDetail.tsx', true],
  ['src/engine/exports.ts is scanned', 'engine/exports.ts', true],
  ['src/theme/tokens.css is visited (colours exempt there, see matcher checks)', 'theme/tokens.css', true],
  ['src/theme/tokens.test.ts is skipped (test file)', 'theme/tokens.test.ts', false],
  ['src/ui/Docket.test.tsx is skipped (test file)', 'ui/Docket.test.tsx', false],
  ['src/test/helpers.tsx is skipped (test directory)', 'test/helpers.tsx', false],
  ['src/test/a11y.test.tsx is skipped (test directory)', 'test/a11y.test.tsx', false],
  ['src/ui/testimonial.tsx is scanned (not a test file)', 'ui/testimonial.tsx', true],
  ['src/fixtures/demo-casefile.json is not a CSS/TS/TSX file', 'fixtures/demo-casefile.json', false],
];

function selfTest() {
  let failures = 0;
  for (const [name, relPath, source, expected] of SELF_TEST) {
    const actual = scanSource(source, relPath).map((v) => `${v.kind}@${v.line}`);
    const ok = actual.length === expected.length && actual.every((e, i) => e === expected[i]);
    if (!ok) failures += 1;
    console.log(`${ok ? 'ok   ' : 'FAIL '} ${name}${ok ? '' : ` — expected [${expected.join(', ')}], got [${actual.join(', ')}]`}`);
  }
  for (const [name, relPath, expected] of SCOPE_TEST) {
    const actual = COLOUR_FILES.test(relPath) && !isTestPath(relPath);
    const ok = actual === expected;
    if (!ok) failures += 1;
    console.log(`${ok ? 'ok   ' : 'FAIL '} ${name}${ok ? '' : ` — expected scanned=${expected}, got ${actual}`}`);
  }
  console.log(`check-tokens --self-test: ${SELF_TEST.length + SCOPE_TEST.length} checks, ${failures} failure(s)`);
  if (failures > 0) process.exitCode = 1;
}

function main(argv) {
  if (argv.includes('--self-test')) {
    selfTest();
    return;
  }
  const srcDir = resolve(ROOT, optionValue(argv, '--src') ?? 'src');
  if (!existsSync(srcDir)) {
    console.error(`check-tokens: ${display(srcDir)} not found`);
    process.exitCode = 1;
    return;
  }
  const { scanned, violations } = scanTree(srcDir);
  for (const v of violations) console.log(v.text);
  const colours = violations.filter((v) => v.kind === 'colour').length;
  const inline = violations.filter((v) => v.kind === 'inline-style').length;
  if (violations.length > 0) {
    console.log(`check-tokens: FAIL — ${violations.length} violation(s) (${colours} line(s) with literal colours, ${inline} line(s) with inline styles) in ${scanned} scanned file(s) under ${display(srcDir)} (tests skipped); only src/${TOKENS_FILE} may define colours and only ${[...INLINE_STYLE_EXEMPT].map((f) => `src/${f}`).join(', ')} may use style={{}}`);
    process.exitCode = 1;
  } else {
    console.log(`check-tokens: OK — ${scanned} file(s) scanned under ${display(srcDir)} (tests skipped); no literal colours outside src/${TOKENS_FILE}; no inline styles outside ${[...INLINE_STYLE_EXEMPT].map((f) => `src/${f}`).join(', ')}`);
  }
}

main(process.argv.slice(2));
