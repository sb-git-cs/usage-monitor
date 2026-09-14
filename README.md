# Usage Monitor

A Windows tray app that shows how much of your **Claude Code**, **Codex**, and **Grok Build** allowance you have used — at a glance, while you work.

It reuses the logins those CLIs already stored on disk. No API keys. Nothing is sent except the same usage requests the official apps make.

![Desktop overlay](docs/screenshots/overlay.png)

## What you see

| Surface | What it does |
| --- | --- |
| **Chips bar** (`C` / `X` / `G`) | Semi-transparent, click-through around the chips so it does not block the desktop. Drag the dotted grip to move. Optional **Dock chips to taskbar** sits it on the taskbar, left of the clock / tray icons. Shows **used/total %**. Red means under 20% remaining. |
| **Flyout** | Semi-transparent compact meters. Drag the title bar to move. Pin to keep it open, or **Dock flyout to taskbar** to sit it left of the clock / tray icons as a widget. Empty space around it clicks through. |
| **Overlay** | Always-on-top HUD with larger meters. Pin it, drag it, close it (quit is tray-only). |
| **Toast** | Silent red Windows notification the first time a bar crosses 80% used. |

![Taskbar flyout](docs/screenshots/tray-flyout.png)

Grok has a **weekly** pool only. The app does not invent a 5-hour Grok bar.

![UI overview](docs/screenshots/overview.png)

## Requirements

- Windows 10/11
- [Node.js](https://nodejs.org/) 20 or newer
- Signed in to the tools you want metered:
  - [Claude Code](https://code.claude.com/) (`claude`)
  - [Codex](https://github.com/openai/codex) (`codex`)
  - [Grok Build](https://grok.com/) (`grok`)

You do not need all three. A missing login shows as gray with a sign-in hint.

## Install

```powershell
git clone https://github.com/shivam-17/usage-monitor.git
cd usage-monitor
npm install
npm start
```

The first launch:

- Shows the overlay on the right of the screen
- Places a movable, semi-transparent `C` / `X` / `G` chips bar (dock it to the taskbar from the menu if you want it as a widget)
- Enables **Start with Windows** (uncheck from the tray menu if you do not want that)

## Use

- **Left-click** a tray chip → flyout
- **Right-click** a tray chip → menu
  - Open / hide overlay
  - Refresh now
  - **Refresh every** — 5, 15, 30, or 60 seconds (default **5s**)
  - Start with Windows
  - Pin overlay
  - **Keep flyout open** — stays up and can be dragged
  - **Dock flyout to taskbar** — widget on the taskbar, left of the tray icons
  - Dock chips to taskbar
  - Quit
- Drag the flyout title bar to move it. Dragging a docked flyout undocks it. The panel is glass (see-through); clicks on empty space pass through to whatever is behind.
- Overlay **×** hides the HUD; it does not quit the app
- Click a provider card to open that product’s official usage page

Meters show **used/total %** (for example `82/100%`), not remaining. A full 5-hour window reads `100/100%` in red.

## Privacy

- Runs only on your PC
- Reads `%USERPROFILE%\.claude`, `.codex`, and `.grok` credentials the CLIs already wrote
- Polls each provider’s usage endpoint; never sends prompts, files, or chat history
- Logs and cache stay under `%APPDATA%\UsageMonitor` and `%LOCALAPPDATA%\UsageMonitor`

## Troubleshooting

| Symptom | What to try |
| --- | --- |
| Gray `C` / `X` / `G` | Open that CLI once and sign in (`claude`, `codex login`, `grok login`) |
| No chips by the clock | Right-click a tray icon → uncheck **Dock chips to taskbar**, or drag the grip. System tray icons may still sit behind **^** |
| Overlay missing | Right-click a chip → **Open overlay** |
| Claude stuck / stale | The usage API rate-limits aggressive polling. The app backs off for 15 minutes and keeps the last good numbers |
| Quit | Right-click a tray chip → **Quit** (closing the overlay is not enough) |

## License

MIT
