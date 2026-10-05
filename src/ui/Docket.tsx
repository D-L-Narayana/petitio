import { useRef, type KeyboardEvent } from 'react';
import type { DeadlineAssessment, DeadlineStatus, DocketFilters, DocketSummary } from '../engine/types';
import { PROFILES } from '../engine/deadline';
import { DEFAULT_DOCKET_FILTERS, DOCKET_STATUS_ORDER, isDocketSort, type DocketItem } from '../engine/docket';
import { Ribbon } from './Ribbon';
import './docket.css';

export type { DocketItem } from '../engine/docket';

interface Props {
  rows: DocketItem[];
  summary: DocketSummary;
  selectedId: string | null;
  onSelect: (id: string) => void;
  filters: DocketFilters;
  onFilter: (next: DocketFilters) => void;
  /** When provided, an "Export CSV" button is rendered that calls it. */
  onExportCsv?: () => void;
}

/** Jurisdiction options come from the profile table, so a new profile appears here without a UI change. */
const JURISDICTION_OPTIONS = Object.values(PROFILES).map((profile) => ({ value: profile.id, label: profile.label }));

const STATUS_LABEL: Record<DeadlineStatus, string> = { overdue: 'overdue', 'at-risk': 'at risk', 'on-track': 'on track', closed: 'closed', rejected: 'rejected' };

function badgeText(assessment: DeadlineAssessment): string {
  if (assessment.status === 'overdue') return `${-assessment.daysRemaining}d over`;
  if (assessment.status === 'closed' || assessment.status === 'rejected') return assessment.status;
  return `${assessment.daysRemaining}d left`;
}

/** Row index a navigation key moves focus to (clamped), or undefined for keys the browser should keep. */
function nextRowIndex(key: string, index: number, count: number): number | undefined {
  switch (key) {
    case 'ArrowDown':
      return Math.min(count - 1, index + 1);
    case 'ArrowUp':
      return Math.max(0, index - 1);
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return undefined;
  }
}

export function Docket({ rows, summary, selectedId, onSelect, filters, onFilter, onExportCsv }: Props) {
  const listRef = useRef<HTMLUListElement>(null);

  // Roving tabindex: exactly one row sits in the tab order — the selected one, or the first row when the
  // selection is filtered out. Arrow keys, Home and End move focus; Enter and Space select (native button).
  const selectedIndex = rows.findIndex((row) => row.request.id === selectedId);
  const tabStop = selectedIndex === -1 ? 0 : selectedIndex;

  function onRowKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const target = nextRowIndex(event.key, index, rows.length);
    if (target === undefined) return;
    event.preventDefault();
    listRef.current?.querySelectorAll<HTMLButtonElement>('button.docket-row')[target]?.focus();
  }

  const summaryStatuses = DOCKET_STATUS_ORDER.filter((status) => summary.byStatus[status] > 0);

  return (
    <aside className="docket" aria-labelledby="docket-title">
      <div className="docket-head">
        <h2 id="docket-title">Docket · {summary.visible} of {summary.total}</h2>
        <ul className="docket-summary" aria-label="Clock summary">
          {summaryStatuses.map((status) => (
            <li key={status} className={`is-${status}`}>{`${summary.byStatus[status]} ${STATUS_LABEL[status]}`}</li>
          ))}
          {summary.duplicates > 0 && <li className="is-duplicates">{`${summary.duplicates} possible duplicate${summary.duplicates === 1 ? '' : 's'}`}</li>}
        </ul>
        <div className="docket-search">
          <input type="search" aria-label="Search requests" placeholder="Search id, pseudonym, email, account" value={filters.query} onChange={(e) => onFilter({ ...filters, query: e.target.value })} />
        </div>
        <div className="filters">
          <label>Jurisdiction
            <select value={filters.jurisdiction} onChange={(e) => onFilter({ ...filters, jurisdiction: e.target.value })}>
              <option value="">All</option>
              {JURISDICTION_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
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
          <label>Sort
            <select
              value={filters.sort}
              onChange={(e) => {
                const value = e.target.value;
                onFilter({ ...filters, sort: isDocketSort(value) ? value : 'urgency' });
              }}
            >
              <option value="urgency">Urgency</option><option value="received">Received</option><option value="due">Due date</option><option value="id">Id</option>
            </select>
          </label>
        </div>
      </div>
      {rows.length === 0 ? (
        <p className="docket-empty">No requests match these filters. Clear a filter or import a case file.</p>
      ) : (
        <ul className="docket-list" ref={listRef}>
          {rows.map(({ request, assessment, duplicateOf }, index) => (
            <li key={request.id}>
              <button
                type="button"
                className="docket-row"
                aria-current={selectedId === request.id}
                tabIndex={index === tabStop ? 0 : -1}
                onClick={() => onSelect(request.id)}
                onKeyDown={(e) => onRowKeyDown(e, index)}
              >
                <span className="id">{request.id}</span>
                <span className={`badge badge-${assessment.status}`}>{badgeText(assessment)}</span>
                <span className="meta">{request.jurisdiction} · {request.type} · {request.stage}{duplicateOf ? ' · possible duplicate' : ''}</span>
                <span className="ribbon"><Ribbon assessment={assessment} receivedOn={request.receivedOn} /></span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {/* After the list on purpose: the row buttons stay first in the docket's DOM/tab order (App.test.tsx reads the first docket button as the first row). */}
      <div className="docket-actions">
        <button type="button" className="btn btn-sm" onClick={() => onFilter({ ...DEFAULT_DOCKET_FILTERS })}>Clear filters</button>
        {onExportCsv && (
          <button type="button" className="btn btn-sm" onClick={() => onExportCsv()}>Export CSV</button>
        )}
      </div>
    </aside>
  );
}
