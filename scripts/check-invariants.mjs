#!/usr/bin/env node
/**
 * check-invariants.mjs — CI gate for Petitio's two structural promises.
 *
 *  1. Browser-local. Nothing under src/ may call a network or storage API
 *     (fetch, XMLHttpRequest, WebSocket, EventSource, sendBeacon, localStorage,
 *     sessionStorage, indexedDB, document.cookie) or inject raw HTML
 *     (dangerouslySetInnerHTML). See README "Data handling".
 *  2. Pure engine. src/engine/**, src/state/session.ts and src/state/auditQueue.ts
 *     import nothing from React and never touch document, window or navigator,
 *     so the rules stay unit-testable without a DOM.
 *
 * Test files (*.test.ts, *.test.tsx) and src/test/ are skipped: they may stub these APIs.
 * Comments are stripped before matching; string literals are not, so
 * window['localStorage'] still counts. Missing zone paths are skipped.
 *
 * Usage:
 *   node scripts/check-invariants.mjs              scan src/; exit code 1 on any violation
 *   node scripts/check-invariants.mjs --self-test  run the matcher against built-in samples
 *   node scripts/check-invariants.mjs --src <dir>  scan another tree laid out like src/
 *
 * Output: <file>:<line>: <reason>. Dependency-free; Node >= 20 (ESM).
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CODE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
/** Paths are relative to the scanned src/ directory, POSIX separators. */
const PURE_DIRECTORIES = ['engine'];
const PURE_FILES = new Set(['state/session.ts', 'state/auditQueue.ts']);

/** Forbidden everywhere under src/. */
const FORBIDDEN_RULES = [
  { id: 'fetch(', kind: 'forbidden API', re: /\bfetch\s*\(/, why: 'no network calls after load' },
  { id: 'XMLHttpRequest', kind: 'forbidden API', re: /XMLHttpRequest/, why: 'no network calls after load' },
  { id: 'WebSocket', kind: 'forbidden API', re: /WebSocket/, why: 'no network connections' },
  { id: 'EventSource', kind: 'forbidden API', re: /EventSource/, why: 'no network connections' },
  { id: 'sendBeacon', kind: 'forbidden API', re: /sendBeacon/, why: 'no network calls after load' },
  { id: 'localStorage', kind: 'forbidden API', re: /localStorage/, why: 'no browser storage; state lives in memory' },
  { id: 'sessionStorage', kind: 'forbidden API', re: /sessionStorage/, why: 'no browser storage; state lives in memory' },
  { id: 'indexedDB', kind: 'forbidden API', re: /indexedDB/, why: 'no browser storage; state lives in memory' },
  { id: 'document.cookie', kind: 'forbidden API', re: /\bdocument\s*(?:\.\s*cookie\b|\[\s*['"]cookie['"]\s*\])/, why: 'no browser storage; state lives in memory' },
  { id: 'dangerouslySetInnerHTML', kind: 'forbidden API', re: /dangerouslySetInnerHTML/, why: 'no raw HTML injection; React escapes rendered strings' },
];

/** Additionally forbidden in the pure zone (engine + session store). */
const PURITY_RULES = [
  { id: 'react import', kind: 'impure reference', re: /(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"](?:react|react-dom)(?:\/[^'"]*)?['"]/, why: 'pure modules import nothing from React' },
  { id: 'react-dom', kind: 'impure reference', re: /react-dom/, after: 'react import', why: 'pure modules import nothing from React' },
  { id: 'document.', kind: 'impure reference', re: /(?<![\w$.])document\s*\.\s*[A-Za-z_$]/, why: 'pure modules do not touch the DOM' },
  { id: 'window.', kind: 'impure reference', re: /(?<![\w$.])window\s*\.\s*[A-Za-z_$]/, why: 'pure modules do not touch the DOM' },
  { id: 'navigator.', kind: 'impure reference', re: /(?<![\w$.])navigator\s*\.\s*[A-Za-z_$]/, why: 'pure modules do not touch the browser' },
  { id: 'globalThis.<dom>', kind: 'impure reference', re: /\bglobalThis\s*\.\s*(?:window|document|navigator)\b/, why: 'pure modules do not touch the DOM' },
];

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

function* walk(dir) {
  const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.isFile()) yield full;
  }
}

function extensionOf(p) {
  const i = p.lastIndexOf('.');
  return i < 0 ? '' : p.slice(i);
}

function isTestPath(relPath) {
  return relPath.startsWith('test/') || /\.test\.(?:ts|tsx|js|jsx|mjs|cjs)$/.test(relPath);
}

function isPurePath(relPath) {
  return PURE_DIRECTORIES.some((d) => relPath.startsWith(`${d}/`)) || PURE_FILES.has(relPath);
}

/**
 * Removes block and line comments while preserving line numbers. Strings are kept.
 * Conservative: a `//` only starts a comment at line start or after whitespace, so URLs
 * survive; quoted strings end at a newline so an apostrophe in JSX text cannot swallow a file.
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
    // inside a string literal
    if (c === '\\') { out += c + (next ?? ''); i += 1; continue; }
    if ((mode === 'sq' && c === "'") || (mode === 'dq' && c === '"') || (mode === 'tpl' && c === '`')) mode = 'code';
    else if (c === '\n' && mode !== 'tpl') mode = 'code';
    out += c;
  }
  return out;
}

/** Returns [{ line, id, kind, why }] for one source text. */
function scanSource(text, { pure }) {
  const rules = pure ? [...FORBIDDEN_RULES, ...PURITY_RULES] : FORBIDDEN_RULES;
  const violations = [];
  stripJsComments(text).split('\n').forEach((line, index) => {
    const hit = new Set();
    for (const rule of rules) {
      if (rule.after && hit.has(rule.after)) continue;
      if (rule.re.test(line)) {
        hit.add(rule.id);
        violations.push({ line: index + 1, id: rule.id, kind: rule.kind, why: rule.why });
      }
    }
  });
  return violations;
}

function scanTree(srcDir) {
  const violations = [];
  let scanned = 0;
  for (const file of walk(srcDir)) {
    const rel = toPosix(relative(srcDir, file));
    if (!CODE_EXTENSIONS.has(extensionOf(rel)) || isTestPath(rel)) continue;
    scanned += 1;
    for (const v of scanSource(readFileSync(file, 'utf8'), { pure: isPurePath(rel) })) {
      violations.push(`${display(file)}:${v.line}: ${v.kind} "${v.id}" — ${v.why}`);
    }
  }
  return { scanned, violations };
}

// [description, zone ('ui' | 'pure'), source, expected rule ids in order]
const SELF_TEST = [
  ['fetch call', 'ui', "export async function load() { return fetch('/api/x'); }", ['fetch(']],
  ['window.fetch call', 'ui', 'const r = window.fetch(url);', ['fetch(']],
  ['XMLHttpRequest', 'ui', 'const xhr = new XMLHttpRequest();', ['XMLHttpRequest']],
  ['WebSocket', 'ui', "const ws = new WebSocket('wss://example.invalid');", ['WebSocket']],
  ['EventSource', 'ui', "new EventSource('/events');", ['EventSource']],
  ['sendBeacon', 'ui', "navigator.sendBeacon('/log', body);", ['sendBeacon']],
  ['localStorage', 'ui', "window.localStorage.setItem('theme', 'dark');", ['localStorage']],
  ['sessionStorage', 'ui', "const v = sessionStorage.getItem('k');", ['sessionStorage']],
  ['indexedDB', 'ui', "const req = indexedDB.open('petitio');", ['indexedDB']],
  ['document.cookie', 'ui', "document.cookie = 'a=b';", ['document.cookie']],
  ["document['cookie']", 'ui', "const c = document['cookie'];", ['document.cookie']],
  ['dangerouslySetInnerHTML', 'ui', '<div dangerouslySetInnerHTML={{ __html: html }} />', ['dangerouslySetInnerHTML']],
  ['bracket access through a string literal is still flagged', 'ui', "const s = window['localStorage'];", ['localStorage']],
  ['forbidden token inside a comment is ignored', 'ui', '// never use localStorage here\nconst x = 1; /* fetch( is also banned */', []],
  ['URL in a string is not a comment', 'ui', "const u = 'https://example.invalid/x'; localStorage;", ['localStorage']],
  ['prefetch/refetch are not fetch', 'ui', 'const prefetch = () => 1; prefetch(); refetch();', []],
  ['React import in a UI file is fine', 'ui', "import { useState } from 'react';", []],
  ['document access in a UI file is fine', 'ui', "document.body.appendChild(a);", []],
  ['React import in a pure module', 'pure', "import { useState } from 'react';", ['react import']],
  ['type-only React import in a pure module', 'pure', 'import type { ReactNode } from "react";', ['react import']],
  ['react-dom import in a pure module is reported once', 'pure', "import { createRoot } from 'react-dom/client';", ['react import']],
  ['dynamic React import in a pure module', 'pure', "const R = await import('react');", ['react import']],
  ['document access in a pure module', 'pure', "const el = document.getElementById('root');", ['document.']],
  ['window access in a pure module', 'pure', 'const dark = window.matchMedia("(prefers-color-scheme: dark)");', ['window.']],
  ['navigator access in a pure module', 'pure', 'const lang = navigator.language;', ['navigator.']],
  ['globalThis.document in a pure module', 'pure', 'const t = globalThis.document.title;', ['globalThis.<dom>']],
  ['the word "window." in prose is not DOM access', 'pure', "throw new WorkflowError('EXTENSION_TOO_LATE', `notice must fall inside the initial window.`);", []],
  ['profile.window.kind is a property, not the DOM', 'pure', "const kind = PROFILES[request.jurisdiction].window.kind; const n = windowDays; const d = documentation.title;", []],
  ['two violations on separate lines are both reported', 'pure', "import React from 'react';\nconst t = document.title;", ['react import', 'document.']],
];

function selfTest() {
  let failures = 0;
  for (const [name, zone, source, expected] of SELF_TEST) {
    const actual = scanSource(source, { pure: zone === 'pure' }).map((v) => v.id);
    const ok = actual.length === expected.length && actual.every((id, i) => id === expected[i]);
    if (!ok) failures += 1;
    console.log(`${ok ? 'ok   ' : 'FAIL '} ${name}${ok ? '' : ` — expected [${expected.join(', ')}], got [${actual.join(', ')}]`}`);
  }
  const pathChecks = [
    ['engine/deadline.ts is pure', isPurePath('engine/deadline.ts') === true],
    ['state/session.ts is pure', isPurePath('state/session.ts') === true],
    ['state/auditQueue.ts is pure', isPurePath('state/auditQueue.ts') === true],
    ['state/useSession.ts is not pure', isPurePath('state/useSession.ts') === false],
    ['ui/Docket.tsx is not pure', isPurePath('ui/Docket.tsx') === false],
    ['test/setup.ts is skipped', isTestPath('test/setup.ts') === true],
    ['ui/Docket.test.tsx is skipped', isTestPath('ui/Docket.test.tsx') === true],
    ['engine/deadline.ts is scanned', isTestPath('engine/deadline.ts') === false],
  ];
  for (const [name, ok] of pathChecks) {
    if (!ok) failures += 1;
    console.log(`${ok ? 'ok   ' : 'FAIL '} ${name}`);
  }
  const total = SELF_TEST.length + pathChecks.length;
  console.log(`check-invariants --self-test: ${total} checks, ${failures} failure(s)`);
  if (failures > 0) process.exitCode = 1;
}

function main(argv) {
  if (argv.includes('--self-test')) {
    selfTest();
    return;
  }
  const srcDir = resolve(ROOT, optionValue(argv, '--src') ?? 'src');
  if (!existsSync(srcDir)) {
    console.error(`check-invariants: ${display(srcDir)} not found`);
    process.exitCode = 1;
    return;
  }
  const { scanned, violations } = scanTree(srcDir);
  for (const line of violations) console.log(line);
  const zone = `pure zone: ${PURE_DIRECTORIES.map((d) => `${d}/**`).concat([...PURE_FILES]).join(', ')} (missing paths skipped)`;
  if (violations.length > 0) {
    console.log(`check-invariants: FAIL — ${violations.length} violation(s) in ${scanned} scanned file(s) under ${display(srcDir)}; ${zone}`);
    process.exitCode = 1;
  } else {
    console.log(`check-invariants: OK — ${scanned} file(s) scanned under ${display(srcDir)} (tests skipped); no forbidden APIs; ${zone}`);
  }
}

main(process.argv.slice(2));
