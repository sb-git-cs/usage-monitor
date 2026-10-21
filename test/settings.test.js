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
