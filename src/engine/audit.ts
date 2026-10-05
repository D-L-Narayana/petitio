import type { AuditEntry, AuditLogFile } from './types';

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

export const AUDITLOG_SCHEMA = 'petitio.auditlog';
export const AUDITLOG_VERSION = 1;

export interface AuditLogLimits {
  maxBytes: number;
  maxEntries: number;
}

export const DEFAULT_AUDITLOG_LIMITS: AuditLogLimits = { maxBytes: 2_000_000, maxEntries: 10_000 };

export type AuditLogParseResult = { ok: true; entries: AuditEntry[]; legacy: boolean } | { ok: false; errors: string[] };

/** Wraps a log in the `petitio.auditlog` v1 envelope as 2-space JSON so the file can be re-imported and verified. */
export function serializeAuditLog(log: AuditEntry[], exportedAt: string): string {
  const file: AuditLogFile = { schema: AUDITLOG_SCHEMA, version: AUDITLOG_VERSION, exportedAt, entries: log };
  return JSON.stringify(file, null, 2);
}

const HEX_64 = /^[0-9a-f]{64}$/;
const STRING_FIELDS = ['at', 'actor', 'requestId', 'action', 'detail'] as const;
const MAX_REPORTED_ERRORS = 50;

/**
 * Parses an exported audit log — either the v1 envelope or a legacy bare array of entries — without
 * trusting any of it: size is checked before `JSON.parse`, every field type is validated, hashes must
 * be 64 lower-case hex characters, `seq` must be a contiguous integer sequence from 1, and only known
 * fields are copied. This is a shape check only; run `verifyChain` on the entries to test integrity.
 * Never throws.
 */
export function parseAuditLog(text: string, limits: Partial<AuditLogLimits> = {}): AuditLogParseResult {
  const { maxBytes, maxEntries } = { ...DEFAULT_AUDITLOG_LIMITS, ...limits };
  const bytes = new TextEncoder().encode(text).length;
  if (bytes > maxBytes) {
    return { ok: false, errors: [`File is ${bytes.toLocaleString('en-US')} bytes; the limit is ${maxBytes.toLocaleString('en-US')} bytes.`] };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { ok: false, errors: [`Not valid JSON: ${(e as Error).message}`] };
  }

  const errors: string[] = [];
  let list: unknown[];
  let legacy: boolean;
  if (Array.isArray(raw)) {
    list = raw;
    legacy = true;
  } else if (typeof raw === 'object' && raw !== null) {
    const root = raw as Record<string, unknown>;
    if (root['schema'] !== AUDITLOG_SCHEMA) errors.push(`auditlog.schema must be "${AUDITLOG_SCHEMA}"`);
    if (root['version'] !== AUDITLOG_VERSION) errors.push(`auditlog.version must be ${AUDITLOG_VERSION}`);
    if (typeof root['exportedAt'] !== 'string') errors.push('auditlog.exportedAt must be a string');
    if (!Array.isArray(root['entries'])) errors.push('auditlog.entries must be an array');
    if (errors.length > 0) return { ok: false, errors };
    list = root['entries'] as unknown[];
    legacy = false;
  } else {
    return { ok: false, errors: [`An audit log export is a ${AUDITLOG_SCHEMA} object or a bare array of entries.`] };
  }
  if (list.length > maxEntries) {
    return { ok: false, errors: [`auditlog.entries has ${list.length.toLocaleString('en-US')} items; the limit is ${maxEntries.toLocaleString('en-US')}`] };
  }

  const entries: AuditEntry[] = [];
  for (let i = 0; i < list.length && errors.length < MAX_REPORTED_ERRORS; i += 1) {
    const path = `entries[${i}]`;
    const value = list[i];
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      errors.push(`${path} must be an object`);
      continue;
    }
    const o = value as Record<string, unknown>;
    const seq = o['seq'];
    if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 1) errors.push(`${path}.seq must be an integer of at least 1`);
    else if (seq !== i + 1) errors.push(`${path}.seq is ${seq}; expected ${i + 1} (entries must be numbered contiguously from 1)`);
    for (const key of STRING_FIELDS) {
      if (typeof o[key] !== 'string') errors.push(`${path}.${key} must be a string`);
    }
    const hash = o['hash'];
    if (typeof hash !== 'string' || !HEX_64.test(hash)) errors.push(`${path}.hash must be 64 lower-case hexadecimal characters`);
    const prevHash = o['prevHash'];
    if (typeof prevHash !== 'string' || !(prevHash === GENESIS || HEX_64.test(prevHash))) errors.push(`${path}.prevHash must be "${GENESIS}" or 64 lower-case hexadecimal characters`);
    if (errors.length === 0) {
      entries.push({
        seq: seq as number,
        at: o['at'] as string,
        actor: o['actor'] as string,
        requestId: o['requestId'] as string,
        action: o['action'] as string,
        detail: o['detail'] as string,
        prevHash: prevHash as string,
        hash: hash as string,
      });
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, entries, legacy };
}
