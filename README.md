# Usage Monitor

A Windows app that shows how much of your **Claude Code**, **Codex**, **Gemini**, and **Grok Build** allowance you have used — at a glance, while you work.

It reuses the logins those CLIs already stored on disk. No API keys. Nothing is sent except the same usage requests the official apps make.

![Flyout](docs/screenshots/tray-flyout.png)

## What you see

| Surface | What it does |
| --- | --- |
| **Flyout** | Two-by-two provider cards (5-hour / weekly, `used/total %`). **Open flyout** / **Hide flyout**. Click outside the panel to close it. **Snap flyout to taskbar** / **Unsnap flyout from taskbar** parks the panel just above the taskbar. |
| **Chips** | Small strip **on** the taskbar with each company’s mark (Anthropic, OpenAI, Gemini, xAI) plus `82/100`. **Snap chips to taskbar** keeps them in an empty gap on the bar; they stay in that slot instead of jumping after a refresh. |
| **Toast** | Silent red Windows notification the first time a bar crosses 80% used. |

![UI overview](docs/screenshots/overview.png)

| Mark | Provider | Windows shown |
| --- | --- | --- |
| Anthropic | Claude Code | 5-hour and weekly |
| OpenAI | Codex | 5-hour and weekly |
| Gemini | Gemini (Antigravity CLI / Gemini CLI) | Gemini model 5-hour and weekly when the API reports them |
| xAI | Grok Build | Weekly only (no 5-hour bar) |

Grok has a **weekly** pool only. Gemini shows the **Gemini model** pools from Antigravity (`agy`) or Gemini CLI; some plans report weekly only.

## Requirements

- Windows 10/11
- [Node.js](https://nodejs.org/) 20 or newer
- Signed in to the tools you want metered:
  - [Claude Code](https://code.claude.com/) (`claude`)
  - [Codex](https://github.com/openai/codex) (`codex`)
  - [Antigravity CLI](https://antigravity.google/) (`agy`) or [Gemini CLI](https://github.com/google-gemini/gemini-cli) (`gemini`)
  - [Grok Build](https://grok.com/) (`grok`)

You do not need all four. A missing login shows as gray with a sign-in hint.

## Install

Clone the app, install the four coding CLIs if they are missing, then start Usage Monitor:

```powershell
git clone https://github.com/sb-git-cs/usage-monitor.git
cd usage-monitor
npm install
npm run setup
```

`npm run setup` runs `scripts/install.ps1`. That script:

1. Installs **Claude Code**, **Codex**, **Antigravity** (`agy`, Gemini), and **Grok Build** using each product’s official Windows installer
2. Skips any CLI already on your PATH
3. Starts Usage Monitor (`npm start`)

You can also double-click `scripts\install.cmd` or run `.\scripts\install.ps1` from the repo root.

Sign in once per tool so the meters can read usage (a missing login shows as a gray chip):

```powershell
claude
codex login
agy
grok
```

Usage Monitor only:

```powershell
npm start
```

`npm start` **detaches** from the terminal: you can close the console and the app keeps running. Quit only from the right-click **Quit** menu. Use `npm run start:fg` if you want logs in the terminal (that process *will* die if you close the console).

The first launch:

- Snaps the compact **chips** widget onto the taskbar in an empty gap (always visible unless you hide it)
- Registers **Start with Windows** (Startup folder shortcut). Uncheck **Start with Windows** in the right-click menu to turn that off.

## Start with Windows

After the first launch, the app starts at sign-in via a hidden **`Usage Monitor.vbs`** in the Windows Startup folder. That runs Electron with no console and no extra host window — only chips (and the flyout if you open it).

To disable, right-click the flyout or chips and uncheck **Start with Windows**.

## Use

- **Left-click** chips → flyout. Click anywhere outside the flyout to close it (unless the flyout is snapped to the taskbar).
- **Right-click** flyout or chips → menu
  - Hide / show chips
  - Refresh now
  - **Refresh every** — 5, 15, 30, or 60 seconds (default **5s**)
  - **Open flyout** / **Hide flyout** (hide minimizes to the taskbar; the app stays there)
  - **Start with Windows** (on by default after first launch)
  - **Snap flyout to taskbar** / **Unsnap flyout from taskbar**
  - **Snap chips to taskbar** / **Unsnap chips from taskbar**
  - Quit
- Drag flyout or chips **from the title bar / dotted grip** to move them anywhere. Positions are saved.
- Flyout uses a **two-by-two card** layout. Snap to taskbar keeps chips on the bar and the flyout panel just above it. Snapped chips keep their gap on the bar across refreshes.
- Click a provider card to open that product’s official usage page (Claude, Codex, [Antigravity](https://antigravity.google), Grok)

Meters show **used/total %** (for example `82/100%`), not remaining. A full 5-hour window reads `100/100%` in red.

## Privacy

- Runs only on your PC
- Reads `%USERPROFILE%\.claude`, `.codex`, `.gemini`, and `.grok` credentials the CLIs already wrote (Gemini also uses the Windows Credential Manager entry `gemini:antigravity`)
- Polls each provider’s usage endpoint; never sends prompts, files, or chat history
- Logs and cache stay under `%APPDATA%\UsageMonitor` and `%LOCALAPPDATA%\UsageMonitor`

## Troubleshooting

| Symptom | What to try |
| --- | --- |
| Gray company mark | Open that CLI once and sign in (`claude`, `codex login`, `agy`, `grok`). If the CLI is missing, run `npm run setup`. |
| No chips on the taskbar | Right-click flyout → **Show chips on taskbar**. They sit in an empty gap, not over the clock. |
| Chips jump or leave a gap on the taskbar | Right-click → **Snap chips to taskbar**, then drag the dotted grip to the gap you want. They stay there instead of re-snapping on every refresh. |
| Flyout missing | Right-click chips → **Open flyout**. Click outside the flyout to close it. |
| Claude stuck / stale | The usage API rate-limits aggressive polling. The app backs off and keeps the last good numbers |
| Does not start at logon | Run `npm run start:silent` once, leave **Start with Windows** checked. Confirm `Usage Monitor.vbs` exists in the Windows Startup folder. |
| Extra Electron window / dies with the terminal | Use `npm start` (detached). Quit only from the right-click **Quit** menu. |
| Quit | Right-click chips or flyout → **Quit**. Hiding the flyout only minimizes it. |

## License

MIT
