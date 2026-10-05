# INTERVIEW_GUIDE.md — Petitio

Rehearsal material. This project was built with substantial AI assistance and has not been independently reviewed by the candidate; study and be able to explain the following unaided before presenting it as personal work.

What the author should be able to explain without notes.

## The core engine in two minutes

Petitio separates four pure functions from the UI:

1. `assessDeadline(request, asOf)` — turns a jurisdiction profile into statutory and effective due dates. GDPR windows are calendar months with the corresponding-date rule (31 Jan + 1 month = 28 Feb); the CCPA, VCDPA and CPA windows are 45 calendar days, PIPEDA's is 30. Status bands are derived from days remaining; closed requests get an on-time/late outcome. `extensionEligibility()` walks the same guard list as `requestExtension()` so the UI can explain a refusal before offering the form.
2. `transition(request, action, ctx, systems)` — a state machine whose guards live in one table, `GUARDS[action]`. `transition()` throws the first refusal as a `WorkflowError` with a stable code; `explainAction()`/`availableActions()` read the same table to produce "why blocked" text, and a property test proves the two agree.
3. `buildResponsePacket(request)` — reconciles per-system results: identity conflicts withhold whole systems, third-party fields are redacted, active holds exclude systems, `partial` is set when anything is withheld, and a proposed action per found system (disclose/export/erase/rectify/opt-out, retain, withhold) follows from the right being exercised.
4. `appendEntry / verifyChain` — SHA-256 hash chain over canonical JSON arrays so separators inside values cannot collide; exported as a `petitio.auditlog` envelope that can be re-imported and verified.

## One failure case to walk through

**Extension requested too late.** REQ-2026-0415 (EU-GDPR, received 15 Sep) has a statutory due date of 15 Oct. Recording an extension with a notice date of 1 Dec throws `EXTENSION_TOO_LATE`, because Art. 12(3) requires the controller to inform the data subject of the extension within one month of receipt. The refusal is shown in the UI and appended to the audit log as `extension (refused)`. The test `rejects a GDPR extension notified after the first month has ended` pins this. Since the October 2026 round the desk also catches a notice dated after the as-of date (`INVALID_EXTENSION_INPUT`), and once the as-of date itself is past the notice deadline the form is replaced by "Extension not available: …" — the refusal is explained before the click.

Bonus: the first property test run failed because `fc.date()` can emit an invalid `Date`; the fix (`noInvalidDate: true`) was a test fix, not an engine fix. Be ready to explain why that distinction matters.

## Why the tests look the way they do

- Engine tests were written first and run against stubs (52 failures) before implementation (52 passes). The 1 Oct RED/GREEN logs were never committed (`*.log` was git-ignored); from the October upgrade round on, verbatim gate output lives in `qa/logs/` and the per-package RED/GREEN record is in `EVIDENCE.md`.
- `daysBetween(addCalendarDays(d, n), d) === n` is a property test because date arithmetic bugs cluster at month and year boundaries that example tests miss. The upgrade round added two more properties: eligibility⇔refusal over every profile/date/stage/clock, and enabled⇔does-not-throw over the guard table — plus a model-based test that re-imports every intermediate request, which is how four engine gaps were found.
- Workflow tests assert error *codes*, not messages, so wording can change without breaking tests. The UI journey tests use the exact labels and status strings documented in `docs/workflows.md`, because those are the visible contract.
- `App.test.tsx` is integration coverage added after the UI; it exercises the explanations users see, not the engine internals. `src/test/journeys.test.tsx` and `a11y.test.tsx` extend that to every workflow, accessible names, live regions, focus and keyboard behaviour.

## Production next steps

- Replace the in-memory case file with a server-side store and real authentication/roles (analyst vs reviewer).
- Business-day calendars per jurisdiction; expose the existing `atRiskDays` option (engine-level since October 2026) as a user setting.
- Per-right exemption semantics instead of a single hold model.
- Anchor the audit chain in an append-only store or external timestamping.
- Connector adapters for real systems of record with their own identity reconciliation evidence.
- Legal review of profiles before anything is used operationally.

## Added in the October 2026 upgrade round — two more things to explain unaided

### The audit-append race, and why a queue fixes it

The first version appended audit entries from a React callback that closed over the current `log` array and
awaited a SHA-256 digest. Two actions dispatched before the first digest resolved both read the same array, both
computed `seq` 1, and the later state write overwrote the earlier one — an entry was lost without any error. The
queue in `src/state/auditQueue.ts` is a promise chain: each append runs on the latest log, strictly in push order,
so `seq` stays contiguous and `verifyChain` holds under rapid input. A failed append (for example when
`crypto.subtle` is unavailable outside a secure context) is counted and surfaced rather than swallowed. The tests
pin both halves: concurrent pushes yield `seq` 1 and 2, and a rejected digest leaves the chain valid and the failure
visible. Be ready to explain why "apply the transition, then await the audit" was the wrong order to leave
unguarded.

### The guard table

`transition()` and the "why is this blocked" explanation used to be two hand-written copies of the same rules. They
now read one table: `GUARDS[action]` is an ordered list of functions returning `{ code, message }` or nothing.
`transition()` throws the first refusal; `explainAction()` reports it. A fast-check property asserts that for random
requests and actions, "enabled" is exactly "does not throw" and the codes agree — so the README sentence "UI and
engine cannot disagree" is a tested invariant rather than a habit.

### One more failure case to walk through

**Extension on a closed request.** Before this round, `requestExtension` had no stage guard, so a closed request
could be extended. Now `extensionEligibility()` returns `EXTENSION_NOT_ALLOWED` for terminal stages (and
`EXTENSION_TOO_LATE` once the as-of date is past the notice deadline), and the UI shows "Extension not available: …"
instead of a form that the engine would refuse. The test `reports EXTENSION_NOT_ALLOWED for terminal stages, ahead
of the already-extended check` pins the order of the guards.
