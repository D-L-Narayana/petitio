import { useCallback, useMemo, useState } from 'react';
import demoJson from './fixtures/demo-casefile.json';
import type { AuditEntry, CaseFile, RightsRequest } from './engine/types';
import { WorkflowError } from './engine/types';
import { parseCaseFile, serializeCaseFile } from './engine/casefile';
import { assessDeadline, requestExtension } from './engine/deadline';
import { findDuplicates } from './engine/duplicates';
import { transition } from './engine/workflow';
import { appendEntry } from './engine/audit';
import { Docket } from './ui/Docket';
import { CaseDetail, type ActionRequest } from './ui/CaseDetail';
import { AuditDialog } from './ui/AuditDialog';
import { ImportDialog } from './ui/ImportDialog';
import { downloadText } from './ui/download';

function loadDemo(): CaseFile {
  const parsed = parseCaseFile(JSON.stringify(demoJson));
  if (!parsed.ok) throw new Error(`Bundled fixture failed validation: ${parsed.errors.join('; ')}`);
  return parsed.file;
}

const ACTOR = 'analyst.demo';

export function App() {
  const [file, setFile] = useState<CaseFile>(loadDemo);
  const [selectedId, setSelectedId] = useState<string | null>(() => 'REQ-2026-0398');
  const [filters, setFilters] = useState({ jurisdiction: '', type: '', status: '' });
  const [log, setLog] = useState<AuditEntry[]>([]);
  const [status, setStatus] = useState<string>('Demo case file loaded. All data is synthetic; state lives in memory and resets on refresh.');
  const [error, setError] = useState<string | null>(null);
  const [source, setSource] = useState<'demo' | 'imported'>('demo');

  const duplicates = useMemo(() => findDuplicates(file.requests, 30), [file.requests]);

  const docket = useMemo(() => {
    const items = file.requests.map((request) => ({ request, assessment: assessDeadline(request, file.asOf) }));
    const rank: Record<string, number> = { overdue: 0, 'at-risk': 1, 'on-track': 2, closed: 3, rejected: 4 };
    items.sort((a, b) => (rank[a.assessment.status]! - rank[b.assessment.status]!) || a.assessment.daysRemaining - b.assessment.daysRemaining || a.request.id.localeCompare(b.request.id));
    return items.filter(({ request, assessment }) => {
      if (filters.jurisdiction && request.jurisdiction !== filters.jurisdiction) return false;
      if (filters.type && request.type !== filters.type) return false;
      if (filters.status === 'open') return assessment.status !== 'closed' && assessment.status !== 'rejected';
      if (filters.status && assessment.status !== filters.status) return false;
      return true;
    });
  }, [file, filters]);

  const selected = file.requests.find((r) => r.id === selectedId) ?? docket[0]?.request ?? null;

  const audit = useCallback(async (requestId: string, action: string, detail: string) => {
    const next = await appendEntry(log, { at: new Date().toISOString(), actor: ACTOR, requestId, action, detail });
    setLog(next);
  }, [log]);

  function replace(updated: RightsRequest) {
    setFile((f) => ({ ...f, requests: f.requests.map((r) => (r.id === updated.id ? updated : r)) }));
  }

  async function onAction(req: ActionRequest) {
    if (!selected) return;
    setError(null);
    try {
      const next = transition(selected, req.action, { at: `${file.asOf}T12:00:00Z`, actor: ACTOR, ...(req.note ? { note: req.note } : {}), payload: req.payload }, file.systems);
      replace(next);
      const detail = next.history[next.history.length - 1]?.note ?? `${selected.stage} → ${next.stage}`;
      await audit(selected.id, req.action, detail);
      setStatus(`${selected.id}: ${req.action} recorded. Stage is now ${next.stage}.`);
    } catch (e) {
      if (e instanceof WorkflowError) {
        setError(`${e.code}: ${e.message}`);
        await audit(selected.id, `${req.action} (refused)`, e.message);
      } else throw e;
    }
  }

  async function onExtend(input: { reason: string; notifiedOn: string; days?: number }) {
    if (!selected) return;
    setError(null);
    try {
      const next = requestExtension(selected, input);
      replace(next);
      await audit(selected.id, 'extension', `${next.extension?.days} days; notified ${input.notifiedOn}`);
      setStatus(`${selected.id}: extension recorded; due date moved to ${assessDeadline(next, file.asOf).effectiveDueOn}.`);
    } catch (e) {
      if (e instanceof WorkflowError) {
        setError(`${e.code}: ${e.message}`);
        await audit(selected.id, 'extension (refused)', e.message);
      } else throw e;
    }
  }

  function onImport(next: CaseFile, warnings: string[]) {
    setFile(next);
    setSource('imported');
    setSelectedId(next.requests[0]?.id ?? null);
    setError(null);
    setStatus(`Imported ${next.requests.length} requests across ${next.systems.length} systems (as of ${next.asOf}).${warnings.length ? ` ${warnings.length} warning(s): ${warnings.slice(0, 3).join('; ')}` : ''}`);
    void audit('—', 'import', `${next.requests.length} requests`);
  }

  function reset() {
    setFile(loadDemo());
    setSource('demo');
    setSelectedId('REQ-2026-0398');
    setError(null);
    setStatus('Demo case file reloaded.');
  }

  return (
    <>
      <header className="masthead">
        <div>
          <h1>Petitio <small>privacy rights request desk</small></h1>
          <p>Educational prototype. Deterministic deadline clock, request state machine, duplicate detection and multi-system reconciliation over synthetic data. Not legal advice and not a compliance certification.</p>
        </div>
        <div className="toolbar" role="toolbar" aria-label="Case file controls">
          <label>As-of date
            <input type="date" value={file.asOf} onChange={(e) => { if (e.target.value) setFile((f) => ({ ...f, asOf: e.target.value })); }} aria-describedby="asof-help" />
          </label>
          <span id="asof-help" className="sr-only">Deadlines are calculated relative to this date so the demo stays deterministic.</span>
          <ImportDialog onImport={onImport} />
          <button type="button" className="btn btn-ghost" onClick={() => downloadText(`petitio-casefile-${file.asOf}.json`, serializeCaseFile(file))}>Export case file</button>
          <AuditDialog log={log} />
          <button type="button" className="btn btn-ghost" onClick={reset}>Reset demo</button>
        </div>
      </header>

      <div className="workspace">
        <Docket items={docket} selectedId={selected?.id ?? null} duplicates={duplicates} onSelect={(id) => { setSelectedId(id); setError(null); }} filters={filters} onFilter={setFilters} total={file.requests.length} />
        <main>
          {error && <div className="notice notice-red" role="alert" style={{ margin: '16px 28px 0' }}><strong>Refused.</strong> {error}</div>}
          {selected ? (
            <CaseDetail key={selected.id} request={selected} systems={file.systems} asOf={file.asOf} duplicates={duplicates} onAction={onAction} onExtend={onExtend} />
          ) : (
            <div className="detail"><div className="notice">No request selected. Pick one from the docket or import a case file.</div></div>
          )}
        </main>
      </div>
      <footer className="status-line">
        <span role="status" aria-live="polite">{status}</span>
        <span>Source: {source === 'demo' ? 'bundled synthetic fixture' : 'imported file (in memory)'} · {file.requests.length} requests · no storage APIs, no network calls</span>
      </footer>
    </>
  );
}
