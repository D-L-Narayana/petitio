#!/usr/bin/env node
/**
 * check-bundle-size.mjs — bundle budget gate.
 *
 * Reads scripts/budgets.json ({ "jsKb", "cssKb", "distKb" }) and measures the production build in
 * dist/: the largest JavaScript asset, the largest CSS asset and the whole directory (every file,
 * recursively). Sizes are raw bytes on disk reported in kB (1 kB = 1000 bytes, the unit Vite prints).
 * Gzip sizes are shown for information only; budgets apply to raw sizes.
 *
 * Exit code 1 when any figure exceeds its budget, when dist/ is missing or empty (run `npm run build`
 * first), or when the budgets file is unreadable.
 *
 * Usage: node scripts/check-bundle-size.mjs [--dist <dir>] [--budgets <file>]
 * Dependency-free; Node >= 20 (ESM).
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BUDGET_KEYS = ['jsKb', 'cssKb', 'distKb'];

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

function kb(bytes) {
  return (bytes / 1000).toFixed(2);
}

function loadBudgets(path) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new Error(`${display(path)}: cannot read budgets — ${e.message}`);
  }
  for (const key of BUDGET_KEYS) {
    if (typeof raw[key] !== 'number' || !Number.isFinite(raw[key]) || raw[key] <= 0) {
      throw new Error(`${display(path)}: "${key}" must be a positive number`);
    }
  }
  return raw;
}

function largest(files, ext) {
  return files.filter((f) => f.rel.endsWith(ext)).sort((a, b) => b.bytes - a.bytes || a.rel.localeCompare(b.rel))[0];
}

function printTable(rows) {
  const header = ['asset', 'file', 'size', 'gzip', 'budget', 'status'];
  const cells = rows.map((r) => [r.label, r.file, `${kb(r.bytes)} kB`, r.gzip === undefined ? '—' : `${kb(r.gzip)} kB`, `${r.budgetKb} kB`, r.status]);
  const widths = header.map((h, i) => Math.max(h.length, ...cells.map((c) => c[i].length)));
  const line = (c) => c.map((v, i) => (i === 2 || i === 3 || i === 4 ? v.padStart(widths[i]) : v.padEnd(widths[i]))).join('  ');
  console.log(`  ${line(header)}`);
  for (const c of cells) console.log(`  ${line(c)}`);
}

function main(argv) {
  const distDir = resolve(ROOT, optionValue(argv, '--dist') ?? 'dist');
  const budgetsPath = resolve(ROOT, optionValue(argv, '--budgets') ?? 'scripts/budgets.json');

  let budgets;
  try {
    budgets = loadBudgets(budgetsPath);
  } catch (e) {
    console.error(`check-bundle-size: ${e.message}`);
    process.exitCode = 1;
    return;
  }

  if (!existsSync(distDir) || !statSync(distDir).isDirectory()) {
    console.error(`check-bundle-size: ${display(distDir)}/ not found — run \`npm run build\` first`);
    process.exitCode = 1;
    return;
  }

  const files = [...walk(distDir)].map((path) => ({ path, rel: toPosix(relative(distDir, path)), bytes: statSync(path).size }));
  if (files.length === 0) {
    console.error(`check-bundle-size: ${display(distDir)}/ is empty — run \`npm run build\` first`);
    process.exitCode = 1;
    return;
  }

  const js = largest(files, '.js');
  const css = largest(files, '.css');
  const total = files.reduce((n, f) => n + f.bytes, 0);
  const gz = (f) => (f ? gzipSync(readFileSync(f.path)).length : 0);

  const rows = [
    { key: 'jsKb', label: 'largest JS', file: js ? js.rel : '(none)', bytes: js ? js.bytes : 0, gzip: gz(js), budgetKb: budgets.jsKb, missing: !js },
    { key: 'cssKb', label: 'CSS', file: css ? css.rel : '(none)', bytes: css ? css.bytes : 0, gzip: gz(css), budgetKb: budgets.cssKb, missing: !css },
    { key: 'distKb', label: 'dist/ total', file: `${files.length} files`, bytes: total, gzip: undefined, budgetKb: budgets.distKb, missing: false },
  ];
  const problems = [];
  for (const row of rows) {
    if (row.missing) {
      row.status = 'MISSING';
      problems.push(`${display(distDir)}/: no ${row.label === 'CSS' ? 'CSS' : 'JavaScript'} asset found — run \`npm run build\` first`);
    } else if (row.bytes > row.budgetKb * 1000) {
      row.status = 'OVER';
      problems.push(`${row.key === 'distKb' ? `${display(distDir)}/` : `${display(distDir)}/${row.file}`}: ${kb(row.bytes)} kB exceeds the ${row.budgetKb} kB ${row.label} budget (${display(budgetsPath)} "${row.key}")`);
    } else {
      row.status = 'ok';
    }
  }

  console.log(`check-bundle-size: ${display(distDir)}/ measured against ${display(budgetsPath)} (raw sizes; 1 kB = 1000 bytes)`);
  printTable(rows);
  for (const p of problems) console.log(p);
  if (problems.length > 0) {
    console.log(`check-bundle-size: FAIL — ${problems.length} problem(s)`);
    process.exitCode = 1;
  } else {
    console.log(`check-bundle-size: OK — within budget (JS ≤ ${budgets.jsKb} kB, CSS ≤ ${budgets.cssKb} kB, dist ≤ ${budgets.distKb} kB)`);
  }
}

main(process.argv.slice(2));
