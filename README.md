# Petitio — privacy rights request desk

Educational, browser-local prototype of a privacy-operations desk for individual rights requests (access, erasure, rectification, portability, opt-out of sale). It is built to make the *decision logic* inspectable: a deterministic deadline clock, an explicit request state machine whose refusals explain themselves, duplicate detection, multi-system reconciliation with redaction, and a hash-chained audit log.

> Educational prototype. Not legal advice, not a compliance certification, and not a claim of experience with any commercial privacy platform (OneTrust, BigID and similar products are referenced only as context). All people, systems and emails are synthetic (`*.example`).

## Why it exists

Rights-request handling is where privacy programs are measured against hard dates. Most demos show a ticket queue; this one shows the *rules* a queue has to enforce:

- a statutory window that depends on jurisdiction and is measured differently (calendar months vs calendar days),
- an extension that is only valid if it is requested in time and is not longer than the law allows,
- a response that cannot be prepared while a hold lacks a written justification,
- a response packet that withholds third-party data and anything whose identity does not reconcile,
- an audit trail whose integrity can be verified rather than asserted.

## Key workflows

1. **Docket triage.** Requests sort by clock status (overdue → at-risk → on-track → closed/rejected) and days remaining. Each row carries a deadline ribbon: statutory window, hatched extension, elapsed fill, and the as-of marker.
2. **Advance a request.** Every action valid for the current stage is listed. Blocked actions stay visible with the exact reason (for example `Lookups still outstanding for: support`). Terminal stages accept nothing.
3. **Record simulated system lookups.** For a request in `collecting`, record a result per system of record (found / not found, record id, subject email on file, fields with a third-party flag). Nothing is actually queried.
4. **Holds.** In `review`, apply a hold (legal hold, legal-obligation retention, fraud prevention, ongoing transaction, third-party rights) to one system. A hold without a justification blocks `prepare-response`; a justified hold produces a partial response with the exclusion listed.
5. **Response packet.** Derived live from results and holds: disclosures, redactions (third-party data, identity conflict), exclusions, conflicts, and a `partial` flag. Redacted values can be revealed by a reviewer and the packet exported as JSON.
6. **Extension.** Record a single extension with reason, days and the date the requester was notified. The engine refuses an extension notified after the initial window or longer than the profile maximum.
7. **Import / export.** Import a `petitio.casefile` v1 JSON (bounded and validated), export the current case file, export the audit log. State is in memory and resets on refresh by design.
8. **Audit log.** Every action and every refusal is appended with a SHA-256 hash chained to the previous entry. "Verify chain" recomputes every hash; "Simulate tampering" edits a copy to show detection.

## Quickstart

```bash
npm ci
npm test          # vitest: engine unit/property tests + app integration tests
npm run build     # tsc -b && vite build → dist/
npm run preview   # serves dist on http://127.0.0.1:6100
npm run dev       # dev server on http://127.0.0.1:6100
```

Node 20.19+ or 22.12+ (Vite 7 requirement).

## Algorithm

### Deadline clock (`src/engine/deadline.ts`)

| Profile | Window | Extension | Notice rule | Source |
|---|---|---|---|---|
| EU-GDPR, UK-GDPR | 1 calendar month | up to 2 further calendar months, once | notice within the initial month | GDPR Art. 12(3) ([gdprhub](https://gdprhub.eu/Article_12_GDPR), [EDPB](https://www.edpb.europa.eu/sme/be-compliant/respect-individuals-rights_en), [ICO guidance](https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/individual-rights/right-of-access/what-should-we-consider-when-responding-to-a-request/)) |
| US-CA-CCPA | 45 calendar days | up to 45 additional days, once | notice within the first 45 days | Cal. Civ. Code 1798.130(a)(2) ([statute text](https://cppa.ca.gov/regulations/pdf/ccpa_statute_eff_20260101.pdf), [OAG summary](https://www.oag.ca.gov/privacy/ccpa)) |

"Calendar month" uses the corresponding-date rule: 15 March + 1 month = 15 April; 31 January + 1 month = 28/29 February (last day of a shorter month). The month-end rule follows ICO guidance; the EU regulation itself does not define day-counting, so this is a documented modelling choice. Status bands: `overdue` when the as-of date is past the effective due date, `at-risk` within the final 5 days (configurable constant `AT_RISK_DAYS`), otherwise `on-track`. Day counts are whole UTC days; no business-day calendar is applied.

### State machine (`src/engine/workflow.ts`)

Extension arithmetic is deliberately conservative at month ends: the maximum additional window is calculated from the truncated initial due date. For a request received on 31 January 2026, the model gives 28 February initially and 28 April after the maximum extension, rather than 30 April under a three-months-from-receipt calculation. This is a teaching-model choice, not a legal interpretation or a deadline calculator for real requests.

`received → identity-check → verified → collecting → review → response-ready → closed`, with `rejected` reachable from any non-terminal stage. Guards: `begin-collection` needs a passed identity check; `send-to-review` needs a result for every system of record; `prepare-response` needs every active hold to have a justification; `reject` needs a reason from a fixed list; the third failed identity attempt rejects the request with `identity-unverified`. `transition()` is pure and returns a new request; `availableActions()` returns the same guard results as explanations.

The three-attempt threshold and identity-check outcomes are simulation constants, not an identity-proofing policy suitable for production.

### Duplicate detection (`src/engine/duplicates.ts`)

A later request is flagged when an earlier, non-rejected request of the same type from the same pseudonym (or the same trimmed, lower-cased email) was received within 30 days. The decision stays with the analyst; the engine does not auto-reject.

### Reconciliation and redaction (`src/engine/reconcile.ts`)

Per system result: a stored subject email that differs from the verified requester marks an identity conflict and withholds every field of that system; fields marked `thirdParty` are withheld; systems under an active hold are excluded; systems with no record are omitted. The packet is `partial` if anything was withheld. Simplification: a hold excludes a system for every request type; real programs distinguish exemptions per right.

### Audit chain (`src/engine/audit.ts`)

`hash = SHA-256(JSON[seq, at, actor, requestId, action, detail, prevHash])` using the Web Crypto API. Verification recomputes each hash and checks `prevHash` linkage and sequence. This is tamper-*evident* within a session, not tamper-*proof*: the log lives in memory and an attacker who controls the tab can rewrite the whole chain. It demonstrates the technique, not a trusted timestamping service.

### Import bounds (`src/engine/casefile.ts`)

1,000,000 bytes, 500 requests, 50 systems, nesting depth 8, string length 4,000; every enum and date format is validated; duplicate ids are rejected; unknown properties are dropped rather than carried into state.

## Architecture

```
src/engine/     pure TypeScript, no React: types, deadline, workflow, duplicates, reconcile, audit, casefile
src/fixtures/   demo-casefile.json (synthetic, labelled)
src/ui/         Docket, CaseDetail, Ribbon, StageRail, AuditDialog, ImportDialog, download helper
src/App.tsx     in-memory session state and wiring
```

React 19 + TypeScript 5.9 + Vite 7; Vitest 4 with jsdom and Testing Library; fast-check for the date-arithmetic property test; Radix UI Dialog and Tooltip for accessible primitives; self-hosted variable fonts via Fontsource (Bricolage Grotesque, Source Serif 4). No router: single view, `base: './'`.

## Tests

`npm test` runs 68 tests in 5 files (measured 1 Oct 2026; engine 63 + UI integration 5; see `EVIDENCE.md` for the RED/GREEN record, including eleven review-driven tests added red-first):

- `deadline.test.ts` (20): calendar arithmetic incl. a property test over ±5,000 days, profile encodings, status bands, extension refusals, extension input validation.
- `workflow.test.ts` (15): every guard, immutability, attempt exhaustion, explanations.
- `reconcile.test.ts` (9): duplicate rules and packet assembly.
- `audit.test.ts` (19): chain linkage, tamper and deletion detection, import bounds and schema rejection, strict calendar dates, imported extensions held to the statutory guards, invalid-input regression (importer returns `ok:false`, never throws).
- `App.test.tsx` (5): integration through the rendered UI (written after the UI as regression coverage; the engine tests were written first).

## Data handling

- Browser-local only. No network requests after the static assets load (verified in the QA audit: the only host contacted is the local preview server).
- No `localStorage`, `sessionStorage` or IndexedDB; refresh resets to the bundled fixture. Continuity is by JSON export/import.
- No real personal data. Fixture people are fictional, emails use `people.example`.
- Identity proofing, system lookups and delivery are simulated by recording outcomes; nothing is sent or queried.

## Limitations

- Jurisdiction profiles cover three regimes with one window each; they do not model fee rules, manifestly-unfounded assessments, special categories of requests, or the many US state laws.
- Day counting is calendar-based UTC; business days, public holidays and "receipt" nuances are not modelled.
- Hold semantics are simplified (a hold excludes a system for any right).
- The audit chain is session-scoped tamper evidence, not a trusted log.
- Single-user; no authentication or roles beyond labels in history entries.
- `requestExtension` does not check the request stage (a closed request could be extended) and does not compare the notice date with `asOf`; the importer enforces the statutory maximum, notice window, receipt order and reason, so a file cannot carry an extension the UI would refuse.

## JD evidence (educational mapping)

Privacy tech workflow (rights automation concepts), analytical/design thinking (explicit guards and explanations), quality deliverables (exportable packet and audit log), HTML/CSS/TypeScript, API-style JSON schema with validation. It does not demonstrate product experience with OneTrust or any vendor platform, and does not establish legal expertise.

## AI-assistance disclosure

Built in October 2026 with substantial AI assistance (Claude) for design, tests, implementation and documentation. Human review and understanding of this code have **not** been independently established. Before this project is presented as personal work, the candidate should study the code and rehearse the material in `INTERVIEW_GUIDE.md`; this README makes no claim that such review has already happened.

## License

MIT (see `LICENSE`). Third-party licences are listed in `THIRD_PARTY_NOTICES.md`.
