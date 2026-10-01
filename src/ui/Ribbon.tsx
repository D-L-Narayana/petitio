import type { DeadlineAssessment } from '../engine/types';
import { daysBetween } from '../engine/deadline';

interface Props {
  assessment: DeadlineAssessment;
  receivedOn: string;
  large?: boolean;
}

/**
 * The deadline ribbon: statutory window as a solid track, any extension as a hatched tail,
 * elapsed time filled in the status colour, and a marker for the as-of date.
 */
export function Ribbon({ assessment, receivedOn, large }: Props) {
  const total = Math.max(1, assessment.totalWindowDays);
  const statutoryPct = assessment.extended ? Math.min(100, (daysBetween(receivedOn, assessment.statutoryDueOn) / total) * 100) : 100;
  const elapsedPct = Math.round(assessment.progress * 1000) / 10;
  const remaining = assessment.daysRemaining >= 0 ? `${assessment.daysRemaining} days remaining` : `${-assessment.daysRemaining} days past due`;
  const label = `${assessment.status.replace('-', ' ')}: ${remaining}, due ${assessment.effectiveDueOn}${assessment.extended ? ' after extension' : ''}`;
  return (
    <div className={`ribbon${large ? ' large' : ''}`} role="img" aria-label={label}>
      <div className="ribbon-track">
        <div className="ribbon-statutory" style={{ width: `${statutoryPct}%` }} />
        {assessment.extended && <div className="ribbon-extension" style={{ width: `${100 - statutoryPct}%` }} />}
        <div className={`ribbon-elapsed is-${assessment.status}`} style={{ width: `${elapsedPct}%` }} />
        {elapsedPct > 0 && elapsedPct < 100 && <div className="ribbon-today" style={{ left: `calc(${elapsedPct}% - 1px)` }} />}
      </div>
      <div className="ribbon-labels" aria-hidden="true">
        <span>received {receivedOn}</span>
        {assessment.extended && <span>statutory {assessment.statutoryDueOn}</span>}
        <span>due {assessment.effectiveDueOn}</span>
      </div>
    </div>
  );
}
