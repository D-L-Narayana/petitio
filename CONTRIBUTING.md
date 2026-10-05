# Contributing to Petitio

Petitio is an educational, browser-local privacy-rights desk. Contributions are welcome as long as
they keep the three promises the project makes: nothing leaves the tab, every rule is inspectable
and tested, and nothing claims to be legal advice. This guide explains the setup, the checks that
run in CI, the testing conventions and how to extend the model.

## Setup

- Node `>=20.19 <21` or `>=22.12` (the `engines` field in `package.json`; Vite 7 requires it).
  CI runs both lines.
- `npm ci --no-fund` — installs the locked tree. Do not run `npm install`/`npm update` in a feature
  branch: the lockfile changes only in dedicated dependency updates (Dependabot opens those).
- The project has no backend, no environment variables and no secrets.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Vite dev server on `http://127.0.0.1:6100` |
| `npm run build` | `tsc -b && vite build` → `dist/` |
| `npm run preview` | Serves `dist/` on `http://127.0.0.1:6100` |
| `npm test` / `npm run test:watch` | Vitest (jsdom, Testing Library, fast-check) |
| `npm run typecheck` | `tsc -b` with no emit |
| `npm run check:invariants` | `scripts/check-invariants.mjs` — no network/storage APIs anywhere in `src/`, no React/DOM in the engine or the session store |
| `npm run check:tokens` | `scripts/check-tokens.mjs` — no literal colours outside `src/theme/tokens.css`, no inline `style={{}}` outside `src/ui/Ribbon.tsx`; production sources only (`*.test.ts(x)` and `src/test/` are not scanned, because tests pass hex colours to the contrast utility) |
| `npm run check:bundle` | `scripts/check-bundle-size.mjs` — `dist/` within `scripts/budgets.json` (run `npm run build` first) |
| `npm run check:yaml` | `scripts/validate-yaml.mjs` — structural and policy lint for `.github/` (pinned actions, read-only token, gates present and in order) |
| `npm run verify` | typecheck → test → build → the four checks; this is what a PR must pass |

The gate scripts are dependency-free Node ESM and print `file:line: reason` for every violation;
`node scripts/check-invariants.mjs --self-test` and `node scripts/check-tokens.mjs --self-test` run
each matcher against built-in positive and negative samples.

## Repository map

```
src/engine/     pure TypeScript — types, deadline, workflow, duplicates, reconcile, exports, docket,
                casefile, integrity, audit. No React, no DOM, no wall clock except through `asOf`/`now`.
src/state/      session reducer, ordered audit queue, React hook
src/theme/      design tokens (light/dark), theme hook and toggle, contrast utility
src/ui/         Docket, CaseDetail and its detail/ panels, Ribbon, StageRail, dialogs, download helpers
src/App.tsx     composition only
src/fixtures/   the bundled synthetic case file
src/test/       setup, render helpers, builders, scenario/journey/a11y tests
docs/           casefile-schema.md, workflows.md (the UI test oracle)
scripts/        the CI gates
qa/             baseline screenshots and saved command output
```

## Test conventions

1. **Assert codes, not messages.** Refusals are `WorkflowError` instances with a stable `code`
   (`WorkflowErrorCode`). Tests assert the code (see `expectCode` in `src/engine/workflow.test.ts`);
   message wording may be improved without breaking tests. The one place wording is a contract is
   `docs/workflows.md`, because the UI journey tests use those labels and status strings.
2. **Red first.** Write the test against the real module, make sure it compiles and is collected,
   and watch it fail on an assertion — an import error, a compile error or "0 tests" is not a red
   run. Then implement and watch it pass. Keep the two Vitest summaries and paste them (or the saved
   logs) into the pull request; say honestly which tests were written after the code.
3. **Deterministic time.** All deadline arithmetic is relative to `asOf`; anything that needs the
   wall clock receives an injectable `now`. Never call `Date.now()`/`new Date()` inside the engine.
4. **Properties where they pay off.** Date arithmetic, the state machine (random sequences of
   *enabled* actions never throw; terminal stages absorb; inputs are not mutated) and the
   eligibility ⇔ refusal equivalence are property tests with fast-check.
5. **Fixture-stable assertions.** Reference requests by id; do not assert exact totals of the demo
   fixture (it may grow). The fixture must always import with zero errors and round-trip through
   `serializeCaseFile`/`parseCaseFile`.
6. **Synthetic data only.** Invented people, `*.example` emails, `REQ-2026-NNNN` ids and
   pseudonym-style requester names in tests and fixtures.
7. **UI tests** use Testing Library queries by role and accessible name, never by class.

## Invariants every change must keep

- **Browser-local.** No `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `sendBeacon`,
  `localStorage`, `sessionStorage`, `indexedDB` or `document.cookie` anywhere under `src/`
  (`check:invariants`). The theme preference is in memory only.
- **Pure engine.** `src/engine/**`, `src/state/session.ts` and `src/state/auditQueue.ts` import
  nothing from React and never touch `document`/`window` (`check:invariants`).
- **No injected markup.** No `dangerouslySetInnerHTML`; generated HTML (the packet export) escapes
  every interpolation; CSV cells that could start a formula are prefixed with `'`.
- **Design tokens.** New CSS uses the custom properties defined in `src/theme/tokens.css`; no
  literal `#hex`/`rgb()`/`hsl()` elsewhere; no inline `style={{}}` except the ribbon's computed
  widths (`check:tokens`). Both palettes must keep text contrast at WCAG AA.
- **Accessibility.** Every control has an accessible name; one `role="status"` live region (the
  footer) and `role="alert"` only for refusals; every new interaction works from the keyboard; focus
  never lands on `<body>` after an action.
- **Compatibility.** Existing `WorkflowErrorCode` values keep their meaning; new codes are additive;
  exported function signatures stay source-compatible (optional parameters and fields only); a
  `petitio.casefile` v1 file that imports today still imports unless it breaks an integrity rule.
- **Not legal advice.** Every statutory figure cites its source and carries the "educational model"
  wording. Documentation describes what the software does; it does not claim compliance, legal
  review, users or vendor-platform experience.
- **Bundle budget.** `scripts/budgets.json` bounds the built JS, CSS and `dist/` sizes
  (`check:bundle`). The project adds no runtime or build dependencies.

## Adding a jurisdiction profile

A profile is data plus a citation. Two places change:

1. `src/engine/types.ts` — add the id to the `Jurisdiction` union (ids follow the
   `REGION-LAW` pattern, e.g. `US-VA-VCDPA`).
2. `src/engine/deadline.ts` — add the entry to `PROFILES` with `id`, `label`, `window`
   (`calendar-months` or `calendar-days`), `extension` (same shapes), `extensionNoticeWithinInitialWindow`
   and a `citation` that names the statute section and ends with the words
   `Educational model, not legal advice.` If the figure cannot be cited from statute text, do not
   add the profile. Business-day calendars are out of scope (no holiday data we can vouch for).

Everything else derives from `PROFILES`: `JURISDICTION_IDS`/`isJurisdiction` are computed from it,
`parseCaseFile` accepts exactly its keys, and the docket's `Jurisdiction` filter lists its labels.
Add tests in `src/engine/deadline.test.ts`: the statutory due date for a known receipt date, the
maximum extension, one refusal per guard, and the eligibility property if the profile has an
unusual notice rule. Add a fixture request only if it illustrates something the existing ones do
not, keep the existing requests unchanged, and update the profile table in `README.md`
(maintainer) and `docs/workflows.md` if any label changes.

## Adding a system of record

Systems are data in the case file, not code: `systems[]` entries with `id`, `name` and
`description`. Add one to `src/fixtures/demo-casefile.json` or to an imported file. Every request
must record a result for every system before `send-to-review`; holds reference system ids;
`record-system-result` and `apply-hold` refuse ids that are not in the file (`UNKNOWN_SYSTEM`), and
the integrity check reports holds on unknown systems. If you change the fixture, re-run the fixture
tests and make sure the docket order described in `docs/workflows.md` still holds for the anchor
requests.

## Documentation

- `docs/workflows.md` is the oracle for UI labels, engine messages and status strings; change it in
  the same pull request as the behaviour.
- `docs/casefile-schema.md` documents every field, limit and integrity rule of the import format.
- `README.md`, `EVIDENCE.md`, `AUDIT.md` and `INTERVIEW_GUIDE.md` carry measured numbers and claims;
  only the maintainer edits those, from saved command output. Report your own measured output in
  the pull request instead.
- `CHANGELOG.md` follows Keep a Changelog; add a line under `Unreleased`, facts only.
- The README discloses that the project was built with substantial automated assistance and has
  not been independently human-reviewed. Keep that disclosure accurate; do not add product, model
  or vendor branding to it.

## Pull request checklist

- [ ] `npm run verify` passes locally on a supported Node version.
- [ ] New behaviour has tests; red-first evidence (two Vitest summaries) is in the description, and
      tests written after the code are labelled as such.
- [ ] Tests assert `WorkflowError` codes, not messages; UI tests use `docs/workflows.md` strings.
- [ ] No network/storage APIs; no React/DOM in the engine or session store.
- [ ] CSS uses tokens only; no new inline styles; both themes checked.
- [ ] Every control has an accessible name and works from the keyboard.
- [ ] Synthetic data only; statutory figures cited with the educational-model wording.
- [ ] Preserved strings unchanged, or `docs/workflows.md` updated in the same change.
- [ ] `CHANGELOG.md` entry under `Unreleased`.
- [ ] No measurements or claims added to README/EVIDENCE/AUDIT; no `*.tsbuildinfo` or `dist/`
      committed; lockfile unchanged (unless this is a dependency update).

Commit messages follow the existing `type: summary` style (`feat:`, `fix:`, `docs:`, `test:`,
`ci:`, `chore:`).
