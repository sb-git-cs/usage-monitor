const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { displayPrefs } = require("../src/insights");
const os = require("node:os");
const { load } = require("./helpers");

test("battery exports and clearing use separate history and reject unrelated renderers", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "um-battery-export-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const handles = {};
  let win;
  let output = path.join(dir, "export.json");
  class Window {
    constructor() { win = this; this.webContents = { setWindowOpenHandler() {}, on() {}, send() {} }; }
    isDestroyed() { return false; }
    setMenuBarVisibility() {} loadFile() {} on() {}
  }
  const { Insights } = require("../src/insights");
  const { BatteryHistory } = require("../src/battery");
  const battery = new BatteryHistory({ file: path.join(dir, "battery.json") });
  battery.record({ hasBattery: true, percent: 60, isCharging: false, acConnected: false });
  const quota = new Insights({ file: path.join(dir, "quota.json") });
  quota.record({ providers: [{ id: "codex", status: { state: "ok" }, windows: [{ kind: "five_hour", used_pct: 30 }] }] });
  quota.save(true);
  const before = fs.readFileSync(quota.file, "utf8");
  const module = load("src/insights-window.js", {
    electron: { app: { getVersion: () => "test", getPath: () => dir }, BrowserWindow: Window,
      ipcMain: { handle: (name, fn) => { handles[name] = fn; } }, nativeTheme: { shouldUseDarkColors: true },
      dialog: { showSaveDialog: async () => ({ filePath: output }) } },
    "./tokens": { scanTokens: () => null }, "./burn": { analyzeBurn: () => [], computeHealth: () => ({}) },
  });
  module.init({ cfg: { display: displayPrefs() }, insights: quota, battery }); module.open("battery");
  const own = { sender: win.webContents }, other = { sender: {} };
  assert.equal(await handles["insights:action"](other, "clear-battery"), null);
  assert.equal(battery.points.length, 1);
  await handles["insights:export"](own, "json", 7);
  const exported = JSON.parse(fs.readFileSync(output, "utf8"));
  assert.equal(exported.unit, "quota_percent_used"); assert.equal(exported.battery.points.length, 1);
  output = path.join(dir, "battery.csv");
  await handles["insights:export"](own, "battery-csv", 7);
  assert.match(fs.readFileSync(output, "utf8"), /timestamp,percent,state/);
  output = path.join(dir, "report.md");
  await handles["insights:export"](own, "report", 7);
  assert.match(fs.readFileSync(output, "utf8"), /## Battery/);
  assert.deepEqual(await handles["insights:action"](own, "clear-battery"), { ok: true });
  assert.equal(battery.points.length, 0);
  assert.equal(fs.readFileSync(quota.file, "utf8"), before);
});
test("Insights IPC only accepts its own renderer and support reports omit sensitive fields", async () => {
  const handles = {};
  let win;
  let retries = 0;
  class Window {
    constructor() { win = this; this.webContents = { setWindowOpenHandler() {}, on() {} }; }
    isDestroyed() { return false; }
    setMenuBarVisibility() {} loadFile() {} on() {} show() {} focus() {}
  }
  const module = { exports: {} };
  const electron = { BrowserWindow: Window, app: { getVersion: () => "1.5.0", getPath: () => "." }, ipcMain: { handle: (name, fn) => { handles[name] = fn; } }, nativeTheme: { shouldUseDarkColors: true }, dialog: { showSaveDialog: async () => ({ canceled: true }) } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../src/insights-window.js"), "utf8"), {
    module, __dirname: path.join(__dirname, "../src"), process,
    require: (id) => id === "electron" ? electron : id === "./insights" ? { displayPrefs } : id === "./tokens" ? require("../src/tokens") : require(id),
  });
  module.exports.init({ cfg: { display: displayPrefs() }, insights: { data: { events: [], snoozeUntil: 0, lastSuccess: {} }, report: () => [], budgetView: () => ({}), error: false },
    snapshot: () => ({ providers: [{ id: "claude", account: "private@example.com", access_token: "secret", status: { state: "fetch_failed", message: "sensitive error" } }] }),
    network: () => ({ state: "error", message: "private path" }), refresh: () => { retries++; } });
  module.exports.open();
  const other = { sender: {} };
  assert.equal(handles["insights:get"](other), null);
  assert.equal(await handles["insights:action"](other, "retry"), null);
  assert.equal(await handles["insights:export"](other, "diagnostics"), null);
  assert.equal(retries, 0);
  const own = { sender: win.webContents };
  const report = (await handles["insights:get"](own)).diagnostics;
  assert.equal(report.providers[0].state, "fetch_failed");
  assert.doesNotMatch(JSON.stringify(report), /private|secret|sensitive|account|token/);
  await handles["insights:action"](own, "retry"); assert.equal(retries, 1);
});

test("the report names the requested period and omits the unit when no budget limit is set", () => {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../src/insights-window.js"), "utf8"), {
    module, __dirname: path.join(__dirname, "../src"), process,
    require: (id) => id === "electron" ? { app: {}, BrowserWindow: class {}, ipcMain: {}, dialog: {}, nativeTheme: {} } : id === "./insights" ? { displayPrefs } : id === "./tokens" ? require("../src/tokens") : require(id),
  });
  const { generateReport } = module.exports;
  const day = generateReport({ days: 1, tokens: null, budget: { used: 4.2e8, limit: 0 } });
  assert.match(day, /Period: 1 day \|/);
  assert.match(day, /0\.42 GB \/ No limit set\n/);
  assert.match(generateReport({ days: 14, tokens: null, budget: { used: 0, limit: 5e9 } }), /Period: 14 days \|[^\n]*\n[\s\S]*0 GB \/ 5\.00 GB/);
  const named = generateReport({ days: 7, burn: [{ provider: "claude", label: "5h", used: 50, burn_rate: 2, safe_rate: 10, hours_to_reset: 3, status: "sustainable" }] });
  assert.match(named, /\| Claude Code \(5h\) \| 50% \| 2%\/h \| 10%\/h \| 3h \| On pace \|/);
});
