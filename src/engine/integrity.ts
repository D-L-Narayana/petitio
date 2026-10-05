import type { CaseFile, RightsRequest, Stage } from './types';

/**
 * Cross-field integrity rules for a `petitio.casefile` v1 case file.
 *
 * `parseCaseFile` validates every field on its own (types, enums, dates, limits) and only then calls
 * `checkIntegrity` on the result, so the rules below may assume a structurally valid file and never need
 * to throw. Errors make the import fail; warnings are passed through to the analyst.
 *
 * Paths follow the importer's convention (`casefile.requests[3].closedOn`); messages start with the
 * request id so they read well on their own in the footer status line.
 */
export interface IntegrityIssue {
  level: 'error' | 'warning';
  path: string;
  message: string;
}

/** Stages a request can only reach after its identity check has passed. */
const REQUIRES_PASSED_IDENTITY: ReadonlySet<Stage> = new Set<Stage>(['collecting', 'review', 'response-ready', 'closed']);

/** Milliseconds for an ISO timestamp, or undefined when the engine cannot order it (never throws). */
function instant(at: string): number | undefined {
  const ms = Date.parse(at);
  return Number.isNaN(ms) ? undefined : ms;
}

function checkRequest(r: RightsRequest, path: string, asOf: string, systemIds: ReadonlySet<string>, issues: IntegrityIssue[]): void {
  const error = (p: string, message: string) => issues.push({ level: 'error', path: p, message });
  const warning = (p: string, message: string) => issues.push({ level: 'warning', path: p, message });

  // closedOn ⇔ stage closed
  if (r.closedOn !== undefined && r.stage !== 'closed') error(`${path}.closedOn`, `${r.id}: closedOn "${r.closedOn}" is set but the stage is "${r.stage}", not "closed"`);
  if (r.stage === 'closed' && r.closedOn === undefined) error(`${path}.closedOn`, `${r.id}: stage is "closed" but closedOn is missing`);

  // rejectReason ⇔ stage rejected
  if (r.rejectReason !== undefined && r.stage !== 'rejected') error(`${path}.rejectReason`, `${r.id}: rejectReason "${r.rejectReason}" is set but the stage is "${r.stage}", not "rejected"`);
  if (r.stage === 'rejected' && r.rejectReason === undefined) error(`${path}.rejectReason`, `${r.id}: stage is "rejected" but rejectReason is missing`);

  // history[last].to === stage
  const last = r.history[r.history.length - 1];
  if (last && last.to !== r.stage) error(`${path}.history[${r.history.length - 1}].to`, `${r.id}: the last history entry leads to "${last.to}" but the stage is "${r.stage}"`);

  // identity.attempts ≤ identity.maxAttempts
  if (r.identity.attempts > r.identity.maxAttempts) error(`${path}.identity.attempts`, `${r.id}: identity.attempts (${r.identity.attempts}) exceeds identity.maxAttempts (${r.identity.maxAttempts})`);

  // collecting and later (except rejected) ⇒ identity passed
  if (REQUIRES_PASSED_IDENTITY.has(r.stage) && r.identity.status !== 'passed') error(`${path}.identity.status`, `${r.id}: stage "${r.stage}" requires a passed identity check but identity.status is "${r.identity.status}"`);

  // holds: known system, unique id, at most one active hold per system
  const holdIds = new Set<string>();
  const activeOn = new Map<string, string>(); // systemId → first active hold id
  r.holds.forEach((h, j) => {
    if (!systemIds.has(h.systemId)) error(`${path}.holds[${j}].systemId`, `${r.id}: hold ${h.id} references unknown system "${h.systemId}"`);
    if (holdIds.has(h.id)) error(`${path}.holds[${j}].id`, `${r.id}: duplicate hold id "${h.id}"`);
    holdIds.add(h.id);
    if (!h.releasedAt) {
      const first = activeOn.get(h.systemId);
      if (first !== undefined) warning(`${path}.holds[${j}].systemId`, `${r.id}: hold ${h.id} is a second active hold on system "${h.systemId}" (${first} is still active)`);
      else activeOn.set(h.systemId, h.id);
    }
  });

  // results for systems the case file does not list (historic wording, kept byte for byte)
  r.systemResults.forEach((result, k) => {
    if (!systemIds.has(result.systemId)) warning(`${path}.systemResults[${k}].systemId`, `${r.id}: result for unknown system "${result.systemId}"`);
  });

  // receivedOn after the as-of date (both are strict YYYY-MM-DD, so string order is date order)
  if (r.receivedOn > asOf) warning(`${path}.receivedOn`, `${r.id}: receivedOn ${r.receivedOn} is after the as-of date ${asOf}`);

  // history timestamps non-decreasing
  for (let j = 1; j < r.history.length; j += 1) {
    const prev = instant(r.history[j - 1]!.at);
    const cur = instant(r.history[j]!.at);
    if (prev !== undefined && cur !== undefined && cur < prev) warning(`${path}.history[${j}].at`, `${r.id}: history[${j}].at ${r.history[j]!.at} is earlier than history[${j - 1}].at ${r.history[j - 1]!.at}`);
  }

  // closedOn before receivedOn
  if (r.closedOn !== undefined && r.closedOn < r.receivedOn) warning(`${path}.closedOn`, `${r.id}: closedOn ${r.closedOn} is before receivedOn ${r.receivedOn}`);
}

/** Runs every cross-field rule and returns the issues found; an empty array means the file is consistent. */
export function checkIntegrity(file: CaseFile): IntegrityIssue[] {
  const issues: IntegrityIssue[] = [];
  const systemIds: ReadonlySet<string> = new Set(file.systems.map((s) => s.id));
  file.requests.forEach((r, i) => checkRequest(r, `casefile.requests[${i}]`, file.asOf, systemIds, issues));
  return issues;
}
