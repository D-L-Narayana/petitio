import type { Exclusion, PacketAction, PacketActionItem, Redaction, RequestType, ResponsePacket, RightsRequest } from './types';
import { normaliseEmail } from './duplicates';

/** The action a found, unheld, reconciled record attracts for each right. */
const PRIMARY_ACTION: Record<RequestType, PacketAction> = {
  access: 'disclose',
  portability: 'export',
  erasure: 'erase',
  rectification: 'rectify',
  'opt-out-sale': 'opt-out',
};

/** Verb phrase used in the summary sentence, completed by "N system(s)". */
const PRIMARY_VERB: Record<RequestType, string> = {
  access: 'disclose',
  portability: 'export',
  erasure: 'erase',
  rectification: 'rectify',
  'opt-out-sale': 'apply opt-out to',
};

const TYPE_LABEL: Record<RequestType, string> = {
  access: 'Access',
  portability: 'Portability',
  erasure: 'Erasure',
  rectification: 'Rectification',
  'opt-out-sale': 'Opt-out',
};

const REDACTION_REASON_LABEL: Record<Redaction['reason'], string> = {
  'third-party-data': 'third-party data',
  'identity-conflict': 'identity conflict',
};

/** Primary packet action for a request type: access→disclose, portability→export, erasure→erase, rectification→rectify, opt-out-sale→opt-out. */
export function primaryActionFor(type: RequestType): PacketAction {
  return PRIMARY_ACTION[type];
}

/** Short label for a request type ("Erasure"), used as "Erasure request" in summaries and exports. */
export function requestTypeLabel(type: RequestType): string {
  return TYPE_LABEL[type];
}

/** Human label for a redaction reason ("third-party data", "identity conflict"). */
export function redactionReasonLabel(reason: Redaction['reason']): string {
  return REDACTION_REASON_LABEL[reason];
}

/**
 * Assembles the response packet from recorded system results.
 *
 * Rules (documented in README "Algorithm"):
 * 1. A system whose stored subject email differs from the requester's is treated as an identity
 *    conflict: every field is withheld (reason identity-conflict) and a conflict note is added.
 * 2. Fields marked thirdParty are withheld (reason third-party-data).
 * 3. Systems with an active hold are excluded from the packet entirely.
 * 4. Systems where nothing was found are omitted.
 * 5. The packet is partial when any redaction, exclusion or conflict exists.
 * 6. `actions` proposes one simulated action per *found* system, in systemResults order: an active
 *    hold → `retain` (reason = the hold reason); an identity conflict → `withhold` (reason
 *    identity-conflict); otherwise the right's primary action (see primaryActionFor). Nothing is
 *    executed; the list is a proposal for the analyst and reviewer.
 * 7. `summary` is one operational sentence counting the proposed actions, redactions and holds,
 *    ending in "partial response" or "complete response".
 */
export function buildResponsePacket(request: RightsRequest, generatedOn: string): ResponsePacket {
  const activeHolds = request.holds.filter((h) => !h.releasedAt);
  const requesterEmail = normaliseEmail(request.requester.email);
  const primary = primaryActionFor(request.type);

  const redactions: Redaction[] = [];
  const conflicts: string[] = [];
  const disclosures: ResponsePacket['disclosures'] = [];
  const actions: PacketActionItem[] = [];

  for (const result of request.systemResults) {
    if (!result.found) continue;
    const hold = activeHolds.find((h) => h.systemId === result.systemId);
    if (hold) {
      actions.push({ systemId: result.systemId, action: 'retain', reason: hold.reason });
      continue;
    }
    const conflict = result.subjectEmail !== undefined && normaliseEmail(result.subjectEmail) !== requesterEmail;
    if (conflict) {
      conflicts.push(`${result.systemId}: stored subject email does not match the verified requester; record withheld pending re-verification.`);
      actions.push({ systemId: result.systemId, action: 'withhold', reason: 'identity-conflict' });
    } else {
      actions.push({ systemId: result.systemId, action: primary });
    }
    const kept = [] as typeof result.fields;
    for (const field of result.fields) {
      if (conflict) redactions.push({ systemId: result.systemId, field: field.name, reason: 'identity-conflict' });
      else if (field.thirdParty) redactions.push({ systemId: result.systemId, field: field.name, reason: 'third-party-data' });
      else kept.push(field);
    }
    disclosures.push({ systemId: result.systemId, ...(result.recordId ? { recordId: result.recordId } : {}), fields: kept });
  }

  const exclusions: Exclusion[] = activeHolds.map((h) => ({ systemId: h.systemId, reason: h.reason, note: h.note }));
  const partial = redactions.length > 0 || exclusions.length > 0 || conflicts.length > 0;

  return {
    requestId: request.id,
    type: request.type,
    generatedOn,
    disclosures,
    redactions,
    exclusions,
    conflicts,
    partial,
    actions,
    summary: summarise(request, actions, redactions, exclusions, partial),
  };
}

/**
 * One operational sentence, e.g.
 * "Erasure request: erase 1 system, retain 1 system under legal-obligation-retention, 1 redaction (third-party data); partial response."
 * Wording is deliberately procedural: it counts proposals, it does not assess them.
 */
function summarise(request: RightsRequest, actions: PacketActionItem[], redactions: Redaction[], exclusions: Exclusion[], partial: boolean): string {
  const clauses: string[] = [];
  const found = request.systemResults.filter((r) => r.found);

  if (found.length === 0) {
    clauses.push(request.systemResults.length === 0 ? 'no system results recorded' : `no records found in ${plural(request.systemResults.length, 'system')}`);
  } else {
    const primaryCount = actions.filter((a) => a.action === primaryActionFor(request.type)).length;
    if (primaryCount > 0) clauses.push(`${PRIMARY_VERB[request.type]} ${plural(primaryCount, 'system')}`);

    const retained = actions.filter((a) => a.action === 'retain');
    if (retained.length > 0) {
      const groups = tally(retained.map((a) => a.reason ?? 'an unspecified hold'));
      const total = plural(retained.length, 'system');
      clauses.push(groups.length === 1 ? `retain ${total} under ${groups[0]!.key}` : `retain ${total} (${groups.map((g) => `${g.count} under ${g.key}`).join(', ')})`);
    }

    const withheld = actions.filter((a) => a.action === 'withhold').length;
    if (withheld > 0) clauses.push(`withhold ${plural(withheld, 'system')} (identity conflict)`);
  }

  if (redactions.length > 0) {
    const groups = tally(redactions.map((r) => redactionReasonLabel(r.reason)));
    const total = plural(redactions.length, 'redaction');
    clauses.push(groups.length === 1 ? `${total} (${groups[0]!.key})` : `${total} (${groups.map((g) => `${g.count} ${g.key}`).join(', ')})`);
  }

  const foundIds = new Set(found.map((r) => r.systemId));
  const holdsWithoutRecord = exclusions.filter((e) => !foundIds.has(e.systemId)).length;
  if (holdsWithoutRecord === 1) clauses.push('1 hold on a system without a found record');
  else if (holdsWithoutRecord > 1) clauses.push(`${holdsWithoutRecord} holds on systems without a found record`);

  return `${requestTypeLabel(request.type)} request: ${clauses.join(', ')}; ${partial ? 'partial' : 'complete'} response.`;
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

/** Counts occurrences, preserving first-appearance order so the sentence follows the systemResults order. */
function tally(keys: string[]): Array<{ key: string; count: number }> {
  const groups: Array<{ key: string; count: number }> = [];
  for (const key of keys) {
    const existing = groups.find((g) => g.key === key);
    if (existing) existing.count += 1;
    else groups.push({ key, count: 1 });
  }
  return groups;
}
