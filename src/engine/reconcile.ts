import type { Exclusion, Redaction, ResponsePacket, RightsRequest } from './types';
import { normaliseEmail } from './duplicates';

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
 */
export function buildResponsePacket(request: RightsRequest, generatedOn: string): ResponsePacket {
  const activeHolds = request.holds.filter((h) => !h.releasedAt);
  const heldSystems = new Set(activeHolds.map((h) => h.systemId));
  const requesterEmail = normaliseEmail(request.requester.email);

  const redactions: Redaction[] = [];
  const conflicts: string[] = [];
  const disclosures: ResponsePacket['disclosures'] = [];

  for (const result of request.systemResults) {
    if (!result.found || heldSystems.has(result.systemId)) continue;
    const conflict = result.subjectEmail !== undefined && normaliseEmail(result.subjectEmail) !== requesterEmail;
    if (conflict) {
      conflicts.push(`${result.systemId}: stored subject email does not match the verified requester; record withheld pending re-verification.`);
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

  return {
    requestId: request.id,
    type: request.type,
    generatedOn,
    disclosures,
    redactions,
    exclusions,
    conflicts,
    partial: redactions.length > 0 || exclusions.length > 0 || conflicts.length > 0,
  };
}
