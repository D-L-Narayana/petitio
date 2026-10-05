import { useMemo, useRef } from 'react';
import type { ActionRequest, ExtensionEligibility, RightsRequest, SystemOfRecord } from '../engine/types';
import { isTerminal } from '../engine/types';
import { assessDeadline, PROFILES, type ExtensionInput } from '../engine/deadline';
import { availableActions } from '../engine/workflow';
import { buildResponsePacket } from '../engine/reconcile';
import type { DuplicateFlag } from '../engine/duplicates';
import { Ribbon } from './Ribbon';
import { StageRail } from './StageRail';
import { ClockSummary } from './detail/ClockSummary';
import { ActionsPanel } from './detail/ActionsPanel';
import { IdentityPanel } from './detail/IdentityPanel';
import { ExtensionPanel } from './detail/ExtensionPanel';
import { SystemsPanel } from './detail/SystemsPanel';
import { HoldsPanel } from './detail/HoldsPanel';
import { PacketPanel, type PacketExport } from './detail/PacketPanel';
import { HistoryPanel } from './detail/HistoryPanel';
import { useFocusAfterTransition } from './detail/useFocusAfterTransition';
import './detail/detail.css';

/** Re-exported for compatibility: App imports `type ActionRequest` from here; the type itself lives in engine/types. */
export type { ActionRequest } from '../engine/types';
export type { PacketExport } from './detail/PacketPanel';

export interface CaseDetailProps {
  request: RightsRequest;
  systems: SystemOfRecord[];
  asOf: string;
  duplicates: DuplicateFlag[];
  onAction: (request: ActionRequest) => void;
  onExtend: (input: ExtensionInput) => void;
  /** `extensionEligibility(request, asOf)`: when it says no, the extension panel explains why instead of offering the form. */
  eligibility?: ExtensionEligibility;
  /** Extra packet exports (Markdown, HTML, …) rendered next to "Export packet JSON". */
  extraExports?: PacketExport[];
  /** Days before the effective due date that count as at-risk; forwarded to assessDeadline when set. */
  atRiskDays?: number;
}

const TYPE_LABEL: Record<RightsRequest['type'], string> = {
  access: 'Access',
  erasure: 'Erasure',
  rectification: 'Rectification',
  portability: 'Portability',
  'opt-out-sale': 'Opt out of sale/sharing',
};

const DISCLAIMER = 'Educational model, not legal advice.';

/** What two requests had in common, by DuplicateFlag reason (unknown future reasons fall back to the raw code). */
const DUPLICATE_MATCH: Record<string, string> = {
  'same-pseudonym': 'pseudonymous requester',
  'same-account': 'account id',
  'same-email': 'normalised email',
};

/**
 * Composition root for one request: header (status, ribbon, clock summary, citation), stage rail, duplicate
 * notice and the panels in src/ui/detail. All engine calls happen here; the panels only render what they are given.
 */
export function CaseDetail({ request, systems, asOf, duplicates, onAction, onExtend, eligibility, extraExports, atRiskDays }: CaseDetailProps) {
  const assessment = useMemo(
    () => (atRiskDays === undefined ? assessDeadline(request, asOf) : assessDeadline(request, asOf, { atRiskDays })),
    [request, asOf, atRiskDays],
  );
  const actions = useMemo(() => availableActions(request, systems), [request, systems]);
  const packet = useMemo(() => buildResponsePacket(request, asOf), [request, asOf]);
  const dup = duplicates.find((d) => d.requestId === request.id);
  const profile = PROFILES[request.jurisdiction];
  const terminal = isTerminal(request.stage);
  // Today's rule (form unless terminal or already extended) when nobody computed eligibility; with a verdict,
  // every open request gets either the form or the pre-emptive explanation.
  const showExtension = !terminal && (eligibility !== undefined || !request.extension);
  const citation = profile.citation.includes(DISCLAIMER) ? profile.citation : `${profile.citation} ${DISCLAIMER}`;
  const titleRef = useRef<HTMLHeadingElement>(null);
  useFocusAfterTransition(request, titleRef);

  return (
    <article className="detail" aria-labelledby="case-title">
      <header className="detail-head">
        <h2 id="case-title" tabIndex={-1} ref={titleRef}>{request.id}</h2>
        <div className="sub">
          <span className={`badge badge-${assessment.status}`}>{assessment.status.replace('-', ' ')}</span>
          <span>{profile.label}</span>
          <span>{TYPE_LABEL[request.type]}</span>
          <span>Requester <span className="mono">{request.requester.pseudonym}</span> · {request.requester.email}</span>
          {dup && <span className="badge badge-dup">possible duplicate of {dup.duplicateOf}</span>}
        </div>
        <Ribbon assessment={assessment} receivedOn={request.receivedOn} large />
        <ClockSummary request={request} assessment={assessment} />
        <p className="citation">{citation}</p>
      </header>

      <section className="panel" aria-label="Stage">
        <StageRail stage={request.stage} />
      </section>

      {dup && (
        <div className="notice" role="note">
          <strong>Duplicate check.</strong> Same {DUPLICATE_MATCH[dup.reason] ?? dup.reason} and request type as <span className="mono">{dup.duplicateOf}</span> within the 30-day window. Consider merging or rejecting with reason <code>duplicate</code>; the decision stays with the analyst.
        </div>
      )}

      <div className="panel-grid">
        <ActionsPanel key={`${request.id}-actions`} actions={actions} request={request} onAction={onAction} />
        <IdentityPanel request={request} />
      </div>

      {showExtension && <ExtensionPanel key={`${request.id}-extension`} request={request} asOf={asOf} onExtend={onExtend} eligibility={eligibility} />}

      <SystemsPanel key={`${request.id}-systems`} request={request} systems={systems} asOf={asOf} onAction={onAction} />

      <div className="panel-grid">
        <HoldsPanel key={`${request.id}-holds`} request={request} systems={systems} asOf={asOf} onAction={onAction} />
        <PacketPanel key={`${request.id}-packet`} packet={packet} request={request} extraExports={extraExports} />
      </div>

      <HistoryPanel request={request} />
    </article>
  );
}
