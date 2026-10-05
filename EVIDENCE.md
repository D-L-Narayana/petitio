# EVIDENCE.md — Petitio

Measured on 1 Oct 2026 in the build sandbox (Node v20.20.1, npm 10.8.2). Nothing below is estimated.

## Commands and results

| Command | Result |
|---|---|
| `npm ci` | reproduces the locked tree (see `qa/npm-ci.log` after the final clean install) |
| `npm run typecheck` (`tsc -b`) | exit 0, no errors |
| `npm test` (`vitest run`) | **5 files, 68 tests passed, 0 failed** (engine 63, UI integration 5) |
| `npm run build` | `dist/` produced; `index-*.js` 360.8 kB (113.8 kB gzip), CSS 15.0 kB, 8 self-hosted woff2 files; `dist/` total 648 kB |
| `npm audit` | 0 vulnerabilities (info/low/moderate/high/critical all 0) |
| Browser QA (`../qa-harness/audit.mjs` against `vite preview` on 127.0.0.1:6100) | 3 viewports (1440/768/375): status 200, 0 page errors, 0 console errors/warnings, 0 failed requests, only host contacted `127.0.0.1:6100`, no horizontal page overflow, **0 axe violations** (WCAG 2.0/2.1 A+AA); 10-step workflow replay with screenshots, 0 errors |

## Test-first record (engine)

**RED** — tests written against stub modules that throw `not implemented` (`qa/tdd-red-engine.log`):

```
 Test Files  4 failed (4)
      Tests  52 failed (52)
```

Example failing entries: `deadline.test.ts > assessDeadline > computes a GDPR statutory due date one month after receipt`, `workflow.test.ts > transition > a hold without a written justification blocks the response`, `audit.test.ts > hash-chained audit log > detects a tampered detail field`.

**GREEN** — after implementing `deadline.ts`, `workflow.ts`, `duplicates.ts`, `reconcile.ts`, `audit.ts`, `casefile.ts` (`qa/tdd-green-engine.log`):

```
 ✓ src/engine/deadline.test.ts (17 tests)
 ✓ src/engine/audit.test.ts (11 tests)
 ✓ src/engine/reconcile.test.ts (9 tests)
 ✓ src/engine/workflow.test.ts (15 tests)
 Test Files  4 passed (4)
      Tests  52 passed (52)
```

One intermediate run had 51/52 passing: the fast-check property test produced an invalid `Date` (`RangeError: Invalid time value`). Fixed in the *test* by `noInvalidDate: true`; the engine was not changed.

**UI integration tests** (`src/App.test.tsx`, 5 tests) were written after the UI; two initially failed only because Testing Library cleanup was missing between tests (`afterEach(cleanup)` added to `src/test/setup.ts`).

## Browser QA findings and fixes

1. `color-contrast` (serious): on-track badge `#157f5a` on `#e7f5ee` measured 4.43:1 → green token darkened to `#0f6b4a` (5.80:1); amber darkened to `#9a4506` (5.99:1 on its background).
2. Horizontal overflow at 768/375: grid children lacked `min-width: 0`, so the stage rail widened the page → fixed; the rail and wide tables now scroll inside focusable regions.
3. `scrollable-region-focusable` (serious): stage rail and tables made focusable with labels → fixed.
Final run: 0 violations, 0 overflow at all three widths.

## Workflow replay (observed text, `qa/browser-audit-summary.json`)

- Blocked reason shown for `prepare-response`: `Holds without a written justification: HOLD-0411-1.`
- Extension refusal: `EXTENSION_TOO_LATE: Extension notice dated 2026-12-01 is after the initial due date 2026-10-15; EU GDPR requires notice within the initial window.`
- Audit tamper simulation: `Chain broken at entry 1: the stored hash or previous-hash link does not match the recomputed value.`
- Invalid import rejected with field-level errors (schema marker, missing fields, unknown stage `teleported`).

## Facts that may support resume bullets (educational project, October 2026)

- Built a browser-local privacy rights-request desk in React/TypeScript with a deterministic deadline engine for GDPR/UK GDPR (calendar-month) and CCPA (45-day) windows and extension rules.
- Implemented a guarded workflow state machine whose refusals are surfaced as explanations, plus multi-system reconciliation with third-party redaction and a SHA-256 hash-chained audit log.
- 68 automated tests including a property-based date test; 0 axe WCAG AA violations at three viewports; 0 `npm audit` findings.

No production users, clients, or legal review are claimed.

## Review-driven fixes (red first, `qa/tdd-red-review-fixes.log` → `qa/tdd-green-review-fixes.log`)

Independent source review by the parent agent (1 Oct 2026) raised three points; each was reproduced as a failing test before the fix.

1. **Recursive depth check could overflow the stack** on hostile nesting within the byte limit. The fix (iterative, bounded `exceedsDepth`) was applied in this project *before* its test existed — the RED reproduction was done in the sibling project Consentry (`consentry/qa/tdd-red-review-fixes.log`); here the hostile-nesting test was added after the fix and passed immediately. Stated honestly: for this one item Petitio has GREEN-only evidence.
2. **Regex-only `YYYY-MM-DD` validation** accepted impossible dates such as `2026-02-30`, which would later throw inside the deadline arithmetic. RED: `1 failed | 12 passed` in `audit.test.ts` → strict calendar validation (`isStrictDate`) → GREEN.
3. **`requestExtension` trusted its input** (non-finite / fractional / zero days, blank reason, malformed notice date, notice before receipt). RED: `3 failed | 17 passed` in `deadline.test.ts` → new `INVALID_EXTENSION_INPUT` error code with four guards → GREEN `62 passed (62)`.

## Adversarial review hardening, round 4 (red first; the RED/GREEN logs of that round were never committed because `*.log` was git-ignored — see the 4 Oct section)

Finding (adversarial review round 4; the probe script is not part of this repository): the importer validated `extension.days` only to 1–366, so an EU-GDPR request with a 300-day extension imported cleanly and was assessed on-track, although `requestExtension` would refuse anything above 61 days. Three tests were added and run: **RED `2 failed | 63 passed (65)`** (the round-trip test passed from the start, as intended). Fix: `parseCaseFile` now applies the same guards as `requestExtension` — profile maximum via `maxExtensionDays`, notice not before receipt, notice within the initial window where the profile requires it, non-blank reason, integer days — with the request id, field path and maximum in the error (`casefile.requests[0].extension.days (300) on request REQ-2026-0411 exceeds the 61-day maximum for EU GDPR …`). **GREEN `65 passed (65)`.** One test assertion was loosened after RED from a single ordered regex to three independent `contains` checks (id, field, "61-day maximum"); the intent is unchanged. The probe re-run against a rebuilt engine bundle now prints `ok: false` with that error. Demo export/import round-trip still passes; build and the 10-step browser flow re-run clean (0 axe, 0 overflow, 0 errors).

## Regression in the extension hardening (red first, `qa/tdd-red-extension-regression.log` → `qa/tdd-green-extension-regression.log`)

Parent re-review found that the new cross-field extension check ran even after `ctx.str` had logged an error, because the validation helpers return the raw value alongside the error. With an extension present, `jurisdiction: 'INVALID'` threw `TypeError: Cannot read properties of undefined (reading 'window')` and `receivedOn: 'garbage'` threw `RangeError: Expected YYYY-MM-DD` instead of returning `{ ok: false }`. Two tests added (invalid jurisdiction; malformed `receivedOn`, free-text `notifiedOn`, impossible `notifiedOn` 2026-02-30): **RED `2 failed | 16 passed`** in `audit.test.ts`. Fix: the arithmetic runs only when `receivedOn` and `notifiedOn` are strict calendar dates, the jurisdiction is a known profile and `days` is a positive integer; every per-field error is still reported by the existing validators and nothing is swallowed. **GREEN `67 passed (67)`**. Follow-up (parent): the first fix tested the jurisdiction with `in PROFILES`, which inherited names (`constructor`, `toString`, `__proto__`, `hasOwnProperty`) also satisfy; a third test with those names ran **RED (`TypeError … reading 'kind'`)**, the guard now uses `JURISDICTIONS.has(jurisdiction)` (a `Set`, no prototype chain), **GREEN `68 passed (68)`**. `tsc -b` clean, build and `npm audit` (0) re-run; bundle probe confirms `ok:false` (no throw) for the four mutations and `ok:true` for the demo fixture.

## Upgrade round, 4 Oct 2026 — baseline before any change (measured; raw output in `qa/logs/baseline-*.log`)

Environment: Node v20.20.1, npm 10.8.2, Linux sandbox. Dependencies installed once with
`npm ci --ignore-scripts --no-fund --no-audit` (196 packages). `--ignore-scripts` skips the only two install scripts
in the lockfile (esbuild's binary validation and macOS-only fsevents); the esbuild platform binary ships as a regular
dependency and the build ran without the script. No dependency was added, removed or updated in this round;
`package-lock.json` is unchanged.

| Command | Result |
|---|---|
| `npm run typecheck` | exit 0 |
| `npm test` | **5 files, 68 tests passed**, 6.32 s |
| `npm run build` | `index-*.js` 363.02 kB (114.33 kB gzip), CSS 15.05 kB (3.93 kB gzip), 9 self-hosted woff2 files, `dist/` 684.7 kB |
| `npm audit --audit-level=high` | 0 vulnerabilities |
| Browser replay (Playwright 1.59, Chromium; `dist/` served by request interception from an `https://` origin with the exact `vercel.json` security headers attached to every response, `bypassCSP` off) | 3 viewports (1440/768/375): status 200; 20 responses checked against the 8 production headers, 0 mismatches; 0 CSP violations; 0 requests to any other origin; 0 page/console errors; no horizontal overflow; 32 controls, all with accessible names; 1 live region; no storage API touched. 11-step workflow replay, 0 failures; 1 download read back and checked (`REQ-2026-0411-response-packet.json`) |

Two differences from the 1 Oct figures above: the bundle now reports 9 woff2 files and 684.7 kB total (1 Oct: 8
files, 648 kB), measured on the same source. The `qa/tdd-*.log` files cited in the earlier sections were never
committed (`*.log` was git-ignored); from this round on, gate output is committed under `qa/logs/`.

CSP note: the built stylesheet references all nine woff2 files by relative URL and contains no `data:` URIs, so
`font-src 'self'` holds; the replay enforces the full `vercel.json` policy and recorded no violation.

### Findings from the baseline browser replay

1. **Audit append failure was silent.** An early harness run served the bundle from a non-secure origin where
   `crypto.subtle` is undefined; `appendEntry()` threw on every action. Because `App.tsx` applied the transition
   before awaiting the audit append, requests changed stage while the status line and the audit log did not
   update, and nothing told the analyst. Production (https) and the preview server (127.0.0.1) are secure
   contexts, so users never saw this; the failure mode is closed in this round by the audit queue, which reports a
   failed append instead of swallowing it. (That early harness run also fulfilled responses without the `vercel.json`
   headers; it was corrected before the committed runs, which attach and assert every header.)
2. **Focus dropped to `<body>`** after a stage change unmounted the clicked button (`document.activeElement` was
   `BODY` after "Send to reviewer").
3. **No arrow-key navigation** in the docket: with a row focused, ArrowDown left focus where it was; every row was a
   separate tab stop.

### Test-first record for the upgrade round

Ten work packages ran in parallel on disjoint files; each wrote its tests against the real module (or a minimal stub
exposing only the new names so the tests compiled and were collected), observed assertion failures, then
implemented. The RED runs below are the ones the lead verified in the saved vitest output; counts are
"failed | passed (total)" for that file at the time. Where tests passed from the start, the table says so.

| Package | RED run (assertion failures) | What was already passing, and why that is honest |
|---|---|---|
| Deadline engine v2 | `deadline.test.ts` 27 \| 20 (47) against stubs returning empty strings/undefined — e.g. `expected '' to be '2026-04-30'` (noticeDeadlineOn), `expected undefined to be 'on-time'` (closure outcome), `expected [ 'EU-GDPR', 'UK-GDPR', 'US-CA-CCPA' ] to deeply equal [ …(6) ]` (new profiles), fast-check counterexample `["EU-GDPR",0,0,false,"received"]` for the eligibility⇔refusal property | the 20 pre-existing deadline tests |
| Workflow guard table | `workflow.test.ts` 13 \| 20 (33) — e.g. `expected undefined to be 'UNKNOWN_SYSTEM'`; fast-check counterexample `apply-hold` enabled while `transition` refused; second round (lead finding F8) 8 \| 35 (43) — reused hold id accepted, `recordId: 9` accepted, `reason: "because"` accepted, `identity-passed` with no attempts left accepted | 15 pre-existing tests + 9 positive-path pins (known system accepted, release-then-reapply, immutability, every HoldReason accepted) |
| Case-file integrity | `integrity.test.ts` 12 \| 2 (14) against a `checkIntegrity` stub returning `[]` | the two passing tests (fixture → no issues; empty file → no issues) are trivially true against the stub and become meaningful once rules exist |
| Importer wiring | `casefile.test.ts` 3 \| 20 (23) | 15 import tests moved verbatim from `audit.test.ts`; 4 negative/preservation cases held at baseline; the schema-constant pin was added with the stub |
| Audit-log envelope | `audit.test.ts` 8 \| 4 (12) — bare array instead of envelope; hostile logs accepted | the 4 chain tests are pre-existing |
| Verify-an-exported-log and import dialogs | `AuditDialog.test.tsx` 5 \| 0 (5); `ImportDialog.test.tsx` 7 \| 0 (7) — controls absent, export not an envelope, drop not handled | — |
| Session reducer | `session.test.ts` 18 \| 4 (22) against a reducer returning the input state; `asOf` guard 1 \| 23 (24) — a notice dated after the as-of date was recorded instead of refused | the 4 describe no-ops (`set-as-of ''`, action/extend with nothing selected, initial shape) |
| Audit queue (lead finding F1) | `auditQueue.test.ts` 7 \| 4 (11) — concurrent pushes both computed `seq 1`; `push()` rejected with `digest unavailable`; `useSession.test.tsx` 6 \| 1 (7) | 2 tests are the executable statement of the defect (raw `appendEntry` pattern loses an entry) and pass by design; 2 single-push pins held |
| Docket engine and UI | `docket.test.ts` 20 \| 3 (23) against API-only stubs; `Docket.test.tsx` 11 \| 8 (19) with the engine green and the UI stub; DOM order 1 \| 43 (44) | the 3 engine cases are negatives satisfied by an empty result; the 8 UI cases are the preserved baseline structure |
| Case-detail panels, dates, focus, ribbon | `CaseDetail.test.tsx` 41 \| 6 (47) against panel stubs returning `null`; `format.test.ts` 3 \| 1 (4) — the run also showed this runtime's ICU abbreviates September as "Sept", so the formatter normalises months to three letters; `Ribbon.test.tsx` 3 \| 3 (6); focus 1 \| 68 (69) | 6 structural passes; the negative date test; 3 characterisation tests of the baseline ribbon; 4 StageRail characterisation tests |
| Theme tokens / contrast / toggle | `tokens.test.ts` 39 \| 3 (42) with a `contrastRatio` stub returning 1 and no dark block, then 20 \| 22 (42) with only the dark block missing; `useTheme.test.tsx` 5 \| 2 (7); `ThemeToggle.test.tsx` 4 \| 1 (5) | light-block presence and the recorded green/amber fixes held at baseline; "never touches Web Storage" and "defaults to auto" are invariant tests, true of the stub by construction |
| Packet actions, exports, duplicates, downloads | `reconcile.test.ts` 12 \| 9 (21) — `packet.actions` undefined for every request type; `exports.test.ts` 10 \| 1 (11); `duplicates.test.ts` 3 \| 2 (5) — `same-email` where `same-account` was expected; `download.test.ts` 13 \| 2 (15) | the 9 pre-existing duplicate/packet tests; "omits redacted values by default" is trivially true on the stub |
| jsdom stubs for journeys | `setup.test.ts` 3 \| 2 (5) — `window.matchMedia is not a function`; jsdom "navigation to another Document" on an export click | 2 helper tests exercised the existing UI |
| UI journeys and accessibility suites (`journeys.test.tsx`, 33; `a11y.test.tsx`, 10) | none — written last, against the integrated application and the finished `docs/workflows.md`, so they are characterisation tests and are labelled as such. Their first run had 3 failures, all expectation errors in the tests (a window wording taken from a draft of the oracle; an export banner the oracle says the UI never adds; two hold reasons in the wrong order); the export case was resolved by *strengthening* the assertion (a revealed preview must still export without the redacted value), the summary case by computing the expected sentence with the engine. No journey exposed a product defect | all 43: they pin behaviour that already existed when they were written, including the audit-failure path (F1) end to end |

Characterisation tests (engine scenarios, the main model-based state-machine property, hostile-file samples, the
StageRail tests) are green from the start by nature and are labelled as such in the test files. The CI gate
scripts have no Vitest tests; their evidence is `--self-test` runs (37 and 34 checks) plus deliberate-violation
runs saved in the checkpoint folder.

### Engine gaps found by the model-based tests (lead finding F8)

`src/test/scenarios.test.ts` encodes the invariant "a payload is either refused with a `WorkflowError` or produces
a request the importer accepts" and ran it against the first guard table (4 failed | 34 passed). Four real gaps
surfaced and were closed red-first in `workflow.ts`:
1. `identity-passed` with attempts already at `maxAttempts` was accepted (`IDENTITY_ATTEMPTS_EXHAUSTED` existed in
   the type but was never thrown).
2. `apply-hold` with an id already used on the request silently replaced the earlier hold record, erasing its
   release history.
3. `record-system-result` accepted `recordId: 9` (and other non-string optionals) that `parseCaseFile` rejects, so
   a live session could become non-re-importable.
4. `apply-hold` accepted `reason: "because"`, which is not a `HoldReason`.

### A harness lesson, stated for the record

The first attempt at the browser replay served the bundle from a non-secure origin, so `crypto.subtle` was
undefined and every audit append threw (that is how finding 1 above was noticed). It also fulfilled intercepted
responses without the `vercel.json` headers, so the CSP was not enforced. Both were corrected before any committed
run: the harness now serves from an `https://` origin, attaches every declared header to every response, asserts
them on index and asset responses, records `securitypolicyviolation` events and foreign requests, and keeps
Playwright's CSP bypass off. One further correction during the integrated run: Playwright's `radio.check()` aims at
the visually hidden theme radio and is intercepted by its label, so the harness clicks the label and asserts the
radio's checked state — the path a pointer user takes — and separately moves the selection with an arrow key.

## Upgrade round, 5 Oct 2026 — after the upgrade (measured; raw output in `qa/logs/upgrade-*.log`)

Same environment and the same installed tree as the baseline (`package-lock.json` byte-identical; no dependency
added, removed or updated). Every row is the final run on the integrated tree after the last work package landed;
nothing below is estimated.

| Command | Result |
|---|---|
| `npm run typecheck` | exit 0, no diagnostics (`upgrade-typecheck.log`) |
| `npm test` | **28 files, 505 tests passed, 0 failed, 0 skipped**, 77.5 s (`upgrade-test.log`) |
| `npm run build` | `index-*.js` 402.95 kB (126.46 kB gzip), CSS 23.81 kB (5.33 kB gzip), 9 self-hosted woff2 files, `dist/` 734.24 kB in 14 files (`upgrade-build.log`) |
| `npm audit --audit-level=high` | 0 vulnerabilities (`upgrade-audit.log`) |
| `node scripts/check-invariants.mjs` | OK — 37 files scanned under `src` (tests skipped); no network or storage API; `engine/**`, `state/session.ts`, `state/auditQueue.ts` free of React and DOM (`upgrade-check-invariants.log`) |
| `node scripts/check-tokens.mjs` | OK — 42 files; no literal colours outside `src/theme/tokens.css`; no inline styles outside `src/ui/Ribbon.tsx` (`upgrade-check-tokens.log`) |
| `node scripts/check-bundle-size.mjs` | OK — JS 402.95 ≤ 420 kB, CSS 23.81 ≤ 40 kB, `dist/` 734.24 ≤ 760 kB (`upgrade-check-bundle.log`) |
| `node scripts/validate-yaml.mjs` | OK — `.github/workflows/verify.yml` and `.github/dependabot.yml` parsed, no policy violations (`upgrade-check-yaml.log`) |
| Browser replay (same harness as the baseline, `--expect upgrade`; Playwright 1.59, Chromium; `dist/` served by request interception from an `https://` origin with every `vercel.json` header on every response, `bypassCSP` off) | 4 viewports (1440/768/375 light, 1440 dark): status 200; 25 responses checked against the 8 production headers, 0 mismatches; 0 CSP violations; 0 requests to any other origin; 0 page/console errors; no horizontal page overflow; 40 controls, all with accessible names; 1 live region; no storage API touched. 23-step workflow replay, 0 failures; 7 downloads read back and checked — `REQ-2026-0411-response-packet.json`, `.md` and `.html` (third-party value absent), `petitio-audit-log.json` (envelope, chain intact), `petitio-sample-casefile.json`, `petitio-casefile-2026-10-01.json` (re-imported in step 19), `petitio-docket-2026-10-01.csv` (`upgrade-browser-check.log`, `qa/screens/upgrade-browser-check.json`) |

`npm run verify` — the CI sequence in one command — was run last on the same tree and exited 0
(`upgrade-verify.log`: typecheck, 505 tests, a build with byte-identical asset hashes to the one the browser replay
used, then the four gates).

Against the baseline: tests went from 68 in 5 files to 505 in 28 files; the JS asset grew from 363.02 kB to
402.95 kB (+39.93 kB raw, +12.13 kB gzip) and the CSS from 15.05 kB to 23.81 kB for the second palette, the docket
and detail stylesheets and the print rules; `dist/` went from 684.7 kB to 734.24 kB. All three stay inside the
budgets that `check:bundle` enforces.

The three baseline findings, re-observed in the browser: (1) the audit-failure path cannot be reproduced under the
production headers because `https://` is a secure context — it is pinned by `src/state/auditQueue.test.ts`,
`useSession.test.tsx` and the journey "when an append fails the action still stands …" instead, and the replay
confirms that the audit chain verifies after the 23-step journey; (2) focus after "Send to reviewer" lands on the
request heading (`focused: case-title` in step 5), not on `<body>`; (3) with a docket row focused, ArrowDown moves
focus to `REQ-2026-0399`, End to `REQ-2026-0390`, Home to `REQ-2026-0398`, and only the focused row is in the tab
order (step 23). One further difference at 375 px: the baseline listed eleven stage-rail elements wider than the
viewport (the rail scrolled sideways); the upgraded run lists none, because the rail wraps — the remaining wide
elements are the system-lookup table and its cells scrolling inside their labelled, focusable region, as before.

What this replay does not show: it does not run axe-core (the 1 Oct set did; the jsdom accessibility suite
`src/test/a11y.test.tsx` and the contrast test over both palettes cover names, roles, live regions, focus, keyboard
behaviour and colour contrast instead), and it exercises the built bundle under the declared headers rather than
the live Vercel responses — the deployment was not re-tested from this environment.

### Facts that may support resume bullets (educational project, updated 5 Oct 2026)

- Extended the privacy rights-request desk to six cited jurisdiction profiles (EU/UK GDPR, CCPA, Virginia VCDPA,
  Colorado CPA, PIPEDA) with a single extension-guard table that explains refusals before the click; a property
  test proves eligibility and refusal agree.
- Refactored the workflow guards into one table shared by the state machine and its explanations; a model-based
  state-machine test re-imports every intermediate request and found four real engine gaps, all closed red-first.
- Replaced an audit-append race with an ordered queue that reports failures; added case-file integrity rules, a
  verifiable audit-log export envelope, docket search/sort/CSV, redaction-safe Markdown/HTML packets, light/dark
  tokens with WCAG AA contrast checks, and four dependency-free CI gates.
- 505 automated tests in 28 files (from 68 in 5), 0 `npm audit` findings, CSP-enforced browser replay of 23
  workflow steps at four viewports with 0 violations.

No production users, clients, or legal review are claimed.
