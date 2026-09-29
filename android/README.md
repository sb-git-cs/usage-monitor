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

## Layout

| Path | What it holds |
| --- | --- |
| `pairing/` | Pairing link parsing, the key derivation and request signing shared with `src/phone.js`, and the client that reads the computer. |
| `net/` | Data counts (NetworkStatsManager), live speed (TrafficStats), billing cycle maths, formatting. |
| `device/` | Memory, storage, battery, heat and CPU clock readings. |
| `alerts/` | Notification channels and the plan and data cap alerts. |
| `update/` | Self-update from GitHub releases through the system package installer. |
| `service/`, `tile/` | Status bar speed (foreground service) and its Quick Settings tile. |
| `widget/` | The three Glance widgets. |
| `work/` | WorkManager jobs: refresh every 15 minutes, update check every 6 hours. |
| `ui/` | The Compose screens. |

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
