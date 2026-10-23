# Changelog

## 1.12.1 — 2026-10-23

- **Android: switch accounts with a tap.** The phone keeps several of its own sign-ins per tool (Claude Code, Codex, Grok Build, Cursor); Home's tool details and the Accounts tab show them as tabs, the one in use selected, with **Add account on this phone** to sign in to another without signing out. Signing out forgets only the account in use. While a tool reads from the computer, the computer's saved accounts are the tabs instead: tapping one asks the computer, which confirms, and **Add account on computer** starts the computer's own sign-in there. Android only; the desktop app is unchanged from 1.12.0.

## 1.12.0 — 2026-10-23

- **Switch accounts with one click.** Every card on the panel has an account menu and Settings → Accounts shows the same sign-ins as tabs. Picking one switches the meters and the tool itself: Usage Monitor keeps a copy of each Claude Code, Codex, Gemini and Cursor sign-in it has seen (encrypted with the computer's keychain where Electron can reach it, owner-only on disk either way) and puts the chosen one back into the tool's login file. Grok's and gh's own saved logins are offered the same way; Copilot switches with `gh auth switch`. **Add account…** keeps the current sign-in and opens a terminal with the tool's sign-in command; the new account joins the list within seconds of signing in (the tool's files are read every 10 s for three minutes). Saved copies can be removed in Settings. The account in use is never removed, and a phone can pick any saved sign-in (you still confirm on the computer).
- **Chips no longer flicker.** The strip was re-stacked as "always on top" every 800 ms and its chips were re-created on every reading, which showed as a flicker beside the taskbar. The level is now set only when it changed or was lost, chips are updated in place, and the window is resized only when its measured size changed.

## 1.11.0 — 2026-10-21

- **Panel:** a toolbar of labelled icons (refresh, Insights, network, pair a phone, keep open, settings) and a **Close** button replace the mixed glyphs and the refresh-interval list, which lives in Settings. The header says when the meters were last read. The summary names the plans at risk and the plan and window that resets next. Cards show **% used** instead of `used/100%`, line their bars up, show the exact reset time on hover and wrap long forecasts. Network and battery sit together under **This computer**, and the battery chart's labels are readable. Signed-out and failed plans show a coloured status line, and an empty or all-hidden panel says what to do.
- **Settings:** a section list with the section in view marked, and each option on one row with its explanation. A new **Appearance** section holds the theme, text size, compact cards and **Plans to show** (visibility and order), moved from Insights → Diagnostics. The theme now applies to every window, Settings and Network usage included, and the chips follow the plan order and visibility too. Changes made from the tray or the Network window appear in an open Settings window at once, and a setting that cannot be saved says so.
- **Insights:** plain names for the tabs and sections, a quota-health label that says what it measures, status dots instead of emoji, and messages that say what happened ("Report saved.") instead of "Saved successfully." for every button. The Markdown report uses the same names.
- **Meters:** a chip turns red when any of its plan's windows reaches the warning level (its tooltip names that window), and its forecast tooltip no longer goes stale. A window short of its limit shows at most 99%, so 100% means the limit is reached. Copilot follows the signed-in gh account, so switching accounts no longer continues the previous account's history (existing Copilot history starts again once). Several Gemini model groups stay separate instead of the last one replacing the others. Forecast notifications for weekly and monthly windows include the date, and slow weekly climbs get a forecast. One threshold crossing warns once even when the account label catches up after a switch, the X Subscription pool changes reader, or the reset sits on a rounding edge. A reading taken just after a reset passed is no longer marked stale. A response without the expected fields keeps the last reading, and a plan with nothing to meter says so. Codex windows of other lengths are named by their length, and a model's own 5-hour limit no longer replaces the plan's on the chip. The combined X Subscription card shows a sign-out or error as it is. Switching the X Subscription setting keeps the other plans' history (for people already on the combined setting, their Claude, Codex, Gemini and Copilot history starts again once).
- **Pace and health:** the pace, runway, safe pace, health score and recommendations read only the current reset cycle, so a window rising fast just after its reset is no longer shown as cooling. A window that resets before it runs out is no longer critical, a sustainable five-hour pace is no longer "elevated", recommendations use plan names and never print "null" or "+-", and resumed sessions, data caps and updates no longer lower quota health. The Overview's pace, the History "to limit" and change figures use the current cycle as well; Daily highs plot each day's highest reading, and a window whose reset has passed no longer counts as the fullest.
- **Tokens:** a Claude response repeated in a resumed session's transcript is counted once. The cache share counts cache writes as prompt tokens, empty `<synthetic>` rows are skipped, and a 7-day period is exactly 7 local days, with empty days shown as zero. The newest alerts are listed first instead of the oldest.
- **Network:** an app's average per minute covers only the time its records are kept. A new data cap counts what the app already used this period, caps keep counting while another app is focused, and a cap set while the clock was ahead rolls over. Hourly and daily chart bars follow the local calendar across daylight-saving changes, and the budget bar uses the warning level.
- **App:** keeping the panel open from its own button no longer leaves an invisible layer that swallowed the next click. Windows shutdown, restart and sign-out save history, battery and network counters like a normal quit. A floating strip that grows stays on screen. Turning off automatic updates after a download no longer restarts the app (the update installs when it quits, or with **Install now**), and copies that can't install updates no longer claim they do. "Check now" on the panel keeps the panel open behind its result. An expired pairing code is withdrawn on time, waking to the lock screen still counts as locked, and a paired phone keeps receiving current CPU and memory while the screen is locked. macOS and Linux read the GPU list every 10 minutes instead of every 5 seconds unless it reports utilization, and macOS reads memory every 10 seconds.

## 1.10.0 — 2026-10-21

- **Meters:** a reset time repeated with a second of jitter is the same window, so forecasts form again and a limit warns once. Readings, history and alerts follow the signed-in account rather than its rotating token. Rate limits honour Retry-After and back off up to an hour. A refused or throttled token refresh is not resent every poll, and a lasting Grok 403 no longer rotates the CLI's login on every poll. A 403 from GitHub or chatgpt.com keeps the last reading instead of reporting a sign-out. Gemini reads a new sign-in at once and keeps quota read before a 429. Codex shows per-model limits in the current response layout, and a blank remaining value is no longer 100% used.
- **Security:** refreshed Claude Code and Grok credential files stay owner-only on macOS and Linux. A paired phone swaps the code-derived key for a random one (`/v1/rekey`), each signed phone request that changes something is accepted once, and a wrong phone clock is reported as such. Packaged builds disable running as Node and Node/inspector options. The click-away window gets a strict CSP and only one call. Pairing, updates and auto-resume accept only the flyout. Workflow actions are pinned to commits.
- **Performance:** the taskbar position comes from the one long-lived watcher instead of a new PowerShell (and C# compile) about every 9 seconds, which cost roughly a tenth of a CPU core. Network totals use the minute index and are cached between record flushes, so the live chips no longer scan every saved record each second. Insights reads Claude and Codex transcripts asynchronously, at most every 30 seconds per period and not while hidden, so opening it no longer freezes the chips. Insights history is rewritten only for new readings and events; byte counters alone are saved every 15 minutes. Battery history is written on a state change and otherwise every 10 minutes, and a computer without a battery is checked every 10 minutes. Alert state keeps only alerts that fired. A missing Codex rollout is searched for again after 5 minutes rather than on every scan. Docked chips are not re-placed while the screen is locked.
- **Network helper:** blocking accepts only an existing program on a local fixed drive, checked again after short names and junctions are resolved. Network shares, Windows system programs and Windows Defender are refused. An installed helper offers **Update** in Network usage to pick this up; CI now fails when the helper's self-test fails.
- **Android:** the phone swaps its pairing key for a random one after pairing (and once for existing pairings), tells a wrong clock apart from a lost pairing, and stops direct reading on the computer before it forgets or switches computers. Pairing links accept only private-network addresses and say when they replace the current pairing. Desktop replies and update downloads are size-capped with overall deadlines, and one update check runs at a time. Battery history is appended instead of rewritten every minute, and insights history moved out of the settings file; both load off the main thread. Settings are excluded from cloud backup and device transfer. Codex per-model limits match the desktop, and a phone without a browser no longer crashes on a usage link.
- **Fixes:** resets more than six days away show their date. The sessions chip opens the flyout again. Insights' 14-day period covers 14 days, uses the configured warning level, shows the shortest runway and keeps keyboard focus across refreshes. Hidden providers are left out of the flyout overview. X Subscription sign-in works from Insights. IPC handlers are registered before windows load, and Settings opens even if its QR code cannot be drawn. The installer asks for the Node.js version the project needs.

## 1.9.0 — 2026-10-21

- Open the flyout as a full-height panel snapped to the right edge of its display; keep the header visible and compact the taskbar chips.
- Estimate battery runtime immediately from native power/current readings when available, with a quicker observed fallback and 10-second active sampling on desktop and phone.
- Correct Gemini weekly limits using current model-pool readings from both Google API hosts, including real decreases after resets. Rate-limit errors no longer fabricate 100% usage.
- Make model usage and trends the default Insights report, with per-model filters, daily CSV/JSON exports, corrected cached-token accounting and deduplicated streamed/cumulative records. Move session reports to a separate tab.
- Harden phone request parsing, connection limits and browser-origin handling; restrict POSIX configuration permissions and escape untrusted report/export fields.

## 1.8.0 — 2026-10-20

- Add a desktop battery chip with percentage and approximate time to empty or full, plus a flyout card and Battery tab in Insights.
- Add phone battery estimates to Android Home, the Phone screen and larger device widgets. Record locally during active use and existing background refreshes.
- Keep 30 days of separate battery observations with charging shading, visible gaps, observed sessions and history clearing. Desktop exports include battery JSON/report data and a separate battery CSV.
- Improve chip grouping, light-theme contrast, keyboard focus and battery layouts at larger text sizes. Label quota health explicitly.

## 1.7.4 — 2026-10-17

- **Professional Executive Insights Suite.** Redesigned the Insights window into an executive-grade dashboard with high-polish UI tabs (Overview, Usage, Burn Rate, Token Intelligence, Network & Budget, Audit & Alerts, Diagnostics & Preferences):
  - **Token Intelligence:** Deep scanning across Claude Code and Codex session logs for prompt tokens, completion tokens, prompt cache read/write efficiency %, and turn volume, with model distribution bars and daily token trends.
  - **Burn Rate & Runway Analysis:** Dynamic quota burn rate (%/h), safe pace estimation (maximum %/h to survive until reset), runway hour forecasting, and automated quota health scoring (Grades A-D, 0-100) with smart recommendations.
  - **Interactive Trajectory Charts:** High-DPI canvas charts with interactive crosshair, floating glassmorphism tooltip, time-of-day peak coding hour bar charts, and one-click Executive Markdown Report export.
- **Fixed Gemini 0% usage glitch and sliding window trap.** Quota windows across `cloudcode-pa` and `daily-cloudcode-pa` are now intelligently merged so that the authoritative weekly pool from `cloudcode-pa` is retained without discarding the active 5-hour model pool from `daily-cloudcode-pa`. The monitor no longer replaces real usage with dummy 0% sliding buckets.
- **Antigravity CLI rate limit detection & seconds parsing.** Added terminal detection for Antigravity's `RESOURCE_EXHAUSTED` and `Individual quota reached` messages, and extended the relative reset parser to support seconds formats (e.g. `Resets in 37m43s`).

## 1.7.3 — 2026-10-16

- **Gemini shows its 5-hour limit.** Google's quota summary no longer includes the Gemini group, so the chip was two identical Flash rows. The allowance shared by the Gemini models is now one 5-hour window. A weekly window is shown when the summary still reports it.

## 1.7.2 — 2026-10-16

- **Chips follow the taskbar.** While the taskbar is hidden, the docked strip hides with it. A screen share that does not include the taskbar no longer shows the strip as a bar on its own.

## 1.7.1 — 2026-10-16

- **Open in terminal (godmode) on the main Windows 11 menu after an update.** The signed menu package ships with the app, so the other PC does not need the Windows SDK. The first launch asks once for administrator approval to trust that package, and the item is then on the main right-click menu. A declined prompt is asked again next launch.
- **Auto-resume follows a 5-hour limit.** When a session stops on the 5-hour window, `continue` is typed a minute after that window resets, even if a weekly window is still full. A weekly limit still waits for the weekly reset. Codex's 5-hour window is the one reported at about 300 minutes.

## 1.7.0 — 2026-10-16

- **Lighter on the system.** While the screen is locked, the computer sleeps, or nobody has used it for five minutes, providers are read once a minute instead of at the chosen interval and coding sessions are checked every 30 seconds (limits are still resumed); everything refreshes at once on return. The chips' CPU, memory, GPU and disk readings pause while the screen is locked or the chips are hidden, and network speed stops updating while locked. The SPACE reading comes from the hardware helper that is already running instead of a new PowerShell process every 30 seconds, and on Windows it counts local fixed drives only. Windows are drawn without GPU acceleration, which keeps about 50 MB less memory and uses less CPU. The session helper returns only coding CLIs among `node` processes.
- **Smaller download.** Only Chromium's English language pack is included, and dependency documentation is left out: the Windows installer is about 9 MB smaller (112 MB) and the installed app about 49 MB smaller.
- **Open in terminal (godmode)** on the File Explorer folder-background menu (right-click empty space in a folder; on Windows 11 it is on the main right-click menu). It starts Claude Code, Codex, Grok Build, Gemini or Cursor in that folder with that CLI's own skip-permissions flag (`claude --dangerously-skip-permissions`, `codex --dangerously-bypass-approvals-and-sandbox`, `grok --always-approve`, `agy --dangerously-skip-permissions`, `cursor-agent --force`). Usage Monitor registers the menu for the current user in the background after it starts, and skips that while the installed menu is current. It needs the Windows SDK (for makeappx and signtool), and Usage Monitor must run as administrator once so Windows trusts the menu package; otherwise the menu is not added and nothing is changed. Its signing certificate goes into the machine Trusted People store, never Trusted Root. The flyout, Settings and the tray menu do not have an auto-accept switch and do not launch these terminals.
- **Sessions** card on the flyout and a sessions chip: Claude Code, Codex, Grok Build, Antigravity, Gemini CLI, Cursor Agent and Copilot CLI sessions running in a terminal, shown as working, waiting for you, or stopped by a usage limit with the time to its reset. Hide the chip in **Settings → Chips**.
- **Resume sessions automatically when a usage limit resets** (Windows, off by default): one minute after the reported reset, `continue` is typed into the same terminal where each session hit the limit. Before typing, that terminal's screen is read and must still show the limit message. Nothing happens if that terminal was closed or no longer shows the message, the process ID now belongs to another program, the session is busy, or the meters still read the window as used up. Each reset is resumed once, with up to three attempts a minute apart; results appear in Insights notifications. A Codex terminal that cannot be linked to one rollout (for example two opened together in one folder) is resumed when the limit message is among its newest lines on screen, using the reset its rollouts or the Codex meter reported. macOS and Linux list Claude Code sessions without typing; Codex sessions are detected on Windows only.
- **Auto-resume for every CLI** (Windows): Grok Build, Antigravity (`agy`), Gemini CLI, Cursor Agent and Copilot CLI terminals are found by their process, listed on the Sessions card, and resumed like Claude Code and Codex. Their own screen must show the CLI's usage-limit message among its newest lines (for example "You hit your weekly limit." or "You have exhausted your quota on this model."). The reset comes from the message ("resets 10:10pm", "try again in 2h") or from that provider's meter. Without either, the session is listed as stopped and nothing is typed. A spending cap or an empty credit balance is not treated as a limit that resets. Instances an editor started without a terminal are not listed.
- Grok Build sessions are read from Grok's own records: the session title, and working or waiting from its turn events (also on macOS and Linux, where they are listed without typing). Cursor Agent terminals show the title of their chat. Each CLI's own busy hint is used, so a Cursor dialog's "Esc to cancel" is no longer read as a running turn, and Antigravity and Cursor at an empty prompt show as waiting for you. Copilot CLI's rate-limit messages ("Sorry, you've hit a rate limit … try again in 4 hours", "wait for your limit to reset in 3 hours 49 minutes") and Cursor's "ends on 8/14/2025" give the reset time.
- Fixed: the Windows session helper could not start once its script grew past the 32,767-character command-line limit; the script now goes in on standard input. Folder names and screen text from the helper keep non-English characters.
- Sessions card and chip: a session whose limit has already reset, or whose reset time was not reported, no longer shows a countdown stuck at "now"; it says the limit reset (type `continue` to resume) or that the reset time is unknown. Waiting on meters that still read 100% is shown as such. The card header shows how many sessions are running and how many are at a limit, and the chip tooltip matches the card. Fixed: switching **Resume after limit** while a scan was running could flip the checkbox back for up to ten seconds.
- Flyout light theme: the "Working" state and the network card's "Now:" line are readable. Settings: saved accounts to choose between are laid out on one line with spacing, with **Switch account** below them.

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
