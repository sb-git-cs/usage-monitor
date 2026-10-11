const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { displayPrefs } = require("../src/insights");
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
    require: (id) => id === "electron" ? electron : id === "./insights" ? { displayPrefs } : require(id),
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
  const report = handles["insights:get"](own).diagnostics;
  assert.equal(report.providers[0].state, "fetch_failed");
  assert.doesNotMatch(JSON.stringify(report), /private|secret|sensitive|account|token/);
  await handles["insights:action"](own, "retry"); assert.equal(retries, 1);
});
