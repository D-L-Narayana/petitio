# Changelog

All notable changes to Petitio are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). The project is not yet versioned by
release: entries accumulate under *Unreleased* until the maintainer cuts a version. Measured
figures (test counts, bundle sizes, audit results, browser checks) live in `EVIDENCE.md`, not here.

## [Unreleased]

### Added

- **Deadline engine.** `extensionEligibility()` and `noticeDeadlineOn()`; one extension guard table
  (`EXTENSION_GUARDS`) walked by both `extensionEligibility()` and `requestExtension()`, so the
  pre-click explanation and the refusal cannot disagree; `requestExtension` accepts an optional
  `asOf` and refuses a notice dated after it; new refusal `EXTENSION_NOT_ALLOWED` for closed or
  rejected requests. `assessDeadline` takes `DeadlineOptions.atRiskDays` and reports
  `noticeDeadlineOn`, `closureOutcome` and `daysLateAtClose`. Jurisdiction profiles for Virginia
  (`US-VA-VCDPA`), Colorado (`US-CO-CPA`) and Canada (`CA-PIPEDA`), each cited to its statute
  section and labelled an educational model, with the PIPEDA citation stating which extension is not
  modelled; `JURISDICTION_IDS`, `isJurisdiction()`, `describeWindow()`, `describeExtension()`.
- **Workflow engine.** A `GUARDS` table consumed by `transition()` and the new `explainAction()`;
  `availableActions()` is built on it and `ActionAvailability` carries the `code` the engine would
  throw. New refusals `UNKNOWN_SYSTEM` (a system id not in the case file), `DUPLICATE_HOLD` (a
  second active hold on one system) and `INVALID_PAYLOAD` (payload shape, including hold-id reuse).
- **Case-file integrity.** `checkIntegrity()` with cross-field rules (closure and rejection fields
  match the stage, history ends at the stage, identity attempts within the maximum, passed identity
  before collection, holds on known systems with unique ids) as errors, and advisory warnings
  (unknown-system results, receipt after the as-of date, out-of-order history, second active hold,
  closure before receipt, truncated notes); wired into `parseCaseFile`. `docs/casefile-schema.md`
  documents every field, limit, rule and the versioning policy.
- **Audit log.** `petitio.auditlog` v1 export envelope with `serializeAuditLog()`/`parseAuditLog()`
  (bounded, field-validated, legacy bare arrays accepted, never throws). The audit dialog gains
  *Verify an exported log* with `Imported log: … chain intact.` / `… chain broken at entry …` /
  `Import rejected: …` results; the imported entries are shown without replacing the session log.
- **Import dialog.** Drag-and-drop onto the dialog, *Validate only* with a
  `Ready to import: …` summary and warnings, *Download sample case file*.
- **Session store** (`src/state`). Pure `reduceSession()` with an injectable actor and clock,
  `createAuditQueue()` for ordered appends, and the `useSession()` hook (exposes the audit log,
  the number of audit failures and an `idle()` test seam).
- **Docket.** `buildDocket()`, `matchesQuery()` and `docketToCsv()` in the engine; in the UI a
  clock summary strip, *Search requests*, *Sort* (Urgency, Received, Due date, Id), *Clear filters*,
  *Export CSV* with RFC 4180 quoting and a formula-injection guard, jurisdiction options derived from
  `PROFILES`, and arrow-key navigation with a roving tabindex.
- **Case detail.** Decomposed into panels under `src/ui/detail` with a tokens-only stylesheet;
  readable dates in `<time>` elements; focus moves to the request heading after a stage change;
  pre-emptive `Extension not available: …` notice; `Closed on time` / `Closed … late` badge;
  the hold form offers only systems without an active hold; *Export packet Markdown* and
  *Export packet HTML* beside *Export packet JSON*; the ribbon marks the last day an extension
  notice may be given.
- **Response packet.** Right-aware `actions` per system (`disclose`, `export`, `erase`, `rectify`,
  `opt-out`, `retain`, `withhold`) and a one-sentence `summary`; `packetToMarkdown()`,
  `packetToHtml()` and `escapeHtml()`; `downloadHtml()` and `safeFilename()`; duplicate detection
  by shared account id (`same-account`).
- **Theme and presentation.** Design tokens for light and dark palettes in `src/theme/tokens.css`
  (the only stylesheet with literal colours), an in-memory *Colour theme* radiogroup
  (Auto / Light / Dark), a WCAG contrast utility with automated checks over both palettes, a print
  stylesheet, `color-scheme` and `theme-color` metas, and an original SVG favicon.
- **Tests.** Engine scenario suite with a model-based state-machine property; shared jsdom stubs,
  render helpers, case-file builders and hostile-input samples; component tests for the docket, the
  case detail panels, the ribbon, the stage rail, both dialogs, the theme, the session store, the
  exports and the download helpers; a UI journey suite that walks every workflow in
  `docs/workflows.md` through the rendered application, and an accessibility suite (accessible
  names, live regions, blocked-action semantics, focus management, docket keyboard navigation,
  dialog focus handling).
- **Engineering.** CI gates `check:invariants` (no network/storage APIs; pure engine),
  `check:tokens` (tokens only, no inline styles), `check:bundle` (budgets in `scripts/budgets.json`)
  and `check:yaml` (pinned actions, read-only token, gate order), all dependency-free; `npm run verify`;
  the workflow runs on both supported Node release lines with typecheck and cancels superseded runs;
  Dependabot for npm and GitHub Actions; `engines` in `package.json`; `CONTRIBUTING.md`,
  `SECURITY.md`, `docs/workflows.md`, `docs/architecture.md`; verbatim gate output kept under
  `qa/logs/`.

### Changed

- Payload-shape failures in `transition()` report `INVALID_PAYLOAD` instead of `INVALID_TRANSITION`;
  `availableActions()` derives from the guard table rather than a parallel description.
- Extension refusal wording is derived from the profile instead of a hard-coded phrase; every
  profile citation ends with the educational-model wording.
- The importer accepts every jurisdiction defined in `PROFILES` rather than a separate list; the
  unknown-system warning now comes from the integrity check with its wording unchanged.
- The audit-log export wraps entries in an envelope; legacy bare arrays are still accepted.
- `App.tsx` is composition only; session logic moved to `src/state`; the docket takes rows, a
  summary and filters with `query` and `sort`; `ActionRequest` lives in `engine/types` and is
  re-exported by `CaseDetail`.
- Applying a hold appends it; hold ids are never reused.
- The stage rail wraps on narrow screens instead of scrolling horizontally; masthead greys are
  consolidated into tokens.
- TypeScript build-info files are written under `node_modules/.tmp` and ignored by git.

### Fixed

- Rapid consecutive actions could lose audit entries: appends raced against the same base log and
  the later write overwrote the earlier one. Appends are now serialised through a queue, so
  sequence numbers stay contiguous and the chain verifies.
- An audit append that failed (for example when `crypto.subtle` is unavailable) was silent and left
  the dispatching promise rejected. Failures are now counted, reported in the alert as
  `Not recorded. …` and in the footer, and later appends continue from the last good entry.
- `identity-passed` was accepted when no identity attempt was left; `IDENTITY_ATTEMPTS_EXHAUSTED`
  existed but was never thrown. It is now enforced before the click and on transition.
- Applying a hold whose id already existed on the request silently replaced the earlier record,
  erasing its release history. Hold-id reuse is now refused (`INVALID_PAYLOAD`).
- `record-system-result` accepted optional fields of the wrong type (for example a numeric record
  id) that the importer then rejected, so a live session could become non-re-importable. The payload
  is now validated to the importer's shape.
- `apply-hold` accepted a reason outside the hold-reason list, which the importer then rejected.
  The reason is now validated.
- A closed or rejected request could be extended, and an extension notice dated after the as-of
  date could be recorded.

### Security

- Audit-log import is bounded (bytes, entry count, hash format, contiguous sequence) and never
  throws on malformed input; the session log is never replaced by an imported file.
- The HTML packet export escapes every interpolation and contains no scripts, links or external
  references; the Markdown export escapes table and inline-markup characters; the CSV export
  neutralises cells that spreadsheets would treat as formulas; download filenames are sanitised.
- Continuous integration runs with a read-only token, pinned action commits, no persisted
  credentials and a dependency audit on every push and pull request.

## [0.1.0] - 2026-10-01

### Added

- Initial public prototype: deterministic deadline clock for EU GDPR, UK GDPR and California CCPA/CPRA
  profiles; workflow state machine with self-explaining refusals; duplicate detection; multi-system
  reconciliation with redaction; hash-chained audit log; bounded, validated case-file import/export;
  static deployment with a strict content-security policy.
