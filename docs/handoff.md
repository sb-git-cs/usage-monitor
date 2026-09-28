# Team handoff

## Objective

Audit and fix defects, bugs and usage miscalculations; harden the Windows app and produce tested distributable builds.

## Assignments

| Owner | Assignment | Status | Evidence |
| --- | --- | --- | --- |
| Development | Code audit, surgical fixes, regression tests and build verification; correct chip window selection | Implementation complete; release acceptance pending | `docs/review.md`, `test/`, `scripts/ui-smoke.js`; verification below |
| Maintainer | Live-account and interactive desktop acceptance; signed distribution | Pending | Checklist below |

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

## Network usage monitor (2026-09-26)

Per-app network monitoring was added to the app (window, engine, SQLite records, caps, blocking, connection logs), together with cross-platform fixes (config/data folders, login items, tray menu on Linux, taskbar features limited to Windows, Claude Keychain login on macOS).

Verified on Windows 11 (this machine):

- `npm test`: 65 tests passed (34 existing plus 31 new for the parsers, records store, engine, live summary, settings, helper protocol and taskbar ownership).
- `npm run test:ui` and `npm run test:ui -- --packaged`: flyout, chips and the network window render under CSP with escaping, sorting, chart, pause and focus checks.
- `npx electron-builder --win --x64 --dir`: the build ships `resources/net-helper` (helper source and setup script).
- Live helper run: installed through the one-time UAC prompt, captured per-app traffic including a 10 MB curl download attributed to curl, captured DNS answers, and blocked then unblocked a copy of curl through Windows Firewall (no rules left behind). The packaged app connected to the installed helper with matching versions.

Not run locally (no macOS or Linux machine was available): the macOS `nettop` and Linux `ss` providers are covered by unit tests against real-format output, and CI now runs a live capture probe (`scripts/probe-capture.js`), the UI test and an unpacked build on macOS and Linux runners. Those CI jobs have not run yet; push to trigger them.

Chips and flyout: the chips strip shows live network speed and, docked on the Windows taskbar, fills its height (2px inset) and is owned by the taskbar window so it stays visible while the Start menu or Quick Settings is open (verified live; ownership is re-applied by the periodic taskbar probe and the strip is recreated if Windows destroys it, e.g. on an Explorer restart, which was not exercised). The flyout shows a network card and rests flush on the taskbar top. `docs/screenshots` are regenerated with `npm run screenshots`.

Acceptance still needed for this feature: the CI matrix passing on macOS and Linux; a manual look at the network window on macOS and a Linux desktop (tray menu, icons, login item); and signed macOS/Windows builds for public release.

## Working tree notes

The working tree already contained edits to README.md, src/main.js, src/ui/clickaway.html and src/ui/shared.css. Those edits were retained. The flyout pointer-events regression in the edited CSS was fixed after reproducing it in Electron. Generated screenshots and test profiles are in ignored `.qa/`; local npm cache and dist outputs are also ignored.

Windows CI now runs unit tests, source and packaged UI tests, a dependency audit, and an unpacked build. Source development requires Node 22.13 or newer; packaged users do not need Node.

## Audit and automatic updates (2026-09-28)

The audit in [`audit-2026-09-28.md`](audit-2026-09-28.md) lists 17 findings with their fixes. The main change is automatic updating (`src/updater.js`): git clones fast-forward and restart (dependency reinstalls run after exit through `scripts/post-update.js`), the Windows installer and the Linux AppImage install GitHub releases through electron-updater, and the portable, zip, tar.gz and macOS builds notify with a download link. Releases must keep `latest*.yml` and `*.blockmap` attached.

Verified on Linux (this session): 87 unit tests including real-git update scenarios and a real run of `post-update.js`; the UI smoke test with the new flyout footer; an AppImage build that produces `latest-linux.yml`, `resources/app-update.yml` and packs electron-updater; and an end-to-end run of the real app from a git checkout one commit behind a local origin, which merged the commit on its own and restarted.

Acceptance still needed: a real Windows installer upgrade from 1.1.0 to the next release (silent NSIS install into the same folder, restart, Startup shortcut still valid), a real AppImage upgrade on a Linux desktop, and the notification-only path on macOS and the portable build. The first release that can deliver an update is the one after 1.1.0.
