# Production hardening review

Reviewed 2026-09-23. Severity reflects the original defect; every finding below is fixed. Existing uncommitted changes were preserved, with the noninteractive flyout CSS corrected as part of this review.

## Blocker - fixed

- **Updater recursion prevented all source update checks.** Separated the subprocess helper from the update entry point. Update checks ignore locally ahead copies, reject diverged histories, refuse dirty updates, use npm ci, and coalesce concurrent update requests. Evidence: `src/updater.js:18`.

- **Grok refresh overwrote the wrong account.** The token write now targets the selected newest account, checks that its original key still matches, and avoids reusing a refresh token twice in the same poll. Evidence: `src/adapters/grok.js:158`, `src/adapters/grok.js:167`.

- **Provider strings were interpolated as HTML.** Escaped provider names, plans, labels, hints, IDs and reset attributes. Denied navigation, new windows and webviews. Validated numeric resize/drag arguments and allowed only known usage-page IDs. Evidence: `src/ui/format.js:9`, `src/ui/flyout.js:36`, `src/main.js:818`.

- **Bundled Electron had known high-severity advisories.** Pinned Electron 44.4.5 and regenerated the lockfile. The online npm audit after installation reported zero vulnerabilities; source builds now require Node 22.12 or newer. Evidence: `package.json:29`.

- **Flyout looked functional but could not receive clicks.** Restored pointer events on the flyout. The real Electron hit-test failed before the fix and passed afterwards. Evidence: `src/ui/shared.css:30`.

## Should-fix - fixed

- **Local reset logic fabricated zero usage and future reset dates.** Expired readings become unknown/stale until confirmed by the API. Main and renderer use one shared implementation; invalid and epoch-zero dates no longer break reset handling. Evidence: `src/models.js:63`, `src/ui/format.js:5`.

- **Malformed values produced false percentages and invalid reset dates.** Rejects blanks, booleans, objects and nonfinite percentages; keeps missing usage unknown, bounds remaining allowance, preserves reported overage, and tolerates malformed reset timestamps. Evidence: `src/models.js:10`, `src/adapters/codex.js:32`, `src/adapters/claude.js:85`.

- **Weekly usage replaced the current short window in chips.** Chips now prefer a valid five-hour reading, then daily, and use other quotas when neither is available. The tooltip identifies the selected window. Cached readings retain a dashed border and stale tooltip. Evidence: `src/models.js:46`, `src/ui/chips.js:28`.

- **Alert colors, model identities and notifications disagreed.** Warnings include exactly 80%, model labels participate in notification identity, stale/expired readings do not notify, and a first observation at 100% produces one limit toast. Evidence: `src/ui/format.js:44`, `src/alerts.js:11`, `src/alerts.js:44`.

- **Meter widths and header layout were blocked by CSP.** Sets validated widths through DOM style properties and moves static inline styles into CSS. Scoped/daily model labels remain visible and long labels are truncated with a full tooltip. Evidence: `src/ui/flyout.js:64`, `src/ui/shared.css:83`.

- **Gemini mixed provider pools and inferred unsupported periods.** Selects all explicitly named Gemini groups, retains IDs from keyed model responses, removes fallback to other providers, preserves group/model labels, and leaves unspecified model periods as quota. Numeric-string expiry times are handled correctly. Evidence: `src/adapters/gemini.js:232`, `src/adapters/gemini.js:288`, `src/adapters/gemini.js:78`.

- **Quota labels and authentication error handling were incorrect.** Codex daily windows have the correct kind and API-key logins are recognized; scoped names are retained. Grok monthly billing is labeled Monthly. Claude keeps the post-refresh HTTP result, so 429 backs off and 401/403 indicates sign-in is needed. Evidence: `src/adapters/codex.js:25`, `src/adapters/codex.js:133`, `src/adapters/grok.js:91`, `src/adapters/claude.js:189`.

- **Timeouts launched overlapping token refresh operations.** Coalesces concurrent polls, retains timed-out adapter promises until their result is consumed, and removes watchdog reentry. Empty rate-limited results remain failures instead of being mislabeled stale usage. Gemini stops at 429 and tries the alternate host after transport failure. Evidence: `src/poller.js:10`, `src/poller.js:98`.

- **Corrupt caches/config or disk-write failures interrupted usage updates.** Validates cache structure and numbers, normalizes config flags/coordinates/intervals, isolates nested defaults, recovers invalid alert state, and keeps readings usable when cache/config persistence fails. Startup cache is marked stale. Evidence: `src/cache.js:20`, `src/config.js:43`, `src/poller.js:94`.

- **HTTP responses could consume unbounded memory or hang after truncation.** Caps response bodies at 2 MiB, rejects aborted responses promptly, validates protocols, and clears request deadlines after synchronous failures. Evidence: `src/http.js:6`, `src/http.js:66`.

- **Taskbar placement mixed physical pixels and DIP.** Makes the native probe DPI-aware and converts its rectangles using Electron screenToDipRect. Detects taskbar edges relative to their display, rejects partially off-taskbar placements, and pops out when strip thickness cannot fit. Evidence: `scripts/taskbar-layout.ps1:21`, `src/taskbarLayout.js:62`, `src/taskbarLayout.js:82`.

- **Opening other UI surfaces resurrected hidden chips.** The shared always-on-top helper now respects the hidden setting. Pending position saves are flushed on quit. Evidence: `src/main.js:219`.

- **Portable autostart referenced the temporary extraction directory.** Uses the durable portable executable path, reports the actual shortcut state, and handles detached-launch errors. Evidence: `src/autostart.js:38`, `scripts/start.js:27`.

- **Credential reader executed a predictable temporary script.** Runs the static PowerShell reader as an encoded command, avoiding a shared temporary script file. Evidence: `src/wincred.js:56`.

## Nit

No style-only findings.

## Verification and release limits

- 29 Node regression tests cover the affected behavior, with synthetic credentials and transport responses.
- Real Electron offscreen tests verify both widgets, CSP, HTML escaping, warning colors, preload isolation, rendering and pointer hit targets. Screenshots: `.qa/flyout.png`, `.qa/chips.png`.
- Windows installer, portable and ZIP builds are generated by `npm run dist`; final build/check results are recorded in `docs/handoff.md`.
- The test session returned no Explorer taskbar. DPI geometry is covered by tests, but real taskbar docking, multi-monitor interaction and sign-in startup need desktop acceptance.
- Live provider quota comparisons and token rotation against real accounts were not exercised. No real CLI credentials were used by the tests.
- Authenticode inspection reports NotSigned. Public signed distribution requires the owner's signing certificate; this review does not claim a signed release.

DPI conversion follows [Electron screen documentation](https://www.electronjs.org/docs/latest/api/screen#screenscreentodiprectwindow-rect-windows).

## Two-row chips and system metrics review (2026-09-29)

No outstanding blockers or should-fix findings in this change. Fixed during verification:

- **Should-fix — packaged hardware script execution:** PowerShell cannot execute a file inside app.asar. Electron now reads the bundled script and passes it as a fixed command argument. Verified with live readings from the packaged collector. `src/system.js:41`.
- **Should-fix — short taskbar overflow:** Two rows overflowed a 28px strip. Reduced short-strip padding and line heights; real Electron layout tests now pass at 28, 36, 48 and 60px. `src/ui/shared.css:331`.

Validation and platform limitations are recorded in `docs/handoff.md`.

## Taskbar alignment follow-up (2026-09-29)

- **Should-fix — fixed:** Docking tested the floating window's 50px height before applying a 44px taskbar fill, causing a two-row strip to reject a 48px taskbar. The placement path also skipped recentering for windows that merely fit within the taskbar. It now resizes to the intended docked height first and snaps both axes. `src/main.js:203`.
- **Should-fix — fixed:** The shared resize helper ignored a one-pixel size difference, which could leave unequal taskbar insets. Exact size matches are now the only no-op. `src/main.js:57`.

The user's saved docking preference was off; it was restored to true as requested. Native window bounds and a desktop capture verified full taskbar containment after restart. No outstanding findings for this fix.

## Two-row chips merged with 1.1.0 (2026-09-29)

The uncommitted chips work was stashed, the tree synced to the 1.1.0 release, and the stash re-applied with conflicts in README.md, package.json, package-lock.json, scripts/ui-smoke.js and src/main.js. The resolutions were reviewed: both sides are kept (`electron-updater` and `systeminformation`; `startUpdater()`/`updater.stop()` and the system poller start/stop; the flyout update message and the system snapshot in the smoke test) and the obsolete `scheduleStartupUpdateCheck` is gone. No conflict markers remain.

- **Should-fix — fixed:** Windows MEM ran `si.mem()` every 2 seconds, and on Windows that call starts PowerShell with a `Win32_PageFileUsage` CIM query for swap figures the app discards. Measured here: about 270 ms and one PowerShell process per call. Memory now comes from `os.totalmem()`/`os.freemem()` on Windows (36.2% used versus 36.1% from the library on the same machine); other platforms are unchanged. `src/system.js:39`.
- **Nit — fixed:** a hardware probe stalled for more than 15 seconds reset `gpuPresent`, hiding the GPU chip until the next good sample, contrary to the intent stated in the collector. Presence is now kept; only the readings are cleared. `src/system.js:105`.
- **Docs — fixed:** the README overview and taskbar screenshots still showed the single-row chips. Regenerated `overview.png` and `tray-flyout.png`; the poster height now follows the flyout height because font metrics differ by platform and clipped the network image (`scripts/screenshots.js`). `network.png` was left as committed.
- **Tests:** three new tests in `test/system.test.js` (memory source per platform, failed and late probes after stop, stalled probe keeps the GPU chip). Reverting either fix makes its test fail.

Not changed, recorded for the owner: the Windows hardware sample (`src/system-windows.ps1`) costs about 450 ms of CPU per run (3 runs: 438–484 ms, about 1.5 s wall) and runs every 5 seconds, roughly 9% of one core, or 0.6% of this 16-thread CPU. About half is PowerShell start-up; the three CIM queries cost about 300, 270 and 20 ms warm. A persistent PowerShell worker would roughly halve it but adds a long-lived child process, so it was left as a decision rather than made here. `si.fsSize()` also starts PowerShell on Windows, but only every 30 seconds.

Decided and done (2026-09-29): one PowerShell process now answers every sample (`createWorker` in `src/system.js`). The script reads `sample` lines on stdin and writes one JSON line each, and the adapter list is queried every 5 minutes instead of every sample. A sample that takes more than 8 seconds kills the worker; a new one starts on the next sample, at most every 30 seconds. The loop ends when stdin closes, so the worker cannot outlive the app. Under PowerShell 7 on Linux the first sample took 594 ms (start-up included) and the next 15 ms from the same process; the CIM cost on Windows is unchanged.
