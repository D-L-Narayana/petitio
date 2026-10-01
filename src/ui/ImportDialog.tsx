import { useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { DEFAULT_LIMITS, parseCaseFile } from '../engine/casefile';
import type { CaseFile } from '../engine/types';

export function ImportDialog({ onImport }: { onImport: (file: CaseFile, warnings: string[]) => void }) {
  const [text, setText] = useState('');
  const [errors, setErrors] = useState<string[]>([]);
  const [open, setOpen] = useState(false);

  function attempt(source: string) {
    const r = parseCaseFile(source);
    if (r.ok) {
      onImport(r.file, r.warnings);
      setErrors([]);
      setText('');
      setOpen(false);
    } else {
      setErrors(r.errors);
    }
  }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    if (f.size > DEFAULT_LIMITS.maxBytes) {
      setErrors([`File is ${f.size.toLocaleString('en-US')} bytes; the limit is ${DEFAULT_LIMITS.maxBytes.toLocaleString('en-US')} bytes.`]);
      return;
    }
    attempt(await f.text());
    e.target.value = '';
  }

  return (
    <Dialog.Root open={open} onOpenChange={(o) => { setOpen(o); if (!o) setErrors([]); }}>
      <Dialog.Trigger asChild><button type="button" className="btn btn-ghost">Import case file</button></Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog" aria-describedby="import-desc">
          <Dialog.Title asChild><h2>Import a case file</h2></Dialog.Title>
          <Dialog.Description id="import-desc" className="desc">
            JSON with schema <code>petitio.casefile</code> v1. Limits: {DEFAULT_LIMITS.maxBytes.toLocaleString('en-US')} bytes, {DEFAULT_LIMITS.maxRequests} requests, nesting depth {DEFAULT_LIMITS.maxDepth}. The file is read in this tab only; nothing is uploaded or stored. Import replaces the current session.
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
              <Dialog.Close asChild><button type="button" className="btn">Cancel</button></Dialog.Close>
            </div>
          </div>
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
