# Petitio user workflows — the test oracle

This document lists every user workflow the desk supports, with the exact UI labels, the engine
messages and codes behind them, and the status text the footer shows. UI journey tests are written
against it: if a label or message here changes, the test and this file change together. Everything
described is current behaviour of the integrated code base.

Conventions

- `Code spans` are exact strings as rendered or exposed as accessible names. `{braces}` are
  placeholders filled at runtime.
- Request ids such as `REQ-2026-0398` refer to the bundled synthetic case file
  (`src/fixtures/demo-casefile.json`, `asOf` `2026-10-01`). All people, systems and emails are
  invented; emails end in `.example`.
- Dates in the engine, in exported files, in the footer and in docket meta text are ISO
  `YYYY-MM-DD`. The case detail renders calendar dates as readable text such as `27 Sep 2026`
  inside `<time dateTime="2026-09-27">`; identifiers keep their ISO form (history timestamps render
  as `2026-09-08 08:30:00 UTC`, the ribbon's `aria-label` keeps ISO dates).
- The deadline profiles are an educational model, not legal advice; nothing here measures anything —
  see `EVIDENCE.md` for measured results.

## Page structure and shared strings

| Region | Markup / accessible name | Notes |
|---|---|---|
| Masthead | `<header class="masthead">`, `<h1>` `Petitio` with `<small>` `privacy rights request desk` | Prose: `Educational prototype. Deterministic deadline clock, request state machine, duplicate detection and multi-system reconciliation over synthetic data. Not legal advice and not a compliance certification.` |
| Toolbar | `role="toolbar"`, name `Case file controls` | Children in order: `As-of date`, `Import case file`, `Export case file`, `Audit log ({n})`, `Reset demo`, then the `Colour theme` radiogroup |
| Docket | `<aside aria-labelledby="docket-title">` (role `complementary`, name starts with `Docket`) | Heading `<h2>` `Docket · {visible} of {total}` |
| Case detail | `<article aria-labelledby="case-title">` | `<h2 id="case-title" tabIndex={-1}>{request id}</h2>`; the heading receives focus after a stage change of the same request |
| Error alert | `<div role="alert">` | `Refused. {CODE}: {message}` for an engine refusal; `Not recorded. Audit entry could not be recorded ({action} on {requestId}): {message}` when an audit append fails (workflow 9). The only `role="alert"` outside the import dialog's error list; cleared when another request is selected or the next action is recorded |
| Footer | `<footer class="status-line">` with one `<span role="status" aria-live="polite">` | The only `role="status"` live region on the main page while no dialog is open; the audit dialog's verification result notice (workflow 9) is a second `role="status"` while that dialog is open and is removed with it |
| Source line | second footer span | `Source: bundled synthetic fixture · {N} requests · no storage APIs, no network calls` or `Source: imported file (in memory) · {N} requests · no storage APIs, no network calls`, followed by ` · {k} action(s) could not be audited` only when an audit append has failed |
| Empty detail | `.notice` | `No request selected. Pick one from the docket or import a case file.` |

Footer status strings (exact, one per event):

| Event | Status text |
|---|---|
| First load | `Demo case file loaded. All data is synthetic; state lives in memory and resets on refresh.` |
| Workflow action recorded | `{id}: {action} recorded. Stage is now {stage}.` — `{action}` is the engine action id (`start-identity-check`, `identity-passed`, `identity-failed`, `begin-collection`, `record-system-result`, `send-to-review`, `apply-hold`, `release-hold`, `prepare-response`, `close`, `reject`) |
| Extension recorded | `{id}: extension recorded; due date moved to {effectiveDueOn}.` |
| Import | `Imported {n} requests across {m} systems (as of {asOf}).` followed, when there are warnings, by ` {k} warning(s): {first}; {second}; {third}` (at most three warnings listed) |
| Reset | `Demo case file reloaded.` |

A refusal or an audit failure changes the alert, not the status: the previous status text stays.

Audit entries (hash-chained; see workflow 9): `actor` is `analyst.demo`; `at` is the wall clock at
the moment of the event; `requestId` is the request id, or `—` for an import; `action` is one of
`{action}`, `{action} (refused)`, `extension`, `extension (refused)`, `import`; `detail` is the last
history note or `{from} → {to}` for an action, the engine message for a refusal,
`{days} days; notified {date}` for an extension, `{n} requests` for an import. Appends are
serialised, so `seq` is contiguous however quickly actions follow each other.

Workflow transitions are stamped `{asOf}T12:00:00Z` (the as-of date at noon UTC) so the demo stays
deterministic; the history panel renders this as `{asOf} 12:00:00 UTC`.

## Fixture anchors

Deterministic facts about the bundled case file as of its `asOf` date `2026-10-01`, for choosing a
request in a test. Use ids, never positions or totals (the maintainer may add requests).

| Request | Profile · type | Stage | Docket badge | Why it is useful |
|---|---|---|---|---|
| `REQ-2026-0398` | EU GDPR · erasure | `review` | `4d over` (overdue) | Selected on load; one justified hold `HOLD-0398-1` on `billing`; sorts first under `Urgency`; its notice deadline `2026-09-27` has passed, so the extension panel shows the pre-emptive notice |
| `REQ-2026-0399` | EU GDPR · erasure | `response-ready` | `4d left` (at risk) | Third-party redaction on `crm`, identity conflict on `support`; `Close request` is enabled |
| `REQ-2026-0411` | EU GDPR · access | `collecting` | `7d left` | `support` lookup outstanding; `Send to reviewer` blocked |
| `REQ-2026-0415` | EU GDPR · rectification | `received` | `14d left` | Empty history; walk the full lifecycle; extension form shown (notice deadline `2026-10-15`) |
| `REQ-2026-0416` | EU GDPR · access | `received` | `15d left` | Duplicate of `REQ-2026-0411` (same pseudonym, eight days later) |
| `REQ-2026-0420` | California CCPA/CPRA · opt-out of sale | `identity-check` | `39d left` | One failed identity attempt already recorded |
| `REQ-2026-0402` | UK GDPR · portability | `collecting` | `61d left` | Already extended (`61` days, notified `2026-09-20`); extension panel shows the pre-emptive notice (`ALREADY_EXTENDED`) |
| `REQ-2026-0380` | California CCPA/CPRA · access | `closed` | `closed` | Closed `2026-09-15`, before its due date → `Closed on time` |
| `REQ-2026-0390` | EU GDPR · access | `rejected` | `rejected` | `rejectReason` `manifestly-unfounded` |
| `REQ-2026-0375` | EU GDPR · access | `closed` | `closed` | Closed `2026-09-10`, after its statutory due date `2026-09-03` → `Closed 7 days late`; earliest received (`2026-08-03`), so first under the `Received` sort |
| `REQ-2026-0419` | Canada PIPEDA · access | `identity-check` | `21d left` | 30-day window; received `2026-09-22`, due `2026-10-22` |
| `REQ-2026-0423` | Virginia VCDPA · access | `received` | `43d left` | 45-day window; received `2026-09-29`, due `2026-11-13`; empty history |

The three requests in the last rows were added by the maintainer for this upgrade; the nine above
them are unchanged from the baseline fixture.

---

## 1. Docket triage

**Goal.** Find the most urgent request and see at a glance how much of its window is gone.

**UI labels, in order.** `Docket · {visible} of {total}` → the clock summary strip (workflow 11) →
`Search requests` → filters `Jurisdiction` (options `All` followed by one option per profile in
`PROFILES`, labelled with the profile label: `EU GDPR`, `UK GDPR`, `California CCPA/CPRA`,
`Virginia VCDPA`, `Colorado CPA`, `Canada PIPEDA`), `Type` (`All`, `Access`, `Erasure`,
`Rectification`, `Portability`, `Opt out`), `Clock` (`All`, `Open only`, `Overdue`, `At risk`,
`On track`, `Closed`, `Rejected`), `Sort` → rows → `Clear filters`, `Export CSV`. Each row is a
`<button aria-current={true|false}>` containing the id, a badge and a meta line:

- badge: `{n}d over` (overdue), `{n}d left` (open), `closed`, `rejected`;
- meta: `{jurisdiction} · {type} · {stage}`, plus ` · possible duplicate` when flagged;
- ribbon: `role="img"` with label `{status}: {n} days remaining, due {date}` or
  `{status}: {n} days past due, due {date}`, with ` after extension` appended when extended and
  `, extension notice by {date}` appended for requests that are not extended (`{status}` is the
  clock status with the hyphen replaced by a space: `on track`, `at risk`, `overdue`, `closed`,
  `rejected`; dates in the label are ISO).

Empty state: `No requests match these filters. Clear a filter or import a case file.`

**Order.** The default `Urgency` sort: `overdue` → `at-risk` → `on-track` → `closed` → `rejected`;
within a band by days remaining, then id. Other sorts: workflow 11.

**Engine.** `buildDocket(file, duplicates, filters)` assesses every request once with
`assessDeadline(request, asOf)` (`status`, `daysRemaining`, `effectiveDueOn`, `noticeDeadlineOn`);
`at-risk` means five or fewer days remain (`atRiskDays`, default `AT_RISK_DAYS`).
`findDuplicates(requests, 30)` flags a later request that repeats an earlier, non-rejected request
of the same type from the same person within the window — checked in the order pseudonym, account
id, normalised email (reasons `same-pseudonym`, `same-account`, `same-email`; account ids match only
when both requests carry one). The case detail explains the match as
`Duplicate check. Same {pseudonymous requester | account id | normalised email} and request type as {id} within the 30-day window. …`

**Expected status.** Selecting a row does not change the footer; it clears any alert.

## 2. Set the as-of date

**Goal.** Move the demo clock and watch every deadline recompute.

**UI labels.** `As-of date` (`<input type="date">`, described by `Deadlines are calculated
relative to this date so the demo stays deterministic.`).

**Behaviour.** Changing the date updates every badge, ribbon and the clock summary in the case
header: `Window {one calendar month | 45 calendar days | 30 calendar days}` (from
`describeWindow(profile.window)`), `Statutory due {date}`, `Extended to {date} ({days} days,
notified {date})` when extended, `Extension notice by {date}` for open unextended requests,
`Elapsed {n} of {m} days`, then `Remaining {n} days` or `{n} days past due` for open requests,
`Closed {date}` plus the closure badge (workflow 12) or `Rejected: {reason}` for terminal ones.
Dates here are readable `<time>` elements. Clearing the input is ignored (the previous date stays).
New transitions are stamped on the chosen date; the extension form's `Requester notified on`
defaults to it; extension eligibility is re-evaluated against it.

**Expected status.** Unchanged. No audit entry.

## 3. Advance a request through the lifecycle

**Goal.** Move a request stage by stage; blocked actions stay visible and explain themselves.

**UI labels, in order.** Section `Next actions` (hint `Blocked actions explain themselves`) →
`Note for the history entry (optional)` (trimmed; an empty note is not recorded) → one button per
structurally allowed action, labelled `Start identity check`, `Record identity passed`,
`Record failed attempt`, `Begin system lookups`, `Send to reviewer`, `Prepare response packet`,
`Close request`. Enabled buttons carry a sentence such as
`Moves to identity check and marks the check pending.`; blocked buttons have `aria-disabled="true"`,
do nothing when clicked (no alert) and show the reason beside them in `#why-{action}` (visually
prefixed `Blocked: `) and in a tooltip. Actions with their own forms (`record-system-result`,
`apply-hold`, `release-hold`, `reject`) are not listed as buttons here. Rejection is a separate
fieldset `Reject request` with select `Reason` (`duplicate`, `manifestly-unfounded`,
`identity-unverified`, `out-of-scope`) and button `Reject with this reason`. Terminal requests show
`This request is {stage}. Terminal stages accept no further actions; the history and audit log remain inspectable.`

Stage rail: `<ol aria-label="Request stages">` with `Received`, `Identity check`, `Verified`,
`System lookups`, `Reviewer`, `Response ready`, `Closed` and, for rejected requests, a final
`Rejected`; the current node has `aria-current="step"`. On narrow screens the rail wraps instead
of scrolling.

History: section `History` (hint `{n} transitions`), rows `{action} · {from} → {to} · {actor}` with
an optional note, timestamp `{date} {time} UTC` in a `<time dateTime>`; empty text
`No transitions yet. Start the identity check to begin the clock review.`; `Analyst notes` list
when the request carries notes.

**Engine.** Allowed actions per stage (`STAGE_ACTIONS`): `received` → start-identity-check, reject;
`identity-check` → identity-passed, identity-failed, reject; `verified` → begin-collection, reject;
`collecting` → record-system-result, send-to-review, reject; `review` → apply-hold, release-hold,
prepare-response, reject; `response-ready` → close, reject; `closed`/`rejected` → nothing. The
`GUARDS` table is evaluated by `transition()` and by `explainAction()`/`availableActions()`, so the
explanation shown before the click carries the same `code` the engine would throw. Explanations:
`Identity check has not passed.` (`IDENTITY_NOT_VERIFIED`),
`Lookups still outstanding for: {ids}.` (`MISSING_SYSTEM_RESULTS`),
`Holds without a written justification: {ids}.` (`UNRESOLVED_HOLDS`),
`There are no active holds to release.` (`HOLD_NOT_FOUND`),
`Identity attempts are exhausted ({attempts} of {maxAttempts}); record the final failed attempt or reject the request.`
(`IDENTITY_ATTEMPTS_EXHAUSTED`, on `Record identity passed` when no attempt is left). Refusal codes
if an action is forced anyway: `INVALID_TRANSITION`
(`"{label}" is not available while the request is in stage "{stage}".`), the codes above,
`MISSING_REJECT_REASON`
(`A rejection needs one of: duplicate, manifestly-unfounded, identity-unverified, out-of-scope.`),
`INVALID_PAYLOAD` for a malformed payload, `UNKNOWN_SYSTEM` and `DUPLICATE_HOLD` (workflows 4 and
5). The third failed identity attempt rejects the request with reason `identity-unverified` and
the note `Identity could not be verified after {n} attempts.` Closing stamps `closedOn` with the
as-of date.

**Expected status.** `{id}: {action} recorded. Stage is now {stage}.` — e.g.
`REQ-2026-0415: start-identity-check recorded. Stage is now identity-check.`,
`REQ-2026-0399: close recorded. Stage is now closed.`,
`REQ-2026-0420: identity-failed recorded. Stage is now identity-check.` for a non-final failure.
Audit: one entry per recorded action; refusals append `{action} (refused)` with the message. After
the stage changes, focus is on the `<h2 id="case-title">`.

## 4. Record simulated system lookups

**Goal.** For a request in `collecting`, record one result per system of record. Nothing is
queried.

**UI labels, in order.** Section `Systems of record` (hint `{n} of {m} looked up`, plus
` · outstanding: {ids}` while any remain) → table region `System lookup results` with columns
`System`, `Result`, `Matched by`, `Subject email on file`, `Fields`; result tags `not looked up`,
`found · {recordId}` (or just `found` without a record id), `no record`; `conflict` beside a subject
email that differs from the requester's (normalised); `third party` beside flagged fields → form
`Record a simulated system lookup` with legend
`Record a lookup result (simulated — nothing is queried)`: `System` (outstanding systems only),
`Outcome` (`Record found` / `No record`), `Record id`, `Subject email on file`, field rows
`Field {i} name`, `Field {i} value`, checkbox `third party`, `Remove field {i}`, `Add field`, submit
`Record result`. When every system has a result:
`All systems looked up. The request can go to the reviewer.`

**Engine.** Payload is a `SystemResult` with `lookedUpAt` `{asOf}T12:00:00Z`; a second result for
the same system replaces the first; history note `{systemId}: record found` or
`{systemId}: no record`. Guards in order: `INVALID_PAYLOAD`
(`record-system-result needs a SystemResult payload.` — every optional field must have the type the
importer accepts, so a recorded session always re-imports), then `UNKNOWN_SYSTEM`
(`System "{id}" is not one of the case file's systems of record. Known systems: {ids}.`).

**Expected status.** `{id}: record-system-result recorded. Stage is now collecting.` Anchor:
`REQ-2026-0411` shows `Lookups still outstanding for: support.`; recording `No record` for
`Helpdesk Tickets (synthetic)` shows the green notice, and `Send to reviewer` then gives
`REQ-2026-0411: send-to-review recorded. Stage is now review.`

## 5. Holds and exemptions

**Goal.** In `review`, exclude one system from the response for a stated reason; an unjustified
hold blocks the response until it is justified or released.

**UI labels, in order.** Section `Holds and exemptions` (hint `{n} active`) → empty text
`No holds. A hold excludes one system from this request and must carry a written justification before the response can be prepared.`
→ one card per hold: `{reason} on {systemId} · {holdId}`, ` · released {date}` once released, then
the justification, or `No justification written yet — blocks the response.`, or
`Released without a written justification.`; button `Release hold` on active holds while in
review → form `Apply a hold`: `System` (only systems without an active hold), `Reason`
(`legal-hold`, `ongoing-transaction`, `fraud-prevention`, `legal-obligation-retention`,
`third-party-rights`), `Justification (leave empty to see how an unjustified hold blocks the response)`,
submit `Apply hold`. When every system already carries an active hold the form is replaced by
`Every system of record already carries an active hold. Release one before applying another.`
Hold ids are `HOLD-{last four digits of the request id}-{n}`, never reusing an id already on the
request.

**Engine.** `apply-hold` takes a `Hold` payload stamped `appliedAt` `{asOf}T12:00:00Z`; guards in
order: `INVALID_PAYLOAD` (`apply-hold needs a Hold payload.` — the reason must be one of the five
above; or `Hold id "{id}" is already used on this request; choose a new id.`), `UNKNOWN_SYSTEM`,
`DUPLICATE_HOLD`
(`Hold "{id}" is already active on {systemId}; release it first before applying another hold to that system.`).
Applying a hold appends it; earlier records, including released ones, are never replaced.
`release-hold` takes the hold id and refuses with `HOLD_NOT_FOUND` (`No active hold with id "{id}".`)
when it is not active; `prepare-response` refuses with `UNRESOLVED_HOLDS`
(`Every active hold needs a written justification before a response can be prepared: {ids}.`) and
is shown blocked beforehand with `Holds without a written justification: {ids}.`

**Expected status.** `{id}: apply-hold recorded. Stage is now review.` /
`{id}: release-hold recorded. Stage is now review.` Anchor: on `REQ-2026-0398` applying a hold with
an empty justification (the `System` select offers `crm` and `support`, not the held `billing`)
turns `Prepare response packet` into a blocked button (`aria-disabled`, no alert) and the packet
lists `billing` under `Excluded by hold`.

## 6. Response packet and exports

**Goal.** Read the packet derived live from results and holds; reveal redacted values as a
reviewer; export it as JSON, Markdown or HTML.

**UI labels, in order.** Section `Response packet preview` (hint `Partial — something is withheld`,
`Nothing collected yet` or `Complete`) → empty text
`The packet is derived from recorded system results; none exist yet.` → checkbox
`Reveal redacted values (reviewer only)`, buttons `Export packet JSON` (downloads
`{safe id}-response-packet.json`), `Export packet Markdown` (downloads
`{safe id}-response-packet.md`), `Export packet HTML` (downloads `{safe id}-response-packet.html`)
→ the summary sentence → per disclosed system a table of fields; redacted rows show a block with
`aria-label="redacted"` (or `redacted value: {value}` when revealed) and a reason tag
`third-party-data` or `identity-conflict` →
`No disclosable records: every found record is held or in conflict.` when nothing can be shown →
table captioned `Proposed actions (simulated)` with columns `System`, `Action`, `Reason` → notice
`Excluded by hold` listing `{systemId} · {reason}: {note}` → notice `Identity conflicts` listing
`{systemId}: stored subject email does not match the verified requester; record withheld pending re-verification.`

**Engine.** `buildResponsePacket(request, asOf)`: a stored subject email that differs from the
requester marks an identity conflict and withholds every field of that system; `thirdParty` fields
are withheld; systems under an active hold are excluded; systems with no record are omitted;
`partial` is true when anything was withheld. `actions` proposes one simulated action per found
system, in result order: `retain` with the hold reason for held systems; `withhold` with reason
`identity-conflict`; otherwise the right's primary action — `disclose` (access), `export`
(portability), `erase` (erasure), `rectify` (rectification), `opt-out` (opt-out of sale).
`summary` is one procedural sentence, e.g.
`Erasure request: erase 1 system, retain 1 system under legal-obligation-retention, 1 redaction (third-party data); partial response.`
`packetToMarkdown`/`packetToHtml` name the requester by pseudonym only, never emit emails, and
omit redacted values; the Markdown has the headings `Disclosures`, `Redactions`, `Exclusions`,
`Identity conflicts`, `Proposed actions (simulated — nothing is executed)`, `Summary` and the
footer `Educational prototype — synthetic data, not legal advice.`; the HTML is a self-contained
page with one `<style>` block, no scripts and no external references, every value escaped. The UI
always exports without redacted values; the engine's `reveal` option (not wired to the checkbox)
adds them under the banner `REVIEWER COPY — contains redacted values`. Filenames pass through
`safeFilename` (control and invisible characters removed, reserved punctuation and whitespace
replaced by `-`). Exports are user-initiated downloads and write no audit entry.

**Expected status.** Unchanged. Anchors: `REQ-2026-0399` (erasure) has a third-party redaction on
`crm` (`agentNote`), an identity conflict on `support`, and proposes `erase` for `crm` and
`withhold` (`identity-conflict`) for `support`; `REQ-2026-0398` excludes `billing` by hold and
proposes `retain` for it.

## 7. Extension

**Goal.** Record the single permitted extension; when no extension is possible the panel says so
before the click; the engine refuses a malformed or over-long one.

**UI labels, in order.** Section `Extend the response window` (hint
`One extension of up to {max} days; notice must fall inside the initial window`, followed by
` — by {date}` while an extension is still possible) → either the `role="note"` notice
`Extension not available: {reason}` or the form: `Extension (days)` (`max={maxDays}`) →
`Requester notified on` (defaults to the as-of date) → `Why more time is necessary (10+ characters)`
→ submit `Record extension` (disabled until the reason has ten characters). The panel is hidden
for terminal requests. Once extended, the clock summary shows
`Extended to {date} ({days} days, notified {date})` and the panel shows the notice with the
`ALREADY_EXTENDED` reason.

**Engine (one guard table, `EXTENSION_GUARDS`).** `extensionEligibility(request, asOf)` evaluates
the state guards with the as-of date standing in for the notice date; `requestExtension(request,
input, asOf)` evaluates all of them in this order: terminal stage → `EXTENSION_NOT_ALLOWED`
(`{id} is {stage} and cannot be extended; an extension can only be recorded on an open request.`);
already extended → `ALREADY_EXTENDED`
(`{id} has already been extended once; the profile allows a single extension.`); input →
`INVALID_EXTENSION_INPUT` with one of
`Extension days must be a positive whole number; received {days}.`,
`An extension needs a stated reason; the reason is what the requester is told.`,
`notifiedOn "{value}" is not a real calendar date (YYYY-MM-DD).`,
`Extension notice dated {date} is before the request was received on {receivedOn}.`,
`Extension notice dated {date} is after the as-of date {asOf}; a notice cannot be dated in the future.`;
too long → `EXTENSION_TOO_LONG`
(`Extension of {days} days exceeds the {max}-day maximum for {profile} ({two further calendar months | 45 additional days | …}).`);
too late → `EXTENSION_TOO_LATE`
(`Extension notice dated {date} is after the initial due date {statutoryDueOn}; {profile} requires notice within the initial window.`).
Tests assert the code, not the sentence. On success the request gains `extension` and the note
`Extension of {days} days recorded; requester notified on {date}.`

**Expected status.** `{id}: extension recorded; due date moved to {effectiveDueOn}.` Refusal
anchor reachable from the UI: `REQ-2026-0415` with `Requester notified on` set to `2026-12-01` →
`Refused. INVALID_EXTENSION_INPUT: Extension notice dated 2026-12-01 is after the as-of date 2026-10-01; a notice cannot be dated in the future.`
`EXTENSION_TOO_LATE` and `EXTENSION_NOT_ALLOWED` cannot be produced from the UI any more — the
panel shows the notice instead of the form — so journeys assert the notice (anchor `REQ-2026-0398`:
`Extension not available: Extension notice dated 2026-10-01 is after the initial due date 2026-09-27; EU GDPR requires notice within the initial window.`)
and reach those codes through the engine. Audit: `extension` with `{days} days; notified {date}`,
or `extension (refused)` with the message.

## 8. Import and export a case file

**Goal.** Load a `petitio.casefile` v1 JSON into the session (bounded, validated), check a file
without importing it, download a sample, and export the current session for later re-import. State
is in memory only.

**UI labels, in order.** `Import case file` → dialog `Import a case file` (description names the
schema and limits, says the file is read in this tab only, and ends
`You can also drop a .json file anywhere on this dialog.`) → `Choose a .json file`
(`<input type="file">`) → `Or paste JSON` (`<textarea>`) → `Validate and import` and
`Validate only` (both disabled while the textarea is blank) → `Download sample case file`
(downloads `petitio-sample-casefile.json`, the bundled fixture serialised) → `Cancel`. Dropping a
`.json` file onto the dialog imports it exactly as the picker does. `Validate only` shows a green
`role="note"` notice: `Ready to import: {N} requests, {M} systems, as of {D}`, then
`{k} warning(s):` with the first twelve warnings when there are any, then
`Nothing has been imported yet. Choose “Validate and import” to replace the current session.`
(typographic quotes, as rendered).
Errors appear in a `role="alert"` block: `Import rejected.` `Fix these and try again:` followed by
the first twelve messages and `…and {n} more.` A file larger than the byte limit is refused before
reading with `File is {n} bytes; the limit is 1,000,000 bytes.` A successful import closes the
dialog. `Export case file` in the toolbar downloads `petitio-casefile-{asOf}.json`.

**Engine.** `parseCaseFile(text)` returns `{ ok: true, file, warnings }` or `{ ok: false, errors }`
and never throws: bounds first, then every field, then `checkIntegrity` (errors appended as
`{message} ({path})`, warnings passed through). Any jurisdiction in `PROFILES` is accepted. Example
errors: `Not valid JSON: {detail}`, `casefile.schema "nope" is not an allowed value`,
`casefile.requests[0].stage "teleported" is not an allowed value`, `Duplicate request id "{id}"`,
`Object nesting deeper than 8 levels is not accepted.`,
`{id}: stage is "closed" but closedOn is missing (casefile.requests[{i}].closedOn)`, and the
extension guards (an imported extension must satisfy the same rules as workflow 7). Example
warnings: `{id}: result for unknown system "{systemId}"`,
`{id}: receivedOn {date} is after the as-of date {asOf}`, a truncated note. Round trip:
`serializeCaseFile(file)` re-imports to an equal case file.

**Expected status.** `Imported {n} requests across {m} systems (as of {asOf}).` with the warning
suffix when applicable; the source line switches to `imported file (in memory)`; the first request
of the file is selected; audit `import` with request id `—` and detail `{n} requests`. A rejected
import, a validate-only check and the sample download leave the session, status and selection
unchanged.

## 9. Audit log

**Goal.** Inspect the hash-chained log of this session, verify it, see tampering detected, export
it, and verify a previously exported log without replacing the session log.

**UI labels, in order.** `Audit log ({n})` → dialog `Hash-chained audit log` (description ends
`Export writes a petitio.auditlog v1 file that can be verified here later.`) → buttons
`Verify chain`, `Simulate tampering with entry 1` (disabled while the log is empty),
`Restore real log` (disabled unless a tampered copy or an imported log is shown), `Export JSON`
(disabled while empty; downloads `petitio-audit-log.json`), `Close` → file input
`Verify an exported log` → result notice (`role="status"`) → `Imported log.` note (`role="note"`)
when an imported log is shown → table region `Audit entries` with columns `#`, `At`, `Actor`,
`Request`, `Action`, `Detail`, `Hash`, or `No actions recorded yet in this session.` /
`The imported log has no entries.`

Results: `Chain intact: {n} entries, every hash recomputed and linked.` or
`Chain broken at entry {k}: the stored hash or previous-hash link does not match the recomputed value.`
for the shown log; for a chosen file `Imported log: {N} entries, chain intact.`,
`Imported log: chain broken at entry {K}.`, `Import rejected: {first error}` or
`Import rejected: File is {n} bytes; the limit is 2,000,000 bytes.` The imported-log note reads
`Imported log. Showing {filename} ({N} entries[, legacy bare-array export]). The session log is unchanged; choose “Restore real log” to show it again.`
(typographic quotes, as rendered).
Tampering edits a copy (entry 1's detail gains ` (edited)`); the real log is never altered;
`Restore real log` (or closing the dialog) returns to the session log and clears the result.

**Engine.** `appendEntry` hashes `[seq, at, actor, requestId, action, detail, prevHash]` with
SHA-256; `verifyChain` recomputes every hash and checks `prevHash` linkage and contiguous `seq`,
reporting the first bad 1-based entry. `serializeAuditLog(log, exportedAt)` writes the envelope
`{ schema: 'petitio.auditlog', version: 1, exportedAt, entries }`; `parseAuditLog` accepts the
envelope or a legacy bare array, is bounded in bytes and entries, validates every field and never
throws. Appends flow through `createAuditQueue`, so rapid consecutive actions keep contiguous `seq`.
If an append fails (for example when `crypto.subtle` is unavailable), the entry is not recorded:
the alert shows `Not recorded. Audit entry could not be recorded ({action} on {requestId}): {message}`,
the footer source line counts ` · {k} action(s) could not be audited`, the action's status text
stands, and later appends continue from the last good entry.

**Expected status.** The footer is unchanged by the dialog. The trigger's count grows by one for
every recorded action, refusal, extension and import (the dialog's own buttons add nothing).

## 10. Reset the demo

**Goal.** Return to the bundled fixture.

**UI labels.** `Reset demo`.

**Behaviour.** Reloads the fixture, selects `REQ-2026-0398`, clears any alert and sets the source
line back to `bundled synthetic fixture`. Docket filters, the search text, the audit log and the
colour theme are not reset.

**Expected status.** `Demo case file reloaded.`

## 11. Docket search, sort, summary and CSV

**Goal.** Work a large imported docket: find a request by text, change the ordering, read the
clock totals, export the visible rows.

**UI labels, in order.** Summary strip `<ul aria-label="Clock summary">` with one item per clock
status that has at least one request, in urgency order — `{n} overdue`, `{n} at risk`,
`{n} on track`, `{n} closed`, `{n} rejected` — plus `{n} possible duplicate` / `{n} possible duplicates`
when any are flagged; counts cover **all** requests, not only the visible rows →
`Search requests` (`<input type="search">`, placeholder `Search id, pseudonym, email, account`;
matches id, pseudonym, email and account id; trimmed, case-insensitive; empty matches everything) →
`Sort` (`Urgency`, `Received`, `Due date`, `Id`; default `Urgency` = the order in workflow 1;
`Received` and `Due date` ascending by ISO date, every mode tie-broken by id) → the three filters of
workflow 1 → rows → `Clear filters` (restores the unfiltered urgency docket) → `Export CSV`
(downloads `petitio-docket-{asOf}.csv` with the visible rows in the visible order). The heading
stays `Docket · {visible} of {total}`. Keyboard: exactly one row is in the tab order (the selected
row, or the first row when the selection is filtered out); `ArrowDown`/`ArrowUp` move focus (clamped
at the ends), `Home`/`End` jump, `Enter`/`Space` select; keys with Alt/Ctrl/Meta are left to the
browser; selecting clears the alert like a click.

**Engine.** `buildDocket(file, duplicates, filters)` returns `{ rows, summary }` with
`summary.byStatus` and `summary.duplicates` over all requests and `summary.visible` over the rows;
`matchesQuery(request, query)`; `docketToCsv(rows)` writes the header
`id,receivedOn,jurisdiction,type,stage,status,statutoryDueOn,effectiveDueOn,daysRemaining,extended,duplicateOf`
and one CRLF-terminated record per row (RFC 4180 quoting; booleans `true`/`false`; `duplicateOf`
empty when none), with any text cell starting with `=`, `+`, `-`, `@`, tab or carriage return
prefixed by `'` (so `=SUM(1)` exports as `'=SUM(1)`).

**Expected status.** Unchanged; no audit entry for the export.

## 12. Closure badge

**Goal.** See, for a closed request, whether it met its effective due date.

**UI labels.** In the clock summary after `Closed {date}`: `Closed on time` (badge styled like
`closed`) or `Closed {N} days late` / `Closed 1 day late` (badge styled like `overdue`).

**Engine.** `assessDeadline(...).closureOutcome` is `on-time` when `closedOn` is on or before
`effectiveDueOn` (equal counts as on time) and `late` otherwise, with `daysLateAtClose` whole days.
Anchors: `REQ-2026-0380` → `Closed on time`; `REQ-2026-0375` → `Closed 7 days late`.

**Expected status.** Unchanged (display only).

## 13. Colour theme

**Goal.** Switch between light and dark palettes without storing anything.

**UI labels.** `<fieldset role="radiogroup" aria-label="Colour theme">` in the toolbar with native
radios labelled `Auto`, `Light`, `Dark`; Tab reaches the checked option and arrow keys move between
radios.

**Behaviour.** `Auto` (the default) follows `prefers-color-scheme` and removes `data-theme` from
`<html>`; `Light`/`Dark` set `<html data-theme="light|dark">`, which `src/theme/tokens.css` reads.
The preference lives in memory only — a refresh returns to `Auto` — and no storage API is called
(`localStorage`/`sessionStorage` spies stay silent). Text contrast meets WCAG AA in both palettes;
printing always uses the light palette.

**Expected status.** Unchanged; no audit entry.

---

## Accessibility expectations shared by every workflow

- Every button, input, select and textarea has an accessible name (visible label, `aria-label` or
  `aria-labelledby`); dialogs have a title and description.
- The footer is the only `role="status"` live region on the main page while no dialog is open; the
  audit dialog's verification result notice is a second `role="status"` while that dialog is open
  and is removed with it. `role="alert"` only for refusals/audit failures and the import dialog's
  error list.
- Blocked actions are real buttons with `aria-disabled="true"` and an explanation referenced by
  `aria-describedby`; they are never removed from the DOM.
- Dialogs trap focus and close on `Escape`; the trigger regains focus.
- Scrollable tables and the stage rail are focusable regions with names (`System lookup results`,
  `Audit entries`, `Request stages`); the rail wraps on narrow screens instead of scrolling.
- After a stage change of the same request, focus moves to the request heading, never to `<body>`;
  docket rows are keyboard-navigable as described in workflow 11.
