import type { RightsRequest } from '../../engine/types';
import { formatTimestamp } from './format';

export interface HistoryPanelProps {
  request: RightsRequest;
}

/** "History": every transition with its UTC timestamp (kept as an identifier, not prettified), actor and note, then the analyst notes. */
export function HistoryPanel({ request }: HistoryPanelProps) {
  return (
    <section className="panel" aria-labelledby="hist-title">
      <header><h3 id="hist-title">History</h3><span className="hint">{request.history.length} transitions</span></header>
      <div className="panel-body">
        {request.history.length === 0 ? (
          <p className="muted-note">No transitions yet. Start the identity check to begin the clock review.</p>
        ) : (
          <ol className="history">
            {request.history.map((t, i) => (
              <li key={i}>
                <time className="when" dateTime={t.at}>{formatTimestamp(t.at)}</time>
                <span className="what">
                  <strong>{t.action}</strong> · {t.from} → {t.to} · {t.actor}
                  {t.note && <span className="note">{t.note}</span>}
                </span>
              </li>
            ))}
          </ol>
        )}
        {request.notes.length > 0 && (
          <>
            <h4 className="notes-title">Analyst notes</h4>
            <ul className="notes-list">{request.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>
          </>
        )}
      </div>
    </section>
  );
}
