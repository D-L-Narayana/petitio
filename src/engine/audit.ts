import type { AuditEntry } from './types';

export interface AuditInput {
  at: string;
  actor: string;
  requestId: string;
  action: string;
  detail: string;
}

const GENESIS = 'GENESIS';

async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

function canonical(entry: Omit<AuditEntry, 'hash'>): string {
  // Field order is fixed and values are JSON-escaped so separators inside values cannot collide.
  return JSON.stringify([entry.seq, entry.at, entry.actor, entry.requestId, entry.action, entry.detail, entry.prevHash]);
}

/** Appends an entry whose hash covers its content and the previous hash. Returns a new array. */
export async function appendEntry(log: AuditEntry[], input: AuditInput): Promise<AuditEntry[]> {
  const prev = log[log.length - 1];
  const partial: Omit<AuditEntry, 'hash'> = {
    seq: log.length + 1,
    ...input,
    prevHash: prev ? prev.hash : GENESIS,
  };
  const hash = await sha256Hex(canonical(partial));
  return [...log, { ...partial, hash }];
}

/**
 * Recomputes every hash. The chain is valid only if each entry's hash matches its content and
 * each prevHash equals the previous entry's hash. `brokenAt` is the 1-based seq of the first bad entry.
 */
export async function verifyChain(log: AuditEntry[]): Promise<{ valid: true } | { valid: false; brokenAt: number }> {
  let expectedPrev = GENESIS;
  for (let i = 0; i < log.length; i += 1) {
    const entry = log[i]!;
    const { hash, ...rest } = entry;
    const recomputed = await sha256Hex(canonical(rest));
    if (entry.prevHash !== expectedPrev || recomputed !== hash || entry.seq !== i + 1) {
      return { valid: false, brokenAt: i + 1 };
    }
    expectedPrev = hash;
  }
  return { valid: true };
}
