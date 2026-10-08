# Usage Monitor for Android

The phone app. It ships with the desktop releases and takes its version from `../package.json`
(1.3.0 becomes version code 1030099; 1.3.0-beta.2 becomes 1030002, so betas sort before the release).

## Build

Needs JDK 17 and the Android SDK (platform 35).

```sh
./gradlew testDebugUnitTest   # unit tests, including the pairing crypto against ../test/fixtures/phone-vectors.json
./gradlew lintDebug
./gradlew assembleDebug       # app/build/outputs/apk/debug/app-debug.apk
```

A debug build is signed with your local debug key, so it can't update a release build (or the
other way round). Uninstall one before installing the other.

Release builds shrink unused code and resources with R8. For a smaller build that can
update the paired development phone with its existing debug key, run:

```sh
./gradlew testDebugUnitTest lintOptimized assembleOptimized
```

The APK is `app/build/outputs/apk/optimized/app-optimized.apk`. This variant uses
release optimization and is not debuggable, but still uses the existing debug signing
identity; it is not a signed public release. Production distribution uses the owner's
release key as described below. Persisted worker and widget names are retained so
existing background jobs and launcher placements survive an optimized update.

### Build with Docker on Windows

From the repository root in PowerShell, this uses the Android SDK image without requiring a
locally configured JDK or SDK. The named volumes retain downloaded dependencies and the debug
signing key between builds:

```powershell
docker run --rm --mount "type=bind,source=$($PWD.Path),target=/workspace" --mount type=volume,source=um-gradle,target=/root/.gradle --mount type=volume,source=um-android-debug,target=/root/.android -w /workspace/android ghcr.io/cirruslabs/android-sdk:35 sh ./gradlew --no-daemon testDebugUnitTest lintDebug assembleDebug
```

The APK lands in `android/app/build/outputs/apk/debug/app-debug.apk`. The verified 2026-09-30
build is also available at `../dist/UsageMonitor-1.3.0-android-debug.apk` (Android 10+).
See `../docs/handoff.md` for test results, checksum and the remaining phone acceptance checks.

## Layout

| Path | What it holds |
| --- | --- |
| `direct/` | Direct usage reading on the phone: the five usage readers, phone sign-ins, the encrypted token vault and which source each meter uses. |
| `pairing/` | Pairing link parsing, the key derivation and request signing shared with `src/phone.js`, and the client that reads the computer. |
| `net/` | Data counts (NetworkStatsManager), live speed (TrafficStats), billing cycle maths, formatting. |
| `device/` | Memory, storage, battery, heat and CPU clock readings. |
| `alerts/` | Notification channels and the plan and data cap alerts. |
| `update/` | Self-update from GitHub releases through the system package installer. |
| `service/`, `tile/` | Status bar speed (foreground service) and its Quick Settings tile. |
| `widget/` | Glance widgets for plans, data and phone status, each at 4×2, 4×1, 2×1 and 1×1. |
| `work/` | WorkManager jobs: refresh every 15 minutes, update check every 6 hours. |
| `ui/` | The Compose screens. |

## Home screen widgets

Every starting size (1×1, 2×1, 4×1 and 4×2) can be resized. Touch and hold a widget,
then drag its side or top/bottom handles to increase or decrease width and height.
The layout follows the available space; the launcher decides the grid increments.

Widgets fetch and redraw in the background about every 15 minutes, on launcher updates,
and after an app update or reboot. With **Show network speed** enabled, they also fetch
every minute while its service runs. Android can delay background jobs to save battery.
Computer plan meters require the paired computer to be reachable; otherwise linked or
phone sign-ins read usage directly, or the last reading is marked cached. Opening the app is not required for
scheduled refreshes. Copilot is excluded from mobile readings and widgets; Codex
remains available alongside Claude, Gemini, Grok and Cursor.

## Home and accounts

**Home** is one compact list: each tool's main window as a bar and a large percentage, and
one line with its reset (or when it runs out at this pace) and its next window. Tap a row for
every window, the account and computer account switching. The header names the computer and
when it was read; readings made on the phone are tagged **Direct** or **Phone**. The
computer's CPU, memory, GPU, disk and network are one card below.

**Accounts** has the **Computer link** (read usage directly with the computer's current
access tokens, approved on the computer) and a row per tool with **Sign in** on the phone for
Claude Code, Codex, Grok Build and Cursor. Gemini reads through the link. Widgets show the
same readings with **PC**, **Direct** or **Phone**; cached values are muted and compact
widgets show **Old**. How each source is chosen, token lifetimes and storage are in
[phone accounts](../docs/phone-accounts.md).

## Release signing

Installed copies only accept an update signed with the same key as the copy they have, so every
release must be signed with one key that never changes. Create it once and keep a backup: if it is
lost, users must uninstall and reinstall to get new versions.

```sh
keytool -genkeypair -v -keystore usage-monitor-release.jks -alias usage-monitor \
  -keyalg RSA -keysize 4096 -validity 36500
base64 -w0 usage-monitor-release.jks > keystore.b64     # macOS: base64 -i usage-monitor-release.jks -o keystore.b64
```

Add these repository secrets (**Settings → Secrets and variables → Actions**):

| Secret | Value |
| --- | --- |
| `ANDROID_KEYSTORE_BASE64` | Contents of `keystore.b64` |
| `ANDROID_KEYSTORE_PASSWORD` | The keystore password |
| `ANDROID_KEY_ALIAS` | `usage-monitor` (or the alias you chose) |
| `ANDROID_KEY_PASSWORD` | The key password (the same as the keystore password unless you set another) |

Then delete `keystore.b64`, and keep the `.jks` file and its passwords somewhere safe outside the
repository. The Release workflow decodes the key, runs `./gradlew releaseBundle`, and attaches
`UsageMonitor-<version>.apk` and `latest-android.json` to the release. Without the secrets the
release is published without the Android app and the workflow shows a warning.

To build a signed APK locally, set `ANDROID_KEYSTORE_PATH` to the `.jks` file plus the three
password and alias variables above, then run `./gradlew releaseBundle`; the files land in
`app/build/dist/`.

## How updates work

`latest-android.json` on each release names the APK, its version code, size and SHA-256. The app
reads it from the latest release (or the newest release of any kind on the Beta channel), and when
the version code is higher it downloads the APK, checks the size, the SHA-256, the package name and
that the signing certificate matches its own, then hands it to Android's package installer. The
first update needs the user to allow installs from Usage Monitor and to confirm; from Android 12
on, later updates install without asking.
