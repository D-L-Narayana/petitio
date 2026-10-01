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

## Unresolved limitations

- `color-scheme` is light only; no dark theme.
- The stage rail scrolls horizontally on narrow screens rather than wrapping.
- Dates in the UI use the browser's `<input type="date">` and ISO strings; no locale formatting.
- No end-to-end test runner is committed to the repo; browser QA lives in the track-level harness and screenshots.
