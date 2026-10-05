/**
 * Pure session reducer: the behaviour of App.tsx's handlers (onAction, onExtend, onImport, reset, the as-of
 * input and docket selection) expressed as (state, event) → (next state, audit inputs).
 *
 * Imports nothing from React or the DOM (PLAN §2.6). Wall-clock time enters only through `deps.now`, so tests
 * and the audit chain are deterministic. Every status/error/audit string is reproduced byte-for-byte from
 * App.tsx (PLAN §4.3); the inputs are never mutated.
 */
import type { ActionRequest, CaseFile, DocketFilters, RightsRequest } from '../engine/types';
import { WorkflowError } from '../engine/types';
import type { AuditInput } from '../engine/audit';
import { assessDeadline, requestExtension, type ExtensionInput } from '../engine/deadline';
import { transition } from '../engine/workflow';

export interface SessionState {
  file: CaseFile;
  source: 'demo' | 'imported';
  selectedId: string | null;
  filters: DocketFilters;
  status: string;
  error: string | null;
}

export type SessionEvent =
  | { type: 'select'; id: string }
  | { type: 'filter'; filters: DocketFilters }
  | { type: 'set-as-of'; asOf: string }
  | { type: 'action'; request: ActionRequest }
  | { type: 'extend'; input: ExtensionInput }
  | { type: 'import'; file: CaseFile; warnings: string[] }
  | { type: 'reset'; file: CaseFile; selectedId: string | null };

export interface SessionDeps {
  /** Actor recorded on transitions and audit entries (App.tsx: 'analyst.demo'). */
  actor: string;
  /** Wall-clock seam: the ISO timestamp stamped on audit entries. */
  now: () => string;
}

export interface ReduceResult {
  state: SessionState;
  /** Zero or one audit inputs, in the order they must be appended. Never more than one per event. */
  audit: AuditInput[];
}

export const DEFAULT_FILTERS: DocketFilters = Object.freeze<DocketFilters>({ jurisdiction: '', type: '', status: '', query: '', sort: 'urgency' });

const DEMO_LOADED = 'Demo case file loaded. All data is synthetic; state lives in memory and resets on refresh.';
const DEMO_RELOADED = 'Demo case file reloaded.';

export function initialSession(file: CaseFile, selectedId: string | null): SessionState {
  return { file, source: 'demo', selectedId, filters: DEFAULT_FILTERS, status: DEMO_LOADED, error: null };
}

/** The request the detail pane acts on: the one with `selectedId`, or null when nothing (or a vanished id) is selected. */
export function selectedRequest(state: SessionState): RightsRequest | null {
  return state.file.requests.find((r) => r.id === state.selectedId) ?? null;
}

function replaceRequest(file: CaseFile, updated: RightsRequest): CaseFile {
  return { ...file, requests: file.requests.map((r) => (r.id === updated.id ? updated : r)) };
}

function entry(deps: SessionDeps, requestId: string, action: string, detail: string): AuditInput {
  return { at: deps.now(), actor: deps.actor, requestId, action, detail };
}

/** A WorkflowError becomes `state.error` plus a "(refused)" audit entry; the case file is left exactly as it was. */
function refusal(state: SessionState, requestId: string, auditAction: string, e: WorkflowError, deps: SessionDeps): ReduceResult {
  return { state: { ...state, error: `${e.code}: ${e.message}` }, audit: [entry(deps, requestId, auditAction, e.message)] };
}

function applyAction(state: SessionState, request: ActionRequest, deps: SessionDeps): ReduceResult {
  const selected = selectedRequest(state);
  if (!selected) return { state, audit: [] };
  const { file } = state;
  try {
    const ctx = { at: `${file.asOf}T12:00:00Z`, actor: deps.actor, ...(request.note ? { note: request.note } : {}), payload: request.payload };
    const next = transition(selected, request.action, ctx, file.systems);
    const detail = next.history[next.history.length - 1]?.note ?? `${selected.stage} → ${next.stage}`;
    return {
      state: { ...state, file: replaceRequest(file, next), error: null, status: `${selected.id}: ${request.action} recorded. Stage is now ${next.stage}.` },
      audit: [entry(deps, selected.id, request.action, detail)],
    };
  } catch (e) {
    if (e instanceof WorkflowError) return refusal(state, selected.id, `${request.action} (refused)`, e, deps);
    throw e;
  }
}

function applyExtension(state: SessionState, input: ExtensionInput, deps: SessionDeps): ReduceResult {
  const selected = selectedRequest(state);
  if (!selected) return { state, audit: [] };
  const { file } = state;
  try {
    // `file.asOf` is the session clock: a notice dated after it is refused (INVALID_EXTENSION_INPUT), PLAN §4.4 / §7.3.
    const next = requestExtension(selected, input, file.asOf);
    const dueOn = assessDeadline(next, file.asOf).effectiveDueOn;
    return {
      state: { ...state, file: replaceRequest(file, next), error: null, status: `${selected.id}: extension recorded; due date moved to ${dueOn}.` },
      audit: [entry(deps, selected.id, 'extension', `${next.extension?.days} days; notified ${input.notifiedOn}`)],
    };
  } catch (e) {
    if (e instanceof WorkflowError) return refusal(state, selected.id, 'extension (refused)', e, deps);
    throw e;
  }
}

function applyImport(state: SessionState, file: CaseFile, warnings: string[], deps: SessionDeps): ReduceResult {
  const summary = `Imported ${file.requests.length} requests across ${file.systems.length} systems (as of ${file.asOf}).`;
  const caveat = warnings.length ? ` ${warnings.length} warning(s): ${warnings.slice(0, 3).join('; ')}` : '';
  return {
    state: { ...state, file, source: 'imported', selectedId: file.requests[0]?.id ?? null, error: null, status: `${summary}${caveat}` },
    audit: [entry(deps, '—', 'import', `${file.requests.length} requests`)],
  };
}

/**
 * Applies one event. Never throws WorkflowError (refusals become `state.error` plus a refusal audit entry);
 * any other error is a programming fault and is rethrown unchanged.
 */
export function reduceSession(state: SessionState, event: SessionEvent, deps: SessionDeps): ReduceResult {
  switch (event.type) {
    case 'select':
      return { state: { ...state, selectedId: event.id, error: null }, audit: [] };
    case 'filter':
      return { state: { ...state, filters: event.filters }, audit: [] };
    case 'set-as-of':
      // The date input reports '' while the analyst is still typing; today's App.tsx ignores that too.
      if (!event.asOf) return { state, audit: [] };
      return { state: { ...state, file: { ...state.file, asOf: event.asOf } }, audit: [] };
    case 'action':
      return applyAction(state, event.request, deps);
    case 'extend':
      return applyExtension(state, event.input, deps);
    case 'import':
      return applyImport(state, event.file, event.warnings, deps);
    case 'reset':
      return { state: { ...state, file: event.file, source: 'demo', selectedId: event.selectedId, error: null, status: DEMO_RELOADED }, audit: [] };
    default: {
      const never: never = event;
      throw new Error(`Unknown session event ${JSON.stringify(never)}`);
    }
  }
}
