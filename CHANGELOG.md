# Changelog

## Unreleased

- **Settings window** (tray menu → Settings…, or ⚙ in the flyout): start at login, refresh interval, the "warn at" percentage (50–95%, was fixed at 80%), limit and forecast notifications, quiet hours, which chips the strip shows, automatic updates with a Stable or Beta channel, and phone sharing.
- **Burn-rate forecast**: the flyout shows when a plan window will reach 100% at the current pace, if that happens before it resets, and an optional notification says so once per window when it is half used.
- **Phone sharing** for the new Android app: pair a phone with a QR code and it shows this computer's plan meters. Off by default; the phone only receives the numbers, encrypted, and your logins never leave the computer.
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
