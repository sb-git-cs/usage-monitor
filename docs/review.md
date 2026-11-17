# Production hardening review

Releases and reviews, newest first. The reviews from 2026-10-11 to 2026-11-15 were kept in a separate root `review.md` until 2026-11-17, when they were moved here.

## Memory optimization review (2026-11-15)

### Blocker

None found in the changed paths. Automated and hidden-window checks passed; acceptance in the installed app remains pending.

### Should-fix (addressed)

- `src/main.js:1546`, `src/main.js:692`: the startup panel and its hidden renderer remained resident indefinitely. Create it on demand and destroy it and its click-away window after 60 seconds hidden; restore state on each load. Regression checks cover reopening, cancellation, docking, and a real Electron destroy/recreate cycle.
- `src/tokens.js:73`: reading and splitting a whole transcript retained its entire text while parsing. Stream lines, preserving duplicate-response accounting, Unicode, CRLF, final unterminated lines, and oversized-line coverage. A synthetic 23.4 MiB input reduced process peak RSS from 117.8 to 48.6 MiB, with unchanged totals; scan time rose from 80 to 509 ms.
- `src/tokens.js:87`: a file-count-only cache could retain arbitrarily many token observations per file. Cap retained observations at 20,000 as well as 2,000 files; oversized results are still reported but not cached. Cache replacement and eviction tests pass.
- `src/system.js:6`, `src/battery.js:4`: Windows eagerly loaded systeminformation despite using native helpers. Defer the import to a probe that needs it; existing Windows and cross-platform probe tests pass.

### Nit

None. No unrelated style cleanup.

Validation: 526 tests, 524 passed, two platform skips; all six source UI smoke checks passed. A real hidden panel renderer used 88.9 MiB working set and disappeared after the idle timeout; recreation passed. This is not a measurement of total installed-app idle RAM. Evidence: `.qa/optimization-tests.log`, `.qa/optimization-ui.log`, `.qa/optimization-window-memory.json`, `.qa/optimization-memory-{before,after}.json`. Windows ZIP built and verified: 108 packaged source files match; ZIP integrity passes. `package.json:62` maximum compression reduces the same payload from 142,298,501 to 142,014,185 bytes (0.20%); it slows packaging and does not reduce installed size. Evidence: `.qa/optimization-package-size.json`. Reproduce the synthetic scanner benchmark with `node --expose-gc scripts/benchmark-tokens.js`.

---

## 1.11.0 review: UI/UX and correctness (2026-10-21)

Scope: the desktop app (panel, chips, Settings, Insights, Network usage) and every module behind it. Three independent reviews covered the meter pipeline (adapters to what is shown), analytics (Insights, tokens, battery, network aggregates) and the app shell (main process, windows, updater, sampler). 52 findings: 2 high, 14 medium, the rest low. Each was reproduced with a stubbed script or traced in the code. All but the deferred items below are fixed, each with a regression test that fails on 1.10.0 unless noted.

### UI/UX changes

- **Panel:** labelled icon toolbar with Close; the refresh-interval list moved to Settings (its IPC was removed). Last-read time in the header. Summary tiles name the at-risk plans and the plan and window that resets next. `% used` instead of `used/100%`; bars aligned per card; exact reset time on hover; forecasts wrap. Network and battery are grouped under "This computer". Status lines for signed-out and failed plans; empty and all-hidden states. Styles moved to `src/ui/flyout.css` as theme tokens; `shared.css` keeps only the chips.
- **Settings:** two-pane layout with a section list (scroll-spy), one row per option, switches. New Appearance section (theme, text size, compact cards, plan visibility and order) moved from Insights. The theme drives `nativeTheme.themeSource`, so every window follows it.
- **Insights:** plain tab and section names, no "PRO/Executive" labels, status dots instead of emoji, action-specific messages, and the same names in the Markdown report.

### High (fixed)

- **Pace mixed reset cycles** (`src/burn.js`, also `src/ui/insights.js` pace, delta and "to limit"). The first hour after every 5-hour reset (6 h for weekly) read as "cooling": a window at about 115 %/h showed −86.6 %/h. Only the current cycle is used now.
- **Resumed Claude sessions counted twice** (`src/tokens.js`). Messages are deduplicated across files by message and request id. Plausible rather than reproduced on a real transcript; harmless when nothing repeats.

### Medium (fixed)

- Copilot had no account reference, so a gh account switch continued the previous account's cache, history and forecasts.
- Several Gemini groups collapsed into the last group's windows.
- Forecast notifications for windows longer than a day dropped the date ("reaches 100% around 11:13 pm, before it resets at 11:13 pm").
- Audit trail showed the oldest six events; recommendations contradicted their numbers ("exhausting before reset" for a window that resets first, "null", "+-"); health dropped for resumed sessions, data caps and updates; the cache share left cache writes out of the denominator.
- Keeping the panel open from its own button left the click-away layer up, swallowing the next desktop click.
- Windows shutdown, restart and sign-out skipped every save (`before-quit` is not emitted); `session-end` now saves the same way.
- A chip stayed green while another window of the same plan was at its limit.
- A floating strip grew off the screen's right edge.
- The macOS/Linux sampler started `system_profiler` or `lspci` every 5 s and a synchronous process every 2 s (macOS). The GPU list is cached for 10 minutes unless it reports utilization; macOS memory is read every 10 s. Not measured on macOS/Linux hardware.

### Low (fixed)

Alerts: duplicate toasts after an account switch, an X Subscription reader change or on a 5-minute bucket edge. Readings: a reading taken after a reset passed was marked stale; an unrecognized response overwrote the last good reading (a response with the expected fields but no window stays a real, empty reading); Codex windows of other lengths were labelled 5h/Weekly and a model's 5h limit could take over the chip; the combined X Subscription hid sign-outs; 99.5 % showed as 100 %; slow weekly climbs got no forecast; switching the X Subscription setting reset other plans' history. Insights: Daily highs plotted the last reading; a reset window counted as fullest; summary cards ignored the period; chart hover could replot another series; budget bar ignored the warning level; report text ("No limit set GB", period). Tokens: partial first day and missing empty days; zero-token rows. Network: Avg/min denominator pinned by kept records; a new cap started at zero; focus on another app stopped caps; a cap set while the clock was ahead never rolled over; day and hour buckets across DST. Shell: Settings not refreshed after tray and Network-window changes; turning off automatic updates after a download still restarted; copies that can't install claimed they do; the panel's Check now closed it behind its dialog; an expired pairing code stayed up; waking to the lock screen counted as unlocked; a paired phone got frozen CPU/memory while locked; failed saves were silent; keep-open shown where it does not persist; hidden system metrics left a gap; tray click flashed "loading…"; equal quiet-hours times and Check now during a check.

### Deferred (not fixed)

- The 1.10.0 deferred items stand (capture helper on shared PCs, GB units, Android 403 handling, folder-menu prompt, asar integrity fuse).
- The "loading…" chip has no click action; autostart is offered in three places; the tray's "Show chips" items duplicate each other.
- Android was not changed beyond the shared version number.

### Verification and limits

- Desktop: 291 tests, 289 pass, 0 fail, 2 platform skips (1.10.0: 254 pass). Electron UI smoke test passes for panel, chips, Network usage, Settings (now including Appearance, section list, plan order and visibility) and Insights. `git diff --check` passes. README screenshots regenerated from the real UI with demo data.
- Not exercised: a real Windows sign-out (session-end rests on Electron's documented behaviour), macOS/Linux runtime, live provider responses for the new empty-response handling, and a real resumed Claude transcript.

## 1.10.0 audit: bugs, security and monitor performance (2026-10-21)

Scope: every desktop module, the Windows capture helper, the Android app, build and CI. Evidence came from the code, the installed 1.9.0's own log and cache files, live process sampling, and stubbed reproductions. Every fix has a regression test that fails on the 1.9.0 code, except where noted.

### High (fixed)

- **Taskbar probe CPU.** Every docked placement started one or two new PowerShell processes, each compiling C# (`Add-Type`), about every 9 s, including while locked: about 11% of one core, roughly 18k launches a day. The long-lived `-Watch` process now streams layouts and applies ownership (`scripts/taskbar-layout.ps1`, `src/taskbarLayout.js`). Steady state starts no processes. The watcher exits when the app's pipe closes. Placement also pauses while the screen is locked.
- **Reset-time jitter.** Providers repeat a reset time with up to about 1 s of jitter, so history restarted on every reading. Claude never got a forecast, limit alerts fired twice (seen in the event log), and Codex reached the 9,000-point cap within 6.4 days. Resets within 5 minutes are now the same window (`src/models.js` `sameReset`), and alert keys round to 5 minutes.
- **Account keys from rotating tokens.** Cache, history and alert keys hashed the access token. The 1.9.0 `insights.json` held 168 Gemini "accounts". Each tool's account now comes from its own files (`accountRef`), never from a token.
- **Grok 403 loop.** A lasting 403 refreshed the token and rewrote the Grok CLI's `auth.json` on every poll, rotating its refresh token about 720 times an hour. It now refreshes once per account.
- **Credential files lost owner-only permissions.** Refreshed Claude Code and Grok credentials were written with the default umask on macOS/Linux. `paths.writeSecretFile` now writes 0600, removes a stray temporary file on failure, and keeps refreshed tokens in memory if the write fails.
- **SYSTEM helper `BLOCK` accepted any path.** UNC paths could make the SYSTEM service authenticate to a remote host, and Windows or Defender programs could be blocked for every user. Blocking now needs a program on a local fixed drive, outside Windows and Defender. The rule is checked again on the final path (`GetFinalPathNameByHandle`) to defeat 8.3 names and junctions. The self-test covers 11 cases, and CI now fails on a self-test failure. Installed helpers show **Update** (hash change); until it is clicked they keep the old check.

### Medium (fixed)

- **Insights froze the app.** It parsed every transcript synchronously on the main process: 2.8–4.5 s cold here, then every 10 s. The scan is now asynchronous, yields per file, is cached for 30 s per period, and skips refreshes while hidden.
- **Phone pairing key never rotated.** It was derived from the on-screen code, so anyone who saw the QR could later read the meters and, with direct reading on, the linked access tokens. `/v1/rekey` replaces the key with a random one at its first use; a lost reply leaves the old key working. The phone rekeys after pairing and once for existing pairings, and unlinks before it forgets a computer. POST replays within the 5-minute window get 409. A wrong phone clock gets `400 clock` instead of "pair again".
- **Write amplification.** These were rewritten every minute: `insights.json` (6.4 MB, network byte counters), `battery.json` (up to 4 MB) and Android battery history (about 4 MB). `alert-state.json` had grown to 19,354 entries (2 MB), re-read and rewritten on every poll. Counter-only Insights changes now save every 15 min. Desktop battery saves on state change or every 10 min. Android battery appends. Alert state keeps fired alerts only (8 entries on a copy of the real file).
- **Network totals scanned the whole table each second.** The query now uses the minute index (60-minute range: 106 ms → 0.1 ms on 1 year of synthetic records), and database totals are cached per flush.
- **Provider error handling.** Retry-After is honoured, with doubling back-off from 1 min to 1 h. Refused or throttled token refreshes are not resent every poll. A 403 from GitHub or chatgpt.com is retryable instead of "signed out". Gemini drops a rejected in-memory token and keeps quota read before a 429. Codex reads per-model limits in the nested `rate_limit` layout (desktop and phone) and validates `remaining_percent`. Burn analysis ignores expired or unread windows.
- **Android main-thread I/O and ANR risk.** Insights history moved from `settings.xml` to its own atomic file. Battery and insights load on IO. Settings are excluded from cloud backup and device transfer. Pairing links are limited to private and CGNAT addresses, with a replacement warning. Replies are bounded (2 MB, 15 s deadline), as are update downloads, and update checks are single-flight.

### Low (fixed)

- The sessions chip could not be clicked (its drag handler captured the pointer).
- Resets more than 6 days away showed only a weekday.
- The 14-day Insights period returned 7 days.
- "Longest Runway" showed the riskiest window; it is now "Shortest Runway".
- Insights ignored the warn threshold.
- Hidden providers counted in the flyout overview.
- X Subscription sign-in from Insights failed.
- Keyboard focus was lost on each refresh.
- From the installed app's log: IPC handlers were missing at startup, and a missing QR module broke Settings.
- The click-away window had no CSP and the full preload; pairing, update and auto-resume IPC now only accept the flyout.
- Packaged builds now disable run-as-Node, `NODE_OPTIONS` and inspector flags (Electron fuses, verified on a local build).
- Workflow actions are pinned to commit SHAs.
- The installer's Node check matches `engines`.
- An Android phone without a browser no longer crashes on a usage link.

### Deferred (not fixed)

- **Capture helper sees other users' traffic (shared PCs only).** On a multi-user PC the helper forwards every user's traffic and DNS names to the enrolled user. It needs per-event SID filtering in `NetCapture.cs`, verified elevated.
- **Elevated setup writes its result to a user-writable folder.** Low risk, over-the-shoulder elevation only.
- **"GB" means 10⁹ in Insights and 2³⁰ elsewhere.** Changing either would shift users' saved budgets.
- **Android: an unauthenticated 403 still clears linked sign-ins.** LAN denial of service only. The provider-API HTTP client on the phone is not size-capped.
- **The folder menu asks for administrator approval on each launch until accepted.** This is owner-designed and left unchanged.
- **Not enabled: the asar integrity fuse, and `unsafe-inline` styles in the Insights CSP.** Both are low value next to their risk of a launch or rendering regression that cannot be checked here.

### Verification and limits

- **Desktop:** 256 tests, 254 pass, 0 fail, 2 platform skips (baseline 229 pass). The Electron UI smoke test passes for flyout, chips, net, settings and Insights; two runs during a parallel Gradle build failed on timing only and passed when re-run on an idle machine. `git diff --check` passes. Runtime dependency audit: zero advisories. The build-tool chain still has 8 moderate advisories, none high or critical.
- **Windows packaging:** the packaged `--dir` build succeeds with the fuses flipped and the new files inside the asar. The packaged executable was not launched, because it would share the running installed app's profile and single-instance lock. The capture helper compiles as CI does, and its self-test passes.
- **Android (Docker SDK 35):** 108 unit tests pass (was 97), lint has 0 errors and 13 warnings, and the debug APK builds. It was not installed on the phone.
- **Live 1.9.0:** main process about 1.9% of one core and about 320 MB private memory, flat over 10 min. Four resident PowerShell helpers used about 300 MB. The taskbar probe CPU comes from the reviewer's measurement on this machine; the new watcher was run here and exits on pipe close.
- **Not exercised:**
  - Live provider responses for the new Codex layout (inferred from the installed CLI's strings) and for Retry-After values.
  - macOS and Linux runtime.
  - The rekey against a real phone.

## Follow-up review (2026-10-21)

### Blocker

No unresolved blocker found in the reviewed request, provider, battery and report paths.

### Should-fix (resolved)

- Malformed phone pairing names could throw from URI decoding, and synchronous payload failures could escape the request callback. `src/phone.js:254` rejects invalid encoding; `src/phone.js:324` returns a generic error without leaking internals. `src/phone.js:125` bounds request time, headers and concurrent connections; `src/phone.js:273` rejects browser Origin requests. Existing authenticated AES-GCM/HMAC, revocation and replay protections remain covered by tests.
- Pairing keys in POSIX configuration could inherit readable file permissions. `src/config.js:157` creates/restricts the directory to 0700 and atomically replaces configuration with a 0600 file. Windows continues to use the user's profile ACL; this change does not claim to configure NTFS permissions.
- Untrusted model/provider text could become Markdown markup or spreadsheet formulas in exported reports. `src/insights-window.js:56` escapes Markdown fields; `src/tokens.js:133` quotes CSV and neutralizes formula prefixes. Reports contain counts/model names and hashed session identifiers, with no transcript content or raw paths. `src/tokens.js:6` bounds file count, file/line size and cached results; coverage identifies exclusions.
- Gemini's stable host could report placeholder weekly 0% while the newer host returned a nonzero shared pool. `src/adapters/gemini.js:437` merges fresh endpoint readings, accepts decreases, and classifies multiday shared resets as weekly; Android mirrors this. The live corrected reader returned weekly 100% with reset 2026-10-23T22:06:38Z. Synthetic regressions cover placeholder replacement and falling usage. Without an explicit window label, a shared pool with less than six hours remaining is ambiguous after a cold restart; its reset classification is remembered for the running process.
- Codex cached input is included in input totals; streaming and repeated cumulative records could inflate model usage. `src/tokens.js:34` derives cumulative deltas and splits cached/uncached input once. Claude streamed chunks are deduplicated by message ID. Tests cover model changes, duplicate messages, future records and export filtering.

### Verification and limits

Publication: desktop v1.9.0 is stable/latest; release workflow `39488928436` passed all builds and Android verification. Public asset checks verified 18 assets, 17 checksum entries and updater metadata; local Windows/phone installation evidence is in `docs/handoff.md`.

Local acceptance: 229 desktop tests passed with two Windows platform skips; 97 Android tests passed, optimized lint/build passed. Source and packaged Electron checks passed; all 80 source files match the installed Windows archive. Native installed panel bounds match the display work area at full height/right edge. Phone update preserved pairing and widget IDs and matches the signed APK hash.

Runtime dependency audit: zero known advisories. Full dependency audit: eight moderate build-tool advisories, zero high/critical; no speculative dependency downgrade applied. Sandboxed/context-isolated renderers, CSP, escaped model rendering, phone authentication/revocation, battery transitions and full-height multi-monitor positioning have regression coverage. No complete physical charge/discharge cycle or macOS/Linux battery hardware was exercised. Current-based estimates vary with workload and charge taper. This is a scoped code review, not a guarantee against every compromise.

Evidence: `.qa/followup-desktop-tests.log`, `.qa/followup-ui.log`, `.qa/followup-android-tests.log`, `.qa/followup-gemini-live.json`, `.qa/followup-audit-runtime.json`, `.qa/followup-audit-all.json`.

### Battery monitoring and UI verification (2026-10-20)

No unresolved blocker or should-fix findings in the new battery feature. Regression coverage checks state distinctions, native/observed estimates, insufficient data, power transitions, suspend and sampling timeouts, recording gaps, retention, persistence/restart recovery, corrupt storage, exports, and isolation from quota history. Desktop history uses atomic replacement; Android writes a synced temporary file and atomically replaces the history file.

Validation: 220 desktop tests passed with one platform skip; Electron smoke checks passed, including two-row taskbar fit and keyboard chart inspection. Android: 96 unit tests passed; debug lint had zero errors (14 existing warnings and three informational notices); debug APK built. Six Android phone/battery screenshots passed and were inspected in light, dark and 150% text layouts. Live Windows sampling detected the computer battery and AC/full state correctly. Synthetic tests cover charge/discharge estimates; no complete physical charge/discharge session or macOS/Linux battery hardware was exercised. 1.8.0 was subsequently installed on Windows and the connected phone: installed desktop archive matches the tested package; native phone checks verified its battery screen/Home chip and preserved pairing/widget IDs. The phone APK uses the original installed debug signing certificate. Source/packaged UI checks, optimized Android build/lint and APK signature checks passed. Public release is prepared through the standard tag workflow; no Android production signing key is configured.

Evidence: `.qa/battery-desktop-tests.log`, `.qa/battery-ui-checks.log`, `.qa/battery-android-final.log`, `.qa/battery-android-screenshots.log`, `.qa/battery-insights.png`, `.qa/battery-android-screenshots/`.

## Usage Monitor 1.6.0 review — 2026-10-14

### Blocker

- Fixed — fabricated shared usage: `src/adapters/grok.js:99` previously summed product percentages, and its mapper inferred zero solely from a live period; Android did the same in `direct/UsageApi.kt:307`. Missing totals could appear as real usage and trigger forecasts/alerts. Both now require an explicit total. `src/subscription.js:8` requires weekly/reset and Cursor-coverage evidence before accepting a shared pool, and `src/subscription.js:20` selects one reader with its own identity/credits. Monthly fallbacks retain monthly reset semantics. Regression tests cover zero, missing/malformed usage, shared-reader fallback and unrelated accounts.

No open release-blocking code defect identified in the affected flow. Final checks and release-asset verification passed; stable 1.6.0 is published.

### Should-fix

- Fixed — refresh/account races and stale cache mixing: `src/poller.js:56` scopes adapter work, cache and rate limits by provider, regime and credential/account. `src/poller.js:144` discards results from the previous selection and immediately refreshes the selected regime. `src/cache.js:49` retains bounded scope-specific readings across restart. Tests exercise concurrent switching, credential changes and persisted cache separation.
- Fixed — wrong account labels on saved readings: `src/accounts.js:247` preserves the fetched identity while retaining saved-account choices. Grok's adapter attaches the fetched account directly (`src/adapters/grok.js:378`). Android direct readings do not borrow computer identities/plans from an unrelated credential (`direct/PlanReadings.kt:183`). Source/account history segmentation and the linked-vs-phone precedence have regression coverage.
- Fixed — misleading sign-out after permissions errors: Grok (`src/adapters/grok.js:348`) and Cursor (`src/adapters/cursor.js:127`) treat HTTP 403 as a retryable failure, retaining cached usage as stale; only HTTP 401 is sign-out. Synthetic HTTP regression tests cover both readers.
- Fixed — expired phone windows: `model/DesktopSnapshot.kt:37` clears expired values/forecasts before direct-source selection (`direct/PlanReadings.kt:256`). Tests verify stale state and no primary numeric reading after reset.
- Fixed — Additional Usage replacing the quota percentage: `src/models.js:53` and `model/DesktopSnapshot.kt:47` keep Grok/Cursor credits out of the primary chip/Home/widget reading. Credits remain visible separately in the flyout, Android Home/details and large Plan widgets. Regression tests cover a 42% pool with 99% Additional Usage. The combined Home title also retains its full name at 130% text.
- Fixed — duplicate shared-pool phone warnings: `alerts/Alerts.kt:17` uses a stable provider account ID to deduplicate a linked replacement of a computer reading. Unknown identities remain isolated by source. Tests cover source replacement, account changes and regime separation.
- Fixed — cached credits losing the stale label after the shared reset: `src/subscription.js:38` and Android `direct/Subscription.kt:17` retain stale status/source and an explicit stale hint when the weekly value expires. The weekly meter stays unavailable while retained credits stay visibly old. The desktop regression failed before the fix; desktop/Android regressions validate the corrected state.
- Fixed — missing or misleading dashboard UI: `src/main.js:84` now routes Cursor/Copilot cards to their dashboards and selects the correct shared-pool reader's dashboard. `src/ui/format.js:130` renders unavailable hints instead of `n/a`; `src/ui/flyout.js:79` only calls saved readings stale when they are stale. Source/packaged Electron checks verify one shared card/chip and separate credits.
- Fixed — dark app/system-bar contrast: actual CPH2423 screenshots showed dark status icons on the app's forced dark background while Android itself was light. `ui/Theme.kt:56` now applies the rendered theme to status/navigation icon contrast. Native rendering assertions and refreshed phone captures validate the fix.
- Release checksums: `.github/workflows/release.yml` now attaches `SHA256SUMS` after normalizing filenames. Existing update manifests and blockmaps remain required. No production Android signing secret is configured; only desktop assets are published, with the development APK kept local.

Android references above are relative to `android/app/src/main/java/io/github/sbgitcs/usagemonitor/`.

### Nit

None recorded; no style-only changes requested.

### Verification and limits

- Desktop: 151 tests passed, one existing platform skip. Source and packaged Electron UI checks passed; all 70 packaged source files match the checkout. The final Windows installer/portable/ZIP and package-source comparison are recorded in `.qa/subscription-windows-complete.txt`, `.qa/subscription-packaged-ui-standard.txt` and `.qa/packaged-source-results.json`. Local update-manifest size and SHA-512 checks passed.
- Android: final verification passed **101 tests** (89 behavioral tests plus 12 native light/dark rendering tests), lint zero errors/14 existing warnings, and optimized build. Both regimes and system-bar contrast are covered; results are in `.qa/subscription-android-complete.txt`. The development APK is version **1.6.0 / 1060099**, **5,533,935 bytes**, SHA-256 **f5eb1cb39853bd85d70d9724e2f9717381bf26abb199e2271eb75332779b1385**. Its certificate remains **4ef13f3472e2e4fa880e7442bf4f370410db86b6c32ad721a12fb55c050e1769**; no production key was created.
- Native CPH2423 acceptance: actual Home, Settings and Glance widget captures passed in both regimes; the Settings toggle was exercised and persisted through restart, and 130% text was inspected. Reproducible harness: `scripts/verify-subscription-phone.py`; result `.qa/subscription-phone-results.json`; sanitized images `docs/screenshots/android/native-*.png`. Tests use a separate demo package, leaving the production pairing, vault and launcher widgets intact.
- Remote main's prior UI/screenshot/dependency commits were integrated by fast-forward before final verification. No open GitHub issues were returned during the focused defect review.
- Live provider account migration, new sign-in consent, refresh-token lifetime, and a real paid X Subscription API response are **unverified**. The currently known response contract requires explicit weekly total/reset plus Cursor product coverage; providers that do not expose that evidence show unavailable rather than an estimated total. Older snapshots/linked tokens default to legacy. No paid plan/account migration was performed.
- Windows/macOS binaries remain unsigned under the existing workflow. Existing moderate build-tool advisories and Android lint warnings are reported, with high/critical audit findings gating release. Public release/checksum/download verification is recorded in the handoff after publication.
- The final audit reports eight moderate build-tool advisories and zero low/high/critical findings. The parallel demo-build attempt hit the shared Gradle journal lock; the final demo build is run serially. A PowerShell screenshot-directory argument needed quoting; native rendering then passed. These were harness/build-environment failures, not application test failures.
- Publication verified: main Checks **38471351149** and Release **38471774303** passed. Stable/latest [v1.6.0](https://github.com/sb-git-cs/usage-monitor/releases/tag/v1.6.0) points to tested commit **529e9a5113d04599e58af160af8116f814f93227**. All 17 checksum catalogue entries match asset digests; the downloaded Windows installer and updater manifests pass size/hash checks, and all updater references/blockmaps resolve. Other platform binaries were verified against server digests rather than downloaded locally. Receipt: `docs/handoff.md`; machine-readable results: `.qa/subscription-published-release.json`.

---

## Usage Monitor 1.5.0 review — 2026-10-11

### Blocker

No blockers identified in the touched desktop/Android features. This is a focused feature and regression review, not a full repository audit.

### Should-fix

- Fixed: forecast history was keyed only by provider/window, allowing an account switch to reuse another account's trend. `src/accounts.js:251` preserves the known account ID and `src/history.js:108` keys trends by a pseudonymous account reference. `src/history.js:139` also excludes stale readings from forecasts. Regression tests cover both cases.
- Fixed: stale/expired projections could generate warnings. `src/alerts.js:80` requires a future run-out before reset; the equivalent Android check and expired-window guard are in `alerts/Alerts.kt`.
- Fixed: provider/network cards accepted pointer clicks only, and polling discarded focus. `src/ui/flyout.js:113` and `src/ui/flyout.js:167` add keyboard activation; render preserves the focused provider. `src/ui/flyout.js:76` exposes saved readings after failures.
- Fixed: larger text could extend the flyout beyond the native size limit. `src/ui/flyout.js:47` bounds its content and `src/main.js:1304` clamps the native window to the display work area. Electron checks cover 130% text, light mode, provider visibility/order and the narrow Insights window.
- Fixed: malformed Claude code input forced a new browser approval. `android/app/src/main/java/io/github/sbgitcs/usagemonitor/direct/PhoneSignIn.kt:136` retains the verifier/approval while accepting another paste; line 139 uses the expected state length. Line 303 rejects null/non-string tokens; line 215 reads Codex identity/expiry from token claims when needed. Existing pending fixes were reviewed, built and installed, with their regression tests.
- Fixed: hiding all mobile providers could display a misleading sign-in prompt. `android/app/src/main/java/io/github/sbgitcs/usagemonitor/ui/PlansScreen.kt:115` now explains visibility settings instead.
- Fixed: first-paint screenshots could be blank despite passing rendering assertions. `scripts/ui-smoke.js:127` captures the completed page; desktop and phone screenshots were inspected.

### Nit

No style findings requested or recorded.

### Validation and limits

Desktop regression suite: **137 passed, one platform skip, zero failures**. Source and packaged Electron checks cover flyout, chips, network, settings and Insights. Tests cover account/reset segmentation, persistence, retention, budget dates/byte deltas, snooze, CSV formula escaping, display validation, renderer authorization and support-report redaction. All **69 packaged source files** match the tested checkout. Windows installer, portable and ZIP builds and their update metadata were verified.

Android: **78 unit tests passed**, lint **zero errors and 14 existing warnings**, optimized build succeeded. Installed **1.5.0 / 1050099** on CPH2423 in place. The installed APK digest matches the final build: **11446ba63f294deb952db1bbd0758365ed48a1392b062073b5e887b8bf2e3c6b**, **5,517,555 bytes**. The existing certificate remains **4ef13f3472e2e4fa880e7442bf4f370410db86b6c32ad721a12fb55c050e1769**. Pairing and widget ID **8** were retained; all five tabs, history periods, export picker/cancellation, snooze/resume, diagnostics, dark theme, 130% text and Back navigation passed native checks. Original display preferences were restored. Existing Claude/Grok phone readings remained available; no new provider authorization was performed. Phone returned to its launcher.

The first streamed Android installation timed out; the standard non-streaming signed install succeeded. The native verifier checks the installed APK's SHA-256, not just its reusable version code. Evidence: `.qa/mobile-features-results.json`, `.qa/packaged-source-results.json`, `.qa/release-verification.json`; reproducible checks in `scripts/verify-mobile-features.py` and `scripts/verify-packaged-source.js`.

`npm audit --audit-level=high` passes. Eight moderate advisories remain in the existing build-only electron-builder dependency chain (`package-lock.json:3205`); the suggested forced fix downgrades the builder and is not a verified compatible remediation. No runtime dependency or production signing key was added. History starts with current observations, network budgets exclude unobserved traffic, and delivery-requested events do not guarantee the OS displayed a notification. Feature scope/limitations and competitor references are in `docs/product-improvements.md`. No public release is published by this task.

## Desktop release review (2026-10-08)

- **Blocker — fixed:** The dependency audit found high-severity build-tool advisories. The lockfile now uses the maintained `electron-builder` 26.17.0 line at `package.json:56`, with patched transitive dependencies. `npm audit --audit-level=high` passes. An automatic audit fix selected an older builder with additional vulnerabilities; that intermediate tree was replaced before packaging.
- **Should-fix — fixed:** Missing, blank, boolean and object quota fields became fabricated 0% Cursor or 100% Copilot readings. Both readers now reject those values at `src/adapters/cursor.js:60` and `src/adapters/copilot.js:52`. An out-of-range Cursor billing timestamp no longer throws and discards valid usage at `src/adapters/cursor.js:67`.
- **Should-fix — fixed:** A phone token request could finish after direct reading was revoked or the paired phone was removed. The token endpoint rechecks the current device and permission before returning credentials at `src/phone.js:304`. Regression tests cover both revocation paths and verify that no token payload is sent.
- **Should-fix — fixed:** Release Android validation was skipped when signing secrets were absent. Tests and lint now run independently of signing at `.github/workflows/release.yml:101`. SDK build tools are pinned to the installed 35.0.0 toolchain at `android/app/build.gradle.kts:25`; `.kotlin/` compiler output is ignored at `android/.gitignore:2`.
- **Should-fix — fixed:** GitHub sanitized spaces in the uploaded macOS ZIP names to dots, while `latest-mac.yml` referenced hyphens, preventing the updater from resolving those assets. The release workflow normalizes filenames before uploading at `.github/workflows/release.yml:144`. The existing release assets were renamed without changing their bytes; all three published manifests now reference attached files with matching sizes, and the downloaded Windows installer matches its SHA-512 metadata and GitHub SHA-256 digest.
- **Should-fix — upstream limitation:** Eight moderate audit entries remain in the build-only `sprintf-js` / `roarr` / `global-agent` / Electron downloader chain. The current builder has no compatible upstream fix. The suggested downgrade reintroduces high/critical advisories, and the downloader's new major changes its request/proxy options. No audit suppression or incompatible override is shipped. See the [downloader's breaking changes](https://github.com/electron/get/releases/tag/v5.0.0).

All three new regression tests failed before the fixes and pass afterwards. Desktop tests: 127 passed, one Windows-specific skip, zero failures. Source Electron UI checks passed. Android verification: 70 tests passed; lint zero errors and 14 existing warnings; optimized 1.4.0 build succeeded. Packaged UI and publication results are recorded in `docs/handoff.md`.

The owner selected desktop downloads only for this release. No Android signing key was created and no repository secrets were changed. At the owner's later request, the optimized development update was installed on the connected phone, preserving pairing and widgets; all five tabs passed native checks. Existing Grok authorization produced a current phone reading. No new provider consent or complete token-lifetime acceptance was performed. This does not establish live Claude authorization: that meter currently uses cached computer data.

## Mobile authentication and widgets (2026-10-02)

- **Should-fix — fixed:** Concurrent app/service/worker reads could rotate the same phone refresh token, while a temporary renewal outage fell back to an expired token and then removed authorization. Refreshes and credential changes now share a mutex at `android/app/src/main/java/io/github/sbgitcs/usagemonitor/direct/PlanReadings.kt:35`; retryable renewal failures preserve the credential at line 195. A token with no refresh token remains usable until its actual expiry. Only explicit grant rejection is treated as permanent by `android/app/src/main/java/io/github/sbgitcs/usagemonitor/direct/PhoneSignIn.kt:275`.
- **Should-fix — fixed:** HTTP 403 was treated as a revoked sign-in, and empty HTTP 200 responses could be reported as connected with no usage. The reader distinguishes these outcomes at `android/app/src/main/java/io/github/sbgitcs/usagemonitor/direct/UsageApi.kt:57` and line 74. Sign-in verifies usage, saves pending results explicitly, and rejects unauthorized results at `android/app/src/main/java/io/github/sbgitcs/usagemonitor/direct/PhoneSignIn.kt:101`.
- **Should-fix — fixed:** Cancelled blocking sign-ins could still save credentials or replace a newer dialog. Attempt-scoped state and cancellation checks guard completion at `android/app/src/main/java/io/github/sbgitcs/usagemonitor/direct/PhoneSignIn.kt:80`. Pasted Claude codes/callbacks are validated at line 156; the UI shows connection progress and permits reauthorization at `android/app/src/main/java/io/github/sbgitcs/usagemonitor/ui/ProviderConnections.kt:199`.
- **Should-fix — fixed:** First usage/widget refresh depended on Accounts remaining composed; phone readings could inherit a different desktop identity; revoked linked access left old direct readings visible. Persistence now occurs in the sign-in operation at `android/app/src/main/java/io/github/sbgitcs/usagemonitor/direct/PlanReadings.kt:119`, linked revocation removes its cache at line 150, and account fallback is limited to linked readings at line 175.
- **Should-fix — fixed:** Cache serialization dropped usage text and forecasts at `android/app/src/main/java/io/github/sbgitcs/usagemonitor/model/DesktopSnapshot.kt:114`. Compact widgets replaced cached usage with only “Old” and could display a percentage for an error state; they now retain clearly labelled cached values and distinguish sign-in/retry states at `android/app/src/main/java/io/github/sbgitcs/usagemonitor/widget/PlanWidget.kt:29`. Large widgets use reading timestamps and suppress old PC hardware values at lines 90 and 102.

The new regression tests cover PKCE/code exchange, cancelled overlapping attempts, refused or unavailable first usage, transient and permanent renewal failures, malformed responses, nonrenewable expiry, cache round-trips and compact widget state. Current build/device evidence is recorded in `docs/handoff.md`. Real provider consent and a full token-lifetime test still require the account owner; mocked HTTP tests do not establish live provider acceptance.

## Copilot removed from Android; Codex and desktop retained (2026-10-01)

- **Blocker — separate direct-cloud objective still pending:** Android reads the computer at android/app/src/main/java/io/github/sbgitcs/usagemonitor/direct/PlanReadings.kt:15. No new Codex phone authentication or direct quota fetching was delivered. The official Codex quota route and other providers' remaining access limits are recorded in docs/phone-accounts.md:41. This phase completes the latest mobile-only Copilot removal, not the earlier independent cloud requirement.
- **Should-fix — fixed:** Copilot could reappear on mobile whenever a paired desktop snapshot included it. The shared filter at android/app/src/main/java/io/github/sbgitcs/usagemonitor/direct/PlanReadings.kt:26 removes only Copilot before the app, widgets and alerts read the snapshot, preserving Codex and the original desktop data. Accounts retains Codex at android/app/src/main/java/io/github/sbgitcs/usagemonitor/ui/ProviderConnections.kt:31; mobile account switching still permits Codex at android/app/src/main/java/io/github/sbgitcs/usagemonitor/pairing/DesktopClient.kt:48. Desktop source/configuration are unchanged.
- **Should-fix — fixed:** Obsolete Copilot phone sign-in, billing, login storage and client-ID configuration remained after the meter was removed. Those components and their specific tests/instrumentation are deleted. Upgrade cleanup removes only the old Copilot authorization/report at android/app/src/main/java/io/github/sbgitcs/usagemonitor/UsageMonitorApp.kt:12; pairing and unrelated settings are retained. The temporary native Codex probe is absent from the final APK.

20 unit tests passed; lint has zero errors and 14 warnings; optimized APK and signing verification passed. Installed preserving app data. Native checks passed for all five tabs, all five retained account/meter rows, Codex details/source, pairing and the launcher Plan widget. Copilot is absent and Codex remains. Current phone readings are cached computer data; live cloud authorization remains untested and unimplemented. Evidence and the current APK checksum are in docs/handoff.md.

## Official personal-provider authorization and usage-only scope (2026-10-01)

- **Blocker — pending provider access:** The user requires personal-subscription usage and officially supported APIs. Only GitHub has a native phone implementation, still unconfigured at `android/app/src/main/java/io/github/sbgitcs/usagemonitor/direct/GitHubAuth.kt:18`. The other five have no phone refresh adapters in `android/app/src/main/java/io/github/sbgitcs/usagemonitor/direct/PlanReadings.kt:24`; availability/actions remain explicit at `android/app/src/main/java/io/github/sbgitcs/usagemonitor/ui/ProviderConnections.kt:45` and line 90. Primary provider evidence and exact outstanding requirements are in `docs/phone-accounts.md`. Read-only intent alone does not supply a missing provider grant.
- **Should-fix — documentation corrected:** Codex does have an official quota interface through app-server's account/rateLimits/read; generic SIWC documentation alone did not establish that interface. The assessment at `docs/phone-accounts.md:21` now identifies the official local runtime instead of implying no quota interface exists. A hash-verified ARM64 --version probe passed under the Android shell. Full app-sandbox/authentication/usage acceptance is not established; embedding the 78 MB compressed runtime was neither selected nor shipped. The user narrowed the task to usage only, and temporary prototype files were removed.

Documentation/cleanup only. The interrupted sandbox build did not run. No new provider connection, real consent or fresh cloud usage was tested or delivered, and the installed APK remains unchanged. The five remaining integrations are incomplete.

## Android cleanup, size and mobile layout (2026-10-01)

- **Blocker — pending provider access:** The earlier all-six cloud requirement remains incomplete. GitHub needs the owner's public client ID at `android/app/src/main/java/io/github/sbgitcs/usagemonitor/direct/GitHubAuth.kt:18`; matching permitted usage authorization for the other five is not enabled. Availability remains explicit at `android/app/src/main/java/io/github/sbgitcs/usagemonitor/ui/ProviderConnections.kt:45`. Website login and computer identity do not grant phone usage access. Requirements and primary provider sources are in `docs/phone-accounts.md`.
- **Should-fix — fixed:** Release optimization was disabled, shipping unused library code. Code/resource shrinking is enabled at `android/app/build.gradle.kts:57`. Removed unused direct lifecycle-process/glance-material3 dependencies, unused imports, the obsolete Settings account-helper wrapper, unused revision/connection counters and an unreachable stale branch. Persisted worker/widget names are retained at `android/app/proguard-rules.pro:1`. The optimized APK is 5,402,867 bytes versus 33,824,071 bytes previously (84.0% reduction), with all four ABIs retained.
- **Should-fix — fixed:** Repeated dashboard instructions, per-card actions and tall account headers consumed screen space. Compact source filters/actions and meter cards are at `android/app/src/main/java/io/github/sbgitcs/usagemonitor/ui/Dashboard.kt:59`; account identity/status/actions share a row at `android/app/src/main/java/io/github/sbgitcs/usagemonitor/ui/ProviderConnections.kt:81`. Reduced ring/card dimensions and a smaller 100% label prevent crowding. The six home readings are visible on the connected phone. Core frequencies now have three normal-text columns and two at larger scales at `android/app/src/main/java/io/github/sbgitcs/usagemonitor/ui/DeviceScreen.kt:36`.
- **Should-fix — fixed:** Settings described the remembered computer as Connected despite failed fetching. It now says Paired with at `android/app/src/main/java/io/github/sbgitcs/usagemonitor/ui/SettingsScreen.kt:135`. Home retains the last-reading age and cached source state. App and widgets use consistent light/dark colors at `android/app/src/main/java/io/github/sbgitcs/usagemonitor/ui/Theme.kt:17` and `android/app/src/main/java/io/github/sbgitcs/usagemonitor/widget/Widgets.kt:86`.

- **Should-fix — fixed:** At larger text sizes, the compact navigation bar split and clipped labels. It now uses 72dp above the normal font scale at `android/app/src/main/java/io/github/sbgitcs/usagemonitor/ui/App.kt:57`, and labels stay on one line with ellipsis at line 108. The final installed build passed native dark-mode and 1.3x-text display checks; full labels remain available in accessibility semantics.

26 unit tests, lint (zero errors, 14 existing warnings), APK signing verification and the optimized build passed. Installed preserving data; native checks passed for all five tabs, all six availability dialogs, meter details/source filtering, every Settings section, cancelled Forget, camera/manual pairing and the existing launcher widget. The final navigation-only adjustment passed dark and larger-text checks. SpeedService remained a foreground service and WorkManager's system job service ran. No live cloud consent or public release signing was completed. Evidence and artifact checksum are recorded in `docs/handoff.md`.

## Cloud authorization and Settings helper removal (2026-10-01)

- **Should-fix — pending requirement:** Direct cloud usage for all six meters is still unavailable. GitHub authorization requires an app-owner client ID at `android/app/src/main/java/io/github/sbgitcs/usagemonitor/direct/GitHubAuth.kt:18`; the remaining five integrations do not exist. Availability is explained per provider at `android/app/src/main/java/io/github/sbgitcs/usagemonitor/ui/ProviderConnections.kt:42`. Existing GitHub connection validates a real billing report before saving authorization at `android/app/src/main/java/io/github/sbgitcs/usagemonitor/direct/GitHubUsage.kt:54`. Its phone reading replaces only its own computer meter at `android/app/src/main/java/io/github/sbgitcs/usagemonitor/direct/PlanReadings.kt:42`. This is not a completed all-six cloud implementation.
- **Should-fix — fixed:** A computer's signed-in reading disabled the phone connection action and made the Accounts page appear authorized. Phone status now requires saved authorization and a matching Phone API source at `android/app/src/main/java/io/github/sbgitcs/usagemonitor/model/MeterConnection.kt:8`; current computer identity is displayed separately at `android/app/src/main/java/io/github/sbgitcs/usagemonitor/ui/ProviderConnections.kt:87`. Browser-only connection buttons were removed, and GitHub authorization cannot start in an unconfigured build at line 126.
- **Should-fix — fixed:** The redundant account helper persisted in Settings despite the dedicated Accounts tab. Settings now starts with Computer settings at `android/app/src/main/java/io/github/sbgitcs/usagemonitor/ui/SettingsScreen.kt:80`; Cloud accounts lives in Accounts at `android/app/src/main/java/io/github/sbgitcs/usagemonitor/ui/ProviderConnections.kt:69`.

26 tests, lint with zero errors and the Android build passed. Installed using the existing key without clearing settings. Connected-phone checks passed for the complete Settings screen, all six provider availability dialogs, separation of computer identity from phone authorization and retained Home source counts. No real cloud consent was completed; the current build remains unconfigured for GitHub and unintegrated for the other five meters. Provider documentation and remaining access requirements are recorded in `docs/phone-accounts.md`.

## Home dashboard, account status and matching widgets (2026-09-30)

- **Should-fix — fixed:** Meters did not clearly distinguish phone authorization from computer readings, and every account action appeared to need sign-in. Source-scoped connection states now distinguish fresh authenticated readings, last-known identities, unavailable authentication and logged-out accounts at `android/app/src/main/java/io/github/sbgitcs/usagemonitor/model/MeterConnection.kt:15`. Account rows show those states and condition their actions at `android/app/src/main/java/io/github/sbgitcs/usagemonitor/ui/ProviderConnections.kt:82`; browser launch does not establish authorization.
- **Should-fix — fixed:** The home list offered little overview or interaction. Usage cards, rings, source filters and refresh are implemented at `android/app/src/main/java/io/github/sbgitcs/usagemonitor/ui/Dashboard.kt:44` and opened as detail cards at `android/app/src/main/java/io/github/sbgitcs/usagemonitor/ui/PlansScreen.kt:129`.
- **Should-fix — fixed:** Widget readings lacked the app's source and authentication context. Large plan rows now include the shared source/sign-in status at `android/app/src/main/java/io/github/sbgitcs/usagemonitor/widget/PlanWidget.kt:121`; compact labels use PC/API. Local readings are identified at `android/app/src/main/java/io/github/sbgitcs/usagemonitor/widget/DataWidget.kt:93` and `android/app/src/main/java/io/github/sbgitcs/usagemonitor/widget/DeviceWidget.kt:58`.

24 unit tests, lint with zero errors and the Android build passed. Installed preserving settings; tested all five tabs, dashboard filters/details/refresh and account labels on the phone. Launcher Plan widget source labels, scrolling to the last meter and automatic background refresh passed. Live Phone API authorization and individual rendering of every widget preset remain outside this UI verification. Evidence and artifact checksum are in `docs/handoff.md`.

## Complete mobile spacing and widget UX (2026-09-30)

- **Should-fix — fixed:** Spacing reductions covered shared cards but missed app chrome, settings fields, pairing and dialogs. Compact content spacing now applies across all screens at `android/app/src/main/java/io/github/sbgitcs/usagemonitor/ui/Components.kt:51`; app bars retain system insets at `android/app/src/main/java/io/github/sbgitcs/usagemonitor/ui/App.kt:82`. Both dialogs use the compact, scrolling layout at `android/app/src/main/java/io/github/sbgitcs/usagemonitor/ui/Components.kt:128`, retaining normal text and usable actions.
- **Should-fix — fixed:** Every widget opened the same default Activity rather than its own tab, and compact missing data access was an unexplained dash. Widget actions specify a distinct destination at `android/app/src/main/java/io/github/sbgitcs/usagemonitor/widget/Widgets.kt:155`; Activity navigation accepts only known tabs at `android/app/src/main/java/io/github/sbgitcs/usagemonitor/MainActivity.kt:87`. Data now shows Set up at `android/app/src/main/java/io/github/sbgitcs/usagemonitor/widget/DataWidget.kt:72`.
- **Should-fix — fixed:** Resizing a large Data or Phone widget shorter could crop details. Content now scrolls at `android/app/src/main/java/io/github/sbgitcs/usagemonitor/widget/DataWidget.kt:99` and `android/app/src/main/java/io/github/sbgitcs/usagemonitor/widget/DeviceWidget.kt:68`. All widget layouts have reduced padding and clearer separation. Cached plan rows have muted bars and Last reading rather than a current forecast at `android/app/src/main/java/io/github/sbgitcs/usagemonitor/widget/PlanWidget.kt:131`.

21 tests, lint with zero errors and final Android build passed. Full tab/settings/pairing/dialog checks, native destination Intent routing and an actual launcher Plan widget tap passed on the connected phone; pairing was retained. Individual Data/Phone launcher layouts and other font scales remain acceptance limits. Artifact identity and screenshots are recorded in `docs/handoff.md`.

## Usage account prompts and compact mobile UI (2026-09-30)

- **Should-fix — fixed:** The account panel emphasized unavailable phone authorization instead of asking users to match their usage identity. It now prompts users to sign in using the account shown on each meter at `android/app/src/main/java/io/github/sbgitcs/usagemonitor/ui/ProviderConnections.kt:63`, shows that identity beside each provider at line 72, and keeps actual phone-authorization status separate at line 90. The ordinary panel no longer shows build setup messages or asks users to register an app.
- **Should-fix — fixed:** Vertically stacked provider text and repeated connection explanations made the panel unnecessarily tall. Six provider rows now use compact identity/action layouts at `android/app/src/main/java/io/github/sbgitcs/usagemonitor/ui/ProviderConnections.kt:69`. Shared screen/card margins and gaps are reduced at `android/app/src/main/java/io/github/sbgitcs/usagemonitor/ui/Components.kt:43`; pairing uses matching spacing at `android/app/src/main/java/io/github/sbgitcs/usagemonitor/ui/PairScreen.kt:125`. Button touch targets remain intact.

All 21 tests passed; lint has zero errors. Installed preserving settings and checked all six sign-in actions in both account panels, plus all four tabs on the phone. Screenshots and artifact identity are recorded in `docs/handoff.md`. This UI change does not claim browser sign-in establishes independent phone usage access.

## Direct phone account connections (2026-09-30)

- **Should-fix — pending requirement:** All six meters are requested to refresh independently of the computer. The installed panel provides six official sign-in pages, but only GitHub has a native usage authorization implementation. `android/app/src/main/java/io/github/sbgitcs/usagemonitor/ui/ProviderConnections.kt:83` exposes its connection action only when configured; `android/app/src/main/java/io/github/sbgitcs/usagemonitor/direct/GitHubAuth.kt:18` disables authorization without a public app client ID. The user has no registration, and this session has no connected Browser runtime. The other five independent integrations remain pending. Setup and limits: `docs/phone-accounts.md:14`.
- **Should-fix — fixed:** A successful independent phone refresh must not make cached computer meters appear fresh or restore a disconnected account. Sources merge with separate freshness at `android/app/src/main/java/io/github/sbgitcs/usagemonitor/direct/PlanReadings.kt:40`; GitHub results compare their saved credential before committing at `android/app/src/main/java/io/github/sbgitcs/usagemonitor/direct/GitHubUsage.kt:90`. Tokens are encrypted in the no-backup directory at `android/app/src/main/java/io/github/sbgitcs/usagemonitor/direct/GitHubLogin.kt:35`.

21 unit tests, lint with zero errors, APK signing verification and actual Android Keystore instrumentation passed. The account panel and a native browser-launch intent were checked on the phone. Live GitHub authorization/billing acceptance remains pending configuration; browser launch alone is not treated as a connected meter.

## Computer-off widget behavior (2026-09-30)

- **Should-fix — fixed:** Unreachable computer readings previously retained apparently current percentages, particularly in compact widgets. Failed or old computer readings now become stale at `android/app/src/main/java/io/github/sbgitcs/usagemonitor/direct/PlanReadings.kt:40`. Compact values return Old before considering a percentage at `android/app/src/main/java/io/github/sbgitcs/usagemonitor/widget/PlanWidget.kt:69`; large layouts retain last-reading age and a cached computer indication. Source freshness and failure behavior have unit coverage.

Phone data usage and device status are read locally and do not require the computer. Desktop hardware and unconnected provider meters require a reachable desktop; authorized native phone readings refresh independently. Automatic widget redraw alone cannot obtain new computer readings from an offline computer.

## Android widget refresh and resizing (2026-09-30)

- **Should-fix — fixed:** The speed service only redrew cached desktop readings, leaving widgets stale until another fetch. It now enqueues a refresh at startup and every minute at `android/app/src/main/java/io/github/sbgitcs/usagemonitor/service/SpeedService.kt:47`. Launcher updates also fetch through `android/app/src/main/java/io/github/sbgitcs/usagemonitor/widget/WidgetPresets.kt:10`; `android/app/src/main/java/io/github/sbgitcs/usagemonitor/BootReceiver.kt:17` refreshes after reboot/package replacement. The existing 15-minute periodic job remains, and immediate requests coalesce instead of cancelling running work at `android/app/src/main/java/io/github/sbgitcs/usagemonitor/work/Scheduler.kt:42`.
- **Should-fix — fixed:** Small presets disabled resizing and large widgets imposed maximum dimensions. All twelve registrations now support horizontal and vertical resizing with 40dp minimums and no maximum dimensions; see `android/app/src/main/res/xml/widget_1x1.xml:7` and `android/app/src/main/res/xml/widget_plans.xml:7`. The three layouts use the actual allocated size (`android/app/src/main/java/io/github/sbgitcs/usagemonitor/widget/PlanWidget.kt:28`), with compact tiers for narrow/short allocations at `android/app/src/main/java/io/github/sbgitcs/usagemonitor/widget/Widgets.kt:50`.

All 14 Android tests pass, including a manifest/metadata regression check covering all twelve widget providers; lint has zero errors. Installed the update without clearing data, observed fresh desktop readings on the home screen, and exercised width/height shrink and growth on the connected phone. Evidence and remaining platform timing limits are recorded in `docs/handoff.md`.

## Switch account browser sign-in (2026-09-30)

- **Should-fix — fixed:** Switch account launched a terminal command rather than the requested sign-in page, and its asynchronous process errors were ignored. `src/accounts.js:259` now awaits a fixed provider browser URL and returns a launch error on failure; `src/main.js:852` awaits this result before reporting success. Settings explains the separate local-login requirement at `src/ui/settings.html:72`.

All six routes and browser-opening failures have regression coverage. Source and packaged Electron checks exercise both account buttons and saved Grok selection; all unit tests pass. Rebuilt and restarted the desktop app. Evidence is in `docs/handoff.md`.

## Desktop refresh (2026-09-30)

- **Should-fix — fixed, local dependency installation:** The checkout declared `qrcode-generator` but the installed dependencies omitted it; generating the phone pairing QR therefore failed at `src/main.js:903`, reproduced by `scripts/ui-smoke.js:185`. Restored the locked package, rebuilt the Windows unpacked app and passed source and packaged UI checks. Package files did not change.

All 61 packaged source files match the current checkout, and the packaged QR dependency is present. The desktop source app was restarted and its phone-sharing listener verified. Evidence and test results are in `docs/handoff.md`.

## Android build continuation (2026-09-30)

No build blockers found in the current Android working tree. The account and widget changes compile, all 13 Android unit tests pass, lint has zero errors, and the generated APK passes signature verification with the earlier debug certificate. Checked the packaged launcher and twelve widget receiver registrations. Glance 1.1.1's receiver lookup supports multiple receivers for the same widget class, so the shared widget implementations can refresh the size presets.

The 21 lint warnings and outstanding device/release acceptance are recorded in `docs/handoff.md`; this build check does not establish runtime acceptance on a phone. No application source changes were needed. Deliverable: `dist/UsageMonitor-1.3.0-android-debug.apk`.

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
