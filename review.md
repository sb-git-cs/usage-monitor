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
