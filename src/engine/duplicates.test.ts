import { describe, expect, it } from 'vitest';
import { findDuplicates } from './duplicates';
import type { Requester, RightsRequest } from './types';

function req(id: string, receivedOn: string, requester: Requester, overrides: Partial<RightsRequest> = {}): RightsRequest {
  return {
    id,
    receivedOn,
    jurisdiction: 'EU-GDPR',
    type: 'access',
    requester,
    stage: 'received',
    identity: { method: 'none', attempts: 0, maxAttempts: 3, status: 'not-started' },
    holds: [],
    systemResults: [],
    history: [],
    notes: [],
    ...overrides,
  };
}

describe('findDuplicates · same-account', () => {
  it('flags a later request whose trimmed account id matches when pseudonym and email differ', () => {
    const a = req('A', '2026-09-01', { pseudonym: 'lark-7731', email: 'lark.7731@people.example', accountId: 'ACC-10431' });
    const b = req('B', '2026-09-10', { pseudonym: 'wren-0042', email: 'wren.0042@people.example', accountId: '  ACC-10431 ' });
    expect(findDuplicates([a, b], 30)).toEqual([{ requestId: 'B', duplicateOf: 'A', reason: 'same-account' }]);
  });

  it('checks the account id after the pseudonym and before the email', () => {
    const a = req('A', '2026-09-01', { pseudonym: 'lark-7731', email: 'lark.7731@people.example', accountId: 'ACC-1' });
    const samePseudonymAndAccount = req('B', '2026-09-05', { pseudonym: 'lark-7731', email: 'other@people.example', accountId: 'ACC-1' });
    expect(findDuplicates([a, samePseudonymAndAccount], 30)).toEqual([{ requestId: 'B', duplicateOf: 'A', reason: 'same-pseudonym' }]);

    const sameAccountAndEmail = req('C', '2026-09-06', { pseudonym: 'wren-0042', email: 'LARK.7731@people.example', accountId: 'ACC-1' });
    expect(findDuplicates([a, sameAccountAndEmail], 30)).toEqual([{ requestId: 'C', duplicateOf: 'A', reason: 'same-account' }]);
  });

  it('does not flag when the account id is missing on either side or on both', () => {
    const withAccount = (id: string, receivedOn: string, pseudonym: string) => req(id, receivedOn, { pseudonym, email: `${pseudonym}@people.example`, accountId: 'ACC-77' });
    const without = (id: string, receivedOn: string, pseudonym: string) => req(id, receivedOn, { pseudonym, email: `${pseudonym}@people.example` });

    expect(findDuplicates([withAccount('A', '2026-09-01', 'p1'), without('B', '2026-09-02', 'p2')], 30)).toEqual([]);
    expect(findDuplicates([without('A', '2026-09-01', 'p1'), withAccount('B', '2026-09-02', 'p2')], 30)).toEqual([]);
    expect(findDuplicates([without('A', '2026-09-01', 'p1'), without('B', '2026-09-02', 'p2')], 30)).toEqual([]);
  });

  it('treats blank account ids as absent and compares the rest exactly after trimming', () => {
    const blankA = req('A', '2026-09-01', { pseudonym: 'p1', email: 'p1@people.example', accountId: '   ' });
    const blankB = req('B', '2026-09-02', { pseudonym: 'p2', email: 'p2@people.example', accountId: ' ' });
    expect(findDuplicates([blankA, blankB], 30)).toEqual([]);

    const lower = req('C', '2026-09-01', { pseudonym: 'p3', email: 'p3@people.example', accountId: 'acc-1' });
    const upper = req('D', '2026-09-02', { pseudonym: 'p4', email: 'p4@people.example', accountId: 'ACC-1' });
    expect(findDuplicates([lower, upper], 30)).toEqual([]);
  });

  it('still applies the type, window and rejected-original rules to account matches', () => {
    const base: Requester = { pseudonym: 'p1', email: 'p1@people.example', accountId: 'ACC-9' };
    const other: Requester = { pseudonym: 'p2', email: 'p2@people.example', accountId: 'ACC-9' };
    const a = req('A', '2026-09-01', base);
    expect(findDuplicates([a, req('B', '2026-09-05', other, { type: 'erasure' })], 30)).toEqual([]);
    expect(findDuplicates([a, req('C', '2026-10-02', other)], 30)).toEqual([]);
    expect(findDuplicates([req('R', '2026-09-01', base, { stage: 'rejected' }), req('D', '2026-09-05', other)], 30)).toEqual([]);
    expect(findDuplicates([a, req('E', '2026-10-01', other)], 30)).toEqual([{ requestId: 'E', duplicateOf: 'A', reason: 'same-account' }]);
  });
});
