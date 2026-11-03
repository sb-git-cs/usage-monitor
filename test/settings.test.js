const test = require("node:test");
const assert = require("node:assert/strict");
const { load } = require("./helpers");
const config = require("../src/config");

test("configuration containing pairing keys is stored with private POSIX permissions", { skip: process.platform === "win32" }, (t) => {
  const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "um-private-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, "config"), file = path.join(directory, "config.json");
  fs.mkdirSync(directory, { mode: 0o755 }); fs.writeFileSync(file, "{}", { mode: 0o644 });
  const isolated = load("src/config.js", { "./paths": { configDir: () => directory, configPath: () => file } });
  assert.equal(isolated.save({ phone: { key: "synthetic" } }), true);
  assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test("refreshed CLI credentials stay owner-only, even over a leftover temporary file", (t) => {
  const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
  const { writeSecretFile } = require("../src/paths");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "um-secret-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, ".credentials.json");
  fs.writeFileSync(file, "{\"old\":true}", { mode: 0o600 });
  fs.writeFileSync(`${file}.tmp`, "stale", { mode: 0o644 });
  writeSecretFile(file, "{\"accessToken\":\"synthetic\"}");
  assert.equal(fs.readFileSync(file, "utf8"), "{\"accessToken\":\"synthetic\"}");
  assert.equal(fs.existsSync(`${file}.tmp`), false);
  if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test("new settings are validated and never share nested defaults", () => {
  const cfg = config.normalize({
    alert_threshold: 73,
    quiet_hours: { enabled: "yes", start: "25:00", end: "06:30" },
    chips_show: { gpu: false, claude: "no" },
    update_channel: "nightly",
    phone: { enabled: true, port: 80, devices: [{ id: "zz", key: "k" }, { id: "0123456789abcdef", key: "A".repeat(43), name: "  Pixel 8  ", direct: "yes" }] },
  });
  assert.equal(cfg.alert_threshold, 80, "only the offered steps are accepted");
  assert.deepEqual(cfg.quiet_hours, { enabled: false, start: "22:00", end: "06:30" });
  assert.equal(cfg.chips_show.gpu, false);
  assert.equal(cfg.chips_show.claude, true, "anything but false keeps a chip visible");
  assert.equal(cfg.update_channel, "stable");
  assert.equal(cfg.phone.port, 47329, "privileged ports are refused");
  assert.equal(cfg.phone.enabled, true);
  assert.equal(cfg.phone.devices.length, 1);
  assert.equal(cfg.phone.devices[0].name, "Pixel 8");
  assert.equal(cfg.phone.devices[0].direct, false, "only an explicit true allows direct reading");
  cfg.quiet_hours.enabled = true;
  cfg.chips_show.cpu = false;
  cfg.phone.devices.push({});
  cfg.accounts.grok = "changed";
  const fresh = config.normalize({});
  assert.equal(fresh.quiet_hours.enabled, false);
  assert.equal(fresh.chips_show.cpu, true);
  assert.equal(fresh.chips_show.cursor, true);
  assert.equal(fresh.chips_show.copilot, true);
  assert.equal(fresh.phone.devices.length, 0);
  assert.deepEqual(fresh.accounts, {});
  assert.equal("changed" in fresh.accounts, false);
  assert.deepEqual(config.normalize({ accounts: { grok: "user-1", cursor: "person@example.com", claude: "../x", extra: "no" } }).accounts, { grok: "user-1", cursor: "person@example.com" });
});

test("quiet hours handle ranges that wrap past midnight", () => {
  const at = (h, m = 0) => new Date(2026, 8, 29, h, m);
  const night = { quiet_hours: { enabled: true, start: "22:00", end: "07:00" } };
  assert.equal(config.inQuietHours(night, at(23)), true);
  assert.equal(config.inQuietHours(night, at(6, 59)), true);
  assert.equal(config.inQuietHours(night, at(7)), false);
  assert.equal(config.inQuietHours(night, at(12)), false);
  const lunch = { quiet_hours: { enabled: true, start: "12:00", end: "13:30" } };
  assert.equal(config.inQuietHours(lunch, at(13, 15)), true);
  assert.equal(config.inQuietHours(lunch, at(13, 30)), false);
  assert.equal(config.inQuietHours({ quiet_hours: { ...night.quiet_hours, enabled: false } }, at(23)), false);
});

function alertHarness() {
  let state = { fired: {} };
  const shown = [];
  class Notification {
    static isSupported() { return true; }
    constructor(options) { this.options = options; }
    show() { shown.push(this.options); }
    on() {}
  }
  const alerts = load("src/alerts.js", {
    electron: { Notification },
    "./cache": { loadAlertState: () => state, saveAlertState: (s) => { state = s; } },
  });
  return { alerts, shown };
}

const soon = (min) => new Date(Date.now() + min * 60000).toISOString();
const snap = (used, extra = {}) => ({ providers: [{ id: "claude", display_name: "Claude Code", status: { state: "ok" },
  windows: [{ kind: "five_hour", label: "5h", used_pct: used, resets_at: soon(120), ...extra }] }] });

test("alerts use the configured threshold and stay silent in quiet hours", () => {
  const { alerts, shown } = alertHarness();
  alerts.evaluate(snap(65), { threshold: 70 });
  assert.equal(shown.length, 0);
  alerts.evaluate(snap(71), { threshold: 70 });
  assert.equal(shown.length, 1);
  assert.match(shown[0].body, /5h window: 71% used/);
  const quiet = alertHarness();
  quiet.alerts.evaluate(snap(90), { threshold: 70, quiet: true });
  quiet.alerts.evaluate(snap(91), { threshold: 70 });
  assert.equal(quiet.shown.length, 0, "a crossing during quiet hours is not replayed afterwards");
});

test("a forecast warning is shown once per window, only when enabled and half used", () => {
  const { alerts, shown } = alertHarness();
  const forecast = { forecast_at: soon(40), burn_per_hour: 30 };
  alerts.evaluate(snap(45, forecast), { threshold: 95, forecastAlerts: true });
  assert.equal(shown.length, 0, "too early in the window");
  alerts.evaluate(snap(60, forecast), { threshold: 95, forecastAlerts: false });
  assert.equal(shown.length, 0, "turned off");
  alerts.evaluate(snap(61, forecast), { threshold: 95, forecastAlerts: true });
  alerts.evaluate(snap(64, forecast), { threshold: 95, forecastAlerts: true });
  assert.equal(shown.length, 1);
  assert.match(shown[0].body, /At this pace it reaches 100% around/);
});

test("a weekly forecast warning gives the day of both times, and 99.6% is not shown as 100%", () => {
  const { alerts, shown } = alertHarness();
  const at = (hours) => new Date(Date.now() + hours * 3600000).toISOString();
  const day = (iso) => new Date(iso).toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const weekly = { kind: "weekly", label: "Weekly", used_pct: 60, resets_at: at(96), forecast_at: at(48) };
  alerts.evaluate({ providers: [{ id: "claude", display_name: "Claude Code", status: { state: "ok" }, windows: [weekly] }] }, { threshold: 95, forecastAlerts: true });
  assert.equal(shown[0].body, `Weekly is 60% used. At this pace it reaches 100% around ${day(weekly.forecast_at)}, before it resets at ${day(weekly.resets_at)}.`);
  alerts.evaluate(snap(99.6), { threshold: 80, notifyOnLimit: true });
  assert.equal(shown[1].body, "5h window: 99% used", "the limit itself is not reached yet");
});

test("the settings window can only change known settings, to allowed values", () => {
  const saved = [];
  const electron = {
    app: { setName() {}, on() {}, commandLine: { appendSwitch() {} }, setAppUserModelId() {}, disableHardwareAcceleration() {}, requestSingleInstanceLock: () => false, quit() {}, getVersion: () => "1.3.0" },
    ipcMain: { on() {}, handle() {} },
    BrowserWindow: { fromWebContents: () => null },
  };
  const signals = new Map(["SIGHUP", "SIGINT"].map((name) => [name, new Set(process.listeners(name))]));
  let updaterChanges = 0;
  let phoneApplied = 0;
  const api = load("src/main.js", {
    electron, "./config": { ...config, save: (c) => saved.push(JSON.parse(JSON.stringify(c))) }, "./poller": {}, "./alerts": {}, "./taskbarLayout": {},
    "./autostart": { apply: (on) => on }, "./updater": { getState: () => null, settingChanged: () => updaterChanges++ }, "./log": { install() {} },
  }, ["applySettings", "setState: (state) => { cfg = state.cfg; phone = state.phone; }"]);
  for (const [name, existing] of signals) for (const l of process.listeners(name)) if (!existing.has(l)) process.removeListener(name, l);
  const cfg = config.normalize({});
  api.setState({ cfg, phone: { apply: () => phoneApplied++, status: () => ({}) } });
  const view = api.applySettings({
    alert_threshold: 42, update_channel: "nightly", phone_port: 22, chips_show: { cpu: false, bogus: false }, quiet_hours: { enabled: true, start: "23:30" },
    poll_interval_secs: 7, admin: true, forecast_alerts: "no",
  });
  assert.equal(cfg.alert_threshold, 80);
  assert.equal(cfg.update_channel, "stable");
  assert.equal(cfg.phone.port, 47329);
  assert.equal(cfg.chips_show.cpu, false);
  assert.equal("bogus" in cfg.chips_show, false);
  assert.deepEqual(cfg.quiet_hours, { enabled: true, start: "23:30", end: "07:00" });
  assert.equal(cfg.poll_interval_secs, 5);
  assert.equal(cfg.forecast_alerts, true);
  assert.equal("admin" in cfg, false);
  assert.equal(updaterChanges, 0);
  api.applySettings({ update_channel: "beta", alert_threshold: 70, phone_enabled: true, phone_port: 50000 });
  assert.equal(cfg.update_channel, "beta");
  assert.equal(cfg.alert_threshold, 70);
  assert.equal(updaterChanges, 1, "the updater hears about a channel change");
  assert.equal(phoneApplied, 1, "sharing restarts once for both phone changes");
  assert.equal(saved.at(-1).phone.port, 50000);
  assert.equal(view.version, "1.3.0");
});

// main.js with the recent-sessions pieces replaced by fakes, so no real terminal, log file or window is touched.
function recentHarness(t, { installed = ["claude"], open } = {}) {
  const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "um-resume-"));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const handlers = {};
  const events = [];
  const opens = [];
  const entries = new Map();
  const calls = { clear: 0, refresh: 0 };
  const sessionLog = { get: (key) => entries.get(key) || null, clear: () => { calls.clear++; entries.clear(); } };
  const resumeCommand = (entry) => entry.cli === "claude" ? { label: entry.label, title: `${entry.label} · ${entry.name}`, file: "claude", args: ["--resume", entry.id] } : null;
  const electron = {
    app: { setName() {}, on() {}, commandLine: { appendSwitch() {} }, setAppUserModelId() {}, disableHardwareAcceleration() {}, requestSingleInstanceLock: () => false, quit() {}, getVersion: () => "1.3.0" },
    ipcMain: { on() {}, handle: (name, fn) => { handlers[name] = fn; } },
    BrowserWindow: { fromWebContents: () => null },
    Menu: { buildFromTemplate: (template) => template },
    nativeTheme: { themeSource: "system", shouldUseDarkColors: false },
    Notification: class { static isSupported() { return false; } },
    screen: { getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) },
  };
  const signals = new Map(["SIGHUP", "SIGINT"].map((name) => [name, new Set(process.listeners(name))]));
  const api = load("src/main.js", {
    electron, "./config": { ...config, save: () => true }, "./poller": {}, "./alerts": {}, "./taskbarLayout": {},
    "./autostart": { apply: (on) => on }, "./updater": { getState: () => null }, "./log": { install() {} },
    "./session-log": { createSessionLog: () => sessionLog, resumeCommand },
    "./godmode-launch": { open: (id, deps) => { opens.push({ id, deps }); return open ? open(deps) : { ok: true }; } },
    "./paths": { cliOnPath: (name) => installed.includes(name), cacheDir: () => folder },
  }, ["applySettings", "resumeSession", "clearRecent", "buildMenu", "placeFlyoutRight", "wireIpc", "getSessions: () => latestSessions",
    "setState: (s) => { if ('cfg' in s) cfg = s.cfg; if ('sessionLog' in s) sessionLog = s.sessionLog; if ('sessionWatch' in s) sessionWatch = s.sessionWatch; if ('latestSessions' in s) latestSessions = s.latestSessions; if ('insights' in s) insights = s.insights; if ('flyout' in s) flyout = s.flyout; if ('settingsWin' in s) settingsWin = s.settingsWin; }"]);
  for (const [name, existing] of signals) for (const l of process.listeners(name)) if (!existing.has(l)) process.removeListener(name, l);
  const cfg = config.normalize({});
  const insights = { event: (...args) => events.push(args), isSnoozed: () => false };
  const watch = { view: () => ({ auto_resume: false, sessions: [], recent: [{ key: "claude:abc" }] }), refresh: () => { calls.refresh++; }, stop() {} };
  api.setState({ cfg, sessionLog, sessionWatch: watch, insights });
  const entry = { key: "claude:abc", tool: "claude", cli: "claude", label: "Claude Code", name: "Fix the bug", cwd: folder, id: "abc", godmode: true, closed_at: Date.now() };
  entries.set(entry.key, entry);
  return { api, cfg, entries, entry, folder, events, opens, calls, handlers };
}

test("recent_sessions is a validated boolean that hides the list without losing it", (t) => {
  assert.equal(config.DEFAULTS.recent_sessions, true);
  assert.equal(config.normalize({ recent_sessions: "yes" }).recent_sessions, true);
  assert.equal(config.normalize({ recent_sessions: false }).recent_sessions, false);
  const { api, cfg } = recentHarness(t);
  api.applySettings({ recent_sessions: false });
  assert.equal(cfg.recent_sessions, false);
  assert.deepEqual(api.getSessions().recent, [], "the view sent to the windows has no recent sessions");
  api.applySettings({ recent_sessions: "no", bogus: true });
  assert.equal(cfg.recent_sessions, false, "anything but a boolean is ignored");
  const view = api.applySettings({ recent_sessions: true });
  assert.equal(cfg.recent_sessions, true);
  assert.deepEqual(api.getSessions().recent, [{ key: "claude:abc" }], "switching it on shows the history again");
  assert.equal(view.settings.recent_sessions, true, "the settings window receives the key");
  assert.equal("bogus" in cfg, false);
});

test("clearing recent sessions empties the log, re-sends the view and answers with the settings", (t) => {
  const { api, calls } = recentHarness(t);
  const reply = api.clearRecent();
  assert.equal(calls.clear, 1);
  assert.equal(reply.ok, true);
  assert.equal(reply.message, "Recent sessions cleared.");
  assert.equal(reply.view.settings.recent_sessions, true);
  assert.deepEqual(api.getSessions().recent, [], "the windows stop listing them at once, not at the next scan");
});

test("resuming a session refuses anything it cannot start, in a fixed order", (t) => {
  const h = recentHarness(t, { installed: [] });
  const { api, entries, entry } = h;
  const error = (key) => api.resumeSession(key);
  for (const key of [undefined, null, 7, {}, ["claude:abc"]]) assert.deepEqual(error(key), { ok: false, error: "That session is no longer listed." });
  assert.deepEqual(error("claude:nothing"), { ok: false, error: "That session is no longer listed." });
  api.setState({ latestSessions: { sessions: [{ key: "claude:abc" }], recent: [] } });
  assert.equal(error("claude:abc").error, "Claude Code · Fix the bug is still open in a terminal.");
  api.setState({ latestSessions: { sessions: [], recent: [] } });
  // Running under another key (no id of its own): the log still has it open.
  entries.set("gemini:c1", { ...entry, key: "gemini:c1", tool: "gemini", cli: "agy", label: "Antigravity", id: "c1", closed_at: null });
  assert.equal(error("gemini:c1").error, "Antigravity · Fix the bug is still open in a terminal.");
  entries.set("grok:x", { ...entry, key: "grok:x", cli: "grok", label: "Grok Build", id: "x" });
  assert.equal(error("grok:x").error, "Can't resume Grok Build sessions.");
  assert.equal(error("claude:abc").error, "Claude Code isn't installed on this computer.");
  const there = recentHarness(t);
  there.entry.cwd = require("node:path").join(there.folder, "gone");
  assert.equal(there.api.resumeSession("claude:abc").error, `Its folder no longer exists: ${there.entry.cwd}`);
  there.entry.cwd = "";
  assert.match(there.api.resumeSession("claude:abc").error, /folder isn't known/);
  assert.equal(there.opens.length, 0, "nothing was started by a refused request");
  assert.equal(h.opens.length, 0);
});

test("resuming a session opens its command in its folder and tells the list to refresh", (t) => {
  const { api, entry, opens, events, calls, folder } = recentHarness(t);
  const reply = api.resumeSession("claude:abc");
  assert.deepEqual(reply, { ok: true, message: "Opening Claude Code · Fix the bug in a terminal…" });
  assert.equal(opens.length, 1);
  assert.equal(opens[0].id, "claude");
  assert.equal(opens[0].deps.cwd, folder);
  assert.deepEqual(opens[0].deps.command, { label: "Claude Code", title: "Claude Code · Fix the bug", file: "claude", args: ["--resume", entry.id] });
  assert.equal(events.length, 1);
  assert.equal(events[0][0], "Session resumed from the panel");
  opens[0].deps.onError(new Error("spawn failed"));
  assert.equal(events.at(-1)[0], "Couldn't resume a session");
  assert.match(events.at(-1)[1], /Fix the bug: spawn failed\./);
  assert.equal(calls.refresh, 0, "the running list is refreshed after the terminal had time to start");
});

test("a terminal that cannot be opened is reported, not claimed as opened", (t) => {
  const failing = recentHarness(t, { open: () => ({ ok: false, error: "No terminal found" }) });
  assert.deepEqual(failing.api.resumeSession("claude:abc"), { ok: false, error: "No terminal found" });
  assert.equal(failing.events.length, 0);
  const throwing = recentHarness(t, { open: () => { throw new Error("boom"); } });
  assert.deepEqual(throwing.api.resumeSession("claude:abc"), { ok: false, error: "boom" });
});

test("only the panel may resume a session and only Settings may clear the list", (t) => {
  const { api, handlers, opens, calls } = recentHarness(t);
  const panel = { webContents: { id: "panel", send() {} }, isDestroyed: () => false };
  const settings = { webContents: { id: "settings" }, isDestroyed: () => false };
  api.setState({ flyout: panel, settingsWin: settings });
  api.wireIpc();
  const from = (win) => ({ sender: win.webContents });
  const stranger = { sender: { id: "other" } };
  assert.deepEqual(handlers["usage://resume-session"](stranger, "claude:abc"), { ok: false, error: "Not allowed" });
  assert.deepEqual(handlers["usage://resume-session"](from(settings), "claude:abc"), { ok: false, error: "Not allowed" });
  assert.equal(opens.length, 0);
  assert.equal(handlers["usage://resume-session"](from(panel), "claude:abc").ok, true);
  assert.equal(opens.length, 1);
  assert.equal(handlers["settings:recent-clear"](stranger), null);
  assert.equal(handlers["settings:recent-clear"](from(panel)), null);
  assert.equal(calls.clear, 0);
  assert.equal(handlers["settings:recent-clear"](from(settings)).ok, true);
  assert.equal(calls.clear, 1);
});

test("the tray offers the newest closed session that can be resumed", (t) => {
  const { api, opens } = recentHarness(t);
  const item = () => api.buildMenu().find((entry) => /^Resume last session/.test(entry.label));
  assert.deepEqual([item().label, item().enabled], ["Resume last session", false]);
  api.setState({ latestSessions: { sessions: [], recent: [
    { key: "codex:z", label: "Codex", name: "old", can_resume: false },
    { key: "claude:abc", label: "Claude Code", name: "Fix & test", can_resume: true },
  ] } });
  assert.deepEqual([item().label, item().enabled], ["Resume last session: Claude Code · Fix && test", true]);
  item().click();
  assert.equal(opens.length, 1);
});

test("an automatic text size does not scale the panel window", (t) => {
  const { api, cfg } = recentHarness(t);
  let bounds = { x: 0, y: 0, width: 580, height: 280 };
  api.setState({ flyout: { getBounds: () => bounds, setBounds: (next) => { bounds = next; }, isDestroyed: () => false, webContents: { send() {} } } });
  assert.equal(cfg.display.scale, "auto");
  api.placeFlyoutRight();
  assert.equal(bounds.width, 620);
  cfg.display.scale = 130;
  api.placeFlyoutRight();
  assert.equal(bounds.width, 806);
  api.applySettings({ display: { scale: "auto" } });
  assert.equal(cfg.display.scale, "auto");
  api.applySettings({ display: { scale: 120 } });
  assert.equal(cfg.display.scale, "auto", "an unknown size falls back to automatic");
});
