# Production hardening review

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
