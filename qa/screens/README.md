# qa/screens — browser evidence

Three sets of screenshots live here, each produced by a Playwright + Chromium replay against the production
`dist/` bundle with a scripted end-to-end workflow.

| Prefix | Date | Harness | Notes |
|---|---|---|---|
| `desktop/tablet/mobile.png`, `flow-01…10` | 1 Oct 2026 | track-level `qa-harness/audit.mjs` (axe-core, not in this repo) | pre-upgrade reference set; summary in `browser-audit.json` / `browser-audit-summary.json` |
| `baseline-*` | 4 Oct 2026 | private replay, pre-upgrade bundle | 3 viewports (1440/768/375), 11-step journey; summary in `baseline-browser-check.json` |
| `upgrade-*` | 5 Oct 2026 | private replay, post-upgrade bundle | 4 viewports (1440/768/375 light + 1440 dark), 23-step journey incl. every new workflow; a representative subset of the step screenshots is committed; full summary in `upgrade-browser-check.json` |

The 4–5 Oct harness serves `dist/` to Chromium by request interception from an `https://` origin and attaches to
**every** response the exact security headers declared in `vercel.json` (Content-Security-Policy, HSTS,
X-Frame-Options, COOP/CORP, Referrer-Policy, Permissions-Policy, nosniff), with Playwright's CSP bypass off, so the
browser enforces the production CSP. It asserts the headers on index and asset responses, records
`securitypolicyviolation` events, blocks and records any request to another origin, and checks page/console
errors, horizontal overflow, accessible names on all controls, the number of live regions, and whether any
storage API was touched. Every workflow step is a hard assertion (no runtime "skipped" results); downloads
(case file, audit log, packet JSON/Markdown/HTML, docket CSV) are read back and checked, including that the
Markdown/HTML exports do not contain the redacted third-party value. It does not run axe-core (the 1 Oct set
does), and it exercises the built bundle under the declared headers rather than the live Vercel HTTP responses —
see EVIDENCE.md for what each run did and did not measure.
