import type { DeadlineAssessment, RightsRequest } from '../../engine/types';
import { isTerminal } from '../../engine/types';
import { describeWindow, PROFILES } from '../../engine/deadline';
import { DateText } from './DateText';

export interface ClockSummaryProps {
  request: RightsRequest;
  /** Passed in rather than recomputed so the summary can be exercised with hand-built assessments. */
  assessment: DeadlineAssessment;
}

function ClosureBadge({ assessment }: { assessment: DeadlineAssessment }) {
  if (assessment.closureOutcome === 'on-time') return <span className="badge badge-closed">Closed on time</span>;
  if (assessment.closureOutcome === 'late') {
    const days = assessment.daysLateAtClose ?? 0;
    return <span className="badge badge-overdue">{`Closed ${days} ${days === 1 ? 'day' : 'days'} late`}</span>;
  }
  return null;
}

/**
 * One line of clock facts under the ribbon: window, statutory and effective due dates, the last day an extension
 * notice may still be given, elapsed/remaining days and — for closed requests — whether the close met the deadline.
 * Dates are readable text with the ISO form kept in `<time dateTime>`.
 */
export function ClockSummary({ request, assessment }: ClockSummaryProps) {
  const profile = PROFILES[request.jurisdiction];
  const terminal = isTerminal(request.stage);
  const { extension } = request;
  return (
    <div className="clock-summary">
      <span>Window <strong>{describeWindow(profile.window)}</strong></span>
      <span>Statutory due <strong><DateText iso={assessment.statutoryDueOn} /></strong></span>
      {assessment.extended && extension && (
        <span>Extended to <strong><DateText iso={assessment.effectiveDueOn} /></strong> ({extension.days} days, notified <DateText iso={extension.notifiedOn} />)</span>
      )}
      {!terminal && !assessment.extended && assessment.noticeDeadlineOn && (
        <span>Extension notice by <strong><DateText iso={assessment.noticeDeadlineOn} /></strong></span>
      )}
      <span>Elapsed <strong>{assessment.daysElapsed}</strong> of <strong>{assessment.totalWindowDays}</strong> days</span>
      {!terminal && (
        <span>
          {assessment.daysRemaining >= 0 ? (
            <>Remaining <strong>{assessment.daysRemaining}</strong> days</>
          ) : (
            <strong className="clock-overdue">{`${-assessment.daysRemaining} days past due`}</strong>
          )}
        </span>
      )}
      {request.closedOn && <span>Closed <strong><DateText iso={request.closedOn} /></strong></span>}
      <ClosureBadge assessment={assessment} />
      {request.rejectReason && <span>Rejected: <strong>{request.rejectReason}</strong></span>}
    </div>
  );
}
