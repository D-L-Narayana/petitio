import { describe, expect, it } from 'vitest';
import { escapeHtml, packetToHtml, packetToMarkdown } from './exports';
import { buildResponsePacket } from './reconcile';
import type { RightsRequest, SystemOfRecord } from './types';

const SYSTEMS: SystemOfRecord[] = [
  { id: 'crm', name: 'Northwind CRM (synthetic)', description: 'Customer profiles, marketing preferences and agent notes.' },
  { id: 'billing', name: 'Ledgerly Billing (synthetic)', description: 'Invoices, payment references and tax records.' },
  { id: 'support', name: 'Helpdesk Tickets (synthetic)', description: 'Support conversations and attachments.' },
];

const THIRD_PARTY_VALUE = 'Neighbour Ines Farrow accepted the parcel on 3 June.';
const CONFLICT_VALUE = '2 tickets about a damaged parcel';
const FOOTER = 'Educational prototype — synthetic data, not legal advice.';
const BANNER = 'REVIEWER COPY — contains redacted values';

function request(overrides: Partial<RightsRequest> = {}): RightsRequest {
  return {
    id: 'REQ-2026-0399',
    receivedOn: '2026-09-05',
    jurisdiction: 'EU-GDPR',
    type: 'erasure',
    requester: { pseudonym: 'heron-6650', email: 'heron.6650@people.example', accountId: 'ACC-66500', ageBand: 'adult' },
    stage: 'response-ready',
    identity: { method: 'account-login', attempts: 1, maxAttempts: 3, status: 'passed' },
    holds: [
      { id: 'HOLD-0399-1', systemId: 'billing', reason: 'legal-obligation-retention', note: 'Invoices retained for the synthetic fiscal period.', appliedAt: '2026-09-20T15:10:00Z' },
    ],
    systemResults: [
      {
        systemId: 'crm',
        found: true,
        recordId: 'crm-66500',
        subjectEmail: 'heron.6650@people.example',
        fields: [
          { name: 'displayName', value: 'Heron Dalisay' },
          { name: 'agentNote', value: THIRD_PARTY_VALUE, thirdParty: true },
        ],
        lookedUpAt: '2026-09-10T09:00:00Z',
      },
      { systemId: 'billing', found: true, recordId: 'cust-66500', subjectEmail: 'heron.6650@people.example', fields: [{ name: 'invoices', value: '4 invoices' }], lookedUpAt: '2026-09-10T09:05:00Z' },
      { systemId: 'support', found: true, recordId: 'tickets-66501', subjectEmail: 'heron.other@people.example', fields: [{ name: 'tickets', value: CONFLICT_VALUE }], lookedUpAt: '2026-09-10T09:08:00Z' },
      { systemId: 'archive', found: false, fields: [], lookedUpAt: '2026-09-10T09:09:00Z' },
    ],
    history: [],
    notes: [],
    ...overrides,
  };
}

describe('escapeHtml', () => {
  it('escapes the characters that can break out of text or attribute context', () => {
    expect(escapeHtml('<a href="x">Tom & Jerry\'s</a>')).toBe('&lt;a href&#61;&quot;x&quot;&gt;Tom &amp; Jerry&#39;s&lt;/a&gt;');
    expect(escapeHtml('`')).toBe('&#96;');
    expect(escapeHtml('plain text, 2026-10-01; ok (1 of 2) — fine.')).toBe('plain text, 2026-10-01; ok (1 of 2) — fine.');
    expect(escapeHtml('')).toBe('');
  });
});

describe('packetToMarkdown', () => {
  const req = request();
  const packet = buildResponsePacket(req, '2026-10-01');

  it('renders title, pseudonym, named systems, field tables, exclusions, conflicts, actions, summary, status and footer', () => {
    const md = packetToMarkdown(packet, req, SYSTEMS);
    expect(md).toContain('# Response packet — REQ-2026-0399 (Erasure request)');
    expect(md).toContain('Generated on: 2026-10-01');
    expect(md).toContain('Requester (pseudonym): heron-6650');
    expect(md).not.toContain('@people.example');
    expect(md).toContain('### Northwind CRM (synthetic) (`crm`)');
    expect(md).toContain('Record id: `crm-66500`');
    expect(md).toContain('| displayName | Heron Dalisay |');
    expect(md).toContain('| Northwind CRM (synthetic) | agentNote | third-party data |');
    expect(md).toContain('| Helpdesk Tickets (synthetic) | tickets | identity conflict |');
    expect(md).toContain('- Ledgerly Billing (synthetic) (`billing`) — legal-obligation-retention: Invoices retained for the synthetic fiscal period.');
    expect(md).toContain('- support: stored subject email does not match the verified requester; record withheld pending re-verification.');
    expect(md).toContain('## Proposed actions (simulated — nothing is executed)');
    expect(md).toContain('| Northwind CRM (synthetic) | erase | — |');
    expect(md).toContain('| Ledgerly Billing (synthetic) | retain | legal-obligation-retention |');
    expect(md).toContain('| Helpdesk Tickets (synthetic) | withhold | identity-conflict |');
    expect(md).toContain(`## Summary\n\n${packet.summary}`);
    expect(md).toContain('Status: Partial response — something is withheld');
    expect(md.trimEnd().endsWith(FOOTER)).toBe(true);
    expect(md).not.toMatch(/compliant|lawful/i);
  });

  it('omits redacted values by default and never includes the emails stored by systems', () => {
    const md = packetToMarkdown(packet, req, SYSTEMS);
    expect(md).not.toContain(THIRD_PARTY_VALUE);
    expect(md).not.toContain(CONFLICT_VALUE);
    expect(md).not.toContain('heron.other');
    expect(md).not.toContain(BANNER);
  });

  it('includes redacted values and a leading banner when reveal is set', () => {
    const md = packetToMarkdown(packet, req, SYSTEMS, { reveal: true });
    expect(md.startsWith(`> **${BANNER}**`)).toBe(true);
    expect(md).toContain(`| Northwind CRM (synthetic) | agentNote | third-party data | ${THIRD_PARTY_VALUE} |`);
    expect(md).toContain(`| Helpdesk Tickets (synthetic) | tickets | identity conflict | ${CONFLICT_VALUE} |`);
  });

  it('escapes pipes and angle brackets and flattens newlines inside table cells', () => {
    const hostile = request({
      holds: [],
      systemResults: [
        { systemId: 'crm', found: true, recordId: 'crm-1', subjectEmail: 'heron.6650@people.example', fields: [{ name: 'a|b', value: 'x | y\nz <img src=x onerror=alert(1)>' }], lookedUpAt: '2026-09-10T09:00:00Z' },
      ],
    });
    const md = packetToMarkdown(buildResponsePacket(hostile, '2026-10-01'), hostile, SYSTEMS);
    expect(md).toContain('| a\\|b | x \\| y z \\<img src=x onerror=alert(1)> |');
    expect(md).not.toMatch(/(?<!\\)</);
  });

  it('falls back to the system id when the system is not in the list', () => {
    const md = packetToMarkdown(packet, req, SYSTEMS.filter((s) => s.id !== 'support'));
    expect(md).toContain('### `support`');
    expect(md).toContain('| `support` | tickets | identity conflict |');
    expect(md).toContain('| `support` | withhold | identity-conflict |');
  });

  it('describes a complete packet with empty sections spelled out', () => {
    const clean = request({
      holds: [],
      systemResults: [
        { systemId: 'crm', found: true, recordId: 'crm-1', subjectEmail: 'heron.6650@people.example', fields: [{ name: 'displayName', value: 'Heron Dalisay' }], lookedUpAt: '2026-09-10T09:00:00Z' },
      ],
    });
    const md = packetToMarkdown(buildResponsePacket(clean, '2026-10-01'), clean, SYSTEMS);
    expect(md).toContain('Status: Complete response — nothing withheld');
    expect(md).toContain('## Redactions\n\nNone.');
    expect(md).toContain('## Exclusions\n\nNone.');
    expect(md).toContain('## Identity conflicts\n\nNone.');
  });
});

describe('packetToHtml', () => {
  const req = request();
  const packet = buildResponsePacket(req, '2026-10-01');

  it('produces a self-contained document with one style block, no scripts or external refs, and every packet section', () => {
    const html = packetToHtml(packet, req, SYSTEMS);
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('<meta charset="utf-8">');
    expect(html).toContain('<title>Response packet REQ-2026-0399 — Erasure request</title>');
    expect(html.match(/<style>/g)).toHaveLength(1);
    expect(html).not.toMatch(/<script|<link|<iframe|<object|<embed|href=|src=|javascript:|\son[a-z]+=/i);
    expect(html).toContain('heron-6650');
    expect(html).not.toContain('@people.example');
    expect(html).toContain('<h3>Northwind CRM (synthetic) <code>crm</code></h3>');
    expect(html).toContain('<code>crm-66500</code>');
    expect(html).toContain('<td>Heron Dalisay</td>');
    expect(html).toContain('<td>agentNote</td>');
    expect(html).toContain('third-party data');
    expect(html).toContain('legal-obligation-retention');
    expect(html).toContain('Invoices retained for the synthetic fiscal period.');
    expect(html).toContain('record withheld pending re-verification');
    expect(html).toContain('Proposed actions');
    expect(html).toContain('<td>erase</td>');
    expect(html).toContain('<td>retain</td>');
    expect(html).toContain('<td>withhold</td>');
    expect(html).toContain(String(packet.summary));
    expect(html).toContain('Partial response — something is withheld');
    expect(html).toContain(FOOTER);
    expect(html).not.toContain(BANNER);
    expect(html).not.toMatch(/compliant|lawful/i);
    expect(html.trimEnd().endsWith('</html>')).toBe(true);
  });

  it('omits redacted values by default and includes them with a banner before the heading when reveal is set', () => {
    const safe = packetToHtml(packet, req, SYSTEMS);
    expect(safe).not.toContain(THIRD_PARTY_VALUE);
    expect(safe).not.toContain(CONFLICT_VALUE);
    expect(safe).not.toContain('heron.other');

    const reviewer = packetToHtml(packet, req, SYSTEMS, { reveal: true });
    expect(reviewer).toContain(THIRD_PARTY_VALUE);
    expect(reviewer).toContain(CONFLICT_VALUE);
    expect(reviewer.indexOf(BANNER)).toBeGreaterThan(-1);
    expect(reviewer.indexOf(BANNER)).toBeLessThan(reviewer.indexOf('<h1'));
  });

  it('neutralises hostile record ids, system names, field names, values, dates and request ids', () => {
    const hostileSystems: SystemOfRecord[] = [
      { id: 'crm', name: '</style><script>1</script>', description: '' },
      { id: 'billing', name: 'x" onmouseover="alert(1)', description: '' },
      { id: 'support', name: "O'Hara & Sons <b>", description: '' },
    ];
    const hostile = request({
      id: 'REQ-<script>alert(1)</script>',
      holds: [],
      systemResults: [
        { systemId: 'crm', found: true, recordId: '<img src=x onerror=alert(1)>', subjectEmail: 'heron.6650@people.example', fields: [{ name: '"quoted" & \'single\'', value: '<svg onload=alert(1)>' }], lookedUpAt: 'x' },
        { systemId: 'billing', found: true, recordId: 'b"1', subjectEmail: 'heron.6650@people.example', fields: [{ name: 'f', value: 'v' }], lookedUpAt: 'x' },
        { systemId: 'support', found: true, recordId: "s'1", subjectEmail: 'other@people.example', fields: [{ name: 'tickets', value: 't' }], lookedUpAt: 'x' },
      ],
    });
    const html = packetToHtml(buildResponsePacket(hostile, '2026-10-01" onfocus="alert(1)'), hostile, hostileSystems, { reveal: true });
    expect(html).not.toContain('<script');
    expect(html).not.toContain('onerror=');
    expect(html).not.toContain('onload=');
    expect(html).not.toContain('onmouseover=');
    expect(html).not.toContain('onfocus=');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<svg');
    expect(html).not.toContain('<b>');
    expect(html.match(/<style>/g)).toHaveLength(1);
    expect(html.match(/<\/style>/g)).toHaveLength(1);
    expect(html).toContain('&lt;img src&#61;x onerror&#61;alert(1)&gt;');
    expect(html).toContain('&lt;/style&gt;&lt;script&gt;1&lt;/script&gt;');
    expect(html).toContain('x&quot; onmouseover&#61;&quot;alert(1)');
    expect(html).toContain('O&#39;Hara &amp; Sons &lt;b&gt;');
    expect(html).toContain('&quot;quoted&quot; &amp; &#39;single&#39;');
    expect(html).toContain('&lt;svg onload&#61;alert(1)&gt;');
    expect(html).toContain('b&quot;1');
    expect(html).toContain('s&#39;1');
    expect(html).toContain('datetime="2026-10-01&quot; onfocus&#61;&quot;alert(1)"');
    expect(html).toContain('<title>Response packet REQ-&lt;script&gt;alert(1)&lt;/script&gt; — Erasure request</title>');
  });

  it('falls back to the system id when the system is not in the list', () => {
    const html = packetToHtml(packet, req, SYSTEMS.filter((s) => s.id !== 'support'));
    expect(html).toContain('<h3><code>support</code></h3>');
    expect(html).toContain('<td><code>support</code></td>');
  });
});
