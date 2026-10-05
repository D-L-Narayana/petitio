/**
 * Render helpers for UI journeys. Every label used here is one of the preserved strings in PLAN §4.3 /
 * docs/workflows.md, so a journey test reads like the workflow it exercises. Downloads are observed
 * through the `globalThis.__petitioDownloads` recorder that src/test/setup.ts maintains.
 */
import { fireEvent, render, screen, within, type RenderResult } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import { expect } from 'vitest';
import { App } from '../App';
import type { RecordedDownload } from './setup';

export type { RecordedDownload } from './setup';

/** Control labels (buttons and form fields) from PLAN §4.3 and docs/workflows.md — the test oracle; wording must not change. */
export const LABELS = {
  // toolbar
  asOfDate: 'As-of date',
  importCaseFile: 'Import case file',
  exportCaseFile: 'Export case file',
  resetDemo: 'Reset demo',
  colourTheme: 'Colour theme',
  // import dialog
  chooseJsonFile: 'Choose a .json file',
  orPasteJson: 'Or paste JSON',
  validateAndImport: 'Validate and import',
  validateOnly: 'Validate only',
  downloadSample: 'Download sample case file',
  cancel: 'Cancel',
  // audit dialog
  verifyChain: 'Verify chain',
  simulateTampering: 'Simulate tampering with entry 1',
  restoreRealLog: 'Restore real log',
  exportJson: 'Export JSON',
  close: 'Close',
  verifyExportedLog: 'Verify an exported log',
  // docket
  searchRequests: 'Search requests',
  jurisdiction: 'Jurisdiction',
  type: 'Type',
  clock: 'Clock',
  sort: 'Sort',
  clearFilters: 'Clear filters',
  exportCsv: 'Export CSV',
  // next actions
  noteForHistory: 'Note for the history entry (optional)',
  startIdentityCheck: 'Start identity check',
  recordIdentityPassed: 'Record identity passed',
  recordFailedAttempt: 'Record failed attempt',
  beginSystemLookups: 'Begin system lookups',
  sendToReviewer: 'Send to reviewer',
  prepareResponsePacket: 'Prepare response packet',
  closeRequest: 'Close request',
  rejectReason: 'Reason',
  rejectWithThisReason: 'Reject with this reason',
  // lookups
  outcome: 'Outcome',
  recordResult: 'Record result',
  // holds
  applyHold: 'Apply hold',
  releaseHold: 'Release hold',
  holdJustification: 'Justification (leave empty to see how an unjustified hold blocks the response)',
  // extension
  extensionDays: 'Extension (days)',
  notifiedOn: 'Requester notified on',
  extensionReason: 'Why more time is necessary (10+ characters)',
  recordExtension: 'Record extension',
  // packet
  revealRedacted: 'Reveal redacted values (reviewer only)',
  exportPacketJson: 'Export packet JSON',
  exportPacketMarkdown: 'Export packet Markdown',
  exportPacketHtml: 'Export packet HTML',
} as const;

export type ActionLabel = (typeof LABELS)[keyof typeof LABELS];

/** Accessible names of the landmark-like sections and regions of the page. */
export const SECTIONS = {
  toolbar: 'Case file controls',
  clockSummary: 'Clock summary',
  stages: 'Request stages',
  actions: 'Next actions',
  identity: 'Identity proofing',
  extension: 'Extend the response window',
  systems: 'Systems of record',
  lookupResults: 'System lookup results',
  recordForm: 'Record a simulated system lookup',
  holds: 'Holds and exemptions',
  packet: 'Response packet preview',
  proposedActions: 'Proposed actions (simulated)',
  history: 'History',
  importDialog: 'Import a case file',
  auditDialog: 'Hash-chained audit log',
  auditEntries: 'Audit entries',
} as const;

export function renderApp(): { user: UserEvent; screen: typeof screen; within: typeof within; view: RenderResult } {
  const user = userEvent.setup();
  const view = render(<App />);
  return { user, screen, within, view };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// --- docket -----------------------------------------------------------------------------------------

export function docket(): HTMLElement {
  return screen.getByRole('complementary', { name: /docket/i });
}

export function docketHeading(): HTMLElement {
  return within(docket()).getByRole('heading', { level: 2 });
}

/** The row buttons in display order (the docket's other buttons — Clear filters, Export CSV — are excluded). */
export function docketRows(): HTMLButtonElement[] {
  return Array.from(docket().querySelectorAll<HTMLButtonElement>('button.docket-row'));
}

export function docketRowIds(): string[] {
  return docketRows().map((row) => row.querySelector('.id')?.textContent ?? '');
}

export function docketRow(id: string): HTMLElement {
  return within(docket()).getByRole('button', { name: new RegExp(escapeRegExp(id)) });
}

/** Clicks the docket row (a button) whose accessible name contains the request id. */
export async function selectRequest(user: UserEvent, id: string): Promise<void> {
  await user.click(docketRow(id));
}

// --- case detail ------------------------------------------------------------------------------------

/** A named `<section>`/`region` of the case detail (or any other named region on the page). */
export function region(name: string): HTMLElement {
  return screen.getByRole('region', { name });
}

export function caseTitle(): HTMLElement {
  const title = document.getElementById('case-title');
  if (!title) throw new Error('No #case-title heading is rendered');
  return title;
}

export function clockSummary(): HTMLElement {
  const summary = document.querySelector<HTMLElement>('.clock-summary');
  if (!summary) throw new Error('No .clock-summary is rendered');
  return summary;
}

/** Label of the stage-rail node carrying aria-current="step". */
export function currentStage(): string {
  const rail = screen.getByRole('list', { name: SECTIONS.stages });
  return rail.querySelector('[aria-current="step"]')?.textContent ?? '';
}

export function optionValues(select: HTMLElement): string[] {
  return Array.from((select as HTMLSelectElement).options).map((option) => option.value);
}

export function optionLabels(select: HTMLElement): string[] {
  return Array.from((select as HTMLSelectElement).options).map((option) => option.textContent ?? '');
}

/** Clicks a button by its preserved label; `index` disambiguates repeated labels such as `Release hold`. */
export async function clickAction(user: UserEvent, label: string | RegExp, index?: number): Promise<void> {
  const buttons = screen.getAllByRole('button', { name: label });
  const target = buttons[index ?? 0];
  if (!target || (index === undefined && buttons.length !== 1)) {
    throw new Error(`Expected exactly one button named ${String(label)} (found ${buttons.length}); pass an index to choose one.`);
  }
  await user.click(target);
}

/** `<input type="date">` cannot be typed into under jsdom; a change event with the new value is what the browser would deliver. */
export function setDateInput(input: HTMLElement, value: string): void {
  fireEvent.change(input, { target: { value } });
}

// --- footer -----------------------------------------------------------------------------------------

/**
 * The footer live region (`role="status"`) owned by App. Dialog notices with the same role are ignored.
 * Queried with `hidden: true` because an open Radix dialog marks the rest of the page `aria-hidden`.
 */
export function footerStatus(): HTMLElement {
  const status = screen.getAllByRole('status', { hidden: true }).find((el) => el.closest('footer') !== null);
  if (!status) throw new Error('No role="status" element inside the footer');
  return status;
}

export function expectStatus(pattern: RegExp): void {
  expect(footerStatus()).toHaveTextContent(pattern);
}

export function expectStatusExact(text: string): void {
  expect(footerStatus().textContent).toBe(text);
}

/** The footer's second span: `Source: … · N requests · no storage APIs, no network calls`. */
export function sourceLine(): HTMLElement {
  const line = footerStatus().nextElementSibling;
  if (!(line instanceof HTMLElement)) throw new Error('No source line next to the footer status');
  return line;
}

export function auditTrigger(): HTMLElement {
  return screen.getByRole('button', { name: /^Audit log \(\d+\)$/ });
}

/** Waits for the audit queue to settle on `n` entries (appends are asynchronous — SHA-256 via crypto.subtle). */
export async function expectAuditCount(n: number): Promise<void> {
  await screen.findByRole('button', { name: `Audit log (${n})` });
}

// --- downloads --------------------------------------------------------------------------------------

export function readDownloads(): readonly RecordedDownload[] {
  return globalThis.__petitioDownloads ?? [];
}

export function clearDownloads(): void {
  if (globalThis.__petitioDownloads) globalThis.__petitioDownloads.length = 0;
}

/** Text of a recorded download (default: the most recent). Needs the blob captured by setup.ts. */
export async function readDownloadText(index = -1): Promise<string> {
  const download = readDownloads().at(index);
  if (!download?.blob) throw new Error('No blob was recorded for that download');
  return blobText(download.blob);
}

function blobText(blob: Blob): Promise<string> {
  if (typeof blob.text === 'function') return blob.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
}

export function jsonFile(text: string, name = 'casefile.json'): File {
  return new File([text], name, { type: 'application/json' });
}

// --- dialogs ----------------------------------------------------------------------------------------

/** Opens a Radix dialog through its trigger button and returns both elements. */
export async function openDialog(user: UserEvent, trigger: string | RegExp, title: string): Promise<{ dialog: HTMLElement; trigger: HTMLElement }> {
  const button = screen.getByRole('button', { name: trigger });
  await user.click(button);
  return { dialog: await screen.findByRole('dialog', { name: title }), trigger: button };
}

/** Opens the import dialog, pastes `text` into the JSON box and clicks "Validate and import". */
export async function pasteImport(user: UserEvent, text: string): Promise<void> {
  const { dialog } = await openDialog(user, LABELS.importCaseFile, SECTIONS.importDialog);
  await user.click(within(dialog).getByLabelText(LABELS.orPasteJson));
  await user.paste(text);
  await user.click(within(dialog).getByRole('button', { name: LABELS.validateAndImport }));
}
