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
