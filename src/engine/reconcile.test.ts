import { describe, expect, it } from 'vitest';
import { findDuplicates } from './duplicates';
import { buildResponsePacket } from './reconcile';
import type { PacketAction, RequestType, RightsRequest, SystemResult } from './types';

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

describe('buildResponsePacket · right-aware actions', () => {
  const at = '2026-09-02T00:00:00Z';
  /** Four systems: a clean match, a held match, an identity conflict and a system with no record. */
  const matrixResults: SystemResult[] = [
    { systemId: 'crm', found: true, recordId: 'c1', subjectEmail: 'p1@people.example', fields: [{ name: 'name', value: 'Priya Example' }], lookedUpAt: at },
    { systemId: 'billing', found: true, recordId: 'b1', subjectEmail: 'p1@people.example', fields: [{ name: 'invoices', value: '3 invoices' }], lookedUpAt: at },
    { systemId: 'support', found: true, recordId: 's1', subjectEmail: 'other@people.example', fields: [{ name: 'tickets', value: '2 tickets' }], lookedUpAt: at },
    { systemId: 'archive', found: false, fields: [], lookedUpAt: at },
  ];
  const billingHold = { id: 'H1', systemId: 'billing', reason: 'legal-obligation-retention' as const, note: 'Retention period (synthetic)', appliedAt: at };

  const PRIMARY: Array<[RequestType, PacketAction]> = [
    ['access', 'disclose'],
    ['portability', 'export'],
    ['erasure', 'erase'],
    ['rectification', 'rectify'],
    ['opt-out-sale', 'opt-out'],
  ];

  it.each(PRIMARY)('maps a %s request to %s for found systems, retain for held, withhold for conflicts, nothing for not-found', (type, primary) => {
    const packet = buildResponsePacket(req({ type, systemResults: matrixResults, holds: [billingHold] }), '2026-09-05');
    expect(packet.actions).toEqual([
      { systemId: 'crm', action: primary },
      { systemId: 'billing', action: 'retain', reason: 'legal-obligation-retention' },
      { systemId: 'support', action: 'withhold', reason: 'identity-conflict' },
    ]);
    // existing fields keep their meaning: the held system is excluded, the conflict is withheld, not-found is omitted
    expect(packet.disclosures.map((d) => d.systemId)).toEqual(['crm', 'support']);
    expect(packet.exclusions).toEqual([{ systemId: 'billing', reason: 'legal-obligation-retention', note: 'Retention period (synthetic)' }]);
    expect(packet.partial).toBe(true);
  });

  it('lets an active hold take precedence over an identity conflict on the same system', () => {
    const hold = { id: 'H2', systemId: 'support', reason: 'fraud-prevention' as const, note: 'Open fraud case (synthetic)', appliedAt: at };
    const packet = buildResponsePacket(req({ type: 'erasure', systemResults: matrixResults, holds: [hold] }), '2026-09-05');
    expect(packet.actions).toEqual([
      { systemId: 'crm', action: 'erase' },
      { systemId: 'billing', action: 'erase' },
      { systemId: 'support', action: 'retain', reason: 'fraud-prevention' },
    ]);
    expect(packet.conflicts).toEqual([]);
  });

  it('ignores released holds when deciding between retain and the primary action', () => {
    const released = { ...billingHold, releasedAt: '2026-09-04T00:00:00Z' };
    const packet = buildResponsePacket(req({ type: 'portability', systemResults: matrixResults.slice(0, 2), holds: [released] }), '2026-09-05');
    expect(packet.actions).toEqual([
      { systemId: 'crm', action: 'export' },
      { systemId: 'billing', action: 'export' },
    ]);
    expect(packet.partial).toBe(false);
  });

  it('returns no actions when no system result was found', () => {
    const packet = buildResponsePacket(req({ systemResults: [matrixResults[3]!] }), '2026-09-05');
    expect(packet.actions).toEqual([]);
  });
});

describe('buildResponsePacket · summary sentence', () => {
  const at = '2026-09-15T09:00:00Z';

  it('describes a partial erasure packet in one operational sentence', () => {
    const request = req({
      type: 'erasure',
      holds: [{ id: 'HOLD-1', systemId: 'billing', reason: 'legal-obligation-retention', note: 'Invoices retained (synthetic)', appliedAt: at }],
      systemResults: [
        {
          systemId: 'crm',
          found: true,
          recordId: 'crm-1',
          subjectEmail: 'p1@people.example',
          fields: [
            { name: 'displayName', value: 'Quill Oberesh' },
            { name: 'agentNote', value: 'Neighbour accepted the parcel', thirdParty: true },
          ],
          lookedUpAt: at,
        },
        { systemId: 'billing', found: true, recordId: 'cust-1', subjectEmail: 'p1@people.example', fields: [{ name: 'invoices', value: '6 invoices' }], lookedUpAt: at },
        { systemId: 'support', found: false, fields: [], lookedUpAt: at },
      ],
    });
    const packet = buildResponsePacket(request, '2026-10-01');
    expect(packet.summary).toBe('Erasure request: erase 1 system, retain 1 system under legal-obligation-retention, 1 redaction (third-party data); partial response.');
  });

  it('describes a complete access packet and never claims compliance', () => {
    const request = req({
      systemResults: [
        { systemId: 'crm', found: true, recordId: 'crm-1', subjectEmail: 'p1@people.example', fields: [{ name: 'displayName', value: 'Aspen Kowalczyk' }], lookedUpAt: at },
        { systemId: 'billing', found: true, recordId: 'cust-1', subjectEmail: 'p1@people.example', fields: [{ name: 'invoices', value: '2 invoices' }], lookedUpAt: at },
        { systemId: 'support', found: false, fields: [], lookedUpAt: at },
      ],
    });
    const packet = buildResponsePacket(request, '2026-10-01');
    expect(packet.summary).toBe('Access request: disclose 2 systems; complete response.');
    expect(packet.summary).not.toMatch(/compliant|lawful/i);
  });

  it('counts withheld systems and mixed redaction reasons', () => {
    const request = req({
      systemResults: [
        {
          systemId: 'crm',
          found: true,
          recordId: 'crm-1',
          subjectEmail: 'p1@people.example',
          fields: [{ name: 'name', value: 'Priya Example' }, { name: 'note', value: 'Spouse called', thirdParty: true }],
          lookedUpAt: at,
        },
        { systemId: 'billing', found: true, recordId: 'inv-5', subjectEmail: 'someone.else@people.example', fields: [{ name: 'lastInvoice', value: 'INV-5' }], lookedUpAt: at },
      ],
    });
    const packet = buildResponsePacket(request, '2026-10-01');
    expect(packet.summary).toBe('Access request: disclose 1 system, withhold 1 system (identity conflict), 2 redactions (1 third-party data, 1 identity conflict); partial response.');
  });

  it('says so when nothing was found or nothing was looked up', () => {
    const nothingFound = buildResponsePacket(req({ type: 'rectification', systemResults: [{ systemId: 'crm', found: false, fields: [], lookedUpAt: at }] }), '2026-10-01');
    expect(nothingFound.summary).toBe('Rectification request: no records found in 1 system; complete response.');
    const empty = buildResponsePacket(req({ type: 'opt-out-sale' }), '2026-10-01');
    expect(empty.summary).toBe('Opt-out request: no system results recorded; complete response.');
  });

  it.each([
    ['access', 'Access request: disclose 1 system; complete response.'],
    ['portability', 'Portability request: export 1 system; complete response.'],
    ['erasure', 'Erasure request: erase 1 system; complete response.'],
    ['rectification', 'Rectification request: rectify 1 system; complete response.'],
    ['opt-out-sale', 'Opt-out request: apply opt-out to 1 system; complete response.'],
  ] as Array<[RequestType, string]>)('uses the type label and verb for a clean %s packet', (type, expected) => {
    const clean = req({
      type,
      systemResults: [{ systemId: 'crm', found: true, recordId: 'c1', subjectEmail: 'p1@people.example', fields: [{ name: 'name', value: 'Priya Example' }], lookedUpAt: at }],
    });
    expect(buildResponsePacket(clean, '2026-10-01').summary).toBe(expected);
  });

  it('explains a hold on a system without a found record, which still makes the packet partial', () => {
    const request = req({
      holds: [{ id: 'H9', systemId: 'support', reason: 'legal-hold', note: 'Litigation hold (synthetic)', appliedAt: at }],
      systemResults: [
        { systemId: 'crm', found: true, recordId: 'crm-1', subjectEmail: 'p1@people.example', fields: [{ name: 'name', value: 'Priya Example' }], lookedUpAt: at },
        { systemId: 'support', found: false, fields: [], lookedUpAt: at },
      ],
    });
    const packet = buildResponsePacket(request, '2026-10-01');
    expect(packet.partial).toBe(true);
    expect(packet.actions).toEqual([{ systemId: 'crm', action: 'disclose' }]);
    expect(packet.summary).toBe('Access request: disclose 1 system, 1 hold on a system without a found record; partial response.');
  });

  it('groups retained systems by hold reason when the reasons differ', () => {
    const request = req({
      type: 'erasure',
      holds: [
        { id: 'H1', systemId: 'crm', reason: 'legal-hold', note: 'Litigation hold (synthetic)', appliedAt: at },
        { id: 'H2', systemId: 'billing', reason: 'legal-obligation-retention', note: 'Invoices retained (synthetic)', appliedAt: at },
      ],
      systemResults: [
        { systemId: 'crm', found: true, recordId: 'crm-1', subjectEmail: 'p1@people.example', fields: [{ name: 'name', value: 'Priya Example' }], lookedUpAt: at },
        { systemId: 'billing', found: true, recordId: 'cust-1', subjectEmail: 'p1@people.example', fields: [{ name: 'invoices', value: '2 invoices' }], lookedUpAt: at },
        { systemId: 'support', found: true, recordId: 'tickets-1', subjectEmail: 'p1@people.example', fields: [{ name: 'tickets', value: '1 ticket' }], lookedUpAt: at },
      ],
    });
    const packet = buildResponsePacket(request, '2026-10-01');
    expect(packet.actions?.map((a) => a.action)).toEqual(['retain', 'retain', 'erase']);
    expect(packet.summary).toBe('Erasure request: erase 1 system, retain 2 systems (1 under legal-hold, 1 under legal-obligation-retention); partial response.');
  });
});
