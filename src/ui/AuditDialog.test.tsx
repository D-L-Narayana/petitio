import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AuditDialog } from './AuditDialog';
import { appendEntry, parseAuditLog, serializeAuditLog } from '../engine/audit';
import type { AuditEntry } from '../engine/types';

async function makeLog(n: number, prefix: string): Promise<AuditEntry[]> {
  let log: AuditEntry[] = [];
  for (let i = 1; i <= n; i += 1) {
    log = await appendEntry(log, { at: `2026-10-0${i}T09:00:00Z`, actor: 'analyst.demo', requestId: `${prefix}-${i}`, action: 'start-identity-check', detail: `step ${i}` });
  }
  return log;
}

const jsonFile = (text: string, name = 'petitio-audit-log.json') => new File([text], name, { type: 'application/json' });
const entriesRegion = () => screen.getByRole('region', { name: /audit entries/i });

// jsdom has neither URL.createObjectURL nor a download-capable anchor click; capture both.
const blobs: Blob[] = [];
const downloads: string[] = [];
const originalCreate = URL.createObjectURL;
const originalRevoke = URL.revokeObjectURL;
let clickSpy: { mockRestore: () => void } | undefined;

beforeAll(() => {
  URL.createObjectURL = vi.fn((b: Blob | MediaSource) => { blobs.push(b as Blob); return 'blob:petitio-test'; });
  URL.revokeObjectURL = vi.fn();
  // downloadText appends the anchor to <body> before clicking it, so the download name is readable at click time.
  clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => { downloads.push(document.querySelector('a[download]')?.getAttribute('download') ?? ''); });
});

afterAll(async () => {
  await new Promise((r) => setTimeout(r, 20)); // let downloadText's deferred revokeObjectURL run first
  clickSpy?.mockRestore();
  URL.createObjectURL = originalCreate;
  URL.revokeObjectURL = originalRevoke;
});

describe('AuditDialog: verify an exported log', () => {
  it('reports an intact chain for a valid envelope, shows it as imported and leaves the session log untouched', async () => {
    const user = userEvent.setup();
    const session = await makeLog(2, 'SESSION');
    const external = await makeLog(3, 'EXTERNAL');
    render(<AuditDialog log={session} />);
    await user.click(screen.getByRole('button', { name: 'Audit log (2)' }));

    await user.upload(screen.getByLabelText('Verify an exported log'), jsonFile(serializeAuditLog(external, '2026-10-04T12:00:00Z')));

    expect(await screen.findByText('Imported log: 3 entries, chain intact.')).toBeInTheDocument();
    expect(entriesRegion()).toHaveTextContent('EXTERNAL-3');
    expect(entriesRegion()).not.toHaveTextContent('SESSION-1');
    // the trigger still counts the session log (it is aria-hidden behind the modal, hence hidden: true)
    expect(screen.getByRole('button', { name: 'Audit log (2)', hidden: true })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Restore real log' }));
    expect(entriesRegion()).toHaveTextContent('SESSION-2');
    expect(entriesRegion()).not.toHaveTextContent('EXTERNAL');
  });

  it('locates the broken entry when an exported log was edited after export', async () => {
    const user = userEvent.setup();
    const external = await makeLog(3, 'EXTERNAL');
    const edited = external.map((e, i) => (i === 1 ? { ...e, detail: 'edited after export' } : e));
    render(<AuditDialog log={[]} />);
    await user.click(screen.getByRole('button', { name: 'Audit log (0)' }));

    await user.upload(screen.getByLabelText('Verify an exported log'), jsonFile(serializeAuditLog(edited, '2026-10-04T12:00:00Z')));

    expect(await screen.findByText('Imported log: chain broken at entry 2.')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveClass('notice-red');
  });

  it('rejects a file that is not an audit log and says why, without showing any imported entries', async () => {
    const user = userEvent.setup();
    const session = await makeLog(1, 'SESSION');
    render(<AuditDialog log={session} />);
    await user.click(screen.getByRole('button', { name: 'Audit log (1)' }));

    await user.upload(screen.getByLabelText('Verify an exported log'), jsonFile('{"schema":"nope","version":1,"exportedAt":"x","entries":[]}'));

    const status = await screen.findByRole('status');
    expect(status).toHaveTextContent(/^Import rejected: /);
    expect(status).toHaveTextContent(/schema/);
    expect(entriesRegion()).toHaveTextContent('SESSION-1');
    expect(screen.getByRole('button', { name: 'Restore real log' })).toBeDisabled();
  });

  it('rejects a log whose hashes are not 64-character hex without throwing', async () => {
    const user = userEvent.setup();
    const external = await makeLog(1, 'EXTERNAL');
    const hostile = [{ ...external[0]!, hash: 'not-a-hash' }];
    render(<AuditDialog log={[]} />);
    await user.click(screen.getByRole('button', { name: 'Audit log (0)' }));

    await user.upload(screen.getByLabelText('Verify an exported log'), jsonFile(JSON.stringify(hostile)));

    const status = await screen.findByRole('status');
    expect(status).toHaveTextContent(/^Import rejected: /);
    expect(status).toHaveTextContent(/hash/);
  });
});

describe('AuditDialog: export', () => {
  it('downloads petitio-audit-log.json as the petitio.auditlog v1 envelope that parseAuditLog accepts', async () => {
    const user = userEvent.setup();
    const session = await makeLog(2, 'SESSION');
    render(<AuditDialog log={session} now={() => '2026-10-04T12:00:00Z'} />);
    await user.click(screen.getByRole('button', { name: 'Audit log (2)' }));

    blobs.length = 0;
    downloads.length = 0;
    await user.click(screen.getByRole('button', { name: 'Export JSON' }));

    expect(downloads).toEqual(['petitio-audit-log.json']);
    expect(blobs).toHaveLength(1);
    const text = await blobs[0]!.text();
    const envelope = JSON.parse(text) as Record<string, unknown>;
    expect(envelope['schema']).toBe('petitio.auditlog');
    expect(envelope['version']).toBe(1);
    expect(envelope['exportedAt']).toBe('2026-10-04T12:00:00Z');
    expect(parseAuditLog(text)).toEqual({ ok: true, entries: session, legacy: false });
  });
});
