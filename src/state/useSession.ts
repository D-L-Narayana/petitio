/**
 * React binding for the pure session reducer and the ordered audit queue.
 *
 * `dispatch` applies reduceSession synchronously and pushes the resulting audit inputs to the queue in dispatch
 * order. The reduction runs against a ref that is the base for the next reduction (so two dispatches in one
 * tick compose) and React state mirrors it. The audit push is deliberately NOT inside a setState updater:
 * React StrictMode double-invokes updaters in development, which would log every entry twice.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AuditEntry, CaseFile, RightsRequest } from '../engine/types';
import type { AuditInput } from '../engine/audit';
import { createAuditQueue, type AuditQueue } from './auditQueue';
import { initialSession, reduceSession, selectedRequest, type SessionDeps, type SessionEvent, type SessionState } from './session';

export interface SessionHandle {
  state: SessionState;
  /** Mirrors the queue's log via its onChange callback; `seq` is always contiguous. */
  log: AuditEntry[];
  dispatch(e: SessionEvent): void;
  /** The request with `state.selectedId`, or null. */
  selected: RightsRequest | null;
  /** Lead finding F1: number of audit entries that could not be recorded (e.g. crypto.subtle unavailable). */
  auditFailures: number;
  /** Resolves when every audit input dispatched so far has been appended or reported (test/journey seam). */
  idle(): Promise<void>;
}

/** Lead finding F1: the error-channel text shown when an append fails. */
export function auditFailureMessage(input: AuditInput, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `Audit entry could not be recorded (${input.action} on ${input.requestId}): ${message}`;
}

export function useSession(initialFile: CaseFile, deps: SessionDeps, initialSelectedId: string | null): SessionHandle {
  const [state, setState] = useState<SessionState>(() => initialSession(initialFile, initialSelectedId));
  const [log, setLog] = useState<AuditEntry[]>([]);
  const [auditFailures, setAuditFailures] = useState(0);

  const stateRef = useRef(state);
  const depsRef = useRef(deps);
  useEffect(() => {
    depsRef.current = deps;
  });

  const queueRef = useRef<AuditQueue | null>(null);
  if (queueRef.current === null) {
    queueRef.current = createAuditQueue(
      (next) => setLog(next),
      [],
      (error, input) => {
        // The reducer's status for the action stands (state and audit are decoupled); only the error channel changes.
        const next: SessionState = { ...stateRef.current, error: auditFailureMessage(input, error) };
        stateRef.current = next;
        setState(next);
        setAuditFailures((n) => n + 1);
      },
    );
  }
  const queue = queueRef.current;

  const dispatch = useCallback(
    (event: SessionEvent) => {
      const result = reduceSession(stateRef.current, event, depsRef.current);
      stateRef.current = result.state;
      setState(result.state);
      for (const input of result.audit) void queue.push(input);
    },
    [queue],
  );

  return { state, log, dispatch, selected: selectedRequest(state), auditFailures, idle: () => queue.idle() };
}
