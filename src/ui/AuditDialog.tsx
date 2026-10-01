import { useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import type { AuditEntry } from '../engine/types';
import { verifyChain } from '../engine/audit';
import { downloadText } from './download';

export function AuditDialog({ log }: { log: AuditEntry[] }) {
  const [result, setResult] = useState<string | null>(null);
  const [tampered, setTampered] = useState<AuditEntry[] | null>(null);
  const shown = tampered ?? log;

  async function verify(entries: AuditEntry[]) {
    const r = await verifyChain(entries);
    setResult(r.valid ? `Chain intact: ${entries.length} entries, every hash recomputed and linked.` : `Chain broken at entry ${r.brokenAt}: the stored hash or previous-hash link does not match the recomputed value.`);
  }

  return (
    <Dialog.Root onOpenChange={(open) => { if (!open) { setResult(null); setTampered(null); } }}>
      <Dialog.Trigger asChild><button type="button" className="btn btn-ghost">Audit log ({log.length})</button></Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog" aria-describedby="audit-desc">
          <Dialog.Title asChild><h2>Hash-chained audit log</h2></Dialog.Title>
          <Dialog.Description id="audit-desc" className="desc">Every action taken in this session is appended with a SHA-256 hash that covers the entry and the previous hash. Edit a copy to see verification fail; the real log is never altered.</Dialog.Description>
          <div className="dialog-actions">
            <button type="button" className="btn btn-primary" onClick={() => verify(shown)}>Verify chain</button>
            <button type="button" className="btn" disabled={log.length < 1} onClick={() => { setTampered(log.map((e, i) => (i === 0 ? { ...e, detail: `${e.detail} (edited)` } : e))); setResult(null); }}>Simulate tampering with entry 1</button>
            <button type="button" className="btn" disabled={!tampered} onClick={() => { setTampered(null); setResult(null); }}>Restore real log</button>
            <button type="button" className="btn" disabled={log.length === 0} onClick={() => downloadText('petitio-audit-log.json', JSON.stringify(log, null, 2))}>Export JSON</button>
            <Dialog.Close asChild><button type="button" className="btn">Close</button></Dialog.Close>
          </div>
          {result && <div className={`notice ${result.startsWith('Chain intact') ? 'notice-green' : 'notice-red'}`} role="status">{result}</div>}
          {shown.length === 0 ? <p>No actions recorded yet in this session.</p> : (
            <div style={{ overflowX: 'auto', marginTop: 12 }} tabIndex={0} role="region" aria-label="Audit entries">
              <table className="audit-table">
                <thead><tr><th scope="col">#</th><th scope="col">At</th><th scope="col">Actor</th><th scope="col">Request</th><th scope="col">Action</th><th scope="col">Detail</th><th scope="col">Hash</th></tr></thead>
                <tbody>
                  {shown.map((e) => (
                    <tr key={e.seq}><td>{e.seq}</td><td>{e.at}</td><td>{e.actor}</td><td>{e.requestId}</td><td>{e.action}</td><td>{e.detail}</td><td>{e.hash.slice(0, 16)}…</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
