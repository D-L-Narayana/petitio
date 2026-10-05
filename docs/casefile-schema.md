# `petitio.casefile` v1 — file format, limits and integrity rules

This document describes the JSON case file that Petitio imports and exports, the cross-field integrity
rules applied on import, the audit-log export envelope, and the versioning policy. The authoritative
implementation is `src/engine/casefile.ts` (field validation), `src/engine/integrity.ts` (cross-field
rules) and `src/engine/audit.ts` (audit-log envelope). Everything here is an educational model with
synthetic data; it is not legal advice and the statutory figures it refers to live, with their citations,
in the jurisdiction profiles in `src/engine/deadline.ts`.

Conventions: `YYYY-MM-DD` means a real calendar date (`2026-02-30` is rejected); "timestamp" means an
ISO-8601 instant such as `2026-09-08T08:30:00Z` (seconds and milliseconds optional; `Z` or a `±HH:MM`
offset required). Required fields are marked **req**. Every string is limited to 4,000 characters.

## 1. Import limits (checked before anything else)

| Limit | Default | Error when exceeded |
|---|---|---|
| File size | 1,000,000 bytes | `File is N bytes; the limit is 1,000,000 bytes.` (checked before `JSON.parse`) |
| Requests | 500 | `casefile.requests has N items; the limit is 500.` |
| Systems | 50 | `casefile.systems has N items; the limit is 50` |
| Nesting depth | 8 object/array levels | `Object nesting deeper than 8 levels is not accepted.` (iterative check; no recursion) |
| String length | 4,000 characters | `<path> exceeds 4000 characters` |

Per-request array limits: `holds` 50, `systemResults` 50, `history` 200, `notes` 100, `systemResults[].fields` 100,
`systemResults[].matchedBy` 3. At most 50 errors are reported per import. The parser never throws: malformed
input yields `{ ok: false, errors: string[] }`.

## 2. Top level

```json
{
  "schema": "petitio.casefile",
  "version": 1,
  "asOf": "2026-10-01",
  "systems": [ { "id": "crm", "name": "Northwind CRM (synthetic)", "description": "Customer profiles and agent notes." } ],
  "requests": [ ]
}
```

| Field | Type | Rule |
|---|---|---|
| `schema` **req** | string | must be exactly `petitio.casefile` |
| `version` **req** | integer | must be `1` |
| `asOf` **req** | `YYYY-MM-DD` | the date the demo clock is set to; every deadline is computed relative to it |
| `systems` **req** | array of System | at least one system; at most 50 |
| `requests` **req** | array of Request | at most 500; request ids must be unique (`Duplicate request id "…"`) |

Unknown keys at any level are dropped on import rather than carried into application state.

### System

| Field | Type | Rule |
|---|---|---|
| `id` **req** | string | non-empty; referenced by holds and results |
| `name` **req** | string | non-empty |
| `description` | string | may be empty; defaults to `""` |

## 3. Request

```json
{
  "id": "REQ-2026-0501",
  "receivedOn": "2026-09-20",
  "jurisdiction": "EU-GDPR",
  "type": "access",
  "requester": { "pseudonym": "wren-3140", "email": "wren.3140@people.example", "accountId": "ACC-31400", "ageBand": "adult" },
  "stage": "collecting",
  "identity": { "method": "account-login", "attempts": 1, "maxAttempts": 3, "status": "passed" },
  "holds": [],
  "systemResults": [],
  "history": [
    { "at": "2026-09-20T09:00:00Z", "from": "received", "to": "identity-check", "action": "start-identity-check", "actor": "analyst.example" },
    { "at": "2026-09-21T09:00:00Z", "from": "identity-check", "to": "verified", "action": "identity-passed", "actor": "analyst.example", "note": "Signed-in session matched" },
    { "at": "2026-09-22T09:00:00Z", "from": "verified", "to": "collecting", "action": "begin-collection", "actor": "analyst.example" }
  ],
  "notes": ["Synthetic example request."]
}
```

| Field | Type | Rule |
|---|---|---|
| `id` **req** | string | non-empty; unique within the file |
| `receivedOn` **req** | `YYYY-MM-DD` | start of the statutory clock |
| `jurisdiction` **req** | enum | any profile id in `PROFILES` (`src/engine/deadline.ts`); the accepted set is derived from the profiles, so a new profile is accepted without changes to the importer. Profile ids at the time of writing: `EU-GDPR`, `UK-GDPR`, `US-CA-CCPA`, `US-VA-VCDPA`, `US-CO-CPA`, `CA-PIPEDA` (each profile carries its statutory citation; all are educational models, not legal advice) |
| `type` **req** | enum | `access` · `erasure` · `rectification` · `portability` · `opt-out-sale` |
| `requester` **req** | Requester | see below |
| `stage` **req** | enum | `received` · `identity-check` · `verified` · `collecting` · `review` · `response-ready` · `closed` · `rejected` |
| `identity` **req** | IdentityCheck | see below |
| `extension` | Extension | see below |
| `holds` | array of Hold | defaults to `[]` |
| `systemResults` | array of SystemResult | defaults to `[]` |
| `history` | array of Transition | defaults to `[]` |
| `rejectReason` | enum | `duplicate` · `manifestly-unfounded` · `identity-unverified` · `out-of-scope`; only valid when `stage` is `rejected` (integrity rule) |
| `closedOn` | `YYYY-MM-DD` | only valid when `stage` is `closed` (integrity rule) |
| `notes` | array of string | defaults to `[]`; each note longer than 2,000 characters is truncated to 2,000 and reported as a warning |

### Requester

| Field | Type | Rule |
|---|---|---|
| `pseudonym` **req** | string | non-empty; stable pseudonym used for duplicate detection, never a real identity |
| `email` **req** | string | non-empty; synthetic `*.example` address |
| `accountId` | string | optional |
| `ageBand` | enum | `adult` · `minor` · `unknown` |

### IdentityCheck

| Field | Type | Rule |
|---|---|---|
| `method` **req** | enum | `account-login` · `email-loop` · `document-upload` · `none` |
| `attempts` **req** | integer | 0 … 20 |
| `maxAttempts` **req** | integer | 1 … 20 |
| `status` **req** | enum | `not-started` · `pending` · `passed` · `failed` |

### Extension (optional)

| Field | Type | Rule |
|---|---|---|
| `days` **req** | integer | 1 … 366, and not more than the profile maximum for the receipt date |
| `reason` **req** | string | must not be blank |
| `notifiedOn` **req** | `YYYY-MM-DD` | not before `receivedOn`; for profiles that require notice inside the initial window, not after the statutory due date |

An imported extension is held to the same guards as `requestExtension()` in the engine, so a file cannot carry an
extension the desk would refuse. The maxima and notice rules come from the jurisdiction profiles (teaching model, not legal advice).

### Hold

| Field | Type | Rule |
|---|---|---|
| `id` **req** | string | non-empty; unique within the request (integrity rule) |
| `systemId` **req** | string | must be one of `systems[].id` (integrity rule) |
| `reason` **req** | enum | `legal-hold` · `ongoing-transaction` · `fraud-prevention` · `legal-obligation-retention` · `third-party-rights` |
| `note` **req** | string | may be empty; an empty note blocks `prepare-response` in the workflow |
| `appliedAt` **req** | string | timestamp by convention (not format-checked) |
| `releasedAt` | string | present once the hold is released; an absent value means the hold is active |

### SystemResult

| Field | Type | Rule |
|---|---|---|
| `systemId` **req** | string | a result for a system not listed in `systems` is accepted with a warning |
| `found` **req** | boolean | |
| `recordId` | string | |
| `matchedBy` | array | up to 3 of `email` · `accountId` · `pseudonym` |
| `fields` | array of FieldRecord | up to 100 |
| `subjectEmail` | string | the system's own copy of the subject's email; a mismatch marks an identity conflict in the packet |
| `lookedUpAt` **req** | string | timestamp by convention (not format-checked) |

FieldRecord: `name` **req** (non-empty string), `value` **req** (string, may be empty), `thirdParty` (boolean; marks a value belonging to someone other than the requester).

### Transition (history entry)

| Field | Type | Rule |
|---|---|---|
| `at` **req** | timestamp | format-checked |
| `from` **req** | Stage enum | |
| `to` **req** | Stage enum | the last entry's `to` must equal the request `stage` (integrity rule) |
| `action` **req** | enum | `start-identity-check` · `identity-passed` · `identity-failed` · `begin-collection` · `record-system-result` · `send-to-review` · `apply-hold` · `release-hold` · `prepare-response` · `close` · `reject` |
| `actor` **req** | string | non-empty label; no authentication is implied |
| `note` | string | optional |

## 4. Integrity rules (cross-field, run only after every field is individually valid)

`checkIntegrity(file)` returns `{ level, path, message }` issues. Paths use the importer's convention, for example
`casefile.requests[3].closedOn`; messages start with the request id. In `parseCaseFile`, each **error** is reported as
`<message> (<path>)` and rejects the file; each **warning** is returned with the parsed file and shown to the analyst.
The rules never run on malformed input and never throw.

### Errors (the file is rejected)

| # | Rule | Path reported |
|---|---|---|
| E1 | `closedOn` is present if and only if `stage` is `closed` | `…closedOn` |
| E2 | `rejectReason` is present if and only if `stage` is `rejected` | `…rejectReason` |
| E3 | if `history` is non-empty, `history[last].to` equals `stage` | `…history[last].to` |
| E4 | `identity.attempts` ≤ `identity.maxAttempts` | `…identity.attempts` |
| E5 | `stage` in {`collecting`, `review`, `response-ready`, `closed`} requires `identity.status` = `passed` | `…identity.status` |
| E6 | every `holds[].systemId` is one of `systems[].id` | `…holds[i].systemId` |
| E7 | hold ids are unique within a request | `…holds[i].id` |

### Warnings (the file imports; the analyst is told)

| # | Rule | Path reported |
|---|---|---|
| W1 | a system result refers to a system not listed in `systems` — message `<id>: result for unknown system "<systemId>"` | `…systemResults[k].systemId` |
| W2 | `receivedOn` is after `asOf` | `…receivedOn` |
| W3 | `history[].at` is not non-decreasing (equal timestamps are fine) | `…history[j].at` |
| W4 | two active (unreleased) holds on the same system | `…holds[i].systemId` (the second hold) |
| W5 | `closedOn` is before `receivedOn` | `…closedOn` |
| W6 | a note longer than 2,000 characters was truncated (emitted by the importer while reading `notes`, not by `checkIntegrity`) | `…notes[i]` |

The bundled demo fixture (`src/fixtures/demo-casefile.json`) produces no errors and no warnings and round-trips through
`serializeCaseFile` → `parseCaseFile` unchanged.

## 5. Audit-log export (`petitio.auditlog` v1)

"Export JSON" in the audit dialog writes:

```json
{
  "schema": "petitio.auditlog",
  "version": 1,
  "exportedAt": "2026-10-04T12:00:00Z",
  "entries": [
    { "seq": 1, "at": "2026-10-04T11:58:00.000Z", "actor": "analyst.demo", "requestId": "REQ-2026-0501", "action": "start-identity-check", "detail": "received → identity-check", "prevHash": "GENESIS", "hash": "<64 lower-case hex characters>" },
    { "seq": 2, "at": "2026-10-04T11:59:00.000Z", "actor": "analyst.demo", "requestId": "REQ-2026-0501", "action": "identity-passed", "detail": "identity-check → verified", "prevHash": "<hash of entry 1>", "hash": "<64 lower-case hex characters>" }
  ]
}
```

(The hash values above are placeholders; real exports carry SHA-256 digests.)

| Field | Rule |
|---|---|
| `schema` | exactly `petitio.auditlog` |
| `version` | exactly `1` |
| `exportedAt` | string (ISO timestamp by convention) |
| `entries[].seq` | integer ≥ 1, contiguous from 1 in file order |
| `entries[].at`, `actor`, `requestId`, `action`, `detail` | strings |
| `entries[].prevHash` | `GENESIS` for the first entry, otherwise 64 lower-case hex characters |
| `entries[].hash` | 64 lower-case hex characters: `SHA-256(JSON.stringify([seq, at, actor, requestId, action, detail, prevHash]))` |

`parseAuditLog(text, { maxBytes = 2,000,000, maxEntries = 10,000 })` accepts the envelope (`legacy: false`) and, for files
written before the envelope existed, a bare array of entries (`legacy: true`). It checks size before parsing, validates every
field type, copies only the known fields and never throws; it is a shape check only. "Verify an exported log" in the audit
dialog then runs `verifyChain` on the imported entries and reports `Imported log: N entries, chain intact.`,
`Imported log: chain broken at entry K.` or `Import rejected: <first error>`. The session log is never replaced by an import.

## 6. Versioning policy

- **v1 is additive.** New optional fields and new enum members (for example a new jurisdiction profile) may be added
  without changing `version`. Required fields are never added to v1, and existing enum values keep their meaning.
- **Unknown keys are dropped.** A v1 reader copies only the fields it knows, so a file written by a newer v1 build imports
  into an older one (minus the fields the older build does not know), and a hand-edited file cannot smuggle data into
  application state.
- **A v1 file that imports today keeps importing** unless it violates an integrity rule in §4; the integrity rules describe
  states the engine itself can never produce.
- **`version: 2` is reserved** for a change that breaks one of the promises above. v1 readers reject it
  (`casefile.version must be an integer between 1 and 1`) rather than guessing.
- The audit-log envelope follows the same policy: `petitio.auditlog` v1 is additive, unknown keys are dropped, bare-array
  exports remain readable as legacy input, and version 2 is reserved.
