# Usage Monitor

A Windows app that shows how much of your **Claude Code**, **Codex**, **Gemini**, and **Grok Build** allowance you have used — at a glance, while you work.

It reuses the logins those CLIs already stored on disk. No API keys. Nothing is sent except the same usage requests the official apps make.

![Flyout](docs/screenshots/tray-flyout.png)

## What you see

| Surface | What it does |
| --- | --- |
| **Flyout** | Two-by-two provider cards (5-hour / weekly, `used/total %`). **Open flyout** / **Hide flyout**. **Snap flyout to taskbar** / **Unsnap flyout from taskbar** parks the panel just above the taskbar. |
| **Chips** | Small `C 82/100` strip **on** the taskbar (`C` Claude, `X` Codex, `M` Gemini, `G` Grok). **Snap chips to taskbar** / **Unsnap chips from taskbar**. |
| **Toast** | Silent red Windows notification the first time a bar crosses 80% used. |

![UI overview](docs/screenshots/overview.png)

Grok has a **weekly** pool only. The app does not invent a 5-hour Grok bar. Gemini shows the **Gemini model** 5-hour and weekly pools from Antigravity / Gemini CLI.

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

```powershell
git clone https://github.com/shivam-17/usage-monitor.git
cd usage-monitor
npm install
npm start
```

`npm start` **detaches** from the terminal: you can close the console and the app keeps running. Quit only from the right-click **Quit** menu. Use `npm run start:fg` if you want logs in the terminal (that process *will* die if you close the console).

The first launch:

- Puts **Usage Monitor** on the Windows taskbar (click it to show the flyout)
- Snaps the compact **chips** widget onto the taskbar in an empty gap (always visible unless you hide it)
- Registers **Start with Windows** (login item + Startup folder shortcut). Uncheck **Start with Windows** in the right-click menu to turn that off.

## Start with Windows

After the first launch, the app starts at sign-in via a hidden **`Usage Monitor.vbs`** in the Windows Startup folder. That runs Electron with no console and no extra host window — only chips (and the flyout if you open it).

To disable, right-click the flyout or chips and uncheck **Start with Windows**.

## Use

- **Left-click** chips → flyout
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
- Flyout uses a **two-by-two card** layout. Snap to taskbar keeps chips on the bar and the flyout panel just above it.
- Click a provider card to open that product’s official usage page

Meters show **used/total %** (for example `82/100%`), not remaining. A full 5-hour window reads `100/100%` in red.

## Privacy

- Runs only on your PC
- Reads `%USERPROFILE%\.claude`, `.codex`, `.gemini`, and `.grok` credentials the CLIs already wrote (Gemini also uses the Windows Credential Manager entry `gemini:antigravity`)
- Polls each provider’s usage endpoint; never sends prompts, files, or chat history
- Logs and cache stay under `%APPDATA%\UsageMonitor` and `%LOCALAPPDATA%\UsageMonitor`

## Troubleshooting

| Symptom | What to try |
| --- | --- |
| Gray `C` / `X` / `M` / `G` | Open that CLI once and sign in (`claude`, `codex login`, `agy`, `grok login`) |
| No chips on the taskbar | Right-click flyout → **Show chips on taskbar**. They sit in an empty gap, not over the clock. |
| Flyout missing | Click **Usage Monitor** on the Windows taskbar, or right-click chips → **Open flyout** |
| Claude stuck / stale | The usage API rate-limits aggressive polling. The app backs off for 15 minutes and keeps the last good numbers |
| Does not start at logon | Run `npm run start:silent` once, leave **Start with Windows** checked. Confirm `Usage Monitor.vbs` exists in the Windows Startup folder. |
| Extra Electron window / dies with the terminal | Use `npm start` (detached). Quit only from the right-click **Quit** menu. |
| Quit | Right-click chips or flyout → **Quit**. Hiding the flyout only minimizes it. |

## License

MIT
