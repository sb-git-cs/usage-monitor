# Contributing

Thanks for helping improve Usage Monitor. Bug reports, ideas and pull requests are all welcome.

## Reporting a bug

Open a [bug report](https://github.com/sb-git-cs/usage-monitor/issues/new?template=bug_report.yml) with:

- Your OS and version, and whether you run a packaged build or `npm start`
- Which provider (Claude Code, Codex, Gemini, Grok) or which part of Network usage is affected
- What the chip, flyout or window showed, and what you expected

Never paste tokens or the contents of `~/.claude`, `~/.codex`, `~/.gemini` or `~/.grok`.

## Development setup

```sh
git clone https://github.com/sb-git-cs/usage-monitor.git
cd usage-monitor
npm ci
npm run start:fg   # runs in the foreground with logs
```

Requires Node.js 22.13 or newer.

## Before opening a pull request

```sh
npm test          # unit tests
npm run test:ui   # real Electron windows, offscreen
```

- Keep changes focused; one fix or feature per pull request.
- Add or update a test for behavior changes. Tests use synthetic credentials and responses only.
- If you change the UI, regenerate the screenshots with `npm run screenshots`.
- CI runs on Windows, macOS and Linux; a pull request needs all three green.

## Project layout

| Path | What it holds |
| --- | --- |
| `src/main.js` | Electron main process: windows, tray, menus |
| `src/updater.js`, `scripts/post-update.js` | Automatic updates (git checkouts, installer/AppImage via electron-updater, notify-only formats) |
| `src/log.js` | Main-process log file (`logs/main.log`) and crash handlers |
| `src/adapters/` | One file per provider; reads the CLI login and fetches usage |
| `src/poller.js`, `src/models.js` | Polling, caching and quota normalization |
| `src/net/` | Network usage: capture providers per OS, engine, SQLite store |
| `src/ui/` | Flyout, chips and Network usage window (HTML/CSS/JS) |
| `helpers/windows/NetCapture.cs` | Windows capture helper (ETW), compiled on the user's PC |
| `scripts/` | Setup, start, screenshots, UI smoke test and live capture probe |
| `test/` | Unit tests (`node --test`) |

## Releasing

Bump `version` in `package.json`, add a `CHANGELOG.md` section and commit, then push a matching tag (`git tag v1.0.1 && git push origin v1.0.1`) or run **Actions → Release → Run workflow** with **publish** ticked. The Release workflow builds every platform, creates the tag if needed and publishes the installers together with `latest*.yml` and `*.blockmap`, which installed copies read to update themselves. Never delete those files from a release.
