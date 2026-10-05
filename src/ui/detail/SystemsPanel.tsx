import type { ActionRequest, RightsRequest, SystemOfRecord } from '../../engine/types';
import { normaliseEmail } from '../../engine/duplicates';
import { RecordResultForm } from './RecordResultForm';

export interface SystemsPanelProps {
  request: RightsRequest;
  systems: SystemOfRecord[];
  asOf: string;
  onAction: (request: ActionRequest) => void;
}

/**
 * "Systems of record": every system in the case file with its (simulated) lookup result, identity conflicts and
 * third-party fields flagged the same way the packet engine treats them, plus the form to record the next lookup
 * while the request is collecting.
 */
export function SystemsPanel({ request, systems, asOf, onAction }: SystemsPanelProps) {
  const canRecord = request.stage === 'collecting';
  const missing = systems.filter((s) => !request.systemResults.some((r) => r.systemId === s.id));
  const requesterEmail = normaliseEmail(request.requester.email);
  return (
    <section className="panel" aria-labelledby="systems-title">
      <header>
        <h3 id="systems-title">Systems of record</h3>
        <span className="hint">{request.systemResults.length} of {systems.length} looked up{missing.length ? ` · outstanding: ${missing.map((m) => m.id).join(', ')}` : ''}</span>
      </header>
      <div className="panel-body stack-lg">
        <div className="table-scroll" tabIndex={0} role="region" aria-label="System lookup results">
          <table>
            <thead>
              <tr><th scope="col">System</th><th scope="col">Result</th><th scope="col">Matched by</th><th scope="col">Subject email on file</th><th scope="col">Fields</th></tr>
            </thead>
            <tbody>
              {systems.map((s) => {
                const r = request.systemResults.find((x) => x.systemId === s.id);
                // Same rule as buildResponsePacket: any stored subject email that differs from the requester's is a conflict.
                const conflict = r?.subjectEmail !== undefined && normaliseEmail(r.subjectEmail) !== requesterEmail;
                return (
                  <tr key={s.id}>
                    <td><strong className="system-name">{s.name}</strong><br /><span className="system-desc">{s.description}</span></td>
                    <td>{!r ? <span className="tag tag-amber">not looked up</span> : r.found ? <span className="tag tag-green">{`found${r.recordId ? ` · ${r.recordId}` : ''}`}</span> : <span className="tag">no record</span>}</td>
                    <td>{r?.matchedBy?.length ? r.matchedBy.join(', ') : '—'}</td>
                    <td>{r?.subjectEmail !== undefined ? <>{r.subjectEmail || <em>(blank)</em>} {conflict && <span className="tag tag-red">conflict</span>}</> : '—'}</td>
                    <td>{r?.fields.length ? r.fields.map((f, i) => <div key={`${f.name}-${i}`}><span className="mono">{f.name}</span>{f.thirdParty && <> <span className="tag tag-red">third party</span></>}</div>) : '—'}</td>
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
