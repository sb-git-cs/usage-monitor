# Team handoff

## Objective

Audit and fix defects, bugs and usage miscalculations; harden the Windows app and produce tested distributable builds.

## Assignments

| Owner | Assignment | Status | Evidence |
| --- | --- | --- | --- |
| Development | Compact two-row chips; CPU, memory, optional GPU, disk activity and storage | Complete; unit, source/packaged UI and live packaged hardware checks passed | `src/system.js`, `src/system-windows.ps1`, `src/ui/chips.js`, `test/system.test.js`, `scripts/ui-smoke.js` |
| Development | Keep the complete two-row strip inside the taskbar | Complete; rebuilt, restarted and verified on the live desktop | `src/main.js:203`, `test/windows.test.js`; taskbar 48px, chip window 44px, 2px inset on both sides vertically |
| Development | Review the two-row chips after syncing to 1.1.0; fix Windows memory sampling and GPU chip flicker; refresh screenshots and changelog; prepare 1.2.0 | Complete; see the merge section below and `docs/review.md` | `src/system.js`, `test/system.test.js`, `docs/screenshots/` |
| Development | Code audit, surgical fixes, regression tests and build verification; correct chip window selection | Implementation complete; release acceptance pending | `docs/review.md`, `test/`, `scripts/ui-smoke.js`; verification below |
| Maintainer | Live-account and interactive desktop acceptance; signed distribution | Pending | Checklist below |

## Verification

### Two-row chips merged with 1.1.0 (2026-09-29)

- The uncommitted chips work had been stashed while the tree synced to 1.1.0, then re-applied with conflicts in README.md, package.json, package-lock.json, `scripts/ui-smoke.js` and `src/main.js`. The resolutions are marker-free and keep both sides. Every line the stash added was checked against the resulting files before the stash was dropped.
- Fixed: Windows MEM started PowerShell every 2 seconds through `si.mem()` (now `os`), and a stalled hardware probe hid the GPU chip. Both have regression tests that fail on the old code. README and taskbar screenshots regenerated for the two-row strip; CHANGELOG has the 1.2.0 entry and the version is bumped.
- Verified: `npm test` 94 tests, 93 passed, 1 skipped (the updater suite's Windows skip), 0 failed; source `test:ui` passed. An unpacked build made after the merge ships `systeminformation`, `electron-updater`, `src/system.js` and `src/system-windows.ps1`, and its collector ran from app.asar with real readings (CPU 5.8%, MEM 36.1%, GPU 0%, DISK 1%, SPACE 78.4%). `dist/win-unpacked` is in use by the running app and was not touched, so it still holds the pre-merge build.
- Release build: `electron-builder --win --x64` into a scratch folder produced `UsageMonitor-Setup-1.2.0.exe` and its `.blockmap`, `UsageMonitor-portable-1.2.0.exe`, `Usage Monitor-1.2.0-win.zip` and a `latest.yml` for 1.2.0 whose checksum matches the installer. `npm audit --audit-level=high`: 0 vulnerabilities.
- CI (`Checks`) on the release branch: green on Windows, macOS and Linux, including the Windows packaged UI test and the macOS/Linux UI tests for the new strip. The first run failed once on Windows at `npm test` (the whole suite ran, about 5 seconds longer than a passing run) and the identical code passed on rerun. Not reproduced in 15+ local runs (Node 22.17 and 22.23.3, low concurrency, CPU load) and the log needs repository admin access, so the failing test is unidentified. If it recurs, take the test name from the Actions log; the updater suite's polling tests are the first suspects.
- Open decision: the Windows hardware sample costs about 450 ms CPU every 5 seconds (about 9% of one core). A persistent PowerShell worker would roughly halve that; see `docs/review.md`.
- Local setup: `node_modules` lacked `electron-updater` after the release sync. `npm install` added it and left both package files byte-identical. Run `npm ci` after pulling.

### Two-row chips and system metrics (2026-09-29)

- Follow-up alignment fix: docking now checks and applies the intended taskbar height before placing the window, and always centers the cross axis. The previous floating 50px height could prevent docking on a 48px taskbar. Restored the user's saved `chips_docked` setting to true.
- Alignment validation: 70 unit tests passed; source and packaged UI tests passed. Added regression coverage for floating-to-docked transitions, one-pixel height drift and recentering across 32/40/48/60px taskbars. The harness removes its signal listeners between cases.
- Rebuilt `dist/win-unpacked`, restarted the desktop app, and measured native bounds: taskbar `(0, 1032, 1920, 48)`, chip window `(1272, 1034, 369, 44)`. Fully contained with a 2px top/bottom inset and clear of occupied taskbar areas. Local evidence: `.qa/taskbar-before.png`, `.qa/taskbar-after.png`. Existing locked executable was preserved in `.qa/Usage Monitor-before-alignment.exe` before replacement.

- Provider chips use two rows and short percentages; network download/upload spans both rows. The full synthetic strip, including CPU/MEM/GPU/DISK/SPACE, measured about 369px wide at 48px high.
- CPU/MEM refresh every 2 seconds; GPU/disk activity every 5 seconds; storage every 30 seconds. Windows DISK is the busiest physical disk's active time; SPACE is the fullest mounted volume. Tooltips list drive values. Failed readings become unknown; absent GPUs are hidden.
- Before the merge: `npm test` 69 passed; source and packaged `test:ui` passed, including 28/36/48/60px taskbar heights, floating two-row layout, absent GPU and unavailable samples, CSP and pointer hit-testing.
- `npm exec electron-builder -- --win --x64 --dir --publish never` passed. Updated app: `dist/win-unpacked/Usage Monitor.exe`. Installer/ZIP/portable artifacts were not regenerated for this change.
- Live packaged collector verified on Windows outside the sandbox (CIM access is denied inside it): CPU 11.4%, memory 49.5%, GPU detected at 0%, busiest disk 31%, fullest volume 78.3%. This exercised the script read from app.asar and the production dependency.
- `git diff --check` and changed JavaScript syntax checks passed. macOS/Linux hardware behavior has not been exercised locally; their disk activity uses throughput and GPU percentages depend on driver support. Interactive desktop docking still needs manual acceptance.
- Existing package-lock engine-version edit was preserved.

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

- `dist/UsageMonitor-Setup-1.2.0.exe`
- `dist/UsageMonitor-portable-1.2.0.exe`
- `dist/Usage Monitor-1.2.0-win.zip`
- `dist/win-unpacked/Usage Monitor.exe`

The build is unsigned: Authenticode inspection reported `NotSigned`. The builder's signing log does not establish that a signing certificate was used. 1.1.0 is published (tag `v1.1.0`). 1.2.0 is prepared (version, changelog, docs) but not tagged or published: run the Release workflow from `main` with "publish" ticked, or push tag `v1.2.0`. It is the first release the 1.1.0 updater can deliver.

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
