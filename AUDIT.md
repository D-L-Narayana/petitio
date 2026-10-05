# AUDIT.md — Petitio

Self-review written 1 Oct 2026. It records what was checked and what remains open; it is not an independent security assessment.

## Threat model

**Assets.** Synthetic case file in memory; the user's own imported JSON; exported JSON files.

**Trust boundary.** Everything runs in one browser tab. There is no backend, no authentication, no persistence. The only untrusted input is a user-supplied case file (file picker or paste).

| Threat | Mitigation | Residual |
|---|---|---|
| Malicious or oversized import exhausts memory or hangs the tab | Byte limit checked before `JSON.parse`; request/system/array caps; nesting depth ≤ 8; string length cap; regex patterns are anchored and linear | A 1 MB file is still parsed fully; acceptable for a desk tool |
| Imported data smuggles unexpected properties into state (prototype pollution style) | Validator copies only known keys into fresh objects; enum and date formats validated; duplicates rejected | None known |
| Script injection through fixture text | React escapes all rendered strings; no `dangerouslySetInnerHTML`; CSP in `vercel.json` disallows inline scripts | CSP allows `'unsafe-inline'` for styles because Radix sets inline style attributes |
| Tampering with the audit log | SHA-256 hash chain, verification recomputes every hash | Session-scoped only; an attacker controlling the tab can rewrite the whole chain. Documented as tamper-evident, not tamper-proof |
| Accidental disclosure of third-party data in a response | Reconciliation withholds `thirdParty` fields and whole systems with identity conflicts; packet exported with reasons | Relies on the flag being set correctly upstream |
| Data leaves the device | No network calls after load (QA audit lists only the local host); no storage APIs; exports are user-initiated downloads | None known |
| Clickjacking / MIME sniffing | `frame-ancestors 'none'`, `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy: no-referrer`, HSTS | Headers apply only when hosted on Vercel with `vercel.json` |

## Data flow

Fixture JSON → `parseCaseFile` → React state → engine functions (pure) → rendered views → user-initiated JSON downloads. No other sinks.

## Dependency findings

`npm audit` on 1 Oct 2026: 0 vulnerabilities (info 0, low 0, moderate 0, high 0, critical 0). Lockfile committed; `npm ci` reproduces the tree. No postinstall scripts from runtime dependencies.

## Accessibility and QA

`qa-harness/audit.mjs` (Playwright + axe-core, WCAG 2.0/2.1 A+AA tags) at 1440/768/375 widths: 0 violations after fixes (initial run found `color-contrast` on the on-track badge and `scrollable-region-focusable` on the stage rail and tables; both fixed), no horizontal page overflow, 0 console or page errors. Workflow replay (10 steps, see `qa/screens/flow-*.png`) exercised blocked actions, hold refusal, extension refusal, audit tamper detection and an invalid import.

**5 Oct 2026 (upgrade round).** A private Playwright replay served the integrated `dist/` to Chromium from an `https://` origin with the exact `vercel.json` security headers on every response and Playwright's CSP bypass off, at 1440/768/375 (light) and 1440 (dark): 25 responses checked against the 8 declared headers with 0 mismatches, 0 `securitypolicyviolation` events, 0 requests to any other origin, 0 page/console errors, no horizontal overflow, every control named, one live region on the main page, no storage API touched; a 23-step journey covering every workflow in `docs/workflows.md` passed with all 7 downloads read back and checked (`qa/logs/upgrade-browser-check.log`, `qa/screens/upgrade-*`). This replay does not run axe-core; the automated accessibility coverage for this round is the jsdom suite (`src/test/a11y.test.tsx`) plus the contrast test over both palettes. It also exercises the bundle under the declared headers rather than the live Vercel responses; the deployment itself was not re-tested from this environment.

## Unresolved limitations (as of 1 Oct 2026; see the 4 Oct section for what changed)

- ~~`color-scheme` is light only; no dark theme.~~ Addressed 4 Oct: light and dark palettes with an in-memory Auto/Light/Dark toggle; text contrast ≥ 4.5:1 in both is asserted by a test.
- ~~The stage rail scrolls horizontally on narrow screens rather than wrapping.~~ Addressed 4 Oct: the rail wraps at ≤ 768 px.
- ~~Dates in the UI use the browser's `<input type="date">` and ISO strings; no locale formatting.~~ Partly addressed 4 Oct: the case detail and ribbon render readable dates (`27 Sep 2026`) inside `<time dateTime="…">`; inputs, history timestamps and exports keep ISO.
- No end-to-end test runner is committed to the repo; browser QA lives in a private replay harness and its committed screenshots/logs (`qa/screens`, `qa/logs`). Still true.

## Upgrade round, 4 Oct 2026 — additions

### New untrusted inputs

| Threat | Mitigation | Residual |
|---|---|---|
| Malicious or oversized **audit-log file** offered to "Verify an exported log" | Byte cap (2,000,000) checked before `JSON.parse`; entry cap (10,000); every field type-checked; hashes must be 64 hex characters; `seq` must be a positive integer; the parser never throws. The session log is never replaced by an imported one — the only output is a verdict string and a read-only view | A hostile file can only produce "Import rejected" or "chain broken" |
| **Drag-and-drop case-file import** | Same size check and the same `parseCaseFile` path as the file picker; nothing is read until a file is dropped on the dialog | None beyond the existing import limits |
| **Integrity-inconsistent case file** (stage, history, `closedOn`, `rejectReason`, identity attempts or holds that contradict each other) | `checkIntegrity` runs only after field validation succeeded; contradictions are errors (file refused) or warnings (file accepted, warnings shown with the request id and field path) | Warnings rely on the analyst reading them |

### New sinks

| Sink | Mitigation |
|---|---|
| **CSV export** of the docket | RFC 4180 quoting; cells beginning with `=`, `+`, `-`, `@`, tab or carriage return are prefixed with `'` so spreadsheet software does not evaluate them |
| **Markdown / HTML packet exports** | The documents the UI downloads never contain redacted values (the on-screen "reveal" checkbox does not carry into exports; a browser-replay step and a UI journey test pin this). The engine's `reveal` option, which adds the values under a `REVIEWER COPY` banner, is not exposed in the UI; the HTML is a self-contained document with a `<style>` block only — no scripts, no external references, no inline handlers — and every interpolated string (including attribute values) is escaped; tests feed `<img onerror>`, `</style><script>` and quote characters |
| **Download filenames** derived from request ids | `safeFilename()` strips path separators, control characters and quotes and caps the length |

### Changed trust assumptions

- **Audit queue.** Appends are serialised in dispatch order, so two rapid actions cannot both compute the same
  sequence number (the previous implementation could lose an entry that way). A failed append — for example when
  `crypto.subtle` is unavailable because the page is not in a secure context — no longer leaves the UI silently
  inconsistent: the action still applies, the failure is shown in the refusal alert and counted in the footer. The
  log remains tamper-*evident* within a session, not tamper-*proof*.
- **Theme preference** is held in memory only; no storage API is used (checked by `scripts/check-invariants.mjs`
  and by the browser replay's storage probe).
- **Guards** are a single table consumed by both `transition()` and the explanations, so the UI cannot disagree
  with the engine about what is blocked; a property test pins this. Writing that property exposed four gaps in the
  first table (an identity pass accepted with no attempts left; a reused hold id silently replacing the earlier
  record; result and hold payloads accepted by the engine but refused by the importer), all closed red-first.
- **Audit chain, stated plainly.** `verifyChain` detects any edit, removal or reordering of an interior entry, but
  not truncation of the tail nor an edit-and-rehash of the final entry — a characterisation test records this. It is
  inherent to an unanchored chain and is why the log is described as tamper-evident within a session, not
  tamper-proof.
- **Secure context.** The audit chain depends on `crypto.subtle`, which browsers expose only to secure contexts
  (https, `localhost`, `127.0.0.1`). The Vercel deployment and the preview server qualify; serving the bundle from a
  plain-http remote host would disable auditing, and the UI now says so instead of failing quietly.
