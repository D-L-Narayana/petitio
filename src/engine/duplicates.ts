import type { RightsRequest } from './types';
import { daysBetween } from './deadline';

export interface DuplicateFlag {
  requestId: string;
  duplicateOf: string;
  /** Checked in this order: pseudonym, account id, normalised email. */
  reason: 'same-pseudonym' | 'same-account' | 'same-email';
}

export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Trimmed account id, or undefined when absent or blank. Case is significant: account ids are opaque identifiers. */
function normaliseAccountId(accountId: string | undefined): string | undefined {
  const trimmed = accountId?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Flags later requests that repeat an earlier, non-rejected request of the same type from the
 * same person — by pseudonym, then by account id, then by normalised email — within `windowDays`.
 * The earliest request is the original; every later match is flagged once against the nearest
 * earlier original. Account ids match only when both requests carry one and they are equal after
 * trimming; a missing or blank account id on either side never matches.
 */
export function findDuplicates(requests: RightsRequest[], windowDays = 30): DuplicateFlag[] {
  const ordered = [...requests].sort((a, b) => (a.receivedOn === b.receivedOn ? a.id.localeCompare(b.id) : a.receivedOn.localeCompare(b.receivedOn)));
  const flags: DuplicateFlag[] = [];
  for (let i = 0; i < ordered.length; i += 1) {
    const later = ordered[i]!;
    const laterAccount = normaliseAccountId(later.requester.accountId);
    for (let j = i - 1; j >= 0; j -= 1) {
      const earlier = ordered[j]!;
      if (earlier.stage === 'rejected' || earlier.type !== later.type) continue;
      const gap = daysBetween(earlier.receivedOn, later.receivedOn);
      if (gap < 0 || gap > windowDays) continue;
      if (earlier.requester.pseudonym === later.requester.pseudonym) {
        flags.push({ requestId: later.id, duplicateOf: earlier.id, reason: 'same-pseudonym' });
        break;
      }
      if (laterAccount !== undefined && laterAccount === normaliseAccountId(earlier.requester.accountId)) {
        flags.push({ requestId: later.id, duplicateOf: earlier.id, reason: 'same-account' });
        break;
      }
      if (normaliseEmail(earlier.requester.email) === normaliseEmail(later.requester.email)) {
        flags.push({ requestId: later.id, duplicateOf: earlier.id, reason: 'same-email' });
        break;
      }
    }
  }
  return flags;
}
