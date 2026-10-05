# qa/logs — verbatim gate output

Each file is the unedited terminal output of one gate command, captured by a small runner that records the
command, working directory, Node version, start/finish time and exit code. Absolute sandbox paths are replaced
with `.` (repository root) or `<private-qa-harness>` so the logs are portable; nothing else is altered.

| File | Command | Purpose |
|---|---|---|
| `baseline-npm-ci.log` | `npm ci --ignore-scripts --no-fund --no-audit` | reproducible install of the committed lockfile before any change |
| `baseline-typecheck.log` | `npm run typecheck` | `tsc -b` on the pre-upgrade tree |
| `baseline-test.log` | `npm test` | Vitest on the pre-upgrade tree (68 tests, 5 files) |
| `baseline-build.log` | `npm run build` | production bundle sizes before the upgrade |
| `baseline-audit.log` | `npm audit --audit-level=high` | dependency vulnerability check on the committed lockfile |
| `baseline-browser-check.log` | Playwright workflow replay against the pre-upgrade `dist/` | 11-step journey at 1440/768/375 with the production headers enforced (see EVIDENCE.md) |
| `upgrade-typecheck.log` | `npm run typecheck` | `tsc -b` on the integrated tree |
| `upgrade-test.log` | `npm test` | Vitest on the integrated tree (505 tests, 28 files) |
| `upgrade-build.log` | `npm run build` | production bundle sizes after the upgrade |
| `upgrade-audit.log` | `npm audit --audit-level=high` | dependency check (lockfile unchanged) |
| `upgrade-check-invariants.log` | `node scripts/check-invariants.mjs` | no network/storage APIs; engine and session store free of React/DOM |
| `upgrade-check-tokens.log` | `node scripts/check-tokens.mjs` | no literal colours outside `src/theme/tokens.css`; no inline styles outside the ribbon |
| `upgrade-check-bundle.log` | `node scripts/check-bundle-size.mjs` | built sizes within `scripts/budgets.json` |
| `upgrade-check-yaml.log` | `node scripts/validate-yaml.mjs` | GitHub workflow and Dependabot policy lint |
| `upgrade-browser-check.log` | Playwright workflow replay against the integrated `dist/` | 23-step journey at four viewports incl. dark scheme, production headers enforced |
| `upgrade-verify.log` | `npm run verify` | the CI sequence in one command (typecheck → test → build → the four gates), run last on the final tree |

The browser replay harness itself is not part of this repository (it needs a Playwright install); its JSON
summaries and screenshots are kept under `qa/screens/`.
