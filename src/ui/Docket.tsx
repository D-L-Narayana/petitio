import type { DeadlineAssessment, RightsRequest } from '../engine/types';
import type { DuplicateFlag } from '../engine/duplicates';
import { Ribbon } from './Ribbon';

export interface DocketItem {
  request: RightsRequest;
  assessment: DeadlineAssessment;
}

interface Props {
  items: DocketItem[];
  selectedId: string | null;
  duplicates: DuplicateFlag[];
  onSelect: (id: string) => void;
  filters: { jurisdiction: string; type: string; status: string };
  onFilter: (next: Props['filters']) => void;
  total: number;
}

export function Docket({ items, selectedId, duplicates, onSelect, filters, onFilter, total }: Props) {
  return (
    <aside className="docket" aria-labelledby="docket-title">
      <div className="docket-head">
        <h2 id="docket-title">Docket · {items.length} of {total}</h2>
        <div className="filters">
          <label>Jurisdiction
            <select value={filters.jurisdiction} onChange={(e) => onFilter({ ...filters, jurisdiction: e.target.value })}>
              <option value="">All</option><option value="EU-GDPR">EU GDPR</option><option value="UK-GDPR">UK GDPR</option><option value="US-CA-CCPA">California</option>
            </select>
          </label>
          <label>Type
            <select value={filters.type} onChange={(e) => onFilter({ ...filters, type: e.target.value })}>
              <option value="">All</option><option value="access">Access</option><option value="erasure">Erasure</option><option value="rectification">Rectification</option><option value="portability">Portability</option><option value="opt-out-sale">Opt out</option>
            </select>
          </label>
          <label>Clock
            <select value={filters.status} onChange={(e) => onFilter({ ...filters, status: e.target.value })}>
              <option value="">All</option><option value="open">Open only</option><option value="overdue">Overdue</option><option value="at-risk">At risk</option><option value="on-track">On track</option><option value="closed">Closed</option><option value="rejected">Rejected</option>
            </select>
          </label>
        </div>
      </div>
      {items.length === 0 ? (
        <p className="docket-empty">No requests match these filters. Clear a filter or import a case file.</p>
      ) : (
        <ul className="docket-list">
          {items.map(({ request, assessment }) => {
            const dup = duplicates.some((d) => d.requestId === request.id);
            return (
              <li key={request.id}>
                <button type="button" className="docket-row" aria-current={selectedId === request.id} onClick={() => onSelect(request.id)}>
                  <span className="id">{request.id}</span>
                  <span className={`badge badge-${assessment.status}`}>{assessment.status === 'overdue' ? `${-assessment.daysRemaining}d over` : assessment.status === 'closed' || assessment.status === 'rejected' ? assessment.status : `${assessment.daysRemaining}d left`}</span>
                  <span className="meta">{request.jurisdiction} · {request.type} · {request.stage}{dup ? ' · possible duplicate' : ''}</span>
                  <span className="ribbon"><Ribbon assessment={assessment} receivedOn={request.receivedOn} /></span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </aside>
  );
}
