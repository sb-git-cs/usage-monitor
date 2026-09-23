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

- **Low five-hour usage hid an exhausted weekly quota.** Chips now display the highest used percentage across available pools. Cached readings have a dashed border and stale tooltip. Evidence: `src/models.js:46`, `src/ui/chips.js:28`.

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
- Windows installer, portable and ZIP builds are generated by `npm run dist`; final build/check results are recorded in `handoff.md`.
- The test session returned no Explorer taskbar. DPI geometry is covered by tests, but real taskbar docking, multi-monitor interaction and sign-in startup need desktop acceptance.
- Live provider quota comparisons and token rotation against real accounts were not exercised. No real CLI credentials were used by the tests.
- Authenticode inspection reports NotSigned. Public signed distribution requires the owner's signing certificate; this review does not claim a signed release.

DPI conversion follows [Electron screen documentation](https://www.electronjs.org/docs/latest/api/screen#screenscreentodiprectwindow-rect-windows).
