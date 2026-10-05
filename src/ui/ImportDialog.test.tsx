import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ImportDialog } from './ImportDialog';
import { parseCaseFile, serializeCaseFile } from '../engine/casefile';
import type { CaseFile } from '../engine/types';
import demo from '../fixtures/demo-casefile.json';

const fixtureIds = demo.requests.map((r) => r.id);
const jsonFile = (text: string, name = 'casefile.json') => new File([text], name, { type: 'application/json' });
const dataTransfer = (files: File[]) => ({ dataTransfer: { files, types: ['Files'] } });

async function openDialog(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'Import case file' }));
  return screen.getByRole('dialog');
}

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

describe('ImportDialog: drag and drop', () => {
  it('imports a .json file dropped onto the dialog through the same validation as the file picker', async () => {
    const onImport = vi.fn<(file: CaseFile, warnings: string[]) => void>();
    const user = userEvent.setup();
    render(<ImportDialog onImport={onImport} />);
    const dialog = await openDialog(user);

    const file = jsonFile(JSON.stringify(demo));
    fireEvent.dragEnter(dialog, dataTransfer([file]));
    fireEvent.dragOver(dialog, dataTransfer([file]));
    fireEvent.drop(dialog, dataTransfer([file]));

    await waitFor(() => expect(onImport).toHaveBeenCalledTimes(1));
    const [imported, warnings] = onImport.mock.calls[0]!;
    expect(imported.requests.map((r) => r.id)).toEqual(fixtureIds);
    expect(warnings).toEqual([]);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull()); // a successful import closes the dialog
  });

  it('applies the byte limit to a dropped file and shows the rejection alert instead of importing', async () => {
    const onImport = vi.fn();
    const user = userEvent.setup();
    render(<ImportDialog onImport={onImport} />);
    const dialog = await openDialog(user);

    fireEvent.drop(dialog, dataTransfer([jsonFile('x'.repeat(1_000_001), 'big.json')]));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Import rejected.');
    expect(alert).toHaveTextContent('File is 1,000,001 bytes; the limit is 1,000,000 bytes.');
    expect(onImport).not.toHaveBeenCalled();
  });

  it('rejects a dropped file that fails validation with the same alert as pasted JSON', async () => {
    const onImport = vi.fn();
    const user = userEvent.setup();
    render(<ImportDialog onImport={onImport} />);
    const dialog = await openDialog(user);

    fireEvent.drop(dialog, dataTransfer([jsonFile('{"schema":"nope"}')]));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/Import rejected\./);
    expect(alert).toHaveTextContent(/schema/);
    expect(onImport).not.toHaveBeenCalled();
  });
});

describe('ImportDialog: validate only', () => {
  it('shows the summary for pasted JSON without importing or closing', async () => {
    const onImport = vi.fn();
    const user = userEvent.setup();
    render(<ImportDialog onImport={onImport} />);
    await openDialog(user);

    await user.click(screen.getByLabelText('Or paste JSON'));
    await user.paste(JSON.stringify(demo));
    await user.click(screen.getByRole('button', { name: 'Validate only' }));

    expect(screen.getByText(`Ready to import: ${demo.requests.length} requests, ${demo.systems.length} systems, as of ${demo.asOf}`)).toBeInTheDocument();
    expect(onImport).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('lists the importer warnings next to the summary', async () => {
    const onImport = vi.fn();
    const user = userEvent.setup();
    render(<ImportDialog onImport={onImport} />);
    await openDialog(user);

    const withWarning = JSON.parse(JSON.stringify(demo)) as typeof demo;
    withWarning.requests[0]!.systemResults[0]!.systemId = 'warehouse';
    await user.click(screen.getByLabelText('Or paste JSON'));
    await user.paste(JSON.stringify(withWarning));
    await user.click(screen.getByRole('button', { name: 'Validate only' }));

    expect(screen.getByText(`Ready to import: ${demo.requests.length} requests, ${demo.systems.length} systems, as of ${demo.asOf}`)).toBeInTheDocument();
    expect(screen.getByText('REQ-2026-0411: result for unknown system "warehouse"')).toBeInTheDocument();
    expect(onImport).not.toHaveBeenCalled();
  });

  it('shows the rejection alert for invalid pasted JSON and still imports nothing', async () => {
    const onImport = vi.fn();
    const user = userEvent.setup();
    render(<ImportDialog onImport={onImport} />);
    await openDialog(user);

    await user.click(screen.getByLabelText('Or paste JSON'));
    await user.paste('{"schema":"nope"}');
    await user.click(screen.getByRole('button', { name: 'Validate only' }));

    expect(screen.getByRole('alert')).toHaveTextContent(/Import rejected\./);
    expect(screen.getByRole('alert')).toHaveTextContent(/schema/);
    expect(onImport).not.toHaveBeenCalled();
  });
});

describe('ImportDialog: sample case file', () => {
  it('downloads the bundled fixture as petitio-sample-casefile.json, serialised exactly like an export', async () => {
    const onImport = vi.fn();
    const user = userEvent.setup();
    render(<ImportDialog onImport={onImport} />);
    await openDialog(user);

    blobs.length = 0;
    downloads.length = 0;
    await user.click(screen.getByRole('button', { name: 'Download sample case file' }));

    expect(downloads).toEqual(['petitio-sample-casefile.json']);
    expect(blobs).toHaveLength(1);
    const text = await blobs[0]!.text();
    const reference = parseCaseFile(JSON.stringify(demo));
    expect(reference.ok).toBe(true);
    if (reference.ok) expect(text).toBe(serializeCaseFile(reference.file));
    const reparsed = parseCaseFile(text);
    expect(reparsed.ok).toBe(true);
    if (reparsed.ok) expect(reparsed.file.requests.map((r) => r.id)).toEqual(fixtureIds);
    expect(onImport).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});
