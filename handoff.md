# Team handoff

## Objective

Audit and fix defects, bugs and usage miscalculations; harden the Windows app and produce tested distributable builds. The supplied global instructions define Fable as orchestrator and Codex as reviewer/implementer. No project AGENTS.md or prior handoff.md existed at the start of this task.

## Assignments

| Engineer | Assignment | Status | Evidence |
| --- | --- | --- | --- |
| Codex | Code audit, surgical fixes, regression tests and build verification; correct chip window selection | Implementation complete; release acceptance pending | `review.md`, `test/`, `scripts/ui-smoke.js`; verification below |
| Owner / Fable | Live-account and interactive desktop acceptance; signed distribution | Pending | Checklist below |

## Verification

- `npm test`: 30 tests passed, no failures. Tests use synthetic credentials and provider responses, including five-hour versus weekly chip selection.
- `npm run test:ui`: both real Electron offscreen render tests passed, including CSP, escaped hostile text, warning thresholds, preload isolation and pointer hit-testing.
- `npm run test:ui -- --packaged`: both render tests passed using the HTML/scripts/preload from the rebuilt app.asar, including five-hour chip selection.
- Final online `npm audit --json --cache .npm-cache`: zero vulnerabilities with Electron 44.4.5.
- Final `npm run dist`: completed successfully for installer, portable executable and ZIP.
- `node --check`: all 29 JavaScript files checked successfully.
- Packaged models, CSS, main process and Grok adapter bytes match the current source.
- `git diff --check`: passed. Git reports line-ending normalization warnings only.
- Windows native taskbar probe ran successfully but returned `tray: null` in this test session. Desktop docking is not claimed as manually verified.

## Builds

`npm run dist` produces:

- `dist/UsageMonitor-Setup-1.0.0.exe`
- `dist/UsageMonitor-portable-1.0.0.exe`
- `dist/Usage Monitor-1.0.0-win.zip`
- `dist/win-unpacked/Usage Monitor.exe`

The build is unsigned: Authenticode inspection reported `NotSigned`. The builder's signing log does not establish that a signing certificate was used. No release was published. The chip selection correction is being committed and pushed to `origin/main`; local build artifacts were rebuilt with the correction.

## Release acceptance still needed

1. Compare all installed providers against their official usage screens, including an expired token and a quota reset. Automated tests did not access real CLI logins.
2. On an interactive Windows desktop, check tray/flyout clicks, hiding chips, drag/dock behavior, display scaling, secondary monitors, and Explorer restart.
3. Verify source, installed and portable startup at Windows sign-in. The portable shortcut now points at the original executable, not its temporary extraction directory.
4. Supply the owner's signing certificate for signed public distribution, then verify the resulting signature and clean-machine install/uninstall.

## Working tree notes

The working tree already contained edits to README.md, src/main.js, src/ui/clickaway.html and src/ui/shared.css. Those edits were retained. The flyout pointer-events regression in the edited CSS was fixed after reproducing it in Electron. Generated screenshots and test profiles are in ignored `.qa/`; local npm cache and dist outputs are also ignored.

Windows CI now runs unit tests, source and packaged UI tests, a dependency audit, and an unpacked build. Source development requires Node 22.12 or newer; packaged users do not need Node.
