import { useMemo, useState } from 'react';
import demoJson from './fixtures/demo-casefile.json';
import type { CaseFile, DocketFilters } from './engine/types';
import type { SessionEvent } from './state/session';
import { parseCaseFile, serializeCaseFile } from './engine/casefile';
import { extensionEligibility } from './engine/deadline';
import { findDuplicates } from './engine/duplicates';
import { buildDocket, docketToCsv } from './engine/docket';
import { buildResponsePacket } from './engine/reconcile';
import { packetToHtml, packetToMarkdown } from './engine/exports';
import { useSession } from './state/useSession';
import { Docket } from './ui/Docket';
import { CaseDetail } from './ui/CaseDetail';
import { AuditDialog } from './ui/AuditDialog';
import { ImportDialog } from './ui/ImportDialog';
import { downloadHtml, downloadText, safeFilename } from './ui/download';
import { ThemeToggle } from './theme/ThemeToggle';

function loadDemo(): CaseFile {
  const parsed = parseCaseFile(JSON.stringify(demoJson));
  if (!parsed.ok) throw new Error(`Bundled fixture failed validation: ${parsed.errors.join('; ')}`);
  return parsed.file;
}

const ACTOR = 'analyst.demo';
const DEMO_SELECTED = 'REQ-2026-0398';
const now = () => new Date().toISOString();

/**
 * Composition root. Session state and the audit chain live in `useSession` (pure reducer + ordered audit queue);
 * the docket is derived by `buildDocket`; every panel below receives engine results, never engine internals.
 */
export function App() {
  const [demo] = useState(loadDemo);
  const { state, log, dispatch, selected, auditFailures } = useSession(demo, { actor: ACTOR, now }, DEMO_SELECTED);
  const { file, filters, status, error, source } = state;

  const duplicates = useMemo(() => findDuplicates(file.requests, 30), [file.requests]);
  const { rows, summary } = useMemo(() => buildDocket(file, duplicates, filters), [file, duplicates, filters]);
  // Today's fallback: with nothing (or a vanished id) selected, the detail pane shows the first visible docket row.
  const current = selected ?? rows[0]?.request ?? null;
  const eligibility = useMemo(() => (current ? extensionEligibility(current, file.asOf) : undefined), [current, file.asOf]);

  // The reducer acts on `selectedId`; when the pane is showing the fallback row, select it first so the two
  // synchronous dispatches compose and the action lands on the request the analyst is looking at.
  function act(event: SessionEvent) {
    if (!selected && current) dispatch({ type: 'select', id: current.id });
    dispatch(event);
  }

  // A refusal is "CODE: message"; the only other error text is the audit-queue failure (lead finding F1).
  const errorPrefix = error && /^[A-Z_]+: /.test(error) ? 'Refused.' : 'Not recorded.';

  function exportPacket(format: 'markdown' | 'html') {
    if (!current) return;
    const packet = buildResponsePacket(current, file.asOf);
    const base = safeFilename(`${current.id}-response-packet`);
    if (format === 'markdown') downloadText(`${base}.md`, packetToMarkdown(packet, current, file.systems), 'text/markdown');
    else downloadHtml(`${base}.html`, packetToHtml(packet, current, file.systems));
  }

  // Rebuilt every render on purpose: the handlers must see the latest request and holds, not a memoised snapshot.
  const extraExports = [
    { label: 'Export packet Markdown', onClick: () => exportPacket('markdown') },
    { label: 'Export packet HTML', onClick: () => exportPacket('html') },
  ];

  return (
    <>
      <header className="masthead">
        <div>
          <h1>Petitio <small>privacy rights request desk</small></h1>
          <p>Educational prototype. Deterministic deadline clock, request state machine, duplicate detection and multi-system reconciliation over synthetic data. Not legal advice and not a compliance certification.</p>
        </div>
        <div className="toolbar" role="toolbar" aria-label="Case file controls">
          <label>As-of date
            <input type="date" value={file.asOf} onChange={(e) => dispatch({ type: 'set-as-of', asOf: e.target.value })} aria-describedby="asof-help" />
          </label>
          <span id="asof-help" className="sr-only">Deadlines are calculated relative to this date so the demo stays deterministic.</span>
          <ImportDialog onImport={(next, warnings) => dispatch({ type: 'import', file: next, warnings })} />
          <button type="button" className="btn btn-ghost" onClick={() => downloadText(`petitio-casefile-${file.asOf}.json`, serializeCaseFile(file))}>Export case file</button>
          <AuditDialog log={log} now={now} />
          <button type="button" className="btn btn-ghost" onClick={() => dispatch({ type: 'reset', file: loadDemo(), selectedId: DEMO_SELECTED })}>Reset demo</button>
          <ThemeToggle />
        </div>
      </header>

      <div className="workspace">
        <Docket
          rows={rows}
          summary={summary}
          selectedId={current?.id ?? null}
          onSelect={(id) => dispatch({ type: 'select', id })}
          filters={filters}
          onFilter={(next: DocketFilters) => dispatch({ type: 'filter', filters: next })}
          onExportCsv={() => downloadText(`petitio-docket-${file.asOf}.csv`, docketToCsv(rows), 'text/csv')}
        />
        <main>
          {error && <div className="notice notice-red app-alert" role="alert"><strong>{errorPrefix}</strong> {error}</div>}
          {current ? (
            <CaseDetail
              key={current.id}
              request={current}
              systems={file.systems}
              asOf={file.asOf}
              duplicates={duplicates}
              onAction={(req) => act({ type: 'action', request: req })}
              onExtend={(input) => act({ type: 'extend', input })}
              eligibility={eligibility}
              extraExports={extraExports}
            />
          ) : (
            <div className="detail"><div className="notice">No request selected. Pick one from the docket or import a case file.</div></div>
          )}
        </main>
      </div>
      <footer className="status-line">
        <span role="status" aria-live="polite">{status}</span>
        <span>
          Source: {source === 'demo' ? 'bundled synthetic fixture' : 'imported file (in memory)'} · {file.requests.length} requests · no storage APIs, no network calls
          {auditFailures > 0 ? ` · ${auditFailures} action(s) could not be audited` : ''}
        </span>
      </footer>
    </>
  );
}
