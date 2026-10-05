/**
 * Ordered audit queue. Imports nothing from React or the DOM (PLAN §2.6).
 *
 * Why it exists: appendEntry() hashes asynchronously, so two appends started against the same base array both
 * compute the same `seq` and the later writer silently overwrites the earlier one (the race in App.tsx's
 * `useCallback(async …, [log])`). The queue serialises appends through a promise chain: each push waits for the
 * previous one to settle and then appends to the latest log, so `seq` is always contiguous and nothing is lost.
 *
 * Lead finding F1: when appendEntry rejects (e.g. `crypto.subtle` is undefined outside a secure context) the
 * entry is reported through `onError` and counted in `failures()`, the chain continues on the last good log, and
 * `push()` still resolves so a dispatching UI is never left hanging on a rejected promise.
 */
import type { AuditEntry } from '../engine/types';
import { appendEntry, type AuditInput } from '../engine/audit';

export interface AuditQueue {
  /** Queues one append. Resolves once the entry is recorded or its failure has been reported; never rejects for an append failure. */
  push(input: AuditInput): Promise<void>;
  /** The latest log (the same array reference that was last passed to onChange). */
  current(): AuditEntry[];
  /** Resolves when every push made so far has been applied or reported. */
  idle(): Promise<void>;
  /** Number of appends that could not be recorded. */
  failures(): number;
}

export function createAuditQueue(
  onChange: (log: AuditEntry[]) => void,
  initial: AuditEntry[] = [],
  onError?: (error: unknown, input: AuditInput) => void,
): AuditQueue {
  let log: AuditEntry[] = initial;
  let failed = 0;
  let tail: Promise<void> = Promise.resolve();

  function push(input: AuditInput): Promise<void> {
    const step = tail.then(async () => {
      let next: AuditEntry[];
      try {
        next = await appendEntry(log, input);
      } catch (error) {
        failed += 1;
        onError?.(error, input);
        return;
      }
      log = next;
      onChange(next);
    });
    // A throwing onChange/onError callback is a consumer bug: it surfaces through that push's promise but never severs the chain.
    tail = step.catch(() => undefined);
    return step;
  }

  return {
    push,
    current: () => log,
    idle: () => tail,
    failures: () => failed,
  };
}
