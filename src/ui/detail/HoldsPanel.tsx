import { useState, type FormEvent } from 'react';
import type { ActionRequest, Hold, HoldReason, RightsRequest, SystemOfRecord } from '../../engine/types';

const HOLD_REASONS: HoldReason[] = ['legal-hold', 'ongoing-transaction', 'fraud-prevention', 'legal-obligation-retention', 'third-party-rights'];

export interface HoldsPanelProps {
  request: RightsRequest;
  systems: SystemOfRecord[];
  asOf: string;
  onAction: (request: ActionRequest) => void;
}

/** Next free id in the existing `HOLD-<last four of the request id>-<n>` scheme; never reuses an id already on the request. */
export function nextHoldId(request: RightsRequest): string {
  const prefix = `HOLD-${request.id.slice(-4)}`;
  let n = request.holds.length + 1;
  while (request.holds.some((h) => h.id === `${prefix}-${n}`)) n += 1;
  return `${prefix}-${n}`;
}

/**
 * "Holds and exemptions": every hold with its justification state, release buttons while in review, and the
 * apply form — which only offers systems that do not already carry an active hold (the engine would refuse
 * a second one with DUPLICATE_HOLD; the UI explains that by not offering it).
 */
export function HoldsPanel({ request, systems, asOf, onAction }: HoldsPanelProps) {
  const active = request.holds.filter((h) => !h.releasedAt);
  const held = new Set(active.map((h) => h.systemId));
  const available = systems.filter((s) => !held.has(s.id));
  const [systemId, setSystemId] = useState(available[0]?.id ?? '');
  const [reason, setReason] = useState<HoldReason>('legal-obligation-retention');
  const [note, setNote] = useState('');
  const inReview = request.stage === 'review';
  const effectiveSystem = available.some((s) => s.id === systemId) ? systemId : (available[0]?.id ?? '');

  function apply(e: FormEvent) {
    e.preventDefault();
    if (!effectiveSystem) return;
    const hold: Hold = { id: nextHoldId(request), systemId: effectiveSystem, reason, note: note.trim(), appliedAt: `${asOf}T12:00:00Z` };
    onAction({ action: 'apply-hold', payload: hold });
    setNote('');
  }

  return (
    <section className="panel" aria-labelledby="holds-title">
      <header><h3 id="holds-title">Holds and exemptions</h3><span className="hint">{active.length} active</span></header>
      <div className="panel-body stack">
        {request.holds.length === 0 && <p className="muted-note">No holds. A hold excludes one system from this request and must carry a written justification before the response can be prepared.</p>}
        {request.holds.map((h) => (
          <div key={h.id} className={`notice ${h.releasedAt ? 'notice-green' : h.note.trim() ? 'notice-indigo' : 'notice-red'}`}>
            <strong>{h.reason}</strong> on <span className="mono">{h.systemId}</span> · <span className="mono">{h.id}</span>
            {h.releasedAt ? <> · released {h.releasedAt.slice(0, 10)}</> : null}
            <div>{h.note.trim() ? h.note : h.releasedAt ? <em>Released without a written justification.</em> : <em>No justification written yet — blocks the response.</em>}</div>
            {!h.releasedAt && inReview && (
              <div className="hold-release"><button type="button" className="btn btn-sm" onClick={() => onAction({ action: 'release-hold', payload: h.id })}>Release hold</button></div>
            )}
          </div>
        ))}
        {inReview && available.length === 0 && (
          <p className="muted-note">Every system of record already carries an active hold. Release one before applying another.</p>
        )}
        {inReview && available.length > 0 && (
          <form className="form" onSubmit={apply}>
            <fieldset>
              <legend>Apply a hold</legend>
              <div className="form-inline">
                <div className="form-row">
                  <label htmlFor="hold-system">System</label>
                  <select id="hold-system" value={effectiveSystem} onChange={(e) => setSystemId(e.target.value)}>{available.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
                </div>
                <div className="form-row">
                  <label htmlFor="hold-reason">Reason</label>
                  <select id="hold-reason" value={reason} onChange={(e) => setReason(e.target.value as HoldReason)}>{HOLD_REASONS.map((r) => <option key={r} value={r}>{r}</option>)}</select>
                </div>
              </div>
              <div className="form-row fieldset-gap">
                <label htmlFor="hold-note">Justification (leave empty to see how an unjustified hold blocks the response)</label>
                <textarea id="hold-note" value={note} onChange={(e) => setNote(e.target.value)} />
              </div>
              <div className="form-actions fieldset-gap"><button type="submit" className="btn">Apply hold</button></div>
            </fieldset>
          </form>
        )}
      </div>
    </section>
  );
}
