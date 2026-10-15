# Changelog

## Unreleased

- **Sessions** card on the flyout and a sessions chip: Claude Code and Codex sessions running in a terminal, shown as working, waiting for you, or stopped by a usage limit with the time to its reset. Hide the chip in **Settings → Chips**.
- **Resume sessions automatically when a usage limit resets** (Windows, off by default): one minute after the reported reset, `continue` is typed into the same terminal where each session hit the limit. Before typing, that terminal's screen is read and must still show the limit message. Nothing happens if that terminal was closed or no longer shows the message, the process ID now belongs to another program, the session is busy, or the meters still read the window as used up. Each reset is resumed once, with up to three attempts a minute apart; results appear in Insights notifications. A Codex terminal that cannot be linked to one rollout (for example two opened together in one folder) is resumed when the limit message is among its newest lines on screen, using the reset its rollouts or the Codex meter reported. macOS and Linux list Claude Code sessions without typing; Codex sessions are detected on Windows only.

## 1.6.0 — 2026-10-14

- Added a persisted **Use combined X Subscription** toggle on desktop and Android, off by default. Combined mode shows one verified shared weekly meter across chips, flyout, Home, summaries and Plan widgets; Additional Usage credits stay separate and both account controls remain available.
- Shared totals require explicit weekly/reset and product-coverage evidence. Removed invented zero readings and product-percentage summation; monthly fallback usage keeps monthly reset semantics. Unverified usage links to the provider dashboard, and cached readings remain stale.
- Scoped caches, history and pending polls by subscription regime/account; changes during refresh discard the previous selection. Phone snapshots and linked credentials carry backward-compatible regime metadata. Linked replacement readings deduplicate shared-pool warnings by stable account ID.
- Fixed Grok/Cursor HTTP 403 handling, expired direct phone windows, stale account relabelling, missing desktop Cursor/Copilot dashboard routes and unavailable-state hints. Added regression coverage and refreshed sanitized desktop/native Android screenshots for both regimes.
- Stable desktop downloads; Android source and screenshots included. The optimized development APK uses the existing local key and is not attached to the public release when production signing is unavailable.

## 1.5.0 — 2026-10-11

- **Insights** on the desktop flyout/tray and Android toolbar: observed plan history for 24 hours, 7 days or 30 days, separated by account reference and reset segment. Up to 31 days retained; cached readings are excluded. Desktop exports CSV/JSON; Android exports JSON using the system file picker. Percentages are not token counts or costs.
- **Notification centre** records quota and network warnings with delivery-requested, suppressed or unavailable states. Snooze persists across restart; quiet hours still apply. Android offers one-hour snooze and resume.
- Desktop **network budget** counts captured traffic across apps independently of list filters, with a billing day, allowance, warning and observed-pace projection. Recording gaps and traffic the capture source cannot observe are excluded; this is not an ISP total.
- **Diagnostics** shows provider reading status, last successful/read times and capture health, with retry/account/network actions and a redacted JSON support report that excludes credentials, identities and traffic details.
- Desktop **display preferences**: system/light/dark theme, 100/115/130% text, compact flyout, provider visibility/order. Android adds theme, text size and Home provider visibility. System accessibility text scaling is retained.
- Desktop overview shows current reporting coverage, at-risk providers and the next reset. Meter cards support keyboard activation, progressbar semantics and focus preservation across refreshes.
- Forecast history and warning deduplication now separate known accounts. Stale or expired forecasts are not presented as current advice. Large-text flyouts fit the available desktop area and scroll when necessary.
- Android Claude authorization uses the expected state length; a malformed pasted code can be corrected without restarting approval. Null/malformed renewal fields no longer become literal tokens, and Codex can recover account identity and expiry from access-token claims.
- Android screenshots in the README: Home (light and dark), Data and Phone, rendered from the real screens with demo data by `ScreenshotsTest` and kept current by the *Android screenshots* workflow.
- Electron 44.7.0 and systeminformation 5.33.15.
- `npm test` installs the Electron binary first. Electron 44 downloads it on first use, and parallel test files could race to unpack it on Windows.

The Android optimized build uses the existing development signing key for an in-place local update. No public release or production Android signing key is created by this work.

## 1.4.0 — 2026-10-08

- **Pair a phone** on the flyout and in Settings shows a QR code and a typeable code immediately, and turns phone sharing on. The code lasts 10 minutes and stays on the flyout if Settings is closed. **Cancel** withdraws it.
- Android home screen widgets come in **4×2**, **4×1**, **2×1** and **1×1**. All presets can grow or shrink in both directions and refresh automatically in the background.
- Settings, the flyout and the Android app show which account each plan meter is reading. **Switch account** opens that tool's browser sign-in page; the meter follows the account signed in to its CLI. When Grok has more than one saved sign-in, pick the one the meters should follow. A paired phone can ask for the same switch; the computer asks you to confirm it.
- **Cursor** and **GitHub Copilot** meters when that account is signed in on this computer. Cursor shows Included, Auto and API usage for the current billing cycle. Copilot shows the chat, completions and premium allowances the plan includes. A Free plan is shown with those allowances. The strip leaves either one off when it is not installed. Copilot is excluded from Android; Codex remains available on both platforms.
- **Phone reads accounts directly.** On Android, **Accounts → Link sign-ins** asks the computer (you confirm there) to hand the phone its current Claude Code, Codex, Gemini, Grok and Cursor access tokens, so meters stay current away from the computer until each token expires. Refresh tokens never leave the computer. **Stop direct reading** in Settings → Phone, or on the phone, ends it.
- **Sign in on the phone** to Claude Code, Codex, Grok Build or Cursor for meters that work without the computer at all. Each phone sign-in is separate from the computer's, stays encrypted with an Android Keystore key, and is used only to read usage. Gemini reads through the computer link.
- Android Home is one compact list: each tool's main window as a bar and a large percentage, with one line for its reset or forecast and its next window. The computer's CPU, memory, GPU and disk are one line. Readings made on the phone are tagged **Direct** or **Phone**.
- Phone sign-ins survive temporary renewal failures; concurrent background refreshes cannot rotate the same refresh token twice. Sign-in verifies the first usage report, and cancelled attempts cannot overwrite a newer sign-in.
- Widgets retain cached percentages with an **Old** label and distinguish **Sign in** from **Retry**. Cached text readings and forecasts are preserved.
- Android release builds shrink unused code and resources while preserving background worker and widget identities.
- Cursor and Copilot reject missing or malformed quota values instead of displaying false 0% or 100% readings. Invalid Cursor billing dates no longer discard valid usage.
- Revoking a phone or stopping direct reading also blocks token requests that are still in progress.
- Updated desktop build dependencies to remove reported high and critical security vulnerabilities.

This release publishes desktop downloads only. Android changes are included in the source;
an Android APK is not attached.

## 1.3.0 — 2026-09-29

### Android app, settings window and forecasts

- **Settings window** (tray menu → Settings…, or ⚙ in the flyout): start at login, refresh interval, the "warn at" percentage (50–95%, was fixed at 80%), limit and forecast notifications, quiet hours, which chips the strip shows, automatic updates with a Stable or Beta channel, and phone sharing.
- **Burn-rate forecast**: the flyout shows when a plan window will reach 100% at the current pace, if that happens before it resets, and an optional notification says so once per window when it is half used.
- **Phone sharing** for the new Android app: pair a phone with a QR code and it shows this computer's plan meters. Off by default; the phone only receives the numbers, encrypted, and your logins never leave the computer.
- **Android app** (Android 10 and later, `UsageMonitor-<version>.apk` on each release):
  - **Plans**: the computer's Claude Code, Codex, Gemini and Grok Build meters with reset times and forecasts, plus its CPU, memory, GPU, disk and network, read over Wi-Fi every 30 seconds while open.
  - **Data**: live download and upload speed, mobile and Wi-Fi data today and this billing cycle, and data per app, from Android's own counts (needs Usage access).
  - **Data plan and caps**: billing day, monthly and daily mobile caps, a projection to the end of the cycle, and a notification when a cap reaches your warning level or runs out.
  - **This phone**: CPU clock per core, memory, storage, battery level, temperature and current, and heat status.
  - **Status bar speed** that updates every second, with a Quick Settings tile to switch it on and off.
  - **Widgets**: Plan meters, Data usage and Phone status. They refresh every 15 minutes in the background, every minute while the status bar speed is on, and whenever the app is opened.
  - **Alerts** like the desktop's (plan warning, limit reached, forecast), with quiet hours.
  - **Updates itself** from GitHub releases: it checks when opened and every six hours, checks the download's SHA-256 and signature, and installs it. Stable or Beta channel.
- Windows: GPU and disk readings come from one PowerShell process that stays running, instead of starting PowerShell every 5 seconds, which roughly halves the CPU the readings cost.

## 1.2.0 — 2026-09-29

### Two-row chips and system readings

- The chips strip is now two compact rows: each provider's mark with a short percentage, and download stacked over upload. Beside them are **CPU**, **MEM**, **GPU** (only when one is detected), **DISK** and **SPACE**. An unavailable reading shows a dash, and a value of 80% or more turns amber.
- CPU and memory refresh every 2 seconds, GPU and disk activity every 5 seconds, and storage every 30 seconds. On Windows DISK is the busiest physical disk's active time and SPACE is the fullest volume; hover either for per-drive values. On Windows the GPU and disk readings come from a short PowerShell query every 5 seconds. On macOS and Linux DISK shows read + write throughput, and GPU depends on driver support.
- Docked on the Windows taskbar, the strip is sized to the taskbar height and centered with an equal inset above and below, including on a 48px taskbar.

## 1.1.0 — 2026-09-28

### Automatic updates

- Usage Monitor now updates itself. It checks GitHub about 8 seconds after it starts, 30 seconds after the computer wakes or is unlocked, and every six hours, retries after 1, 5 and 15 minutes when offline, then installs the new version and restarts with a notification. It waits while you are working in the Network usage window or a menu.
- **Windows installer** and **Linux AppImage**: the new release is downloaded (only the changed blocks when possible), its SHA-512 checked, installed silently and started.
- **git clone**: fast-forwards to GitHub. Dependencies are reinstalled after the app has quit (`scripts/post-update.js`), because `npm ci` would delete the Electron binary the app runs from. Uncommitted changes, local commits and detached checkouts are left alone and reported.
- **Portable exe, zip, tar.gz and macOS**: one notification per new version with a direct download link, since these can't replace themselves.
- **Install updates automatically** replaces **Check for updates at startup** (an opt-out carries over). **Check for updates now** always works. The flyout footer shows the version and update status with **Check now** / **Download**.
- Releases now publish `latest.yml`, `latest-linux.yml`, `latest-mac.yml` and `*.blockmap` for installed copies to read.

### Fixes from the 2026-09-28 audit

See [`docs/audit-2026-09-28.md`](docs/audit-2026-09-28.md) for details.

- Updating a clone no longer breaks the app: the old updater ran `npm ci` while running, deleting its own Electron binary (A-01). Clones without an upstream branch update from `origin/main` (A-02); diverged history and hidden git credential prompts no longer look like failures (A-03, A-04); restarts go through normal shutdown so settings and network records are saved (A-05).
- Windows: Gemini no longer starts PowerShell and compiles a Credential Manager reader on every poll when you aren't signed in to Gemini (A-08). The `agy` binary is read asynchronously and only once per version when looking for its OAuth client (A-09).
- Chips and flyout move back onto a remaining screen when a monitor is unplugged (A-10).
- Errors, crashes and update activity are written to `logs/main.log` (1 MB, previous file kept) instead of being lost, and an uncaught error no longer opens a modal error box (A-11).
- The snapshot and alert caches are no longer rewritten every poll when nothing changed (A-12).
- Network usage: a failed CSV export shows why (A-13); a banner warns when records can't be saved, for example on a full disk or a removed records drive (A-14); domain updates for recorded connections use an index (A-17).

## 1.0.0 — 2026-09-26

First release: plan meters for Claude Code, Codex, Gemini and Grok Build; per-app network usage on Windows, macOS and Linux; installers for all three platforms.
