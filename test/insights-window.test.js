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

test("Insights lists closed sessions and forwards Resume only from its own renderer", async () => {
  const handles = {};
  let win;
  const resumed = [];
  class Window {
    constructor() { win = this; this.webContents = { setWindowOpenHandler() {}, on() {} }; }
    isDestroyed() { return false; }
    setMenuBarVisibility() {} loadFile() {} on() {} show() {} focus() {}
  }
  const electron = { BrowserWindow: Window, app: { getVersion: () => "1.5.0", getPath: () => "." }, ipcMain: { handle: (name, fn) => { handles[name] = fn; } }, nativeTheme: { shouldUseDarkColors: true }, dialog: {} };
  const closed = { key: "claude:abc", tool: "claude", cli: "claude", label: "Claude Code", name: "<img src=x onerror=1>", cwd: "D:\\work", id: "abc",
    started: "2026-10-30T08:00:00.000Z", last_active: "2026-10-30T09:00:00.000Z", closed_at: "2026-10-30T09:05:00.000Z", godmode: true, can_resume: true, reason: null, pid: 42, secret: "x" };
  const start = (sessions) => {
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../src/insights-window.js"), "utf8"), {
      module, __dirname: path.join(__dirname, "../src"), process,
      require: (id) => id === "electron" ? electron : id === "./insights" ? { displayPrefs } : id === "./tokens" ? require("../src/tokens") : require(id),
    });
    module.exports.init({ cfg: { display: displayPrefs() }, insights: { data: { events: [], snoozeUntil: 0, lastSuccess: {} }, report: () => [], budgetView: () => ({}), error: false },
      sessions, resume: (key) => { resumed.push(key); return { ok: true, message: "Opening" }; }, save: () => true });
    module.exports.open();
    return { own: { sender: win.webContents }, other: { sender: {} } };
  };
  const { own, other } = start(() => ({ sessions: [], recent: [closed] }));
  const view = await handles["insights:get"](own, 7);
  // The page runs in its own realm, so compare plain data.
  assert.deepEqual(JSON.parse(JSON.stringify(view.recent_sessions)), [{ key: "claude:abc", tool: "claude", cli: "claude", label: "Claude Code", name: "<img src=x onerror=1>", cwd: "D:\\work", id: "abc",
    started: closed.started, last_active: closed.last_active, closed_at: closed.closed_at, godmode: true, can_resume: true, reason: null }], "only the displayed fields are sent");
  assert.deepEqual(await handles["insights:action"](own, "resume", "claude:abc"), { ok: true, message: "Opening" });
  assert.equal(await handles["insights:action"](other, "resume", "claude:abc"), null);
  for (const value of [undefined, null, 5, { key: "claude:abc" }]) await handles["insights:action"](own, "resume", value);
  assert.deepEqual(resumed, ["claude:abc"], "a value that is not a string never reaches the launcher");
  const idle = start(() => null);
  assert.equal((await handles["insights:get"](idle.own, 7)).recent_sessions.length, 0, "no watcher view means no rows");
  const broken = start(() => { throw new Error("gone"); });
  assert.equal((await handles["insights:get"](broken.own, 7)).recent_sessions.length, 0, "a failing watcher does not break the page");
});

test("Insights accepts the automatic text size", async () => {
  const handles = {};
  let win;
  class Window {
    constructor() { win = this; this.webContents = { setWindowOpenHandler() {}, on() {} }; }
    isDestroyed() { return false; }
    setMenuBarVisibility() {} loadFile() {} on() {} show() {} focus() {}
  }
  const module = load("src/insights-window.js", {
    electron: { app: { getVersion: () => "test", getPath: () => "." }, BrowserWindow: Window, ipcMain: { handle: (name, fn) => { handles[name] = fn; } }, nativeTheme: { shouldUseDarkColors: false }, dialog: {} },
    "./tokens": { scanTokens: () => null }, "./burn": { analyzeBurn: () => [], computeHealth: () => ({}) },
  });
  const cfg = { display: displayPrefs({ scale: 130 }) };
  module.init({ cfg, insights: { data: { events: [], snoozeUntil: 0, lastSuccess: {} }, error: false }, save: () => true });
  module.open();
  const own = { sender: win.webContents };
  assert.equal(cfg.display.scale, 130);
  assert.deepEqual(await handles["insights:action"](own, "display", { ...cfg.display, scale: "auto" }), { ok: true });
  assert.equal(cfg.display.scale, "auto");
  await handles["insights:action"](own, "display", { ...cfg.display, scale: 1000 });
  assert.equal(cfg.display.scale, "auto", "an unknown size is the automatic one");
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
