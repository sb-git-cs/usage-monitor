const test = require("node:test");
const assert = require("node:assert/strict");
const { load } = require("./helpers");
const config = require("../src/config");

test("new settings are validated and never share nested defaults", () => {
  const cfg = config.normalize({
    alert_threshold: 73,
    quiet_hours: { enabled: "yes", start: "25:00", end: "06:30" },
    chips_show: { gpu: false, claude: "no" },
    update_channel: "nightly",
    phone: { enabled: true, port: 80, devices: [{ id: "zz", key: "k" }, { id: "0123456789abcdef", key: "A".repeat(43), name: "  Pixel 8  " }] },
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
  cfg.quiet_hours.enabled = true;
  cfg.chips_show.cpu = false;
  cfg.phone.devices.push({});
  const fresh = config.normalize({});
  assert.equal(fresh.quiet_hours.enabled, false);
  assert.equal(fresh.chips_show.cpu, true);
  assert.equal(fresh.phone.devices.length, 0);
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
  assert.match(shown[0].body, /5h 71\/100% used/);
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

test("the settings window can only change known settings, to allowed values", () => {
  const saved = [];
  const electron = {
    app: { setName() {}, on() {}, commandLine: { appendSwitch() {} }, setAppUserModelId() {}, requestSingleInstanceLock: () => false, quit() {}, getVersion: () => "1.3.0" },
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
