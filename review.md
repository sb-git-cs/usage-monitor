# 1.11.0 review: UI/UX and correctness (2026-10-21)

Scope: the desktop app (panel, chips, Settings, Insights, Network usage) and every module behind it. Three independent reviews covered the meter pipeline (adapters to what is shown), analytics (Insights, tokens, battery, network aggregates) and the app shell (main process, windows, updater, sampler). 52 findings: 2 high, 14 medium, the rest low. Each was reproduced with a stubbed script or traced in the code. All but the deferred items below are fixed, each with a regression test that fails on 1.10.0 unless noted.

## UI/UX changes

- **Panel:** labelled icon toolbar with Close; the refresh-interval list moved to Settings (its IPC was removed). Last-read time in the header. Summary tiles name the at-risk plans and the plan and window that resets next. `% used` instead of `used/100%`; bars aligned per card; exact reset time on hover; forecasts wrap. Network and battery are grouped under "This computer". Status lines for signed-out and failed plans; empty and all-hidden states. Styles moved to `src/ui/flyout.css` as theme tokens; `shared.css` keeps only the chips.
- **Settings:** two-pane layout with a section list (scroll-spy), one row per option, switches. New Appearance section (theme, text size, compact cards, plan visibility and order) moved from Insights. The theme drives `nativeTheme.themeSource`, so every window follows it.
- **Insights:** plain tab and section names, no "PRO/Executive" labels, status dots instead of emoji, action-specific messages, and the same names in the Markdown report.

## High (fixed)

- **Pace mixed reset cycles** (`src/burn.js`, also `src/ui/insights.js` pace, delta and "to limit"). The first hour after every 5-hour reset (6 h for weekly) read as "cooling": a window at about 115 %/h showed −86.6 %/h. Only the current cycle is used now.
- **Resumed Claude sessions counted twice** (`src/tokens.js`). Messages are deduplicated across files by message and request id. Plausible rather than reproduced on a real transcript; harmless when nothing repeats.

## Medium (fixed)

- Copilot had no account reference, so a gh account switch continued the previous account's cache, history and forecasts.
- Several Gemini groups collapsed into the last group's windows.
- Forecast notifications for windows longer than a day dropped the date ("reaches 100% around 11:13 pm, before it resets at 11:13 pm").
- Audit trail showed the oldest six events; recommendations contradicted their numbers ("exhausting before reset" for a window that resets first, "null", "+-"); health dropped for resumed sessions, data caps and updates; the cache share left cache writes out of the denominator.
- Keeping the panel open from its own button left the click-away layer up, swallowing the next desktop click.
- Windows shutdown, restart and sign-out skipped every save (`before-quit` is not emitted); `session-end` now saves the same way.
- A chip stayed green while another window of the same plan was at its limit.
- A floating strip grew off the screen's right edge.
- The macOS/Linux sampler started `system_profiler` or `lspci` every 5 s and a synchronous process every 2 s (macOS). The GPU list is cached for 10 minutes unless it reports utilization; macOS memory is read every 10 s. Not measured on macOS/Linux hardware.

## Low (fixed)

Alerts: duplicate toasts after an account switch, an X Subscription reader change or on a 5-minute bucket edge. Readings: a reading taken after a reset passed was marked stale; an unrecognized response overwrote the last good reading (a response with the expected fields but no window stays a real, empty reading); Codex windows of other lengths were labelled 5h/Weekly and a model's 5h limit could take over the chip; the combined X Subscription hid sign-outs; 99.5 % showed as 100 %; slow weekly climbs got no forecast; switching the X Subscription setting reset other plans' history. Insights: Daily highs plotted the last reading; a reset window counted as fullest; summary cards ignored the period; chart hover could replot another series; budget bar ignored the warning level; report text ("No limit set GB", period). Tokens: partial first day and missing empty days; zero-token rows. Network: Avg/min denominator pinned by kept records; a new cap started at zero; focus on another app stopped caps; a cap set while the clock was ahead never rolled over; day and hour buckets across DST. Shell: Settings not refreshed after tray and Network-window changes; turning off automatic updates after a download still restarted; copies that can't install claimed they do; the panel's Check now closed it behind its dialog; an expired pairing code stayed up; waking to the lock screen counted as unlocked; a paired phone got frozen CPU/memory while locked; failed saves were silent; keep-open shown where it does not persist; hidden system metrics left a gap; tray click flashed "loading…"; equal quiet-hours times and Check now during a check.

## Deferred (not fixed)

- The 1.10.0 deferred items stand (capture helper on shared PCs, GB units, Android 403 handling, folder-menu prompt, asar integrity fuse).
- The "loading…" chip has no click action; autostart is offered in three places; the tray's "Show chips" items duplicate each other.
- Android was not changed beyond the shared version number.

## Verification and limits

- Desktop: 291 tests, 289 pass, 0 fail, 2 platform skips (1.10.0: 254 pass). Electron UI smoke test passes for panel, chips, Network usage, Settings (now including Appearance, section list, plan order and visibility) and Insights. `git diff --check` passes. README screenshots regenerated from the real UI with demo data.
- Not exercised: a real Windows sign-out (session-end rests on Electron's documented behaviour), macOS/Linux runtime, live provider responses for the new empty-response handling, and a real resumed Claude transcript.

# 1.10.0 audit: bugs, security and monitor performance (2026-10-21)

Scope: every desktop module, the Windows capture helper, the Android app, build and CI. Evidence came from the code, the installed 1.9.0's own log and cache files, live process sampling, and stubbed reproductions. Every fix has a regression test that fails on the 1.9.0 code, except where noted.

## High (fixed)

- **Taskbar probe CPU.** Every docked placement started one or two new PowerShell processes, each compiling C# (`Add-Type`), about every 9 s, including while locked: about 11% of one core, roughly 18k launches a day. The long-lived `-Watch` process now streams layouts and applies ownership (`scripts/taskbar-layout.ps1`, `src/taskbarLayout.js`). Steady state starts no processes. The watcher exits when the app's pipe closes. Placement also pauses while the screen is locked.
- **Reset-time jitter.** Providers repeat a reset time with up to about 1 s of jitter, so history restarted on every reading. Claude never got a forecast, limit alerts fired twice (seen in the event log), and Codex reached the 9,000-point cap within 6.4 days. Resets within 5 minutes are now the same window (`src/models.js` `sameReset`), and alert keys round to 5 minutes.
- **Account keys from rotating tokens.** Cache, history and alert keys hashed the access token. The 1.9.0 `insights.json` held 168 Gemini "accounts". Each tool's account now comes from its own files (`accountRef`), never from a token.
- **Grok 403 loop.** A lasting 403 refreshed the token and rewrote the Grok CLI's `auth.json` on every poll, rotating its refresh token about 720 times an hour. It now refreshes once per account.
- **Credential files lost owner-only permissions.** Refreshed Claude Code and Grok credentials were written with the default umask on macOS/Linux. `paths.writeSecretFile` now writes 0600, removes a stray temporary file on failure, and keeps refreshed tokens in memory if the write fails.
- **SYSTEM helper `BLOCK` accepted any path.** UNC paths could make the SYSTEM service authenticate to a remote host, and Windows or Defender programs could be blocked for every user. Blocking now needs a program on a local fixed drive, outside Windows and Defender. The rule is checked again on the final path (`GetFinalPathNameByHandle`) to defeat 8.3 names and junctions. The self-test covers 11 cases, and CI now fails on a self-test failure. Installed helpers show **Update** (hash change); until it is clicked they keep the old check.

## Medium (fixed)

- **Insights froze the app.** It parsed every transcript synchronously on the main process: 2.8–4.5 s cold here, then every 10 s. The scan is now asynchronous, yields per file, is cached for 30 s per period, and skips refreshes while hidden.
- **Phone pairing key never rotated.** It was derived from the on-screen code, so anyone who saw the QR could later read the meters and, with direct reading on, the linked access tokens. `/v1/rekey` replaces the key with a random one at its first use; a lost reply leaves the old key working. The phone rekeys after pairing and once for existing pairings, and unlinks before it forgets a computer. POST replays within the 5-minute window get 409. A wrong phone clock gets `400 clock` instead of "pair again".
- **Write amplification.** These were rewritten every minute: `insights.json` (6.4 MB, network byte counters), `battery.json` (up to 4 MB) and Android battery history (about 4 MB). `alert-state.json` had grown to 19,354 entries (2 MB), re-read and rewritten on every poll. Counter-only Insights changes now save every 15 min. Desktop battery saves on state change or every 10 min. Android battery appends. Alert state keeps fired alerts only (8 entries on a copy of the real file).
- **Network totals scanned the whole table each second.** The query now uses the minute index (60-minute range: 106 ms → 0.1 ms on 1 year of synthetic records), and database totals are cached per flush.
- **Provider error handling.** Retry-After is honoured, with doubling back-off from 1 min to 1 h. Refused or throttled token refreshes are not resent every poll. A 403 from GitHub or chatgpt.com is retryable instead of "signed out". Gemini drops a rejected in-memory token and keeps quota read before a 429. Codex reads per-model limits in the nested `rate_limit` layout (desktop and phone) and validates `remaining_percent`. Burn analysis ignores expired or unread windows.
- **Android main-thread I/O and ANR risk.** Insights history moved from `settings.xml` to its own atomic file. Battery and insights load on IO. Settings are excluded from cloud backup and device transfer. Pairing links are limited to private and CGNAT addresses, with a replacement warning. Replies are bounded (2 MB, 15 s deadline), as are update downloads, and update checks are single-flight.

## Low (fixed)

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

## Deferred (not fixed)

- **Capture helper sees other users' traffic (shared PCs only).** On a multi-user PC the helper forwards every user's traffic and DNS names to the enrolled user. It needs per-event SID filtering in `NetCapture.cs`, verified elevated.
- **Elevated setup writes its result to a user-writable folder.** Low risk, over-the-shoulder elevation only.
- **"GB" means 10⁹ in Insights and 2³⁰ elsewhere.** Changing either would shift users' saved budgets.
- **Android: an unauthenticated 403 still clears linked sign-ins.** LAN denial of service only. The provider-API HTTP client on the phone is not size-capped.
- **The folder menu asks for administrator approval on each launch until accepted.** This is owner-designed and left unchanged.
- **Not enabled: the asar integrity fuse, and `unsafe-inline` styles in the Insights CSP.** Both are low value next to their risk of a launch or rendering regression that cannot be checked here.

## Verification and limits

- **Desktop:** 256 tests, 254 pass, 0 fail, 2 platform skips (baseline 229 pass). The Electron UI smoke test passes for flyout, chips, net, settings and Insights; two runs during a parallel Gradle build failed on timing only and passed when re-run on an idle machine. `git diff --check` passes. Runtime dependency audit: zero advisories. The build-tool chain still has 8 moderate advisories, none high or critical.
- **Windows packaging:** the packaged `--dir` build succeeds with the fuses flipped and the new files inside the asar. The packaged executable was not launched, because it would share the running installed app's profile and single-instance lock. The capture helper compiles as CI does, and its self-test passes.
- **Android (Docker SDK 35):** 108 unit tests pass (was 97), lint has 0 errors and 13 warnings, and the debug APK builds. It was not installed on the phone.
- **Live 1.9.0:** main process about 1.9% of one core and about 320 MB private memory, flat over 10 min. Four resident PowerShell helpers used about 300 MB. The taskbar probe CPU comes from the reviewer's measurement on this machine; the new watcher was run here and exits on pipe close.
- **Not exercised:**
  - Live provider responses for the new Codex layout (inferred from the installed CLI's strings) and for Retry-After values.
  - macOS and Linux runtime.
  - The rekey against a real phone.

# Follow-up review (2026-10-21)

## Blocker

No unresolved blocker found in the reviewed request, provider, battery and report paths.

## Should-fix (resolved)

- Malformed phone pairing names could throw from URI decoding, and synchronous payload failures could escape the request callback. `src/phone.js:254` rejects invalid encoding; `src/phone.js:324` returns a generic error without leaking internals. `src/phone.js:125` bounds request time, headers and concurrent connections; `src/phone.js:273` rejects browser Origin requests. Existing authenticated AES-GCM/HMAC, revocation and replay protections remain covered by tests.
- Pairing keys in POSIX configuration could inherit readable file permissions. `src/config.js:157` creates/restricts the directory to 0700 and atomically replaces configuration with a 0600 file. Windows continues to use the user's profile ACL; this change does not claim to configure NTFS permissions.
- Untrusted model/provider text could become Markdown markup or spreadsheet formulas in exported reports. `src/insights-window.js:56` escapes Markdown fields; `src/tokens.js:133` quotes CSV and neutralizes formula prefixes. Reports contain counts/model names and hashed session identifiers, with no transcript content or raw paths. `src/tokens.js:6` bounds file count, file/line size and cached results; coverage identifies exclusions.
- Gemini's stable host could report placeholder weekly 0% while the newer host returned a nonzero shared pool. `src/adapters/gemini.js:437` merges fresh endpoint readings, accepts decreases, and classifies multiday shared resets as weekly; Android mirrors this. The live corrected reader returned weekly 100% with reset 2026-10-23T22:06:38Z. Synthetic regressions cover placeholder replacement and falling usage. Without an explicit window label, a shared pool with less than six hours remaining is ambiguous after a cold restart; its reset classification is remembered for the running process.
- Codex cached input is included in input totals; streaming and repeated cumulative records could inflate model usage. `src/tokens.js:34` derives cumulative deltas and splits cached/uncached input once. Claude streamed chunks are deduplicated by message ID. Tests cover model changes, duplicate messages, future records and export filtering.

## Verification and limits

Publication: desktop v1.9.0 is stable/latest; release workflow `39488928436` passed all builds and Android verification. Public asset checks verified 18 assets, 17 checksum entries and updater metadata; local Windows/phone installation evidence is in `docs/handoff.md`.

Local acceptance: 229 desktop tests passed with two Windows platform skips; 97 Android tests passed, optimized lint/build passed. Source and packaged Electron checks passed; all 80 source files match the installed Windows archive. Native installed panel bounds match the display work area at full height/right edge. Phone update preserved pairing and widget IDs and matches the signed APK hash.

Runtime dependency audit: zero known advisories. Full dependency audit: eight moderate build-tool advisories, zero high/critical; no speculative dependency downgrade applied. Sandboxed/context-isolated renderers, CSP, escaped model rendering, phone authentication/revocation, battery transitions and full-height multi-monitor positioning have regression coverage. No complete physical charge/discharge cycle or macOS/Linux battery hardware was exercised. Current-based estimates vary with workload and charge taper. This is a scoped code review, not a guarantee against every compromise.

Evidence: `.qa/followup-desktop-tests.log`, `.qa/followup-ui.log`, `.qa/followup-android-tests.log`, `.qa/followup-gemini-live.json`, `.qa/followup-audit-runtime.json`, `.qa/followup-audit-all.json`.

## Battery monitoring and UI verification (2026-10-20)

No unresolved blocker or should-fix findings in the new battery feature. Regression coverage checks state distinctions, native/observed estimates, insufficient data, power transitions, suspend and sampling timeouts, recording gaps, retention, persistence/restart recovery, corrupt storage, exports, and isolation from quota history. Desktop history uses atomic replacement; Android writes a synced temporary file and atomically replaces the history file.

Validation: 220 desktop tests passed with one platform skip; Electron smoke checks passed, including two-row taskbar fit and keyboard chart inspection. Android: 96 unit tests passed; debug lint had zero errors (14 existing warnings and three informational notices); debug APK built. Six Android phone/battery screenshots passed and were inspected in light, dark and 150% text layouts. Live Windows sampling detected the computer battery and AC/full state correctly. Synthetic tests cover charge/discharge estimates; no complete physical charge/discharge session or macOS/Linux battery hardware was exercised. 1.8.0 was subsequently installed on Windows and the connected phone: installed desktop archive matches the tested package; native phone checks verified its battery screen/Home chip and preserved pairing/widget IDs. The phone APK uses the original installed debug signing certificate. Source/packaged UI checks, optimized Android build/lint and APK signature checks passed. Public release is prepared through the standard tag workflow; no Android production signing key is configured.

Evidence: `.qa/battery-desktop-tests.log`, `.qa/battery-ui-checks.log`, `.qa/battery-android-final.log`, `.qa/battery-android-screenshots.log`, `.qa/battery-insights.png`, `.qa/battery-android-screenshots/`.

# Usage Monitor 1.6.0 review — 2026-10-14

## Blocker

- Fixed — fabricated shared usage: `src/adapters/grok.js:99` previously summed product percentages, and its mapper inferred zero solely from a live period; Android did the same in `direct/UsageApi.kt:307`. Missing totals could appear as real usage and trigger forecasts/alerts. Both now require an explicit total. `src/subscription.js:8` requires weekly/reset and Cursor-coverage evidence before accepting a shared pool, and `src/subscription.js:20` selects one reader with its own identity/credits. Monthly fallbacks retain monthly reset semantics. Regression tests cover zero, missing/malformed usage, shared-reader fallback and unrelated accounts.

No open release-blocking code defect identified in the affected flow. Final checks and release-asset verification passed; stable 1.6.0 is published.

## Should-fix

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

## Nit

None recorded; no style-only changes requested.

## Verification and limits

- Desktop: 151 tests passed, one existing platform skip. Source and packaged Electron UI checks passed; all 70 packaged source files match the checkout. The final Windows installer/portable/ZIP and package-source comparison are recorded in `.qa/subscription-windows-complete.txt`, `.qa/subscription-packaged-ui-standard.txt` and `.qa/packaged-source-results.json`. Local update-manifest size and SHA-512 checks passed.
- Android: final verification passed **101 tests** (89 behavioral tests plus 12 native light/dark rendering tests), lint zero errors/14 existing warnings, and optimized build. Both regimes and system-bar contrast are covered; results are in `.qa/subscription-android-complete.txt`. The development APK is version **1.6.0 / 1060099**, **5,533,935 bytes**, SHA-256 **f5eb1cb39853bd85d70d9724e2f9717381bf26abb199e2271eb75332779b1385**. Its certificate remains **4ef13f3472e2e4fa880e7442bf4f370410db86b6c32ad721a12fb55c050e1769**; no production key was created.
- Native CPH2423 acceptance: actual Home, Settings and Glance widget captures passed in both regimes; the Settings toggle was exercised and persisted through restart, and 130% text was inspected. Reproducible harness: `scripts/verify-subscription-phone.py`; result `.qa/subscription-phone-results.json`; sanitized images `docs/screenshots/android/native-*.png`. Tests use a separate demo package, leaving the production pairing, vault and launcher widgets intact.
- Remote main's prior UI/screenshot/dependency commits were integrated by fast-forward before final verification. No open GitHub issues were returned during the focused defect review.
- Live provider account migration, new sign-in consent, refresh-token lifetime, and a real paid X Subscription API response are **unverified**. The currently known response contract requires explicit weekly total/reset plus Cursor product coverage; providers that do not expose that evidence show unavailable rather than an estimated total. Older snapshots/linked tokens default to legacy. No paid plan/account migration was performed.
- Windows/macOS binaries remain unsigned under the existing workflow. Existing moderate build-tool advisories and Android lint warnings are reported, with high/critical audit findings gating release. Public release/checksum/download verification is recorded in the handoff after publication.
- The final audit reports eight moderate build-tool advisories and zero low/high/critical findings. The parallel demo-build attempt hit the shared Gradle journal lock; the final demo build is run serially. A PowerShell screenshot-directory argument needed quoting; native rendering then passed. These were harness/build-environment failures, not application test failures.
- Publication verified: main Checks **38471351149** and Release **38471774303** passed. Stable/latest [v1.6.0](https://github.com/sb-git-cs/usage-monitor/releases/tag/v1.6.0) points to tested commit **529e9a5113d04599e58af160af8116f814f93227**. All 17 checksum catalogue entries match asset digests; the downloaded Windows installer and updater manifests pass size/hash checks, and all updater references/blockmaps resolve. Other platform binaries were verified against server digests rather than downloaded locally. Receipt: `docs/handoff.md`; machine-readable results: `.qa/subscription-published-release.json`.

---

# Usage Monitor 1.5.0 review — 2026-10-11

## Blocker

No blockers identified in the touched desktop/Android features. This is a focused feature and regression review, not a full repository audit.

## Should-fix

- Fixed: forecast history was keyed only by provider/window, allowing an account switch to reuse another account's trend. `src/accounts.js:251` preserves the known account ID and `src/history.js:108` keys trends by a pseudonymous account reference. `src/history.js:139` also excludes stale readings from forecasts. Regression tests cover both cases.
- Fixed: stale/expired projections could generate warnings. `src/alerts.js:80` requires a future run-out before reset; the equivalent Android check and expired-window guard are in `alerts/Alerts.kt`.
- Fixed: provider/network cards accepted pointer clicks only, and polling discarded focus. `src/ui/flyout.js:113` and `src/ui/flyout.js:167` add keyboard activation; render preserves the focused provider. `src/ui/flyout.js:76` exposes saved readings after failures.
- Fixed: larger text could extend the flyout beyond the native size limit. `src/ui/flyout.js:47` bounds its content and `src/main.js:1304` clamps the native window to the display work area. Electron checks cover 130% text, light mode, provider visibility/order and the narrow Insights window.
- Fixed: malformed Claude code input forced a new browser approval. `android/app/src/main/java/io/github/sbgitcs/usagemonitor/direct/PhoneSignIn.kt:136` retains the verifier/approval while accepting another paste; line 139 uses the expected state length. Line 303 rejects null/non-string tokens; line 215 reads Codex identity/expiry from token claims when needed. Existing pending fixes were reviewed, built and installed, with their regression tests.
- Fixed: hiding all mobile providers could display a misleading sign-in prompt. `android/app/src/main/java/io/github/sbgitcs/usagemonitor/ui/PlansScreen.kt:115` now explains visibility settings instead.
- Fixed: first-paint screenshots could be blank despite passing rendering assertions. `scripts/ui-smoke.js:127` captures the completed page; desktop and phone screenshots were inspected.

## Nit

No style findings requested or recorded.

## Validation and limits

Desktop regression suite: **137 passed, one platform skip, zero failures**. Source and packaged Electron checks cover flyout, chips, network, settings and Insights. Tests cover account/reset segmentation, persistence, retention, budget dates/byte deltas, snooze, CSV formula escaping, display validation, renderer authorization and support-report redaction. All **69 packaged source files** match the tested checkout. Windows installer, portable and ZIP builds and their update metadata were verified.

Android: **78 unit tests passed**, lint **zero errors and 14 existing warnings**, optimized build succeeded. Installed **1.5.0 / 1050099** on CPH2423 in place. The installed APK digest matches the final build: **11446ba63f294deb952db1bbd0758365ed48a1392b062073b5e887b8bf2e3c6b**, **5,517,555 bytes**. The existing certificate remains **4ef13f3472e2e4fa880e7442bf4f370410db86b6c32ad721a12fb55c050e1769**. Pairing and widget ID **8** were retained; all five tabs, history periods, export picker/cancellation, snooze/resume, diagnostics, dark theme, 130% text and Back navigation passed native checks. Original display preferences were restored. Existing Claude/Grok phone readings remained available; no new provider authorization was performed. Phone returned to its launcher.

The first streamed Android installation timed out; the standard non-streaming signed install succeeded. The native verifier checks the installed APK's SHA-256, not just its reusable version code. Evidence: `.qa/mobile-features-results.json`, `.qa/packaged-source-results.json`, `.qa/release-verification.json`; reproducible checks in `scripts/verify-mobile-features.py` and `scripts/verify-packaged-source.js`.

`npm audit --audit-level=high` passes. Eight moderate advisories remain in the existing build-only electron-builder dependency chain (`package-lock.json:3205`); the suggested forced fix downgrades the builder and is not a verified compatible remediation. No runtime dependency or production signing key was added. History starts with current observations, network budgets exclude unobserved traffic, and delivery-requested events do not guarantee the OS displayed a notification. Feature scope/limitations and competitor references are in `docs/product-improvements.md`. No public release is published by this task.
