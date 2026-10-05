/**
 * Typed builders for engine and UI tests. Everything here is synthetic: invented people, `*.example`
 * addresses, no statutory claims. Builders return plain JSON-safe objects and omit optional fields
 * instead of setting them to `undefined`/`[]`, so `parseCaseFile(serializeCaseFile(file))` deep-equals
 * what was built.
 */
import type { CaseFile, Hold, IdentityCheck, RightsRequest, SystemOfRecord, SystemResult } from '../../engine/types';
import { parseCaseFile } from '../../engine/casefile';
import demo from '../../fixtures/demo-casefile.json';

/** The demo clock. Deadlines in scenario tests are computed relative to this date. */
export const AS_OF = '2026-10-01';
export const REQUESTER_EMAIL = 'wren.4471@people.example';

export function makeSystem(id: string, overrides: Partial<SystemOfRecord> = {}): SystemOfRecord {
  return { id, name: `${id} (synthetic)`, description: `Synthetic ${id} system of record.`, ...overrides };
}

/** The three systems of record the bundled fixture uses. Treat as read-only. */
export const SYSTEMS: SystemOfRecord[] = [makeSystem('crm'), makeSystem('billing'), makeSystem('support')];

export function passedIdentity(overrides: Partial<IdentityCheck> = {}): IdentityCheck {
  return { method: 'email-loop', attempts: 1, maxAttempts: 3, status: 'passed', ...overrides };
}

export function makeRequest(overrides: Partial<RightsRequest> = {}): RightsRequest {
  return {
    id: 'REQ-2026-9001',
    receivedOn: '2026-09-10',
    jurisdiction: 'EU-GDPR',
    type: 'access',
    requester: { pseudonym: 'wren-4471', email: REQUESTER_EMAIL, accountId: 'ACC-44710', ageBand: 'adult' },
    stage: 'received',
    identity: { method: 'email-loop', attempts: 0, maxAttempts: 3, status: 'not-started' },
    holds: [],
    systemResults: [],
    history: [],
    notes: [],
    ...overrides,
  };
}

/** A found record whose subject email matches the default requester (no identity conflict); `found: false` yields the minimal shape. */
export function makeResult(systemId: string, overrides: Partial<SystemResult> = {}): SystemResult {
  const found = overrides.found ?? true;
  const base: SystemResult = found
    ? {
        systemId,
        found: true,
        recordId: `${systemId}-9001`,
        matchedBy: ['email'],
        subjectEmail: REQUESTER_EMAIL,
        fields: [{ name: 'displayName', value: 'Wren Example' }],
        lookedUpAt: '2026-09-20T10:00:00Z',
      }
    : { systemId, found: false, fields: [], lookedUpAt: '2026-09-20T10:00:00Z' };
  return { ...base, ...overrides };
}

/** An active, justified hold. Pass `note: ''` for an unjustified one or `releasedAt` for a released one. */
export function makeHold(systemId: string, overrides: Partial<Hold> = {}): Hold {
  return {
    id: `HOLD-${systemId}-1`,
    systemId,
    reason: 'legal-obligation-retention',
    note: 'Records retained under the synthetic fiscal retention rule.',
    appliedAt: '2026-09-21T10:00:00Z',
    ...overrides,
  };
}

export function makeCaseFile(parts: { systems?: SystemOfRecord[]; requests?: RightsRequest[]; asOf?: string } = {}): CaseFile {
  return {
    schema: 'petitio.casefile',
    version: 1,
    asOf: parts.asOf ?? AS_OF,
    systems: parts.systems ?? [...SYSTEMS],
    requests: parts.requests ?? [],
  };
}

/** Structural clone for JSON-safe data (every engine type is). */
export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** A fresh, validated copy of the bundled demo fixture, parsed the same way App.tsx parses it. */
export function demoFile(): CaseFile {
  const parsed = parseCaseFile(JSON.stringify(demo));
  if (!parsed.ok) throw new Error(`Bundled fixture failed validation: ${parsed.errors.join('; ')}`);
  return parsed.file;
}

export function demoRequest(id: string): RightsRequest {
  const request = demoFile().requests.find((r) => r.id === id);
  if (!request) throw new Error(`No request ${id} in the bundled fixture`);
  return request;
}
