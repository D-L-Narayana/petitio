import type { RightsRequest } from './types';
import { daysBetween } from './deadline';

export interface DuplicateFlag {
  requestId: string;
  duplicateOf: string;
  reason: 'same-pseudonym' | 'same-email';
}

export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Flags later requests that repeat an earlier, non-rejected request of the same type from the
 * same person (by pseudonym or normalised email) within `windowDays`. The earliest request is the
 * original; every later match is flagged once against the nearest earlier original.
 */
export function findDuplicates(requests: RightsRequest[], windowDays = 30): DuplicateFlag[] {
  const ordered = [...requests].sort((a, b) => (a.receivedOn === b.receivedOn ? a.id.localeCompare(b.id) : a.receivedOn.localeCompare(b.receivedOn)));
  const flags: DuplicateFlag[] = [];
  for (let i = 0; i < ordered.length; i += 1) {
    const later = ordered[i]!;
    for (let j = i - 1; j >= 0; j -= 1) {
      const earlier = ordered[j]!;
      if (earlier.stage === 'rejected' || earlier.type !== later.type) continue;
      const gap = daysBetween(earlier.receivedOn, later.receivedOn);
      if (gap < 0 || gap > windowDays) continue;
      if (earlier.requester.pseudonym === later.requester.pseudonym) {
        flags.push({ requestId: later.id, duplicateOf: earlier.id, reason: 'same-pseudonym' });
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
