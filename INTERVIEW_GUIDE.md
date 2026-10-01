# INTERVIEW_GUIDE.md — Petitio

Rehearsal material. This project was built with substantial AI assistance and has not been independently reviewed by the candidate; study and be able to explain the following unaided before presenting it as personal work.

What the author should be able to explain without notes.

## The core engine in two minutes

Petitio separates four pure functions from the UI:

1. `assessDeadline(request, asOf)` — turns a jurisdiction profile into statutory and effective due dates. GDPR windows are calendar months with the corresponding-date rule (31 Jan + 1 month = 28 Feb); CCPA windows are 45 calendar days. Status bands are derived from days remaining.
2. `transition(request, action, ctx, systems)` — a state machine with guards. Each guard throws a `WorkflowError` with a stable code; `availableActions()` runs the same guards to produce "why blocked" text, so UI and engine can never disagree.
3. `buildResponsePacket(request)` — reconciles per-system results: identity conflicts withhold whole systems, third-party fields are redacted, active holds exclude systems, and `partial` is set when anything is withheld.
4. `appendEntry / verifyChain` — SHA-256 hash chain over canonical JSON arrays so separators inside values cannot collide.

## One failure case to walk through

**Extension requested too late.** REQ-2026-0415 (EU-GDPR, received 15 Sep) has a statutory due date of 15 Oct. Recording an extension with a notice date of 1 Dec throws `EXTENSION_TOO_LATE`, because Art. 12(3) requires the controller to inform the data subject of the extension within one month of receipt. The refusal is shown in the UI and appended to the audit log as `extension (refused)`. The test `rejects a GDPR extension notified after the first month has ended` pins this.

Bonus: the first property test run failed because `fc.date()` can emit an invalid `Date`; the fix (`noInvalidDate: true`) was a test fix, not an engine fix. Be ready to explain why that distinction matters.

## Why the tests look the way they do

- Engine tests were written first and run against stubs (52 failures, see `qa/tdd-red-engine.log`) before implementation (52 passes).
- `daysBetween(addCalendarDays(d, n), d) === n` is a property test because date arithmetic bugs cluster at month and year boundaries that example tests miss.
- Workflow tests assert error *codes*, not messages, so wording can change without breaking tests.
- `App.test.tsx` is integration coverage added after the UI; it exercises the explanations users see, not the engine internals.

## Production next steps

- Replace the in-memory case file with a server-side store and real authentication/roles (analyst vs reviewer).
- Business-day calendars per jurisdiction and configurable at-risk thresholds.
- Per-right exemption semantics instead of a single hold model.
- Anchor the audit chain in an append-only store or external timestamping.
- Connector adapters for real systems of record with their own identity reconciliation evidence.
- Legal review of profiles before anything is used operationally.
