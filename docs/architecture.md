# Petitio architecture

Petitio is an educational, browser-local desk for individual privacy-rights requests. Everything
runs in one tab from static files: a pure TypeScript engine computes deadlines, guards the request
state machine, reconciles system lookups into a response packet and hash-chains an audit log; a thin
React layer renders it; nothing is sent or stored anywhere. This document describes how the code is
organised, how data moves through it, which invariants are enforced mechanically, and why the main
design decisions were taken.

Companion documents: `README.md` (what the rules are and their statutory sources), `docs/workflows.md`
(every user workflow with exact labels — the UI test oracle), `docs/casefile-schema.md` (the import
format, limits, integrity rules and the audit-log envelope), `AUDIT.md` and `SECURITY.md` (threat
model), `CONTRIBUTING.md` (conventions and gates). All measured figures — test counts, bundle sizes,
audit results, browser checks — live in `EVIDENCE.md` with raw output under `qa/logs/`; this document
deliberately contains none.

## 1. Module map

```
src/
  engine/                 pure TypeScript: no React, no DOM, no wall clock (time enters only as `asOf` / `now`)
    types.ts              domain contracts: Jurisdiction, Stage, Action, RightsRequest, CaseFile, DeadlineAssessment,
                          ExtensionEligibility, DocketFilters/DocketSort/DocketSummary, AuditEntry/AuditLogFile,
                          ResponsePacket (+ actions, summary), WorkflowErrorCode + WorkflowError, TERMINAL_STAGES/isTerminal
    deadline.ts           PROFILES (statutory windows as cited data), JURISDICTION_IDS/isJurisdiction, calendar arithmetic,
                          assessDeadline (status, notice deadline, closure outcome), EXTENSION_GUARDS → extensionEligibility
                          and requestExtension
    workflow.ts           STAGE_ACTIONS, ACTION_LABELS, GUARDS table → transition, explainAction, availableActions
    duplicates.ts         findDuplicates: same type, earlier non-rejected request, same pseudonym → account id → email
    reconcile.ts          buildResponsePacket: disclosures, redactions, exclusions, conflicts, proposed actions, summary
    exports.ts            packetToMarkdown, packetToHtml, escapeHtml — redacted values omitted unless `reveal`
    docket.ts             buildDocket (filters, search, sort, summary), matchesQuery, docketToCsv (RFC 4180 + formula guard)
    casefile.ts           parseCaseFile (bounds → field validation → checkIntegrity), serializeCaseFile, DEFAULT_LIMITS
    integrity.ts          checkIntegrity: cross-field rules, each an error (reject) or a warning (import and tell)
    audit.ts              appendEntry / verifyChain (SHA-256 chain), serializeAuditLog / parseAuditLog (bounded envelope)
  state/
    session.ts            reduceSession: pure (state, event) → { state, audit inputs }; owns every status/error string
    auditQueue.ts         createAuditQueue: promise-chained appends, contiguous `seq`, failures counted and reported
    useSession.ts         React binding: synchronous dispatch against a ref, log mirrored from the queue
  theme/
    tokens.css            the only stylesheet with literal colours: light `:root`, `[data-theme='dark']`,
                          `prefers-color-scheme` fallback, print block
    useTheme.ts           in-memory preference auto | light | dark → `<html data-theme>`; `auto` follows the OS
    ThemeToggle.tsx       radiogroup "Colour theme"
    contrast.ts           WCAG contrast ratio, used by tokens.test.ts over both palettes
  ui/
    Docket.tsx            summary strip, search, filters (jurisdictions from PROFILES), sort, roving-tabindex rows,
      + docket.css        Clear filters, Export CSV
    CaseDetail.tsx        composition of the detail panels; focus moves to the heading after a stage change
    detail/               ClockSummary (closure badge), ActionsPanel, IdentityPanel, ExtensionPanel (pre-emptive
      + detail.css        eligibility notice), SystemsPanel + RecordResultForm, HoldsPanel, PacketPanel (proposed
                          actions, extra exports), HistoryPanel, DateText + format.ts (`<time>` with readable dates),
                          useFocusAfterTransition.ts
    Ribbon.tsx            deadline ribbon with notice-deadline tick; the one component allowed computed inline widths
      + ribbon.css
    StageRail.tsx         stage progress with aria-current="step"; wraps on narrow screens
    AuditDialog.tsx       verify chain, tamper simulation, export envelope, verify an exported log
    ImportDialog.tsx      file picker, paste, drag-and-drop; Validate only; Download sample case file
    download.ts           downloadText, downloadHtml, safeFilename — the only way data leaves the tab
  App.tsx                 composition root: useSession + buildDocket + wiring; App.test.tsx integration tests
  main.tsx                createRoot; imports styles.css
  styles.css              imports tokens.css first; layout and components in tokens only; narrow-screen rules; print
  fixtures/               demo-casefile.json — synthetic case file, invented people, `*.example` emails
  test/                   setup.ts (jsdom stubs, download capture), helpers.tsx (renderApp, selectRequest, clickAction,
                          expectStatus, …), fixtures/build.ts (builders) and hostile.ts (malformed inputs),
                          scenarios.test.ts (engine-only journeys, model-based state-machine property), setup.test.ts,
                          journeys.test.tsx (every workflow in docs/workflows.md through the rendered application),
                          a11y.test.tsx (accessible names, live regions, blocked-action semantics, focus, keyboard, dialogs)
scripts/                  check-invariants.mjs, check-tokens.mjs, check-bundle-size.mjs + budgets.json, validate-yaml.mjs
docs/                     architecture.md (this file), workflows.md, casefile-schema.md
qa/                       screenshots and verbatim command logs (qa/logs/README.md lists each file)
.github/                  workflows/verify.yml (Node release matrix, typecheck → test → build → audit → gates), dependabot.yml
public/                   favicon.svg, third-party licence text
```

Every `*.test.ts(x)` sits next to the module it tests; `src/test/` holds shared test infrastructure and
the cross-module suites. Dependency direction is strict: `ui` → `state` → `engine`; `theme` is used
by `App` and by the stylesheets; `engine` imports nothing outside `engine`. A profile is data in
`PROFILES` — the importer's accepted jurisdictions, the docket's filter options, the refusal wording
and `JURISDICTION_IDS` all derive from it, so adding a jurisdiction is one entry plus a type-union member.

## 2. Data flow

```
bundled fixture ──┐
imported JSON ────┼──► parseCaseFile ──► checkIntegrity ──► CaseFile ──► initialSession / 'import' event
(file · paste · drop)   │ bounds, fields     │ errors → "Import rejected." list (role="alert")
                        └────────────────────┘ warnings → footer status, Validate-only summary

SessionState ──reduceSession(event, deps)──► { state, audit: AuditInput[] }
   events: select · filter · set-as-of · action · extend · import · reset
   │                                              │
   │                                              └─► auditQueue.push ─► appendEntry (SHA-256 over the previous hash)
   │                                                      └─► onChange(log) ─► useSession.log ─► AuditDialog
   ├─► findDuplicates ─► buildDocket(file, duplicates, filters) ─► Docket rows + Clock summary
   ├─► assessDeadline(request, asOf) ─► Ribbon · ClockSummary (status, closure badge, notice tick)
   ├─► extensionEligibility(request, asOf) ─► ExtensionPanel (form, or "Extension not available: …")
   ├─► availableActions / explainAction ─► ActionsPanel (blocked actions stay visible with their reason)
   └─► buildResponsePacket(request, asOf) ─► PacketPanel ─► packetToMarkdown · packetToHtml

user-initiated downloads only: serializeCaseFile · serializeAuditLog · docketToCsv · packet JSON / Markdown / HTML
external audit log ─► parseAuditLog ─► verifyChain ─► result notice; the session log is never replaced
```

Three details make the flow deterministic and testable. Workflow transitions are stamped at noon UTC
on the as-of date (`${asOf}T12:00:00Z`), so the demo replays identically; audit entries take their
`at` from the injected `now`, the only wall-clock seam. `reduceSession` never throws a `WorkflowError`:
a refusal becomes `state.error` (`CODE: message`) plus an `… (refused)` audit input, and the case file
is left untouched. State and audit are decoupled — the reducer's result stands even if an append
later fails, in which case the failure is counted and shown in the footer rather than swallowed.

## 3. Invariants and what enforces them

| Invariant | Enforced by |
|---|---|
| Browser-local: no `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `sendBeacon`, `localStorage`, `sessionStorage`, `indexedDB`, `document.cookie` anywhere under `src/`; no `dangerouslySetInnerHTML` | `scripts/check-invariants.mjs` in CI and `npm run verify`; the content-security policy in `vercel.json` when hosted |
| Pure engine: `src/engine/**`, `src/state/session.ts`, `src/state/auditQueue.ts` import nothing from React and never touch `document`, `window` or `navigator` | `scripts/check-invariants.mjs` (pure zone); module headers state the rule |
| Deterministic time: deadline maths relative to `asOf`; wall clock only through `now` | Function signatures (`assessDeadline(request, asOf)`, `SessionDeps.now`); reducer tests with a fixed clock |
| Design tokens only: no literal colours outside `src/theme/tokens.css`; no inline `style={{}}` outside `src/ui/Ribbon.tsx`; text contrast meets WCAG AA in both palettes | `scripts/check-tokens.mjs`; `src/theme/tokens.test.ts` over every text/background pair |
| Bundle budget: largest JS asset, CSS asset and total `dist/` bounded; no new runtime or build dependencies | `scripts/check-bundle-size.mjs` with `scripts/budgets.json`; `npm audit --audit-level=high` in CI |
| CI hygiene: actions pinned to commit SHAs, read-only token, no persisted credentials, gates present and in order | `scripts/validate-yaml.mjs` over `.github/` |
| Refusal codes are a contract: existing `WorkflowErrorCode` values keep their meaning; new codes are additive; what the UI explains before the click is what the engine refuses | Engine tests assert codes, not sentences; property tests check `explainAction(...).enabled ⇔ transition(...) does not throw` and `extensionEligibility(...).eligible ⇔ requestExtension(...) does not throw` |
| Import safety: bounds checked before `JSON.parse`, iterative depth check, only known keys copied, every enum and date validated, cross-field integrity rules, never throws | `parseCaseFile` + `checkIntegrity`; hostile-input tests in `src/test/fixtures/hostile.ts`; the fixture must import with zero errors and round-trip |
| Audit integrity: every entry's hash covers its content and the previous hash; `seq` contiguous; imported logs verified without replacing the session log | `appendEntry`/`verifyChain`; the promise-chained queue; `parseAuditLog` bounds |
| Export safety: generated HTML escapes every interpolation and carries no scripts or external references; CSV cells that could start a formula are prefixed; the UI's exports never include redacted values, and the engine's `reveal` option (not exposed in the UI) adds them only under a banner | `escapeHtml`, `guardCsvCell`; hostile-value tests in `exports.test.ts` and `docket.test.ts`; the export journey in `src/test/journeys.test.tsx` |
| Accessibility: every control has a name; one `role="status"` live region (footer) with the audit dialog's result notice as the only other, while that dialog is open; `role="alert"` only for refusals, audit failures and the import error list; keyboard operability; focus never lands on `<body>` after an action | Component tests and `App.test.tsx`; UI journeys are written against the labels in `docs/workflows.md` |
| Synthetic data and honest wording: invented people, `*.example` emails; every statutory figure cited and marked an educational model; measurements only in `EVIDENCE.md` | `PROFILES` citations; fixture conventions; `CONTRIBUTING.md` checklist and review |

## 4. Decision records

Short records in the style of architecture decision records: the situation, what was decided, and
what it costs.

### 4.1 No persistence

*Situation.* A desk tool invites "remember my work". Browsers offer `localStorage`, IndexedDB and
cookies; a backend would offer more.

*Decision.* State lives in memory only. A refresh returns to the bundled synthetic fixture.
Continuity is by explicit, user-initiated export and import of a `petitio.casefile` JSON (and of the
audit log). No storage API is called anywhere, and the gate makes that a build failure.

*Consequences.* The privacy promise is checkable rather than asserted: nothing leaves the tab and
nothing survives it, so the demo can never accumulate real data by accident. The cost is that work
is lost on refresh unless exported — accepted for an educational tool, and the reason the footer
says so on every load.

### 4.2 Calendar days, not business days

*Situation.* Statutes count in calendar months or calendar days, while operations teams often think
in working days with public holidays.

*Decision.* All arithmetic is in whole UTC calendar days. Month-based windows use the
corresponding-date rule (the last day of a shorter month when the date does not exist). Extension
maxima are computed from the truncated initial due date, which is deliberately conservative at month
ends. No business-day or holiday calendar is applied.

*Consequences.* The clock is deterministic and reproducible from the case file alone, and every rule
can be read in `PROFILES`. The model will sometimes be stricter than a jurisdiction's own practice;
holiday data that could be vouched for is not available, and a wrong calendar would be worse than
none. `README.md` states the choice as a teaching model, not a legal interpretation.

### 4.3 A single hold model

*Situation.* Real programmes apply exemptions per right: a retention obligation may block erasure
but not access.

*Decision.* A hold is one record per system per request with a reason and a written justification.
At most one hold may be active on a system at a time (`DUPLICATE_HOLD`; the import integrity check
warns about files that say otherwise). An active hold excludes that system from the packet for any
request type and surfaces as a `retain` action with the hold's reason; an unjustified hold blocks
`prepare-response`. Releasing a hold is an action with its own history entry.

*Consequences.* One concept to learn, one guard to test, one card to render. The simplification is
documented in `README.md` ("a hold excludes a system for any right") and in the packet wording,
which proposes rather than decides.

### 4.4 Theme preference in memory

*Situation.* A dark theme is usually paired with a remembered preference, which means `localStorage`
or a cookie.

*Decision.* The preference is a module-level value: `auto` by default (following
`prefers-color-scheme`), `light` or `dark` when chosen, mirrored onto `<html data-theme>` so
`tokens.css` can select the palette. It resets on refresh. Light and dark values live only in
`tokens.css`, and both palettes are checked for text contrast.

*Consequences.* The no-storage invariant holds without exceptions, which keeps the gate simple and
the privacy statement unconditional. The cost — choosing the theme again after a refresh — is small
because `auto` already follows the operating system.

### 4.5 The audit queue is a promise chain

*Situation.* `appendEntry` hashes asynchronously. The original `App.tsx` appended from a callback
closed over the current log, so two appends started in the same tick both computed the same `seq`
and the later write silently discarded the earlier entry — a real lost-entry race under rapid input.

*Decision.* `createAuditQueue` serialises appends: each `push` waits for the previous one to settle,
then appends to the latest log and publishes it through `onChange`. If an append fails (for example
when `crypto.subtle` is unavailable outside a secure context), the failure is counted and reported
through `onError`, the chain continues from the last good log, and `push` still resolves so the UI
is never left hanging. `useSession` dispatches synchronously and enqueues the reducer's audit inputs
in dispatch order; the push is kept out of React state updaters so StrictMode's double invocation
cannot log an entry twice.

*Consequences.* `seq` is always contiguous and `verifyChain` holds over any sequence of actions, which
is exactly what the audit dialog demonstrates. The alternative of folding the append into the
reducer was rejected because hashing is asynchronous and the reducer must stay pure.

### 4.6 Guards are a table

*Situation.* The baseline enforced rules inside `transition()` and re-described them in
`availableActions()`; the two could drift, and "the UI and the engine cannot disagree" was a
discipline rather than a structure.

*Decision.* `GUARDS` maps each action to an ordered list of guard functions returning a refusal
(`code`, `message`, optional shorter `blockedBecause`) or nothing. `transition()` throws the first
refusal; `explainAction()`/`availableActions()` return the same refusal as an explanation, skipping
guards that need a payload until one exists. Guards read only the request, the payload and the
systems of record — never the timestamp or actor — so they can be evaluated before the click. The
extension rules follow the same pattern in `deadline.ts` (`EXTENSION_GUARDS`, with `state` guards
shared by `extensionEligibility` and `input` guards used only by `requestExtension`).

*Consequences.* Adding a rule is one table entry with one piece of wording; the refusal code the UI
shows is the code the engine would throw, and a property test checks the equivalence over random
requests. Payload-shape failures gained their own code (`INVALID_PAYLOAD`) because a table entry
has to say precisely what it refuses.

### 4.7 Profiles are data

*Situation.* Jurisdictions differ in window length, unit, extension and notice rule, and new ones
keep arriving.

*Decision.* `PROFILES` is a plain object of cited records. Due dates, extension maxima, notice
deadlines, refusal wording, the importer's accepted values, the docket's filter options and
`JURISDICTION_IDS`/`isJurisdiction` are all derived from it. A profile without a statute citation is
not added; every citation ends with the educational-model wording.

*Consequences.* A new jurisdiction is one record plus a type-union member and its tests. The
trade-off is expressiveness: anything that cannot be said as "window, extension, notice rule" (fee
rules, format-conversion extensions, business-day counting) is out of scope and said so in the
citation text.

## 5. Where to look next

- Labels, messages and status strings: `docs/workflows.md`.
- Import format, limits, integrity rules, audit-log envelope, versioning: `docs/casefile-schema.md`.
- Statutory sources and algorithm descriptions: `README.md`.
- Threat model and reporting: `AUDIT.md`, `SECURITY.md`.
- Measured results and the test-first record: `EVIDENCE.md`, raw output in `qa/logs/`.
- Conventions, gates and the pull-request checklist: `CONTRIBUTING.md`.
