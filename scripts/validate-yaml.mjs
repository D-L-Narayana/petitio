#!/usr/bin/env node
/**
 * validate-yaml.mjs — dependency-free structural check for the repository's GitHub configuration.
 *
 * Node has no YAML parser in its standard library and this repository adds no dependencies, so this
 * script parses the small YAML subset the .github files use (block mappings and sequences, plain and
 * quoted scalars, single-line flow collections, `|`/`>` block scalars, comments; spaces only) and then
 * applies policy checks:
 *
 *   workflows   every `uses` pinned to a 40-hex commit SHA · top-level read-only `permissions` · no job
 *               raises permissions · `concurrency.cancel-in-progress: true` · every job has `timeout-minutes`
 *               · every checkout step sets `persist-credentials: false` · matrix node versions are quoted
 *               strings · no `pull_request_target` trigger · no secret interpolated into a `run` line ·
 *               verify.yml keeps the repository gates in order
 *   dependabot  `version: 2` · npm and github-actions ecosystems present · valid schedule intervals ·
 *               group update-types limited to major/minor/patch
 *
 * Usage: node scripts/validate-yaml.mjs [file ...]
 *        (default: .github/dependabot.yml and every .github/workflows/*.yml)
 * Output: <file>:<line>: <reason>; exit code 1 on any problem. Node >= 20 (ESM).
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const META = new WeakMap(); // container → Map(key | index → line number)
const PINNED_ACTION = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_./-]+)?@[0-9a-f]{40}$/;
const READ_ONLY = new Set(['read', 'none']);
const INTERVALS = new Set(['daily', 'weekly', 'monthly']);
const UPDATE_TYPES = new Set(['major', 'minor', 'patch']);
const REQUIRED_RUNS = [
  'npm ci --no-fund',
  'npm run typecheck',
  'npm test',
  'npm run build',
  'npm audit --audit-level=high',
  'npm run check:invariants',
  'npm run check:tokens',
  'npm run check:bundle',
  'npm run check:yaml',
];

class YamlError extends Error {
  constructor(line, message) {
    super(message);
    this.name = 'YamlError';
    this.line = line;
  }
}

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const lineOf = (container, key) => (container && typeof container === 'object' ? META.get(container)?.get(key) : undefined);

function toPosix(p) {
  return p.split(sep).join('/');
}

function display(file) {
  const rel = relative(ROOT, file);
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? toPosix(rel) : file;
}

/* ----------------------------- YAML subset parser ----------------------------- */

/** Drops a trailing `# comment` unless the # is inside a quoted scalar. */
function stripComment(raw) {
  let quote = null;
  for (let i = 0; i < raw.length; i += 1) {
    const c = raw[i];
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      const prev = raw.slice(0, i).trimEnd().slice(-1);
      if (prev === '' || ':-[{,'.includes(prev)) quote = c;
      continue;
    }
    if (c === '#' && (i === 0 || /\s/.test(raw[i - 1]))) return raw.slice(0, i);
  }
  return raw;
}

function tokenizeLines(text) {
  const lines = [];
  text.split(/\r?\n/).forEach((raw, index) => {
    const line = index + 1;
    const leading = raw.length - raw.trimStart().length;
    if (raw.slice(0, leading).includes('\t')) throw new YamlError(line, 'tab character in indentation (YAML requires spaces)');
    const body = stripComment(raw).trimEnd();
    const trimmed = body.trim();
    if (trimmed === '' || trimmed === '---' || trimmed === '...') return;
    lines.push({ line, indent: body.length - body.trimStart().length, text: trimmed });
  });
  return lines;
}

const KEY_RE = /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s"'[\]{}#&*!|>%@`][^:]*?)\s*:(?:\s+(.*))?$/;

function unquote(s) {
  if (s.startsWith('"')) return s.slice(1, -1).replace(/\\(.)/g, (_, c) => ({ n: '\n', t: '\t' })[c] ?? c);
  if (s.startsWith("'")) return s.slice(1, -1).replace(/''/g, "'");
  return s;
}

function parseYaml(text) {
  const lines = tokenizeLines(text);
  if (lines.length === 0) return null;
  let pos = 0;

  const isSeqItem = (t) => t === '-' || t.startsWith('- ');

  function parseScalar(s, line) {
    if (s.startsWith('[')) return parseFlow(s, line, ']');
    if (s.startsWith('{')) return parseFlow(s, line, '}');
    if (s.startsWith('"') || s.startsWith("'")) {
      if (s.length < 2 || !s.endsWith(s[0])) throw new YamlError(line, `unterminated quoted scalar: ${s}`);
      return unquote(s);
    }
    if (s === 'true') return true;
    if (s === 'false') return false;
    if (s === 'null' || s === '~') return null;
    if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(s)) return Number(s);
    return s;
  }

  function splitFlow(inner, line) {
    const items = [];
    let depth = 0;
    let quote = null;
    let cur = '';
    for (const c of inner) {
      if (quote) {
        cur += c;
        if (c === quote) quote = null;
        continue;
      }
      if (c === '"' || c === "'") {
        quote = c;
        cur += c;
        continue;
      }
      if (c === '[' || c === '{') depth += 1;
      if (c === ']' || c === '}') depth -= 1;
      if (c === ',' && depth === 0) {
        items.push(cur.trim());
        cur = '';
        continue;
      }
      cur += c;
    }
    if (quote) throw new YamlError(line, 'unterminated quote in flow collection');
    if (cur.trim() !== '') items.push(cur.trim());
    return items;
  }

  function parseFlow(s, line, close) {
    if (!s.endsWith(close)) throw new YamlError(line, `flow collection must close on the same line: ${s}`);
    const items = splitFlow(s.slice(1, -1), line);
    if (close === ']') {
      const arr = items.map((it) => parseScalar(it, line));
      META.set(arr, new Map(arr.map((_, i) => [i, line])));
      return arr;
    }
    const obj = {};
    const meta = new Map();
    META.set(obj, meta);
    for (const it of items) {
      const m = KEY_RE.exec(it);
      if (!m) throw new YamlError(line, `expected "key: value" inside flow mapping, got "${it}"`);
      const key = unquote(m[1]);
      obj[key] = m[2] === undefined ? null : parseScalar(m[2], line);
      meta.set(key, line);
    }
    return obj;
  }

  function parseValue(rest, indent, line) {
    if (rest === undefined || rest === '') {
      if (pos < lines.length && lines[pos].indent > indent) return parseNode(lines[pos].indent);
      if (pos < lines.length && lines[pos].indent === indent && isSeqItem(lines[pos].text)) return parseSequence(indent);
      return null;
    }
    if (/^[|>][+-]?$/.test(rest)) {
      const chunks = [];
      while (pos < lines.length && lines[pos].indent > indent) {
        chunks.push(lines[pos].text);
        pos += 1;
      }
      return chunks.join(rest.startsWith('|') ? '\n' : ' ');
    }
    return parseScalar(rest, line);
  }

  function parseMapping(indent) {
    const obj = {};
    const meta = new Map();
    META.set(obj, meta);
    while (pos < lines.length && lines[pos].indent === indent) {
      const { text, line } = lines[pos];
      if (isSeqItem(text)) break;
      const m = KEY_RE.exec(text);
      if (!m) throw new YamlError(line, `expected "key: value", got "${text}"`);
      const key = unquote(m[1]);
      if (Object.hasOwn(obj, key)) throw new YamlError(line, `duplicate key "${key}"`);
      meta.set(key, line);
      pos += 1;
      obj[key] = parseValue(m[2], indent, line);
    }
    if (pos < lines.length && lines[pos].indent > indent) throw new YamlError(lines[pos].line, 'unexpected indentation');
    return obj;
  }

  function parseSequence(indent) {
    const arr = [];
    const meta = new Map();
    META.set(arr, meta);
    while (pos < lines.length && lines[pos].indent === indent && isSeqItem(lines[pos].text)) {
      const { text, line } = lines[pos];
      meta.set(arr.length, line);
      const rest = text.slice(1).trim();
      if (rest === '') {
        pos += 1;
        arr.push(pos < lines.length && lines[pos].indent > indent ? parseNode(lines[pos].indent) : null);
        continue;
      }
      const childIndent = indent + (text.length - rest.length);
      if (isSeqItem(rest) || (KEY_RE.test(rest) && !/^["'[{]/.test(rest))) {
        // "- key: value" (or "- - x") starts a nested node whose remaining lines align with `rest`
        lines[pos] = { line, indent: childIndent, text: rest };
        arr.push(parseNode(childIndent));
      } else {
        pos += 1;
        arr.push(parseScalar(rest, line));
      }
    }
    return arr;
  }

  function parseNode(indent) {
    return isSeqItem(lines[pos].text) ? parseSequence(indent) : parseMapping(indent);
  }

  if (lines[0].indent !== 0) throw new YamlError(lines[0].line, 'document must start at column 0');
  const doc = parseNode(0);
  if (pos < lines.length) throw new YamlError(lines[pos].line, `unexpected content: "${lines[pos].text}"`);
  return doc;
}

/* --------------------------------- policies --------------------------------- */

function checkPermissions(value, line, where, add) {
  if (typeof value === 'string') {
    if (value !== 'read-all') add(line, `${where} permissions "${value}" is not read-only`);
    return;
  }
  if (!isObject(value)) {
    add(line, `${where} permissions must be a mapping of scope: read|none`);
    return;
  }
  for (const [scope, level] of Object.entries(value)) {
    if (!READ_ONLY.has(level)) add(lineOf(value, scope) ?? line, `${where} permission "${scope}: ${level}" is not read-only`);
  }
}

function checkWorkflow(doc, file, problems) {
  const add = (line, reason) => problems.push(`${file}:${line ?? 1}: ${reason}`);
  if (!isObject(doc)) {
    add(1, 'workflow must be a mapping');
    return;
  }
  if (!('on' in doc)) add(1, 'missing "on" trigger block');
  if (isObject(doc.on) && 'pull_request_target' in doc.on) add(lineOf(doc.on, 'pull_request_target'), '"pull_request_target" exposes secrets to fork code; use pull_request');
  if (!('permissions' in doc)) add(1, 'missing top-level "permissions" (expected contents: read)');
  else checkPermissions(doc.permissions, lineOf(doc, 'permissions'), 'top-level', add);
  if (!isObject(doc.concurrency)) add(lineOf(doc, 'concurrency') ?? 1, 'missing "concurrency" block (expected cancel-in-progress: true)');
  else {
    if (doc.concurrency['cancel-in-progress'] !== true) add(lineOf(doc.concurrency, 'cancel-in-progress') ?? lineOf(doc, 'concurrency'), 'concurrency.cancel-in-progress must be true');
    if (typeof doc.concurrency.group !== 'string' || doc.concurrency.group === '') add(lineOf(doc, 'concurrency'), 'concurrency.group must be a non-empty string');
  }
  if (!isObject(doc.jobs) || Object.keys(doc.jobs).length === 0) {
    add(lineOf(doc, 'jobs') ?? 1, 'missing "jobs"');
    return;
  }
  const runs = [];
  for (const [jobId, job] of Object.entries(doc.jobs)) {
    const jobLine = lineOf(doc.jobs, jobId);
    if (!isObject(job)) {
      add(jobLine, `job "${jobId}" must be a mapping`);
      continue;
    }
    if (typeof job['timeout-minutes'] !== 'number') add(jobLine, `job "${jobId}" needs a numeric timeout-minutes`);
    if ('permissions' in job) checkPermissions(job.permissions, lineOf(job, 'permissions'), `job "${jobId}"`, add);
    const matrix = job.strategy?.matrix;
    if (isObject(matrix) && 'node-version' in matrix) {
      const versions = matrix['node-version'];
      const line = lineOf(matrix, 'node-version') ?? jobLine;
      if (!Array.isArray(versions) || versions.length < 2) add(line, 'matrix.node-version should list at least two quoted versions');
      else versions.forEach((v, i) => { if (typeof v !== 'string') add(line, `matrix.node-version[${i}] must be a quoted string (unquoted ${JSON.stringify(v)} is a number and can lose digits)`); });
    }
    if (!Array.isArray(job.steps) || job.steps.length === 0) {
      add(lineOf(job, 'steps') ?? jobLine, `job "${jobId}" has no steps`);
      continue;
    }
    job.steps.forEach((step, i) => {
      const line = lineOf(job.steps, i) ?? jobLine;
      if (!isObject(step)) {
        add(line, `step ${i + 1} must be a mapping`);
        return;
      }
      const hasUses = typeof step.uses === 'string';
      const hasRun = typeof step.run === 'string';
      if (hasUses === hasRun) add(line, `step ${i + 1} must have exactly one of "uses" or "run"`);
      if (hasUses) {
        if (!PINNED_ACTION.test(step.uses)) add(lineOf(step, 'uses') ?? line, `"${step.uses}" is not pinned to a 40-character commit SHA`);
        if (step.uses.startsWith('actions/checkout@') && step.with?.['persist-credentials'] !== false) add(line, 'checkout step must set with.persist-credentials: false');
      }
      if (hasRun) {
        runs.push(step.run.trim());
        if (/\$\{\{\s*secrets\./.test(step.run)) add(lineOf(step, 'run') ?? line, 'run step interpolates a secret; pass it through env instead');
      }
    });
  }
  if (basename(file) === 'verify.yml') {
    let last = -1;
    for (const cmd of REQUIRED_RUNS) {
      const idx = runs.indexOf(cmd);
      if (idx < 0) add(1, `verify.yml must run "${cmd}"`);
      else if (idx < last) add(1, `verify.yml runs "${cmd}" out of order (expected ${REQUIRED_RUNS.join(' → ')})`);
      else last = idx;
    }
  }
}

function checkDependabot(doc, file, problems) {
  const add = (line, reason) => problems.push(`${file}:${line ?? 1}: ${reason}`);
  if (!isObject(doc)) {
    add(1, 'dependabot config must be a mapping');
    return;
  }
  if (doc.version !== 2) add(lineOf(doc, 'version') ?? 1, 'version must be 2');
  if (!Array.isArray(doc.updates) || doc.updates.length === 0) {
    add(lineOf(doc, 'updates') ?? 1, '"updates" must be a non-empty list');
    return;
  }
  const ecosystems = new Set();
  doc.updates.forEach((u, i) => {
    const line = lineOf(doc.updates, i) ?? 1;
    if (!isObject(u)) {
      add(line, `updates[${i}] must be a mapping`);
      return;
    }
    if (typeof u['package-ecosystem'] !== 'string') add(line, `updates[${i}].package-ecosystem is required`);
    else ecosystems.add(u['package-ecosystem']);
    if (typeof u.directory !== 'string' || !u.directory.startsWith('/')) add(lineOf(u, 'directory') ?? line, `updates[${i}].directory must be a path starting with "/"`);
    const interval = isObject(u.schedule) ? u.schedule.interval : undefined;
    if (!INTERVALS.has(interval)) add(lineOf(u.schedule, 'interval') ?? lineOf(u, 'schedule') ?? line, `updates[${i}].schedule.interval must be one of ${[...INTERVALS].join(', ')}`);
    if ('groups' in u) {
      if (!isObject(u.groups)) add(lineOf(u, 'groups') ?? line, `updates[${i}].groups must be a mapping`);
      else {
        for (const [name, g] of Object.entries(u.groups)) {
          const gl = lineOf(u.groups, name) ?? line;
          if (!isObject(g)) {
            add(gl, `group "${name}" must be a mapping`);
            continue;
          }
          if (!Array.isArray(g.patterns) && !Array.isArray(g['update-types']) && typeof g['dependency-type'] !== 'string') add(gl, `group "${name}" needs patterns, update-types or dependency-type`);
          for (const t of Array.isArray(g['update-types']) ? g['update-types'] : []) {
            if (!UPDATE_TYPES.has(t)) add(lineOf(g, 'update-types') ?? gl, `group "${name}" has unknown update-type "${t}"`);
          }
        }
      }
    }
  });
  for (const eco of ['npm', 'github-actions']) {
    if (!ecosystems.has(eco)) add(lineOf(doc, 'updates') ?? 1, `no update entry for package-ecosystem "${eco}"`);
  }
}

/* ----------------------------------- main ----------------------------------- */

function defaultFiles() {
  const files = [];
  const dependabot = join(ROOT, '.github', 'dependabot.yml');
  if (existsSync(dependabot)) files.push(dependabot);
  const workflows = join(ROOT, '.github', 'workflows');
  if (existsSync(workflows)) {
    for (const name of readdirSync(workflows).sort()) if (/\.ya?ml$/.test(name)) files.push(join(workflows, name));
  }
  return files;
}

function main(argv) {
  const files = argv.length > 0 ? argv.map((a) => resolve(ROOT, a)) : defaultFiles();
  if (files.length === 0) {
    console.error('validate-yaml: no YAML files found under .github/');
    process.exitCode = 1;
    return;
  }
  const problems = [];
  for (const file of files) {
    const shown = display(file);
    let doc;
    try {
      doc = parseYaml(readFileSync(file, 'utf8'));
    } catch (e) {
      problems.push(`${shown}:${e.line ?? 1}: ${e.message}`);
      console.log(`FAIL  ${shown} (does not parse)`);
      continue;
    }
    const before = problems.length;
    let policy = 'parsed';
    if (toPosix(file).includes('/.github/workflows/')) {
      checkWorkflow(doc, shown, problems);
      policy = 'workflow policy';
    } else if (basename(file) === 'dependabot.yml') {
      checkDependabot(doc, shown, problems);
      policy = 'dependabot policy';
    }
    console.log(`${problems.length === before ? 'ok   ' : 'FAIL '} ${shown} (${policy})`);
  }
  for (const p of problems) console.log(p);
  if (problems.length > 0) {
    console.log(`validate-yaml: FAIL — ${problems.length} problem(s) in ${files.length} file(s)`);
    process.exitCode = 1;
  } else {
    console.log(`validate-yaml: OK — ${files.length} file(s) parsed, no policy violations`);
  }
}

main(process.argv.slice(2));
