import { useState } from 'react';
import type { ResponsePacket, RightsRequest } from '../../engine/types';
import { downloadText, safeFilename } from '../download';

/** An extra export offered next to "Export packet JSON" (Markdown, HTML, …); the handler owns the download. */
export interface PacketExport {
  label: string;
  onClick: () => void;
}

export interface PacketPanelProps {
  packet: ResponsePacket;
  request: RightsRequest;
  extraExports?: PacketExport[];
}

/**
 * "Response packet preview": what would be disclosed, with redactions masked unless a reviewer reveals them,
 * the right-aware proposals per system (simulated — nothing is executed), exclusions by hold and identity conflicts.
 */
export function PacketPanel({ packet, request, extraExports = [] }: PacketPanelProps) {
  const [reveal, setReveal] = useState(false);
  const empty = request.systemResults.length === 0;
  const actions = packet.actions ?? [];
  return (
    <section className="panel" aria-labelledby="packet-title">
      <header>
        <h3 id="packet-title">Response packet preview</h3>
        <span className="hint">{packet.partial ? 'Partial — something is withheld' : empty ? 'Nothing collected yet' : 'Complete'}</span>
      </header>
      <div className="panel-body stack">
        {empty ? (
          <p className="muted-note">The packet is derived from recorded system results; none exist yet.</p>
        ) : (
          <>
            <div className="form-actions">
              <label className="check"><input type="checkbox" checked={reveal} onChange={(e) => setReveal(e.target.checked)} /> Reveal redacted values (reviewer only)</label>
              <button type="button" className="btn btn-sm" onClick={() => downloadText(`${safeFilename(request.id)}-response-packet.json`, JSON.stringify(packet, null, 2))}>Export packet JSON</button>
              {extraExports.map((e) => <button key={e.label} type="button" className="btn btn-sm" onClick={e.onClick}>{e.label}</button>)}
            </div>
            {packet.summary && <p className="packet-summary">{packet.summary}</p>}
            {packet.disclosures.length === 0 && <p className="flush">No disclosable records: every found record is held or in conflict.</p>}
            {packet.disclosures.map((d) => {
              const original = request.systemResults.find((r) => r.systemId === d.systemId);
              const redactedHere = packet.redactions.filter((r) => r.systemId === d.systemId);
              return (
                <div key={d.systemId}>
                  <strong className="system-name">{d.systemId}</strong> {d.recordId && <span className="mono">{d.recordId}</span>}
                  <table>
                    <tbody>
                      {d.fields.map((f) => <tr key={f.name}><th scope="row" className="field-name">{f.name}</th><td>{f.value}</td></tr>)}
                      {redactedHere.map((r) => {
                        const value = original?.fields.find((f) => f.name === r.field)?.value ?? '';
                        return (
                          <tr key={r.field}>
                            <th scope="row" className="field-name">{r.field}</th>
                            <td>
                              <span className={`redacted${reveal ? ' revealed' : ''}`} aria-label={reveal ? `redacted value: ${value}` : 'redacted'}>{reveal ? value : '█'.repeat(Math.min(24, Math.max(6, value.length)))}</span>{' '}
                              <span className="tag tag-red">{r.reason}</span>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              );
            })}
            {actions.length > 0 && (
              <table className="packet-actions" aria-labelledby="packet-actions-title">
                <caption id="packet-actions-title">Proposed actions (simulated)</caption>
                <thead><tr><th scope="col">System</th><th scope="col">Action</th><th scope="col">Reason</th></tr></thead>
                <tbody>
                  {actions.map((a, i) => (
                    <tr key={`${a.systemId}-${i}`}><td className="mono">{a.systemId}</td><td>{a.action}</td><td>{a.reason ?? '—'}</td></tr>
                  ))}
                </tbody>
              </table>
            )}
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
