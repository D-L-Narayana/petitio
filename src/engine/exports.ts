import type { FieldRecord, Redaction, ResponsePacket, RightsRequest, SystemOfRecord } from './types';
import { redactionReasonLabel, requestTypeLabel } from './reconcile';

/**
 * Response-packet exports: plain string builders for Markdown and a self-contained HTML page.
 * Both minimise by design: the requester appears as a pseudonym (never the email), systems' stored
 * subject emails are never emitted, and redacted values are omitted unless `reveal` is set.
 */

export interface PacketExportOptions {
  /** Include the values behind each redaction (reviewer copy, adds a banner). Default false: values are omitted. */
  reveal?: boolean;
}

export const EXPORT_FOOTER = 'Educational prototype — synthetic data, not legal advice.';
export const REVIEWER_BANNER = 'REVIEWER COPY — contains redacted values';

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
  '`': '&#96;',
  '=': '&#61;',
};

/** Escapes text for interpolation into HTML text nodes and double-quoted attribute values. */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"'`=]/g, (c) => HTML_ESCAPES[c] ?? c);
}

interface SystemRef {
  id: string;
  /** Display name from the systems of record; absent when the id is not in the list. */
  name?: string;
}

interface PacketView {
  requestId: string;
  typeLabel: string;
  generatedOn: string;
  pseudonym: string;
  partial: boolean;
  statusText: string;
  disclosures: Array<{ system: SystemRef; recordId?: string; fields: FieldRecord[]; withheld: number }>;
  redactions: Array<{ system: SystemRef; field: string; reasonLabel: string; value: string }>;
  exclusions: Array<{ system: SystemRef; reason: string; note: string }>;
  conflicts: string[];
  actions: Array<{ system: SystemRef; action: string; reason?: string }>;
  summary: string;
  reveal: boolean;
}

function buildView(packet: ResponsePacket, request: RightsRequest, systems: SystemOfRecord[], options: PacketExportOptions): PacketView {
  const reveal = Boolean(options.reveal);
  const ref = (id: string): SystemRef => {
    const name = systems.find((s) => s.id === id)?.name.trim();
    return name ? { id, name } : { id };
  };
  const valueOf = (redaction: Redaction): string =>
    request.systemResults.find((r) => r.systemId === redaction.systemId)?.fields.find((f) => f.name === redaction.field)?.value ?? '';

  return {
    requestId: packet.requestId,
    typeLabel: requestTypeLabel(packet.type),
    generatedOn: packet.generatedOn,
    pseudonym: request.requester.pseudonym,
    partial: packet.partial,
    statusText: packet.partial ? 'Partial response — something is withheld' : 'Complete response — nothing withheld',
    disclosures: packet.disclosures.map((d) => ({
      system: ref(d.systemId),
      recordId: d.recordId,
      fields: d.fields,
      withheld: packet.redactions.filter((r) => r.systemId === d.systemId).length,
    })),
    redactions: packet.redactions.map((r) => ({ system: ref(r.systemId), field: r.field, reasonLabel: redactionReasonLabel(r.reason), value: reveal ? valueOf(r) : '' })),
    exclusions: packet.exclusions.map((e) => ({ system: ref(e.systemId), reason: e.reason, note: e.note })),
    conflicts: packet.conflicts,
    actions: (packet.actions ?? []).map((a) => ({ system: ref(a.systemId), action: a.action, reason: a.reason })),
    summary: packet.summary ?? (packet.partial ? 'Partial response.' : 'Complete response.'),
    reveal,
  };
}

const NO_DISCLOSURES = 'No disclosable records: nothing was found, or every found record is excluded by a hold.';
const ACTIONS_HEADING = 'Proposed actions';
const ACTIONS_NOTE = '(simulated — nothing is executed)';

// ---------------------------------------------------------------------------------------------
// Markdown

/**
 * Escapes text for Markdown: newlines become spaces (table cells are single-line), and the
 * punctuation that could open a table cell, inline HTML, a link or emphasis is backslash-escaped.
 */
function mdEscape(s: string): string {
  return s.replace(/\r\n|\r|\n/g, ' ').replace(/[\\`*_[\]<|]/g, (c) => `\\${c}`);
}

/** Code span: backslash escapes do not apply inside, so backticks are replaced and pipes escaped for GFM tables. */
function mdCode(s: string): string {
  return `\`${s.replace(/\r\n|\r|\n/g, ' ').replace(/`/g, "'").replace(/\|/g, '\\|')}\``;
}

function mdSystemHeading(system: SystemRef): string {
  return system.name ? `${mdEscape(system.name)} (${mdCode(system.id)})` : mdCode(system.id);
}

function mdSystemCell(system: SystemRef): string {
  return system.name ? mdEscape(system.name) : mdCode(system.id);
}

export function packetToMarkdown(packet: ResponsePacket, request: RightsRequest, systems: SystemOfRecord[], options: PacketExportOptions = {}): string {
  const v = buildView(packet, request, systems, options);
  const lines: string[] = [];

  if (v.reveal) lines.push(`> **${REVIEWER_BANNER}**`, '');
  lines.push(`# Response packet — ${mdEscape(v.requestId)} (${mdEscape(v.typeLabel)} request)`, '');
  lines.push(`- Generated on: ${mdEscape(v.generatedOn)}`, `- Requester (pseudonym): ${mdEscape(v.pseudonym)}`, `- Status: ${v.statusText}`, '');

  lines.push('## Disclosures', '');
  if (v.disclosures.length === 0) lines.push(NO_DISCLOSURES, '');
  for (const d of v.disclosures) {
    lines.push(`### ${mdSystemHeading(d.system)}`, '');
    if (d.recordId) lines.push(`Record id: ${mdCode(d.recordId)}`, '');
    if (d.fields.length === 0) {
      lines.push(d.withheld > 0 ? 'All fields withheld — see Redactions.' : 'No fields recorded.', '');
    } else {
      lines.push('| Field | Value |', '|---|---|');
      for (const f of d.fields) lines.push(`| ${mdEscape(f.name)} | ${mdEscape(f.value)} |`);
      lines.push('');
    }
  }

  lines.push('## Redactions', '');
  if (v.redactions.length === 0) lines.push('None.', '');
  else {
    lines.push(v.reveal ? '| System | Field | Reason | Value (reviewer copy) |' : '| System | Field | Reason |', v.reveal ? '|---|---|---|---|' : '|---|---|---|');
    for (const r of v.redactions) {
      lines.push(`| ${mdSystemCell(r.system)} | ${mdEscape(r.field)} | ${r.reasonLabel} |${v.reveal ? ` ${mdEscape(r.value)} |` : ''}`);
    }
    lines.push('');
  }

  lines.push('## Exclusions', '');
  if (v.exclusions.length === 0) lines.push('None.', '');
  else {
    for (const e of v.exclusions) lines.push(`- ${mdSystemHeading(e.system)} — ${mdEscape(e.reason)}${e.note.trim() ? `: ${mdEscape(e.note)}` : ''}`);
    lines.push('');
  }

  lines.push('## Identity conflicts', '');
  if (v.conflicts.length === 0) lines.push('None.', '');
  else {
    for (const c of v.conflicts) lines.push(`- ${mdEscape(c)}`);
    lines.push('');
  }

  lines.push(`## ${ACTIONS_HEADING} ${ACTIONS_NOTE}`, '');
  if (v.actions.length === 0) lines.push('None.', '');
  else {
    lines.push('| System | Action | Reason |', '|---|---|---|');
    for (const a of v.actions) lines.push(`| ${mdSystemCell(a.system)} | ${mdEscape(a.action)} | ${a.reason ? mdEscape(a.reason) : '—'} |`);
    lines.push('');
  }

  lines.push('## Summary', '', mdEscape(v.summary), '');
  lines.push('---', '', EXPORT_FOOTER, '');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------------------------
// HTML — one <style> block, no scripts, no links, no external references. Named CSS colours only
// (the app's design-token lint forbids literal hex/rgb/hsl outside src/theme/tokens.css).

const CSS = `
:root { color-scheme: light dark; }
body { margin: 0 auto; max-width: 56rem; padding: 2rem 1.25rem 3rem; font: 16px/1.5 Georgia, "Times New Roman", serif; }
h1 { font-size: 1.6rem; margin: 0 0 .5rem; }
h1 small, h2 small { font-size: .7em; font-weight: normal; color: dimgray; }
h2 { font-size: 1.15rem; margin: 2rem 0 .5rem; padding-bottom: .25rem; border-bottom: 1px solid gainsboro; }
h3 { font-size: 1rem; margin: 1.25rem 0 .25rem; }
code { font: .92em ui-monospace, "SF Mono", Menlo, Consolas, monospace; }
dl.meta { display: grid; grid-template-columns: max-content 1fr; gap: .2rem 1rem; margin: 0; }
dl.meta dt { color: dimgray; }
dl.meta dd { margin: 0; }
table { border-collapse: collapse; width: 100%; margin: .5rem 0 1rem; }
th, td { text-align: left; vertical-align: top; padding: .35rem .5rem; border-bottom: 1px solid gainsboro; }
th { font-weight: 600; }
ul { padding-left: 1.25rem; }
.banner { margin: 0 0 1.5rem; padding: .6rem .9rem; border: 2px solid firebrick; color: firebrick; font-weight: 700; letter-spacing: .02em; }
.status.partial { color: firebrick; font-weight: 600; }
.status.complete { color: seagreen; font-weight: 600; }
.reason { color: firebrick; }
.revealed { background: lemonchiffon; color: black; }
.none { color: dimgray; font-style: italic; }
footer { margin-top: 3rem; padding-top: 1rem; border-top: 1px solid gainsboro; color: dimgray; font-size: .9rem; }
@media print { body { max-width: none; padding: 0; } .banner { border-width: 3px; } }
`;

function htmlSystemHeading(system: SystemRef): string {
  return system.name ? `${escapeHtml(system.name)} <code>${escapeHtml(system.id)}</code>` : `<code>${escapeHtml(system.id)}</code>`;
}

function htmlSystemCell(system: SystemRef): string {
  return system.name ? escapeHtml(system.name) : `<code>${escapeHtml(system.id)}</code>`;
}

export function packetToHtml(packet: ResponsePacket, request: RightsRequest, systems: SystemOfRecord[], options: PacketExportOptions = {}): string {
  const v = buildView(packet, request, systems, options);
  const e = escapeHtml;
  const out: string[] = [];

  out.push(
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="color-scheme" content="light dark">',
    `<title>Response packet ${e(v.requestId)} — ${e(v.typeLabel)} request</title>`,
    `<style>${CSS}</style>`,
    '</head>',
    '<body>',
  );

  if (v.reveal) out.push(`<p class="banner"><strong>${e(REVIEWER_BANNER)}</strong></p>`);

  out.push(
    '<header>',
    `<h1>Response packet — ${e(v.requestId)} <small>${e(v.typeLabel)} request</small></h1>`,
    '<dl class="meta">',
    `<dt>Generated on</dt><dd><time datetime="${e(v.generatedOn)}">${e(v.generatedOn)}</time></dd>`,
    `<dt>Requester (pseudonym)</dt><dd><code>${e(v.pseudonym)}</code></dd>`,
    `<dt>Status</dt><dd class="status ${v.partial ? 'partial' : 'complete'}">${e(v.statusText)}</dd>`,
    '</dl>',
    '</header>',
    '<main>',
  );

  out.push('<section>', '<h2>Disclosures</h2>');
  if (v.disclosures.length === 0) out.push(`<p class="none">${e(NO_DISCLOSURES)}</p>`);
  for (const d of v.disclosures) {
    out.push('<article>', `<h3>${htmlSystemHeading(d.system)}</h3>`);
    if (d.recordId) out.push(`<p>Record id: <code>${e(d.recordId)}</code></p>`);
    if (d.fields.length === 0) {
      out.push(`<p class="none">${d.withheld > 0 ? 'All fields withheld — see Redactions.' : 'No fields recorded.'}</p>`);
    } else {
      out.push('<table>', '<thead><tr><th scope="col">Field</th><th scope="col">Value</th></tr></thead>', '<tbody>');
      for (const f of d.fields) out.push(`<tr><th scope="row">${e(f.name)}</th><td>${e(f.value)}</td></tr>`);
      out.push('</tbody>', '</table>');
    }
    out.push('</article>');
  }
  out.push('</section>');

  out.push('<section>', '<h2>Redactions</h2>');
  if (v.redactions.length === 0) out.push('<p class="none">None.</p>');
  else {
    out.push(
      '<table>',
      `<thead><tr><th scope="col">System</th><th scope="col">Field</th><th scope="col">Reason</th>${v.reveal ? '<th scope="col">Value (reviewer copy)</th>' : ''}</tr></thead>`,
      '<tbody>',
    );
    for (const r of v.redactions) {
      out.push(`<tr><td>${htmlSystemCell(r.system)}</td><td>${e(r.field)}</td><td class="reason">${e(r.reasonLabel)}</td>${v.reveal ? `<td class="revealed">${e(r.value)}</td>` : ''}</tr>`);
    }
    out.push('</tbody>', '</table>');
  }
  out.push('</section>');

  out.push('<section>', '<h2>Exclusions</h2>');
  if (v.exclusions.length === 0) out.push('<p class="none">None.</p>');
  else {
    out.push('<ul>');
    for (const x of v.exclusions) out.push(`<li>${htmlSystemHeading(x.system)} — ${e(x.reason)}${x.note.trim() ? `: ${e(x.note)}` : ''}</li>`);
    out.push('</ul>');
  }
  out.push('</section>');

  out.push('<section>', '<h2>Identity conflicts</h2>');
  if (v.conflicts.length === 0) out.push('<p class="none">None.</p>');
  else {
    out.push('<ul>');
    for (const c of v.conflicts) out.push(`<li>${e(c)}</li>`);
    out.push('</ul>');
  }
  out.push('</section>');

  out.push('<section>', `<h2>${ACTIONS_HEADING} <small>${e(ACTIONS_NOTE)}</small></h2>`);
  if (v.actions.length === 0) out.push('<p class="none">None.</p>');
  else {
    out.push('<table>', '<thead><tr><th scope="col">System</th><th scope="col">Action</th><th scope="col">Reason</th></tr></thead>', '<tbody>');
    for (const a of v.actions) out.push(`<tr><td>${htmlSystemCell(a.system)}</td><td>${e(a.action)}</td><td>${a.reason ? e(a.reason) : '—'}</td></tr>`);
    out.push('</tbody>', '</table>');
  }
  out.push('</section>');

  out.push('<section>', '<h2>Summary</h2>', `<p>${e(v.summary)}</p>`, '</section>');
  out.push('</main>', '<footer>', `<p>${e(EXPORT_FOOTER)}</p>`, '</footer>', '</body>', '</html>', '');
  return out.join('\n');
}
