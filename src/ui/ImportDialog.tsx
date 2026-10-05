import { useState, type ChangeEvent, type DragEvent } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { DEFAULT_LIMITS, parseCaseFile, serializeCaseFile } from '../engine/casefile';
import type { CaseFile } from '../engine/types';
import demoJson from '../fixtures/demo-casefile.json';
import { downloadText } from './download';

interface Preview {
  summary: string;
  warnings: string[];
}

export function ImportDialog({ onImport }: { onImport: (file: CaseFile, warnings: string[]) => void }) {
  const [text, setText] = useState('');
  const [errors, setErrors] = useState<string[]>([]);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [dragging, setDragging] = useState(false);
  const [open, setOpen] = useState(false);

  function attempt(source: string) {
    const r = parseCaseFile(source);
    if (r.ok) {
      onImport(r.file, r.warnings);
      setErrors([]);
      setPreview(null);
      setText('');
      setOpen(false);
    } else {
      setErrors(r.errors);
      setPreview(null);
    }
  }

  /** Same validation as attempt(), but only reports what would be imported. */
  function validateOnly(source: string) {
    const r = parseCaseFile(source);
    if (r.ok) {
      setErrors([]);
      setPreview({ summary: `Ready to import: ${r.file.requests.length} requests, ${r.file.systems.length} systems, as of ${r.file.asOf}`, warnings: r.warnings });
    } else {
      setErrors(r.errors);
      setPreview(null);
    }
  }

  /** Byte check before the file is read, shared by the picker and drag-and-drop. */
  function tooLarge(f: File): boolean {
    if (f.size <= DEFAULT_LIMITS.maxBytes) return false;
    setErrors([`File is ${f.size.toLocaleString('en-US')} bytes; the limit is ${DEFAULT_LIMITS.maxBytes.toLocaleString('en-US')} bytes.`]);
    setPreview(null);
    return true;
  }

  async function onFile(e: ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    if (tooLarge(f)) return;
    attempt(await f.text());
    e.target.value = '';
  }

  function onDragOver(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    if (!dragging) setDragging(true);
  }

  async function onDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragging(false);
    const f = e.dataTransfer?.files?.[0];
    if (!f) return;
    if (tooLarge(f)) return;
    attempt(await f.text());
  }

  function downloadSample() {
    const parsed = parseCaseFile(JSON.stringify(demoJson));
    if (!parsed.ok) {
      setErrors(parsed.errors);
      return;
    }
    downloadText('petitio-sample-casefile.json', serializeCaseFile(parsed.file));
  }

  return (
    <Dialog.Root open={open} onOpenChange={(o) => { setOpen(o); if (!o) { setErrors([]); setPreview(null); setDragging(false); } }}>
      <Dialog.Trigger asChild><button type="button" className="btn btn-ghost">Import case file</button></Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className={`dialog${dragging ? ' is-dragover' : ''}`} aria-describedby="import-desc" onDragEnter={onDragOver} onDragOver={onDragOver} onDragLeave={() => setDragging(false)} onDrop={onDrop}>
          <Dialog.Title asChild><h2>Import a case file</h2></Dialog.Title>
          <Dialog.Description id="import-desc" className="desc">
            JSON with schema <code>petitio.casefile</code> v1. Limits: {DEFAULT_LIMITS.maxBytes.toLocaleString('en-US')} bytes, {DEFAULT_LIMITS.maxRequests} requests, nesting depth {DEFAULT_LIMITS.maxDepth}. The file is read in this tab only; nothing is uploaded or stored. Import replaces the current session. You can also drop a .json file anywhere on this dialog.
          </Dialog.Description>
          <div className="form">
            <div className="form-row">
              <label htmlFor="import-file">Choose a .json file</label>
              <input id="import-file" type="file" accept="application/json,.json" onChange={onFile} />
            </div>
            <div className="form-row">
              <label htmlFor="import-text">Or paste JSON</label>
              <textarea id="import-text" value={text} onChange={(e) => setText(e.target.value)} rows={8} spellCheck={false} />
            </div>
            <div className="dialog-actions">
              <button type="button" className="btn btn-primary" disabled={!text.trim()} onClick={() => attempt(text)}>Validate and import</button>
              <button type="button" className="btn" disabled={!text.trim()} onClick={() => validateOnly(text)}>Validate only</button>
              <button type="button" className="btn" onClick={downloadSample}>Download sample case file</button>
              <Dialog.Close asChild><button type="button" className="btn">Cancel</button></Dialog.Close>
            </div>
          </div>
          {preview && (
            <div className="notice notice-green" role="note">
              <strong>{preview.summary}</strong>
              {preview.warnings.length > 0 && (
                <>
                  <div>{preview.warnings.length} warning(s):</div>
                  <ul>{preview.warnings.slice(0, 12).map((w, i) => <li key={i}>{w}</li>)}</ul>
                  {preview.warnings.length > 12 && <div>…and {preview.warnings.length - 12} more.</div>}
                </>
              )}
              <div>Nothing has been imported yet. Choose “Validate and import” to replace the current session.</div>
            </div>
          )}
          {errors.length > 0 && (
            <div className="notice notice-red" role="alert">
              <strong>Import rejected.</strong> Fix these and try again:
              <ul>{errors.slice(0, 12).map((e, i) => <li key={i}>{e}</li>)}</ul>
              {errors.length > 12 && <div>…and {errors.length - 12} more.</div>}
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
