# Professional desktop improvements — 2026-10-11

Implemented in 1.5.0 for the local Electron desktop app and the Android companion. Existing Android authentication fixes are included and tested.

## Competitor evidence

- [CodexBar UI documentation](https://github.com/steipete/CodexBar/blob/main/docs/ui.md): reset display, usage pace, provider menus, reporting coverage and exports.
- [TokenBar](https://www.tokenbar.site/): consolidated agent activity, usage and costs; [use cases](https://www.tokenbar.site/use-cases) describe live session monitoring and local-first tracking.
- [GlassWire quick start](https://www.glasswire.com/quickstartguide/): historical traffic exploration, day/week/month summaries, themes and notification snoozing. [User guide](https://www.glasswire.com/userguide/) documents bandwidth threshold alerts.

Usage Monitor already offers forecasts, threshold/quiet-hours notifications, network history, per-app caps, filters and CSV export. Adding duplicates would not improve the product.

## Implemented locally

- Flyout overview: providers reporting current numeric usage, providers at risk, earliest future quota reset and explicit unavailable/cached coverage. Each provider counts once; stale and failed readings do not drive current advice.
- Risk uses the configured alert threshold or a future forecast that precedes reset. It is an estimate based on existing data, not a guarantee of availability.
- Clear used/limit and reset legend; summary hierarchy, larger toolbar targets, hover and keyboard-focus treatment, account text truncation.
- Keyboard activation of provider/network cards; progressbar semantics; preserve provider focus across polling updates.
- Preserve saved meters while exposing fetch/sign-in errors; suppress forecasts from stale readings.

## Roadmap implementation

| Feature | Desktop | Android |
| --- | --- | --- |
| Plan history | 24h/7d/30d observed charts, CSV/JSON export, 31-day retention | Same periods, JSON export with Android's file picker, 31-day retention |
| Notification centre | Last 200 events, requested/suppressed/unsupported delivery status, 15m/1h/4h snooze and resume | Last 200 retained events (50 displayed), requested/suppressed/permission-denied status, 1h snooze and resume |
| Diagnostics | Provider state and last successful reading, capture health, retry/account/network actions, redacted JSON support export | Provider/source/last-read state, computer reachability and notification/usage permissions, retry/Accounts, redacted JSON support export |
| Network budget | Independent captured-byte ledger, local billing day, allowance, threshold warning and observed-pace projection | Existing Android mobile/Wi-Fi totals, billing day, mobile monthly/daily caps and cycle projection retained |
| Display | System/light/dark, 100/115/130% text, compact flyout, provider visibility/order | System/light/dark, 100/115/130% text (on top of system accessibility scaling), Home provider visibility |

History starts with new current numeric readings; no past observations are manufactured. Known account identifiers are stored only as pseudonymous hashes in reports. When identity is unavailable, that provider's account cannot be separated reliably and is explicitly marked unidentified. Reset changes or falling quota percentages create separate chart segments. Subscription percentages are not additive daily consumption, token totals or API costs.

Desktop budget totals count capture samples independently of app focus/ignore settings. They exclude recording gaps, periods when the PC was off and unobserved traffic. Linux's capture source excludes UDP/QUIC. The projection requires 24 hours of observed elapsed time and remains an estimate; it is not an ISP bill. Android's data totals come from its existing NetworkStats integration, subject to Usage access and OS reporting.

Notification delivery requested means the OS was asked to show a notification; it does not guarantee the user saw it. Support reports exclude accounts, credentials, paths, domains and notification text. History exports include pseudonymous account references. Settings, pairing and widget identities are retained on the signed in-place mobile update.
