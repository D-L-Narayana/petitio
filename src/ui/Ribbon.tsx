import type { DeadlineAssessment } from '../engine/types';
import { daysBetween } from '../engine/deadline';
import { DateText } from './detail/DateText';
import './ribbon.css';

interface Props {
  assessment: DeadlineAssessment;
  receivedOn: string;
  large?: boolean;
}

/** Position of a date along the window as a percentage, rounded to one decimal and clamped to the track. */
function positionOf(receivedOn: string, date: string, totalDays: number): number {
  return Math.min(100, Math.max(0, Math.round((daysBetween(receivedOn, date) / totalDays) * 1000) / 10));
}

/**
 * The deadline ribbon: statutory window as a solid track, any extension as a hatched tail, elapsed time filled in
 * the status colour, a marker for the as-of date and — while an extension can still be noticed — a tick on the
 * last day an extension notice may be given. The computed widths/offsets are the only inline styles in the UI;
 * everything static lives in ribbon.css. The visible labels are readable dates; the `aria-label` keeps ISO dates.
 */
export function Ribbon({ assessment, receivedOn, large }: Props) {
  const total = Math.max(1, assessment.totalWindowDays);
  const statutoryPct = assessment.extended ? Math.min(100, (daysBetween(receivedOn, assessment.statutoryDueOn) / total) * 100) : 100;
  const elapsedPct = Math.round(assessment.progress * 1000) / 10;
  const noticeOn = !assessment.extended && assessment.noticeDeadlineOn ? assessment.noticeDeadlineOn : undefined;
  const noticePct = noticeOn === undefined ? undefined : positionOf(receivedOn, noticeOn, total);
  const remaining = assessment.daysRemaining >= 0 ? `${assessment.daysRemaining} days remaining` : `${-assessment.daysRemaining} days past due`;
  const label = `${assessment.status.replace('-', ' ')}: ${remaining}, due ${assessment.effectiveDueOn}${assessment.extended ? ' after extension' : ''}${noticeOn ? `, extension notice by ${noticeOn}` : ''}`;
  return (
    <div className={`ribbon${large ? ' large' : ''}`} role="img" aria-label={label}>
      <div className="ribbon-track">
        <div className="ribbon-statutory" style={{ width: `${statutoryPct}%` }} />
        {assessment.extended && <div className="ribbon-extension" style={{ width: `${100 - statutoryPct}%` }} />}
        <div className={`ribbon-elapsed is-${assessment.status}`} style={{ width: `${elapsedPct}%` }} />
        {noticePct !== undefined && (
          // A 2px tick: centred on its day, but kept inside the clipped track when the notice deadline is the due day itself.
          <div className="ribbon-notice" style={{ left: noticePct >= 100 ? 'calc(100% - 2px)' : `calc(${noticePct}% - 1px)` }} />
        )}
        {elapsedPct > 0 && elapsedPct < 100 && <div className="ribbon-today" style={{ left: `calc(${elapsedPct}% - 1px)` }} />}
      </div>
      <div className="ribbon-labels" aria-hidden="true">
        <span>received <DateText iso={receivedOn} /></span>
        {assessment.extended && <span>statutory <DateText iso={assessment.statutoryDueOn} /></span>}
        <span>due <DateText iso={assessment.effectiveDueOn} /></span>
      </div>
    </div>
  );
}
