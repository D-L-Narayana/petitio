import { useState } from 'react';
import * as Tooltip from '@radix-ui/react-tooltip';
import type { Action, ActionRequest, RejectReason, RightsRequest } from '../../engine/types';
import type { ActionAvailability } from '../../engine/workflow';

const REJECT_REASONS: RejectReason[] = ['duplicate', 'manifestly-unfounded', 'identity-unverified', 'out-of-scope'];

/** Actions that have a form of their own: lookups (Systems panel), holds (Holds panel) and the reject fieldset below. */
const FORM_ACTIONS: ReadonlySet<Action> = new Set<Action>(['record-system-result', 'apply-hold', 'release-hold', 'reject']);

export interface ActionsPanelProps {
  actions: ActionAvailability[];
  request: RightsRequest;
  onAction: (request: ActionRequest) => void;
}

/**
 * "Next actions": one button per structurally possible action. Blocked actions stay visible, carry
 * `aria-disabled`, point at their explanation with `aria-describedby="why-<action>"` and repeat it in a tooltip,
 * so the refusal is readable before — not after — the click.
 */
export function ActionsPanel({ actions, request, onAction }: ActionsPanelProps) {
  const [rejectReason, setRejectReason] = useState<RejectReason>('duplicate');
  const [note, setNote] = useState('');
  const simple = actions.filter((a) => !FORM_ACTIONS.has(a.action));
  const reject = actions.find((a) => a.action === 'reject');

  function submit(request: ActionRequest) {
    const trimmed = note.trim();
    onAction(trimmed ? { ...request, note: trimmed } : request);
    setNote('');
  }

  return (
    <section className="panel" aria-labelledby="actions-title">
      <header><h3 id="actions-title">Next actions</h3><span className="hint">Blocked actions explain themselves</span></header>
      <div className="panel-body">
        {actions.length === 0 ? (
          <p className="muted-note">This request is {request.stage}. Terminal stages accept no further actions; the history and audit log remain inspectable.</p>
        ) : (
          <div className="actions">
            <div className="form-row">
              <label htmlFor="action-note">Note for the history entry (optional)</label>
              <input id="action-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Signed-in session matched" />
            </div>
            {simple.map((a) => (
              <div className="action-row" key={a.action}>
                <Tooltip.Provider delayDuration={200}>
                  <Tooltip.Root>
                    <Tooltip.Trigger asChild>
                      <button
                        type="button"
                        className="btn btn-primary"
                        aria-disabled={!a.enabled}
                        aria-describedby={a.enabled ? undefined : `why-${a.action}`}
                        onClick={() => { if (a.enabled) submit({ action: a.action }); }}
                      >
                        {a.label}
                      </button>
                    </Tooltip.Trigger>
                    {!a.enabled && (
                      <Tooltip.Portal>
                        <Tooltip.Content className="tooltip" sideOffset={6}>{a.blockedBecause}</Tooltip.Content>
                      </Tooltip.Portal>
                    )}
                  </Tooltip.Root>
                </Tooltip.Provider>
                {a.enabled ? <span className="ok">{describe(a.action)}</span> : <span className="why" id={`why-${a.action}`}>{a.blockedBecause}</span>}
              </div>
            ))}
            {reject && (
              <fieldset>
                <legend>Reject request</legend>
                <div className="form-inline">
                  <div className="form-row">
                    <label htmlFor="reject-reason">Reason</label>
                    <select id="reject-reason" value={rejectReason} onChange={(e) => setRejectReason(e.target.value as RejectReason)}>
                      {REJECT_REASONS.map((r) => <option key={r} value={r}>{r}</option>)}
                    </select>
                  </div>
                  <button type="button" className="btn btn-danger" onClick={() => submit({ action: 'reject', payload: rejectReason })}>Reject with this reason</button>
                </div>
              </fieldset>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

/** What an enabled action will do, shown beside its button. */
function describe(action: Action): string {
  switch (action) {
    case 'start-identity-check': return 'Moves to identity check and marks the check pending.';
    case 'identity-passed': return 'Records a successful verification and unlocks system lookups.';
    case 'identity-failed': return 'Counts a failed attempt; the third failure rejects the request.';
    case 'begin-collection': return 'Opens lookups against every system of record.';
    case 'send-to-review': return 'Hands the collected results to a reviewer.';
    case 'prepare-response': return 'Freezes the response packet from the current results and holds.';
    case 'close': return 'Marks the request fulfilled on the as-of date.';
    default: return '';
  }
}
