import { useState } from 'react';
import type { ExtensionEligibility, RightsRequest } from '../../engine/types';
import { maxExtensionDays, PROFILES, type ExtensionInput } from '../../engine/deadline';
import { DateText } from './DateText';

export interface ExtensionPanelProps {
  request: RightsRequest;
  asOf: string;
  onExtend: (input: ExtensionInput) => void;
  /**
   * Pre-emptive verdict from `extensionEligibility(request, asOf)`. When it says no, the reason replaces the form;
   * when absent the form is shown and the engine refuses on submit (today's behaviour).
   */
  eligibility?: ExtensionEligibility;
}

/** "Extend the response window": the single statutory extension, explained before it is attempted. */
export function ExtensionPanel({ request, asOf, onExtend, eligibility }: ExtensionPanelProps) {
  const max = eligibility?.maxDays ?? maxExtensionDays(request);
  const noticeRule = PROFILES[request.jurisdiction].extensionNoticeWithinInitialWindow
    ? 'notice must fall inside the initial window'
    : 'notice must be given before the maximum extended window ends';
  const [reason, setReason] = useState('');
  const [days, setDays] = useState(String(max));
  const [notifiedOn, setNotifiedOn] = useState(asOf);
  const canSubmit = reason.trim().length >= 10;
  return (
    <section className="panel" aria-labelledby="ext-title">
      <header>
        <h3 id="ext-title">Extend the response window</h3>
        <span className="hint ext-hint">
          One extension of up to {max} days; {noticeRule}
          {eligibility?.eligible && <> — by <DateText iso={eligibility.noticeDeadlineOn} /></>}
        </span>
      </header>
      <div className="panel-body">
        {eligibility && !eligibility.eligible ? (
          <div className="notice" role="note">Extension not available: {eligibility.reason ?? `refused (${eligibility.code ?? 'no reason given'}).`}</div>
        ) : (
          <form className="form" onSubmit={(e) => { e.preventDefault(); if (canSubmit) onExtend({ reason: reason.trim(), notifiedOn, days: Number(days) }); }}>
            <div className="form-inline">
              <div className="form-row">
                <label htmlFor="ext-days">Extension (days)</label>
                <input id="ext-days" type="number" min={1} max={max} value={days} onChange={(e) => setDays(e.target.value)} />
              </div>
              <div className="form-row">
                <label htmlFor="ext-notified">Requester notified on</label>
                <input id="ext-notified" type="date" value={notifiedOn} onChange={(e) => setNotifiedOn(e.target.value)} />
              </div>
            </div>
            <div className="form-row">
              <label htmlFor="ext-reason">Why more time is necessary (10+ characters)</label>
              <textarea id="ext-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Complexity or number of requests, e.g. archived attachments across three systems" />
            </div>
            <div className="form-actions">
              <button type="submit" className="btn" disabled={!canSubmit}>Record extension</button>
            </div>
          </form>
        )}
      </div>
    </section>
  );
}
