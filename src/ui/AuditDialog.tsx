import { useState, type ChangeEvent } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import type { AuditEntry } from '../engine/types';
import { DEFAULT_AUDITLOG_LIMITS, parseAuditLog, serializeAuditLog, verifyChain } from '../engine/audit';
import { downloadText } from './download';

interface Props {
  log: AuditEntry[];
  /** Wall-clock seam for the export timestamp; defaults to the current time. */
  now?: () => string;
}

interface ImportedLog {
  name: string;
  entries: AuditEntry[];
  legacy: boolean;
}

export function AuditDialog({ log, now = () => new Date().toISOString() }: Props) {
  const [result, setResult] = useState<string | null>(null);
  const [tampered, setTampered] = useState<AuditEntry[] | null>(null);
  const [imported, setImported] = useState<ImportedLog | null>(null);
  const shown = imported?.entries ?? tampered ?? log;
  const good = result !== null && (result.startsWith('Chain intact') || result.endsWith('chain intact.'));

  async function verify(entries: AuditEntry[]) {
    const r = await verifyChain(entries);
    setResult(r.valid ? `Chain intact: ${entries.length} entries, every hash recomputed and linked.` : `Chain broken at entry ${r.brokenAt}: the stored hash or previous-hash link does not match the recomputed value.`);
  }

  function restore() {
    setTampered(null);
    setImported(null);
    setResult(null);
  }

  /** Verifies a previously exported log. The session log is never replaced; the imported entries are only shown. */
  async function onVerifyFile(e: ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    if (f.size > DEFAULT_AUDITLOG_LIMITS.maxBytes) {
      setResult(`Import rejected: File is ${f.size.toLocaleString('en-US')} bytes; the limit is ${DEFAULT_AUDITLOG_LIMITS.maxBytes.toLocaleString('en-US')} bytes.`);
      return;
    }
    const parsed = parseAuditLog(await f.text());
    if (!parsed.ok) {
      setResult(`Import rejected: ${parsed.errors[0] ?? 'the file is not an audit log export.'}`);
      return;
    }
    const r = await verifyChain(parsed.entries);
    setTampered(null);
    setImported({ name: f.name, entries: parsed.entries, legacy: parsed.legacy });
    setResult(r.valid ? `Imported log: ${parsed.entries.length} entries, chain intact.` : `Imported log: chain broken at entry ${r.brokenAt}.`);
  }

  return (
    <Dialog.Root onOpenChange={(open) => { if (!open) restore(); }}>
      <Dialog.Trigger asChild><button type="button" className="btn btn-ghost">Audit log ({log.length})</button></Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog" aria-describedby="audit-desc">
          <Dialog.Title asChild><h2>Hash-chained audit log</h2></Dialog.Title>
          <Dialog.Description id="audit-desc" className="desc">Every action taken in this session is appended with a SHA-256 hash that covers the entry and the previous hash. Edit a copy to see verification fail; the real log is never altered. Export writes a <code>petitio.auditlog</code> v1 file that can be verified here later.</Dialog.Description>
          <div className="dialog-actions">
            <button type="button" className="btn btn-primary" onClick={() => verify(shown)}>Verify chain</button>
            <button type="button" className="btn" disabled={log.length < 1} onClick={() => { setImported(null); setTampered(log.map((e, i) => (i === 0 ? { ...e, detail: `${e.detail} (edited)` } : e))); setResult(null); }}>Simulate tampering with entry 1</button>
            <button type="button" className="btn" disabled={!tampered && !imported} onClick={restore}>Restore real log</button>
            <button type="button" className="btn" disabled={log.length === 0} onClick={() => downloadText('petitio-audit-log.json', serializeAuditLog(log, now()))}>Export JSON</button>
            <Dialog.Close asChild><button type="button" className="btn">Close</button></Dialog.Close>
          </div>
          <div className="form-row">
            <label htmlFor="audit-verify-file">Verify an exported log</label>
            <input id="audit-verify-file" type="file" accept="application/json,.json" onChange={onVerifyFile} />
          </div>
          {result && <div className={`notice ${good ? 'notice-green' : 'notice-red'}`} role="status">{result}</div>}
          {imported && (
            <div className="notice notice-indigo" role="note">
              <strong>Imported log.</strong> Showing <code>{imported.name}</code> ({imported.entries.length} entries{imported.legacy ? ', legacy bare-array export' : ''}). The session log is unchanged; choose “Restore real log” to show it again.
            </div>
          )}
          {shown.length === 0 ? <p>{imported ? 'The imported log has no entries.' : 'No actions recorded yet in this session.'}</p> : (
            <div className="audit-entries" tabIndex={0} role="region" aria-label="Audit entries">
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
