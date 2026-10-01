import { describe, expect, it } from 'vitest';
import { findDuplicates } from './duplicates';
import { buildResponsePacket } from './reconcile';
import type { RightsRequest } from './types';

function req(overrides: Partial<RightsRequest>): RightsRequest {
  return {
    id: 'R',
    receivedOn: '2026-09-01',
    jurisdiction: 'EU-GDPR',
    type: 'access',
    requester: { pseudonym: 'p1', email: 'p1@people.example' },
    stage: 'review',
    identity: { method: 'email-loop', attempts: 1, maxAttempts: 3, status: 'passed' },
    holds: [],
    systemResults: [],
    history: [],
    notes: [],
    ...overrides,
  };
}

describe('findDuplicates', () => {
  it('flags a later request of the same type from the same pseudonym within the window', () => {
    const a = req({ id: 'A', receivedOn: '2026-09-01' });
    const b = req({ id: 'B', receivedOn: '2026-09-10' });
    const dupes = findDuplicates([a, b], 30);
    expect(dupes).toEqual([{ requestId: 'B', duplicateOf: 'A', reason: 'same-pseudonym' }]);
  });

  it('matches on normalised email when pseudonyms differ', () => {
    const a = req({ id: 'A', requester: { pseudonym: 'x', email: 'Same@People.example' } });
    const b = req({ id: 'B', receivedOn: '2026-09-03', requester: { pseudonym: 'y', email: ' same@people.example ' } });
    expect(findDuplicates([a, b], 30)[0]).toMatchObject({ requestId: 'B', reason: 'same-email' });
  });

  it('ignores different request types, rejected originals and requests outside the window', () => {
    const a = req({ id: 'A', receivedOn: '2026-01-01' });
    const b = req({ id: 'B', receivedOn: '2026-09-01', type: 'erasure' });
    const c = req({ id: 'C', receivedOn: '2026-09-01', stage: 'rejected' });
    const d = req({ id: 'D', receivedOn: '2026-09-20' });
    const dupes = findDuplicates([a, b, c, d], 30);
    // D is within 30 days of C, but C was rejected, so D is not a duplicate of it; A is far outside the window.
    expect(dupes).toEqual([]);
  });

  it('is order independent', () => {
    const a = req({ id: 'A', receivedOn: '2026-09-01' });
    const b = req({ id: 'B', receivedOn: '2026-09-10' });
    expect(findDuplicates([b, a], 30)).toEqual(findDuplicates([a, b], 30));
  });
});

describe('buildResponsePacket', () => {
  const base = req({
    systemResults: [
      {
        systemId: 'crm',
        found: true,
        recordId: 'crm-77',
        subjectEmail: 'p1@people.example',
        fields: [
          { name: 'name', value: 'Priya Example' },
          { name: 'note', value: 'Spouse Arjun called about the order', thirdParty: true },
        ],
        lookedUpAt: '2026-09-02T00:00:00Z',
      },
      {
        systemId: 'billing',
        found: true,
        recordId: 'inv-5',
        subjectEmail: 'someone.else@people.example',
        fields: [{ name: 'lastInvoice', value: 'INV-5 42.00' }],
        lookedUpAt: '2026-09-02T00:00:00Z',
      },
      { systemId: 'support', found: false, fields: [], lookedUpAt: '2026-09-02T00:00:00Z' },
    ],
  });

  it('redacts third-party fields and keeps the rest', () => {
    const packet = buildResponsePacket(base, '2026-09-05');
    const crm = packet.disclosures.find((d) => d.systemId === 'crm');
    expect(crm?.fields.map((f) => f.name)).toEqual(['name']);
    expect(packet.redactions).toContainEqual({ systemId: 'crm', field: 'note', reason: 'third-party-data' });
  });

  it('withholds a whole system when its subject email conflicts with the requester', () => {
    const packet = buildResponsePacket(base, '2026-09-05');
    expect(packet.disclosures.find((d) => d.systemId === 'billing')?.fields).toEqual([]);
    expect(packet.redactions).toContainEqual({ systemId: 'billing', field: 'lastInvoice', reason: 'identity-conflict' });
    expect(packet.conflicts[0]).toMatch(/billing/);
  });

  it('omits systems where nothing was found and marks the packet partial when anything was withheld', () => {
    const packet = buildResponsePacket(base, '2026-09-05');
    expect(packet.disclosures.map((d) => d.systemId)).toEqual(['crm', 'billing']);
    expect(packet.partial).toBe(true);
  });

  it('turns active holds into exclusions but ignores released holds', () => {
    const held = req({
      ...base,
      holds: [
        { id: 'H1', systemId: 'crm', reason: 'legal-hold', note: 'Litigation hold (synthetic)', appliedAt: '2026-09-03T00:00:00Z' },
        { id: 'H2', systemId: 'billing', reason: 'fraud-prevention', note: 'released', appliedAt: '2026-09-03T00:00:00Z', releasedAt: '2026-09-04T00:00:00Z' },
      ],
    });
    const packet = buildResponsePacket(held, '2026-09-05');
    expect(packet.exclusions).toEqual([{ systemId: 'crm', reason: 'legal-hold', note: 'Litigation hold (synthetic)' }]);
    expect(packet.disclosures.find((d) => d.systemId === 'crm')).toBeUndefined();
  });

  it('is complete when nothing is redacted, excluded or in conflict', () => {
    const clean = req({
      systemResults: [
        { systemId: 'crm', found: true, recordId: 'c1', subjectEmail: 'p1@people.example', fields: [{ name: 'name', value: 'Priya Example' }], lookedUpAt: 'x' },
      ],
    });
    const packet = buildResponsePacket(clean, '2026-09-05');
    expect(packet.partial).toBe(false);
    expect(packet.redactions).toEqual([]);
  });
});
