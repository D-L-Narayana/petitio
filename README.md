# Petitio — privacy rights request desk

[Open the public educational demo](https://dln-petitio.vercel.app). Use synthetic data only; the deadline profiles are teaching models, not legal advice.

Educational, browser-local prototype of a privacy-operations desk for individual rights requests (access, erasure, rectification, portability, opt-out of sale). It is built to make the *decision logic* inspectable: a deterministic deadline clock, an explicit request state machine whose refusals explain themselves — before and after the click — duplicate detection, multi-system reconciliation with redaction, a right-aware response packet, and a hash-chained audit log that can be exported and re-verified.

> Educational prototype. Not legal advice, not a compliance certification, and not a claim of experience with any commercial privacy platform (OneTrust, BigID and similar products are referenced only as context). All people, systems and emails are synthetic (`*.example`).

## Why it exists

Rights-request handling is where privacy programs are measured against hard dates. Most demos show a ticket queue; this one shows the *rules* a queue has to enforce:

- a statutory window that depends on jurisdiction and is measured differently (calendar months vs calendar days),
- an extension that is only valid if it is requested in time and is not longer than the law allows — and a desk that says so *before* offering the form,
- a response that cannot be prepared while a hold lacks a written justification,
- a response packet that withholds third-party data and anything whose identity does not reconcile, and proposes per-system actions that fit the right being exercised,
- an audit trail whose integrity can be verified rather than asserted — in the session and from an exported file.

## Key workflows

1. **Docket triage.** Requests sort by clock status (overdue → at-risk → on-track → closed/rejected) and days remaining, or by received date, due date or id. A summary strip counts requests per clock status and flagged duplicates; a search box narrows the docket by id, pseudonym, email or account id; "Clear filters" resets everything; "Export CSV" downloads the visible rows (RFC 4180, with a formula-injection guard). Rows are a single tab stop: arrow keys, Home and End move between them, Enter selects. Each row carries a deadline ribbon: statutory window, hatched extension, elapsed fill, the as-of marker and — until an extension is recorded — a tick for the last day an extension notice may be given.
2. **Advance a request.** Every action valid for the current stage is listed. Blocked actions stay visible with the exact reason (for example `Lookups still outstanding for: support`). One guard table drives both the action and its explanation, so the two cannot disagree. After a stage change, focus moves to the request heading instead of being dropped. Terminal stages accept nothing.
3. **Record simulated system lookups.** For a request in `collecting`, record a result per system of record (found / not found, record id, subject email on file, fields with a third-party flag). A result for a system that is not in the case file is refused (`UNKNOWN_SYSTEM`). Nothing is actually queried.
4. **Holds.** In `review`, apply a hold (legal hold, legal-obligation retention, fraud prevention, ongoing transaction, third-party rights) to one system. A hold without a justification blocks `prepare-response`; a justified hold produces a partial response with the exclusion listed. A second active hold on the same system is refused (`DUPLICATE_HOLD`), a reused hold id is refused, and the hold form only offers systems that are not already held.
5. **Response packet.** Derived live from results and holds: disclosures, redactions (third-party data, identity conflict), exclusions, conflicts, a `partial` flag, a one-sentence summary and a table of proposed per-system actions that depends on the right (disclose / export / erase / rectify / opt-out, with retain for held systems and withhold for identity conflicts — all simulated). Redacted values can be revealed on screen by a reviewer. The packet exports as JSON, Markdown or a self-contained HTML document; the exported documents never contain redacted values — the on-screen reveal does not carry into a download. (The engine's `packetToMarkdown`/`packetToHtml` accept a `reveal` option that adds the values under a `REVIEWER COPY` banner for programmatic use; the UI does not expose it.)
6. **Extension.** The desk first explains whether an extension is still possible ("Extension not available: …" for closed or rejected requests, a second extension, or a notice window that has already ended); otherwise it offers a form capped at the profile maximum and naming the notice deadline. The engine refuses an extension notified after the initial window, longer than the profile maximum, or dated after the as-of date.
7. **Closure outcome.** Closed requests show "Closed on time" or "Closed N days late" against their effective due date.
8. **Import / export.** Import a `petitio.casefile` v1 JSON by file, paste or drag-and-drop (bounded, field-validated, then checked for cross-field integrity: errors refuse the file, warnings are shown), preview with "Validate only", download a sample file, export the current case file. State is in memory and resets on refresh by design.
9. **Audit log.** Every action and every refusal is appended with a SHA-256 hash chained to the previous entry; appends are serialised so rapid actions cannot lose an entry, and an append that fails is reported rather than swallowed. "Verify chain" recomputes every hash; "Simulate tampering" edits a copy to show detection; "Export JSON" writes a `petitio.auditlog` envelope; "Verify an exported log" re-checks a previously exported file without replacing the session log.
10. **Theme and print.** Auto / Light / Dark colour theme (held in memory only — no storage API is used); the case detail, packet and history print on white without the chrome.

## Quickstart

```bash
npm ci
npm test          # vitest: engine unit/property tests, session store, UI panels, journeys
npm run build     # tsc -b && vite build → dist/
npm run preview   # serves dist on http://127.0.0.1:6100
npm run dev       # dev server on http://127.0.0.1:6100
npm run verify    # typecheck + test + build + invariants + tokens + bundle budget + CI YAML lint (what CI runs)
```

Node 20.19+ or 22.12+ (declared in `engines`; Vite 7 requirement). No dependency was added, removed or updated in the October 2026 upgrade round.

## Algorithm

### Deadline clock (`src/engine/deadline.ts`)

| Profile (label) | Window | Extension | Notice rule | Source |
|---|---|---|---|---|
| `EU-GDPR` (EU GDPR), `UK-GDPR` (UK GDPR) | 1 calendar month | up to 2 further calendar months, once | notice within the initial month | GDPR Art. 12(3) ([gdprhub](https://gdprhub.eu/Article_12_GDPR), [EDPB](https://www.edpb.europa.eu/sme/be-compliant/respect-individuals-rights_en), [ICO guidance](https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/individual-rights/right-of-access/what-should-we-consider-when-responding-to-a-request/)) |
| `US-CA-CCPA` (California CCPA/CPRA) | 45 calendar days | up to 45 additional days, once | notice within the first 45 days | Cal. Civ. Code 1798.130(a)(2) ([statute text](https://cppa.ca.gov/regulations/pdf/ccpa_statute_eff_20260101.pdf), [OAG summary](https://www.oag.ca.gov/privacy/ccpa)) |
| `US-VA-VCDPA` (Virginia VCDPA) | 45 calendar days | up to 45 additional days, once, "when reasonably necessary" | consumer informed within the initial 45-day period | Va. Code § 59.1-577(B) |
| `US-CO-CPA` (Colorado CPA) | 45 calendar days | 45 additional days "when reasonably necessary" (modelled as a single extension) | consumer informed within the initial 45-day period | C.R.S. § 6-1-1306(2)(a) |
| `CA-PIPEDA` (Canada PIPEDA) | 30 calendar days | at most 30 days, once (s. 8(4)(a): the time limit would unreasonably interfere with the organization's activities, or necessary consultations make it impracticable) | notice of extension within the first 30 days (measured here from receipt) | PIPEDA s. 8(3)–(5); s. 8(5) deems an unanswered request refused. **Not modelled:** the open-ended s. 8(4)(b) extension for converting information into an alternative format, and consultations needing longer than 30 days |

Every profile carries its citation and the sentence "Educational model, not legal advice." in the data itself (`PROFILES[id].citation`), so the UI shows them next to the figures. The importer accepts exactly the profile ids (`JURISDICTION_IDS`) and the docket's jurisdiction filter lists the labels. None of the profiles has had legal review; the three added in October 2026 were written from the statute text cited and nothing else.

"Calendar month" uses the corresponding-date rule: 15 March + 1 month = 15 April; 31 January + 1 month = 28/29 February (last day of a shorter month). The month-end rule follows ICO guidance; the EU regulation itself does not define day-counting, so this is a documented modelling choice. Status bands: `overdue` when the as-of date is past the effective due date, `at-risk` within the final 5 days (`AT_RISK_DAYS`, overridable per call through `assessDeadline(request, asOf, { atRiskDays })`), otherwise `on-track`. Day counts are whole UTC days; no business-day calendar is applied.

`extensionEligibility(request, asOf)` answers, before any form is shown, whether an extension can still be recorded: `EXTENSION_NOT_ALLOWED` for closed or rejected requests, `ALREADY_EXTENDED` after one extension, `EXTENSION_TOO_LATE` once the as-of date is past the notice deadline, and otherwise the maximum days and the notice deadline. `requestExtension(request, input, asOf?)` walks the same guard list plus input validation, `EXTENSION_TOO_LONG`, and — when `asOf` is given — refuses a notice dated in the future; a property test asserts that eligibility and refusal agree for every profile, receipt date, stage and clock. `assessDeadline` also reports `noticeDeadlineOn` and, for closed requests, `closureOutcome` (`on-time` when `closedOn` ≤ effective due date, else `late` with `daysLateAtClose`).

Extension arithmetic is deliberately conservative at month ends: the maximum additional window is calculated from the truncated initial due date. For a request received on 31 January 2026, the model gives 28 February initially and 28 April after the maximum extension, rather than 30 April under a three-months-from-receipt calculation. This is a teaching-model choice, not a legal interpretation or a deadline calculator for real requests.

### State machine (`src/engine/workflow.ts`)

`received → identity-check → verified → collecting → review → response-ready → closed`, with `rejected` reachable from any non-terminal stage. Guards live in one frozen table, `GUARDS[action]`, an ordered list of functions returning a refusal `{ code, message }` or nothing. `transition()` throws the first refusal as a `WorkflowError`; `explainAction()` reports the same refusal as text and code for the UI, and `availableActions()` is `explainAction` over the stage's actions. A fast-check property asserts that for random requests and actions, "enabled" is exactly "does not throw" and the codes agree.

| Action | Guards, in order (refusal code) |
|---|---|
| `start-identity-check`, `identity-failed`, `close` | none beyond the stage check (`INVALID_TRANSITION`) |
| `identity-passed` | an attempt remains (`IDENTITY_ATTEMPTS_EXHAUSTED`) |
| `begin-collection` | identity passed (`IDENTITY_NOT_VERIFIED`) |
| `record-system-result` | payload is a well-formed `SystemResult` — every optional field in its documented type (`INVALID_PAYLOAD`) → its system exists in the case file (`UNKNOWN_SYSTEM`) |
| `send-to-review` | every system of record has a result (`MISSING_SYSTEM_RESULTS`) |
| `apply-hold` | payload is a well-formed `Hold` with a known reason (`INVALID_PAYLOAD`) → its id is not already used on the request (`INVALID_PAYLOAD`) → its system exists (`UNKNOWN_SYSTEM`) → no active hold on that system (`DUPLICATE_HOLD`) |
| `release-hold` | some hold is active (`HOLD_NOT_FOUND`, explained as "There are no active holds to release.") → the named hold is active (`HOLD_NOT_FOUND`) |
| `prepare-response` | every active hold has a written justification (`UNRESOLVED_HOLDS`) |
| `reject` | reason is one of the fixed list (`MISSING_REJECT_REASON`) |

Guards that need a payload are skipped when `explainAction()` is asked about an action before any payload exists, so the "Next actions" list can show `record-system-result` and `apply-hold` as available while a result or hold is still being typed; data guards (identity, attempts, missing lookups, unjustified holds, no active hold) always run. A model-based test drives random sequences of enabled actions through the machine and re-imports every intermediate request: anything `transition()` accepts, `parseCaseFile()` accepts too. Writing that property exposed four gaps in the first version of the table (see `EVIDENCE.md`), all closed red-first. The third failed identity attempt rejects the request with `identity-unverified`. `transition()` is pure and returns a new request.

The three-attempt threshold and identity-check outcomes are simulation constants, not an identity-proofing policy suitable for production.

### Duplicate detection (`src/engine/duplicates.ts`)

A later request is flagged when an earlier, non-rejected request of the same type from the same pseudonym, the same trimmed account id (when both carry one), or the same trimmed, lower-cased email was received within 30 days — checked in that order. The decision stays with the analyst; the engine does not auto-reject.

### Reconciliation and the response packet (`src/engine/reconcile.ts`, `src/engine/exports.ts`)

Per system result: a stored subject email that differs from the verified requester marks an identity conflict and withholds every field of that system; fields marked `thirdParty` are withheld; systems under an active hold are excluded; systems with no record are omitted. The packet is `partial` if anything was withheld. It also lists a proposed action per found system — by request type `access → disclose`, `portability → export`, `erasure → erase`, `rectification → rectify`, `opt-out-sale → opt-out`; held systems become `retain` (with the hold reason) and identity conflicts `withhold` — and a one-sentence summary that counts proposals without assessing them. `packetToMarkdown` / `packetToHtml` render the packet as documents: the requester appears as a pseudonym only, redacted values are omitted unless the `reveal` option is set (which adds a reviewer banner; the UI never sets it), and the HTML is self-contained (a `<style>` block, no scripts, no external references) with every interpolated string escaped. Simplification: a hold excludes a system for every request type; real programs distinguish exemptions per right. The actions are proposals in a teaching model; nothing is executed.

### Audit chain (`src/engine/audit.ts`, `src/state/auditQueue.ts`)

`hash = SHA-256(JSON[seq, at, actor, requestId, action, detail, prevHash])` using the Web Crypto API. Verification recomputes each hash and checks `prevHash` linkage and sequence. In the app, appends go through a queue that applies them strictly in dispatch order, so two rapid actions cannot both compute the same `seq` (the pre-upgrade implementation could lose an entry that way); a failed append is counted and reported in the footer and the alert. Exports use a `petitio.auditlog` v1 envelope (`{ schema, version, exportedAt, entries }`); `parseAuditLog` accepts the envelope or a legacy bare array within size and count bounds, and "Verify an exported log" runs `verifyChain` on the imported entries without touching the session log. This is tamper-*evident*, not tamper-*proof*: the chain detects any edit, removal or reordering of an interior entry, but not truncation of the tail nor an edit-and-rehash of the last entry, and an attacker who controls the tab can rewrite the whole chain. It demonstrates the technique, not a trusted timestamping service. The chain depends on `crypto.subtle`, which browsers expose only to secure contexts (https, `localhost`, `127.0.0.1`); the Vercel deployment and the preview server qualify.

### Import bounds and integrity (`src/engine/casefile.ts`, `src/engine/integrity.ts`)

1,000,000 bytes, 500 requests, 50 systems, nesting depth 8, string length 4,000; every enum and date format is validated; duplicate ids are rejected; unknown properties are dropped rather than carried into state; the jurisdiction list is derived from the deadline profiles. After field validation, cross-field integrity rules run: `closedOn` only on closed requests and `rejectReason` only on rejected ones, the last history entry must lead to the current stage, identity attempts cannot exceed the maximum, stages from `collecting` onwards require a passed identity check, holds must reference known systems and carry unique ids (errors — the file is refused); results for unknown systems, a receipt date after the as-of date, history timestamps that go backwards, two active holds on one system, a closure before receipt, and a truncated note are warnings (the file is accepted, the warnings are shown). The full schema is in `docs/casefile-schema.md`.

## Architecture

```
src/engine/     pure TypeScript, no React: types, deadline, workflow, duplicates, reconcile, exports, docket,
                casefile, integrity, audit
src/state/      session reducer (pure), ordered audit queue (pure), useSession hook
src/theme/      tokens.css (light/dark), useTheme, ThemeToggle, contrast utility
src/ui/         Docket, CaseDetail → detail/* panels, Ribbon, StageRail, AuditDialog, ImportDialog, download helpers
src/App.tsx     composition only: useSession + buildDocket + wiring
src/fixtures/   demo-casefile.json (synthetic, labelled; 12 requests)
src/test/       setup, helpers, builders, engine scenarios, UI journeys, accessibility checks
scripts/        check-invariants, check-tokens, check-bundle-size, validate-yaml (CI gates, dependency-free)
docs/           architecture, workflows (the UI test oracle), case-file schema
qa/             browser evidence (screenshots, JSON summaries) and verbatim gate logs
```

React 19 + TypeScript 5.9 + Vite 7; Vitest 4 with jsdom and Testing Library; fast-check for property tests; Radix UI Dialog and Tooltip for accessible primitives; self-hosted variable fonts via Fontsource (Bricolage Grotesque, Source Serif 4). No router: single view, `base: './'`.

## Tests

<!-- test-count --> `npm test` runs 505 tests in 28 files, all passing, none skipped (measured 5 Oct 2026, `qa/logs/upgrade-test.log`; the 1 Oct baseline was 68 tests in 5 files). See `EVIDENCE.md` for the measured record, including which tests were written red-first and which are characterisation tests.

- `deadline.test.ts`: calendar arithmetic incl. a property test over ±5,000 days, profile encodings, status bands, extension refusals and input validation, eligibility, closure outcome, the eligibility⇔refusal property.
- `workflow.test.ts`: every guard, immutability, attempt exhaustion, explanations, the enabled⇔does-not-throw property over the guard table with valid and hostile payloads.
- `casefile.test.ts`, `integrity.test.ts`: import bounds, schema and enum rejection, strict dates, imported extensions held to the statutory guards, integrity rules (errors vs warnings), fixture round-trip.
- `audit.test.ts`: chain linkage, tamper and deletion detection, envelope serialisation, hostile log files.
- `reconcile.test.ts`, `duplicates.test.ts`, `exports.test.ts`: packet assembly and actions, duplicate rules, redaction-safe Markdown/HTML with hostile input.
- `docket.test.ts`: sorting, filtering, search, summary counts, CSV quoting and injection guard.
- `src/state/*.test.ts(x)`: table-driven reducer, concurrent audit appends, failure surfacing, the hook.
- `src/theme/*.test.ts(x)`: contrast ≥ 4.5:1 for every text pair in both palettes, theme hook and toggle, no storage use.
- `src/ui/*.test.tsx`, `src/ui/detail/*.test.ts`: dialogs, docket, case-detail panels, ribbon, stage rail, date formatting.
- `src/test/scenarios.test.ts`: engine journeys, a model-based state-machine property, the audit chain over a journey.
- `src/test/journeys.test.tsx`, `src/test/a11y.test.tsx`, `App.test.tsx`: every workflow above through the rendered UI; accessible names, live regions, focus, keyboard.

## Data handling

- Browser-local only. No network requests after the static assets load (verified in the browser replay: the only origin contacted is the one serving the bundle).
- No `localStorage`, `sessionStorage`, IndexedDB or cookies — including for the theme preference; refresh resets to the bundled fixture. Continuity is by JSON export/import. `scripts/check-invariants.mjs` fails CI on any such API.
- Exports (case file, audit log, packet JSON/Markdown/HTML, docket CSV) are user-initiated downloads; audit-log import is read-only verification.
- No real personal data. Fixture people are fictional, emails use `people.example`.
- Identity proofing, system lookups and delivery are simulated by recording outcomes; nothing is sent or queried.

## Limitations

- Jurisdiction profiles cover six regimes with one window each; they do not model fee rules, manifestly-unfounded assessments, special categories of requests, or the many other US state laws. The new profiles are teaching models with a citation each; none has had legal review. PIPEDA's open-ended format-conversion extension is not modelled.
- Day counting is calendar-based UTC; business days, public holidays and "receipt" nuances are not modelled.
- Hold semantics are simplified (a hold excludes a system for any right); packet actions are proposals, not executed operations.
- The audit chain is session-scoped tamper evidence, not a trusted log; an exported log is verifiable only against itself, and tail truncation is not detectable.
- Single-user; no authentication or roles beyond labels in history entries. The theme preference resets on refresh by design.
- Exports are plain generated documents (no PDF). The committed browser evidence comes from a private replay harness (headless Chromium with the production security headers enforced); it does not run axe-core, which the 1 Oct set did.

## JD evidence (educational mapping)

Privacy tech workflow (rights automation concepts), analytical/design thinking (explicit guards and explanations), quality deliverables (exportable packet and audit log), HTML/CSS/TypeScript, API-style JSON schema with validation. It does not demonstrate product experience with OneTrust or any vendor platform, and does not establish legal expertise.

## AI-assistance disclosure

Built in October 2026 with substantial automated (AI) assistance for design, tests, implementation and documentation; a second round in October 2026 (engine guards, integrity checks, session store, docket, theme, exports, tests, CI gates) was built the same way. Human review and understanding of this code have **not** been independently established. Before this project is presented as personal work, the candidate should study the code and rehearse the material in `INTERVIEW_GUIDE.md`; this README makes no claim that such review has already happened.

## License

MIT (see `LICENSE`). Third-party licences are listed in `THIRD_PARTY_NOTICES.md`.
