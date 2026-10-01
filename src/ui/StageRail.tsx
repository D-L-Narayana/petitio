import type { Stage } from '../engine/types';

const ORDER: Stage[] = ['received', 'identity-check', 'verified', 'collecting', 'review', 'response-ready', 'closed'];
const LABEL: Record<Stage, string> = {
  received: 'Received',
  'identity-check': 'Identity check',
  verified: 'Verified',
  collecting: 'System lookups',
  review: 'Reviewer',
  'response-ready': 'Response ready',
  closed: 'Closed',
  rejected: 'Rejected',
};

export function StageRail({ stage }: { stage: Stage }) {
  const idx = stage === 'rejected' ? -1 : ORDER.indexOf(stage);
  return (
    <ol className="rail" aria-label="Request stages" tabIndex={0}>
      {ORDER.map((s, i) => {
        const cls = stage === 'rejected' ? '' : i < idx ? 'done' : i === idx ? 'current' : '';
        return (
          <li key={s} className="rail-step">
            {i > 0 && <span className={`rail-link ${i <= idx ? 'done' : ''}`} aria-hidden="true" />}
            <span className={`rail-node ${cls}`} aria-current={i === idx ? 'step' : undefined}>{LABEL[s]}</span>
          </li>
        );
      })}
      {stage === 'rejected' && (
        <li className="rail-step">
          <span className="rail-link" aria-hidden="true" />
          <span className="rail-node terminal-rejected" aria-current="step">Rejected</span>
        </li>
      )}
    </ol>
  );
}
