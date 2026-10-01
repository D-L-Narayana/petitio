import { useMemo, useState } from 'react';
import * as Tooltip from '@radix-ui/react-tooltip';
import type { Action, FieldRecord, Hold, HoldReason, RejectReason, RightsRequest, SystemOfRecord, SystemResult } from '../engine/types';
import { assessDeadline, maxExtensionDays, PROFILES } from '../engine/deadline';
import { availableActions } from '../engine/workflow';
import { buildResponsePacket } from '../engine/reconcile';
import type { DuplicateFlag } from '../engine/duplicates';
import { Ribbon } from './Ribbon';
import { StageRail } from './StageRail';
import { downloadText } from './download';

export interface ActionRequest {
  action: Action;
  payload?: unknown;
  note?: string;
}

interface Props {
  request: RightsRequest;
  systems: SystemOfRecord[];
  asOf: string;
  duplicates: DuplicateFlag[];
  onAction: (req: ActionRequest) => void;
  onExtend: (input: { reason: string; notifiedOn: string; days?: number }) => void;
}

const TYPE_LABEL: Record<RightsRequest['type'], string> = {
  access: 'Access',
  erasure: 'Erasure',
  rectification: 'Rectification',
  portability: 'Portability',
  'opt-out-sale': 'Opt out of sale/sharing',
};

const HOLD_REASONS: HoldReason[] = ['legal-hold', 'ongoing-transaction', 'fraud-prevention', 'legal-obligation-retention', 'third-party-rights'];
const REJECT_REASONS: RejectReason[] = ['duplicate', 'manifestly-unfounded', 'identity-unverified', 'out-of-scope'];

export function CaseDetail({ request, systems, asOf, duplicates, onAction, onExtend }: Props) {
  const assessment = useMemo(() => assessDeadline(request, asOf), [request, asOf]);
  const actions = useMemo(() => availableActions(request, systems), [request, systems]);
  const packet = useMemo(() => buildResponsePacket(request, asOf), [request, asOf]);
  const dup = duplicates.find((d) => d.requestId === request.id);
  const profile = PROFILES[request.jurisdiction];
  const terminal = request.stage === 'closed' || request.stage === 'rejected';

  return (
    <article className="detail" aria-labelledby="case-title">
      <header className="detail-head">
        <h2 id="case-title">{request.id}</h2>
        <div className="sub">
          <span className={`badge badge-${assessment.status}`}>{assessment.status.replace('-', ' ')}</span>
          <span>{profile.label}</span>
          <span>{TYPE_LABEL[request.type]}</span>
          <span>Requester <span className="mono">{request.requester.pseudonym}</span> · {request.requester.email}</span>
          {dup && <span className="badge badge-dup">possible duplicate of {dup.duplicateOf}</span>}
        </div>
        <Ribbon assessment={assessment} receivedOn={request.receivedOn} large />
        <div className="clock-summary">
          <span>Window <strong>{profile.window.kind === 'calendar-months' ? `${profile.window.months} calendar month` : `${profile.window.days} calendar days`}</strong></span>
          <span>Statutory due <strong>{assessment.statutoryDueOn}</strong></span>
          {assessment.extended && <span>Extended to <strong>{assessment.effectiveDueOn}</strong> ({request.extension?.days} days, notified {request.extension?.notifiedOn})</span>}
          <span>Elapsed <strong>{assessment.daysElapsed}</strong> of <strong>{assessment.totalWindowDays}</strong> days</span>
          {!terminal && <span>{assessment.daysRemaining >= 0 ? <>Remaining <strong>{assessment.daysRemaining}</strong> days</> : <strong style={{ color: 'var(--red)' }}>{-assessment.daysRemaining} days past due</strong>}</span>}
          {request.closedOn && <span>Closed <strong>{request.closedOn}</strong></span>}
          {request.rejectReason && <span>Rejected: <strong>{request.rejectReason}</strong></span>}
        </div>
        <p className="hint" style={{ margin: 0, color: 'var(--mute)', fontSize: 13 }}>{profile.citation} Educational model, not legal advice.</p>
      </header>

      <section className="panel" aria-label="Stage">
        <StageRail stage={request.stage} />
      </section>

      {dup && (
        <div className="notice" role="note">
          <strong>Duplicate check.</strong> Same {dup.reason === 'same-pseudonym' ? 'pseudonymous requester' : 'normalised email'} and request type as <span className="mono">{dup.duplicateOf}</span> within the 30-day window. Consider merging or rejecting with reason <code>duplicate</code>; the decision stays with the analyst.
        </div>
      )}

      <div className="panel-grid">
        <ActionsPanel actions={actions} request={request} systems={systems} onAction={onAction} />
        <IdentityPanel request={request} />
      </div>

      {!terminal && !request.extension && (
        <ExtensionPanel request={request} asOf={asOf} onExtend={onExtend} />
      )}

      <SystemsPanel request={request} systems={systems} asOf={asOf} onAction={onAction} />

      <div className="panel-grid">
        <HoldsPanel request={request} systems={systems} asOf={asOf} onAction={onAction} />
        <PacketPanel packet={packet} request={request} />
      </div>

      <section className="panel" aria-labelledby="hist-title">
        <header><h3 id="hist-title">History</h3><span className="hint">{request.history.length} transitions</span></header>
        <div className="panel-body">
          {request.history.length === 0 ? <p style={{ margin: 0, color: 'var(--mute)' }}>No transitions yet. Start the identity check to begin the clock review.</p> : (
            <ol className="history">
              {request.history.map((t, i) => (
                <li key={i}>
                  <span className="when">{t.at.replace('T', ' ').replace('Z', ' UTC')}</span>
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
              <h4 style={{ marginTop: 14, fontSize: 13, color: 'var(--mute)' }}>Analyst notes</h4>
              <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>{request.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>
            </>
          )}
        </div>
      </section>
    </article>
  );
}

function ActionsPanel({ actions, request, systems, onAction }: { actions: ReturnType<typeof availableActions>; request: RightsRequest; systems: SystemOfRecord[]; onAction: (r: ActionRequest) => void }) {
  const [rejectReason, setRejectReason] = useState<RejectReason>('duplicate');
  const [note, setNote] = useState('');
  const simple = actions.filter((a) => !['record-system-result', 'apply-hold', 'release-hold', 'reject'].includes(a.action));
  const reject = actions.find((a) => a.action === 'reject');
  void systems;
  return (
    <section className="panel" aria-labelledby="actions-title">
      <header><h3 id="actions-title">Next actions</h3><span className="hint">Blocked actions explain themselves</span></header>
      <div className="panel-body">
        {actions.length === 0 ? (
          <p style={{ margin: 0, color: 'var(--mute)' }}>This request is {request.stage}. Terminal stages accept no further actions; the history and audit log remain inspectable.</p>
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
                        className={`btn ${a.action === 'reject' ? 'btn-danger' : 'btn-primary'}`}
                        aria-disabled={!a.enabled}
                        aria-describedby={a.enabled ? undefined : `why-${a.action}`}
                        onClick={() => { if (a.enabled) { onAction({ action: a.action, ...(note ? { note } : {}) }); setNote(''); } }}
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
                  <button type="button" className="btn btn-danger" onClick={() => { onAction({ action: 'reject', payload: rejectReason, ...(note ? { note } : {}) }); setNote(''); }}>Reject with this reason</button>
                </div>
              </fieldset>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

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

function IdentityPanel({ request }: { request: RightsRequest }) {
  const id = request.identity;
  return (
    <section className="panel" aria-labelledby="identity-title">
      <header><h3 id="identity-title">Identity proofing</h3><span className={`tag ${id.status === 'passed' ? 'tag-green' : id.status === 'failed' ? 'tag-red' : id.status === 'pending' ? 'tag-amber' : ''}`}>{id.status}</span></header>
      <div className="panel-body">
        <table>
          <tbody>
            <tr><th scope="row">Method</th><td>{id.method}</td></tr>
            <tr><th scope="row">Attempts</th><td>{id.attempts} of {id.maxAttempts}</td></tr>
            <tr><th scope="row">Account id</th><td className="mono">{request.requester.accountId ?? '—'}</td></tr>
            <tr><th scope="row">Age band</th><td>{request.requester.ageBand ?? 'unknown'}</td></tr>
          </tbody>
        </table>
        <p style={{ margin: '10px 0 0', fontSize: 13.5, color: 'var(--mute)' }}>
          Identity proofing is simulated: no email is sent and no document is read. The engine only enforces that lookups cannot begin before a pass is recorded.
        </p>
      </div>
    </section>
  );
}

function ExtensionPanel({ request, asOf, onExtend }: { request: RightsRequest; asOf: string; onExtend: Props['onExtend'] }) {
  const max = maxExtensionDays(request);
  const [reason, setReason] = useState('');
  const [days, setDays] = useState(max);
  const [notifiedOn, setNotifiedOn] = useState(asOf);
  const canSubmit = reason.trim().length >= 10;
  return (
    <section className="panel" aria-labelledby="ext-title">
      <header><h3 id="ext-title">Extend the response window</h3><span className="hint">One extension of up to {max} days; notice must fall inside the initial window</span></header>
      <div className="panel-body">
        <form className="form" onSubmit={(e) => { e.preventDefault(); if (canSubmit) onExtend({ reason: reason.trim(), notifiedOn, days }); }}>
          <div className="form-inline">
            <div className="form-row">
              <label htmlFor="ext-days">Extension (days)</label>
              <input id="ext-days" type="number" min={1} max={max} value={days} onChange={(e) => setDays(Number(e.target.value))} />
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
      </div>
    </section>
  );
}

function SystemsPanel({ request, systems, asOf, onAction }: { request: RightsRequest; systems: SystemOfRecord[]; asOf: string; onAction: (r: ActionRequest) => void }) {
  const canRecord = request.stage === 'collecting';
  const missing = systems.filter((s) => !request.systemResults.some((r) => r.systemId === s.id));
  return (
    <section className="panel" aria-labelledby="systems-title">
      <header>
        <h3 id="systems-title">Systems of record</h3>
        <span className="hint">{request.systemResults.length} of {systems.length} looked up{missing.length ? ` · outstanding: ${missing.map((m) => m.id).join(', ')}` : ''}</span>
      </header>
      <div className="panel-body" style={{ display: 'grid', gap: 14 }}>
        <div style={{ overflowX: 'auto' }} tabIndex={0} role="region" aria-label="System lookup results">
          <table>
            <thead>
              <tr><th scope="col">System</th><th scope="col">Result</th><th scope="col">Matched by</th><th scope="col">Subject email on file</th><th scope="col">Fields</th></tr>
            </thead>
            <tbody>
              {systems.map((s) => {
                const r = request.systemResults.find((x) => x.systemId === s.id);
                const conflict = r?.subjectEmail && r.subjectEmail.trim().toLowerCase() !== request.requester.email.trim().toLowerCase();
                return (
                  <tr key={s.id}>
                    <td><strong style={{ fontFamily: 'var(--display)' }}>{s.name}</strong><br /><span style={{ color: 'var(--mute)', fontSize: 13 }}>{s.description}</span></td>
                    <td>{!r ? <span className="tag tag-amber">not looked up</span> : r.found ? <span className="tag tag-green">found · {r.recordId}</span> : <span className="tag">no record</span>}</td>
                    <td>{r?.matchedBy?.join(', ') ?? '—'}</td>
                    <td>{r?.subjectEmail ? <>{r.subjectEmail} {conflict && <span className="tag tag-red">conflict</span>}</> : '—'}</td>
                    <td>{r?.fields.length ? r.fields.map((f) => <div key={f.name}><span className="mono">{f.name}</span>{f.thirdParty && <> <span className="tag tag-red">third party</span></>}</div>) : '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {canRecord && missing.length > 0 && <RecordResultForm systems={missing} asOf={asOf} onSubmit={(result) => onAction({ action: 'record-system-result', payload: result })} />}
        {canRecord && missing.length === 0 && <div className="notice notice-green">All systems looked up. The request can go to the reviewer.</div>}
      </div>
    </section>
  );
}

function RecordResultForm({ systems, asOf, onSubmit }: { systems: SystemOfRecord[]; asOf: string; onSubmit: (r: SystemResult) => void }) {
  const [systemId, setSystemId] = useState(systems[0]?.id ?? '');
  const [found, setFound] = useState(true);
  const [recordId, setRecordId] = useState('');
  const [subjectEmail, setSubjectEmail] = useState('');
  const [fields, setFields] = useState<FieldRecord[]>([{ name: '', value: '' }]);
  const effectiveSystem = systems.some((s) => s.id === systemId) ? systemId : (systems[0]?.id ?? '');

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const cleanFields = fields.filter((f) => f.name.trim()).map((f) => ({ name: f.name.trim(), value: f.value, ...(f.thirdParty ? { thirdParty: true } : {}) }));
    const result: SystemResult = {
      systemId: effectiveSystem,
      found,
      fields: found ? cleanFields : [],
      lookedUpAt: `${asOf}T12:00:00Z`,
      ...(found && recordId.trim() ? { recordId: recordId.trim() } : {}),
      ...(found && subjectEmail.trim() ? { subjectEmail: subjectEmail.trim() } : {}),
    };
    onSubmit(result);
    setRecordId(''); setSubjectEmail(''); setFields([{ name: '', value: '' }]);
  }

  return (
    <form className="form" onSubmit={submit} aria-label="Record a simulated system lookup">
      <fieldset>
        <legend>Record a lookup result (simulated — nothing is queried)</legend>
        <div className="form-inline">
          <div className="form-row">
            <label htmlFor="res-system">System</label>
            <select id="res-system" value={effectiveSystem} onChange={(e) => setSystemId(e.target.value)}>{systems.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
          </div>
          <div className="form-row">
            <label htmlFor="res-found">Outcome</label>
            <select id="res-found" value={found ? 'found' : 'none'} onChange={(e) => setFound(e.target.value === 'found')}>
              <option value="found">Record found</option>
              <option value="none">No record</option>
            </select>
          </div>
          {found && (
            <>
              <div className="form-row">
                <label htmlFor="res-record">Record id</label>
                <input id="res-record" value={recordId} onChange={(e) => setRecordId(e.target.value)} placeholder="tickets-10431" />
              </div>
              <div className="form-row">
                <label htmlFor="res-email">Subject email on file</label>
                <input id="res-email" value={subjectEmail} onChange={(e) => setSubjectEmail(e.target.value)} placeholder="name@people.example" />
              </div>
            </>
          )}
        </div>
        {found && (
          <div className="field-list" style={{ marginTop: 10 }}>
            {fields.map((f, i) => (
              <div className="field-list-row" key={i}>
                <input aria-label={`Field ${i + 1} name`} value={f.name} onChange={(e) => setFields(fields.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} placeholder="field name" />
                <input aria-label={`Field ${i + 1} value`} value={f.value} onChange={(e) => setFields(fields.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} placeholder="value (synthetic)" />
                <label className="check"><input type="checkbox" checked={Boolean(f.thirdParty)} onChange={(e) => setFields(fields.map((x, j) => (j === i ? { ...x, thirdParty: e.target.checked } : x)))} /> third party</label>
                <button type="button" className="btn btn-sm" onClick={() => setFields(fields.length === 1 ? [{ name: '', value: '' }] : fields.filter((_, j) => j !== i))} aria-label={`Remove field ${i + 1}`}>Remove</button>
              </div>
            ))}
            <div><button type="button" className="btn btn-sm" onClick={() => setFields([...fields, { name: '', value: '' }])}>Add field</button></div>
          </div>
        )}
        <div className="form-actions" style={{ marginTop: 10 }}>
          <button type="submit" className="btn btn-primary">Record result</button>
        </div>
      </fieldset>
    </form>
  );
}

function HoldsPanel({ request, systems, asOf, onAction }: { request: RightsRequest; systems: SystemOfRecord[]; asOf: string; onAction: (r: ActionRequest) => void }) {
  const [systemId, setSystemId] = useState(systems[0]?.id ?? '');
  const [reason, setReason] = useState<HoldReason>('legal-obligation-retention');
  const [note, setNote] = useState('');
  const inReview = request.stage === 'review';
  const active = request.holds.filter((h) => !h.releasedAt);
  return (
    <section className="panel" aria-labelledby="holds-title">
      <header><h3 id="holds-title">Holds and exemptions</h3><span className="hint">{active.length} active</span></header>
      <div className="panel-body" style={{ display: 'grid', gap: 12 }}>
        {request.holds.length === 0 && <p style={{ margin: 0, color: 'var(--mute)' }}>No holds. A hold excludes one system from this request and must carry a written justification before the response can be prepared.</p>}
        {request.holds.map((h) => (
          <div key={h.id} className={`notice ${h.releasedAt ? 'notice-green' : h.note.trim() ? 'notice-indigo' : 'notice-red'}`}>
            <strong>{h.reason}</strong> on <span className="mono">{h.systemId}</span> · <span className="mono">{h.id}</span>
            {h.releasedAt ? <> · released {h.releasedAt.slice(0, 10)}</> : null}
            <div>{h.note.trim() ? h.note : h.releasedAt ? <em>Released without a written justification.</em> : <em>No justification written yet — blocks the response.</em>}</div>
            {!h.releasedAt && inReview && <div style={{ marginTop: 6 }}><button type="button" className="btn btn-sm" onClick={() => onAction({ action: 'release-hold', payload: h.id })}>Release hold</button></div>}
          </div>
        ))}
        {inReview && (
          <form className="form" onSubmit={(e) => { e.preventDefault(); const hold: Hold = { id: `HOLD-${request.id.slice(-4)}-${request.holds.length + 1}`, systemId, reason, note: note.trim(), appliedAt: `${asOf}T12:00:00Z` }; onAction({ action: 'apply-hold', payload: hold }); setNote(''); }}>
            <fieldset>
              <legend>Apply a hold</legend>
              <div className="form-inline">
                <div className="form-row">
                  <label htmlFor="hold-system">System</label>
                  <select id="hold-system" value={systemId} onChange={(e) => setSystemId(e.target.value)}>{systems.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
                </div>
                <div className="form-row">
                  <label htmlFor="hold-reason">Reason</label>
                  <select id="hold-reason" value={reason} onChange={(e) => setReason(e.target.value as HoldReason)}>{HOLD_REASONS.map((r) => <option key={r} value={r}>{r}</option>)}</select>
                </div>
              </div>
              <div className="form-row" style={{ marginTop: 8 }}>
                <label htmlFor="hold-note">Justification (leave empty to see how an unjustified hold blocks the response)</label>
                <textarea id="hold-note" value={note} onChange={(e) => setNote(e.target.value)} />
              </div>
              <div className="form-actions" style={{ marginTop: 8 }}><button type="submit" className="btn">Apply hold</button></div>
            </fieldset>
          </form>
        )}
      </div>
    </section>
  );
}

function PacketPanel({ packet, request }: { packet: ReturnType<typeof buildResponsePacket>; request: RightsRequest }) {
  const [reveal, setReveal] = useState(false);
  const empty = request.systemResults.length === 0;
  return (
    <section className="panel" aria-labelledby="packet-title">
      <header>
        <h3 id="packet-title">Response packet preview</h3>
        <span className="hint">{packet.partial ? 'Partial — something is withheld' : empty ? 'Nothing collected yet' : 'Complete'}</span>
      </header>
      <div className="panel-body" style={{ display: 'grid', gap: 12 }}>
        {empty ? <p style={{ margin: 0, color: 'var(--mute)' }}>The packet is derived from recorded system results; none exist yet.</p> : (
          <>
            <div className="form-actions">
              <label className="check"><input type="checkbox" checked={reveal} onChange={(e) => setReveal(e.target.checked)} /> Reveal redacted values (reviewer only)</label>
              <button type="button" className="btn btn-sm" onClick={() => downloadText(`${request.id}-response-packet.json`, JSON.stringify(packet, null, 2))}>Export packet JSON</button>
            </div>
            {packet.disclosures.length === 0 && <p style={{ margin: 0 }}>No disclosable records: every found record is held or in conflict.</p>}
            {packet.disclosures.map((d) => {
              const original = request.systemResults.find((r) => r.systemId === d.systemId);
              const redactedHere = packet.redactions.filter((r) => r.systemId === d.systemId);
              return (
                <div key={d.systemId}>
                  <strong style={{ fontFamily: 'var(--display)' }}>{d.systemId}</strong> {d.recordId && <span className="mono">{d.recordId}</span>}
                  <table>
                    <tbody>
                      {d.fields.map((f) => <tr key={f.name}><th scope="row" style={{ textTransform: 'none', letterSpacing: 0 }}>{f.name}</th><td>{f.value}</td></tr>)}
                      {redactedHere.map((r) => {
                        const value = original?.fields.find((f) => f.name === r.field)?.value ?? '';
                        return (
                          <tr key={r.field}>
                            <th scope="row" style={{ textTransform: 'none', letterSpacing: 0 }}>{r.field}</th>
                            <td><span className={`redacted${reveal ? ' revealed' : ''}`} aria-label={reveal ? `redacted value: ${value}` : 'redacted'}>{reveal ? value : '█'.repeat(Math.min(24, Math.max(6, value.length)))}</span> <span className="tag tag-red">{r.reason}</span></td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              );
            })}
            {packet.exclusions.length > 0 && (
              <div className="notice notice-indigo"><strong>Excluded by hold</strong><ul>{packet.exclusions.map((e, i) => <li key={i}><span className="mono">{e.systemId}</span> · {e.reason}: {e.note}</li>)}</ul></div>
            )}
            {packet.conflicts.length > 0 && (
              <div className="notice notice-red"><strong>Identity conflicts</strong><ul>{packet.conflicts.map((c, i) => <li key={i}>{c}</li>)}</ul></div>
            )}
          </>
        )}
      </div>
    </section>
  );
}
