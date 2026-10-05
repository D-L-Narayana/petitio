# Security policy

Petitio is an educational, browser-local prototype. It has no backend, no accounts and no
persistence, so the attack surface is small — but it does parse user-supplied files and it does
generate downloadable documents, and both are worth getting right. This page says what we consider
a vulnerability, how to report one and what the threat model is.

## Supported versions

Only the `main` branch is supported. There are no release branches; the public demo is built from
`main`. Fixes land on `main` and are not backported.

## Reporting a vulnerability

Please use **GitHub private vulnerability reporting**: open the repository's *Security* tab and
choose *Report a vulnerability*. That creates a private advisory thread with the maintainer.

- Do not open a public issue or pull request that contains exploit details.
- Include the steps or the input file that reproduces the problem (synthetic data only, please),
  the browser and version, and what you expected to happen.
- This is a personal project maintained on a best-effort basis; expect an acknowledgement, not an
  SLA. Credit is given in the fix's changelog entry if you want it.

There is no e-mail address or bug bounty for this project.

## What counts

Reports we want:

- anything that makes data leave the tab (a network request after the static assets have loaded)
  or persist beyond the tab (any use of storage APIs);
- script execution or markup injection through an imported case file, an imported audit log, or
  text that ends up in an exported HTML, Markdown, CSV or JSON document;
- an import that bypasses the documented bounds (byte size, request/system counts, nesting depth,
  string length) or hangs or crashes the tab within them;
- an export that carries redacted values without the reviewer explicitly revealing them;
- a way to make the audit chain verify as intact after an entry was altered, removed or reordered;
- a CSV cell that reaches a spreadsheet as a formula.

Out of scope: the deadline profiles and workflow rules as a *legal* matter (they are an
educational model, documented as such); anything that requires an attacker who already controls
the browser tab or device; the synthetic fixture being "personal data" (it is invented); and
security headers when the site is self-hosted without `vercel.json`.

## Threat model

**Assets.** The in-memory case file (synthetic fixture or the user's own import), the in-memory
audit log, and the files the user downloads.

**Trust boundary.** Everything runs inside one browser tab served as static files. There is no
server-side state, no authentication, no roles beyond labels in history entries. The untrusted
inputs are the files a user chooses to import — a case file (picker, paste or drag-and-drop) and an
exported audit log for verification. The sinks are the rendered DOM and user-initiated downloads.

| Threat | Mitigation | Residual |
|---|---|---|
| Oversized or hostile import exhausts memory or hangs the tab | Byte limit checked before `JSON.parse`; caps on requests, systems and arrays; iterative nesting-depth check; string-length cap; anchored, linear regular expressions | A file at the limit is still parsed in full; acceptable for a desk tool |
| Imported data smuggles unexpected properties into state | The validator copies only known keys into fresh objects, validates every enum and date, rejects duplicate ids, and applies cross-field integrity rules; the jurisdiction check uses a `Set` so inherited object names are not accepted | None known |
| Markup or script injection through fixture or imported text | React escapes all rendered strings; no `dangerouslySetInnerHTML`; generated HTML escapes every interpolation and contains no scripts or external references; CSP `script-src 'self'` | CSP allows `'unsafe-inline'` for styles because the dialog library sets inline style attributes |
| Formula injection through CSV export | Cells starting with `=`, `+`, `-`, `@`, tab or carriage return are prefixed with `'` | Spreadsheet behaviour varies; the guard follows common practice |
| Tampering with the audit log | SHA-256 hash chain; verification recomputes every hash and checks linkage and sequence; an imported log is verified without replacing the session log | Tamper-*evident* within a session, not tamper-*proof*: whoever controls the tab can rewrite the whole chain. Not a trusted timestamping service |
| Redacted values leaking in a response | Reconciliation withholds third-party fields and whole systems with an identity conflict; the documents the UI exports never include redacted values (the on-screen reveal is display-only); the engine's `reveal` option, which the UI does not expose, adds them only under a visible `REVIEWER COPY` banner | Relies on the `thirdParty` flag being set correctly upstream |
| Data leaving the device | No network or storage APIs (enforced by `scripts/check-invariants.mjs` in CI); the theme preference is in memory; exports are user-initiated downloads | None known |
| Clickjacking, MIME sniffing, referrer leakage | `frame-ancestors 'none'`, `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy: no-referrer`, HSTS, COOP/CORP | Headers apply only when hosted with `vercel.json` |

**Data flow.** Fixture or imported JSON → `parseCaseFile` (+ integrity checks) → in-memory session
state → pure engine functions → rendered views → user-initiated downloads (case file, audit log,
packet JSON/Markdown/HTML, docket CSV). No other sinks.

## Hardening in continuous integration

- `npm audit --audit-level=high` runs on every push and pull request; Dependabot proposes grouped
  minor/patch updates weekly and action updates monthly; the lockfile is committed.
- GitHub Actions are pinned to commit SHAs, the workflow token is read-only and checkout does not
  persist credentials (`scripts/validate-yaml.mjs` lints this).
- `scripts/check-invariants.mjs` fails the build on any network/storage API or on DOM access inside
  the pure engine; `scripts/check-tokens.mjs` and `scripts/check-bundle-size.mjs` guard
  presentation drift and bundle growth.

## Disclosure

Fixed vulnerabilities are described in `CHANGELOG.md` under *Security* once the fix is on `main`.
The self-review that informed this policy is in `AUDIT.md`; it is not an independent security
assessment.
