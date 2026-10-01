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

## Sixth-Fable hardening (red first, `qa/tdd-red-sixth-fable.log` → `qa/tdd-green-sixth-fable.log`)

Finding (sixth-Fable Round 4, `v2/pt-adverse3.mjs`): the importer validated `extension.days` only to 1–366, so an EU-GDPR request with a 300-day extension imported cleanly and was assessed on-track, although `requestExtension` would refuse anything above 61 days. Three tests were added and run: **RED `2 failed | 63 passed (65)`** (the round-trip test passed from the start, as intended). Fix: `parseCaseFile` now applies the same guards as `requestExtension` — profile maximum via `maxExtensionDays`, notice not before receipt, notice within the initial window where the profile requires it, non-blank reason, integer days — with the request id, field path and maximum in the error (`casefile.requests[0].extension.days (300) on request REQ-2026-0411 exceeds the 61-day maximum for EU GDPR …`). **GREEN `65 passed (65)`.** One test assertion was loosened after RED from a single ordered regex to three independent `contains` checks (id, field, "61-day maximum"); the intent is unchanged. The probe re-run against a rebuilt engine bundle now prints `ok: false` with that error. Demo export/import round-trip still passes; build and the 10-step browser flow re-run clean (0 axe, 0 overflow, 0 errors).

## Regression in the extension hardening (red first, `qa/tdd-red-extension-regression.log` → `qa/tdd-green-extension-regression.log`)

Parent re-review found that the new cross-field extension check ran even after `ctx.str` had logged an error, because the validation helpers return the raw value alongside the error. With an extension present, `jurisdiction: 'INVALID'` threw `TypeError: Cannot read properties of undefined (reading 'window')` and `receivedOn: 'garbage'` threw `RangeError: Expected YYYY-MM-DD` instead of returning `{ ok: false }`. Two tests added (invalid jurisdiction; malformed `receivedOn`, free-text `notifiedOn`, impossible `notifiedOn` 2026-02-30): **RED `2 failed | 16 passed`** in `audit.test.ts`. Fix: the arithmetic runs only when `receivedOn` and `notifiedOn` are strict calendar dates, the jurisdiction is a known profile and `days` is a positive integer; every per-field error is still reported by the existing validators and nothing is swallowed. **GREEN `67 passed (67)`**. Follow-up (parent): the first fix tested the jurisdiction with `in PROFILES`, which inherited names (`constructor`, `toString`, `__proto__`, `hasOwnProperty`) also satisfy; a third test with those names ran **RED (`TypeError … reading 'kind'`)**, the guard now uses `JURISDICTIONS.has(jurisdiction)` (a `Set`, no prototype chain), **GREEN `68 passed (68)`**. `tsc -b` clean, build and `npm audit` (0) re-run; bundle probe confirms `ok:false` (no throw) for the four mutations and `ok:true` for the demo fixture.
