const test = require("node:test");
const assert = require("node:assert/strict");
const { load } = require("./helpers");

function mainHarness() {
  const events = {};
  const ipc = {};
  const electron = {
    app: { setName() {}, on: (event, cb) => { events[event] = cb; }, commandLine: { appendSwitch() {} }, setAppUserModelId() {}, requestSingleInstanceLock: () => false, quit() {} },
    ipcMain: { on: (event, cb) => { ipc[event] = cb; }, handle() {} },
    BrowserWindow: { fromWebContents: () => null },
  };
  const api = load("src/main.js", {
    electron, "./config": { save() {} }, "./poller": {}, "./alerts": {}, "./taskbarLayout": {}, "./autostart": {}, "./updater": {},
  }, ["wireIpc", "keepWidgetOnTop", "setState: (state) => { cfg = state.cfg; chips = state.chips; flyout = state.flyout; }"]);
  api.wireIpc();
  return { api, ipc, events };
}

test("hidden chips stay hidden when other windows request always-on-top", () => {
  const { api } = mainHarness();
  let shown = false;
  const chips = { isDestroyed: () => false, setAlwaysOnTop() {}, webContents: { setBackgroundThrottling() {} }, isVisible: () => false, showInactive() { shown = true; } };
  api.setState({ cfg: { chips_hidden: true }, chips });
  api.keepWidgetOnTop(chips, true);
  assert.equal(shown, false);
  api.setState({ cfg: { chips_hidden: false }, chips });
  api.keepWidgetOnTop(chips, true);
  assert.equal(shown, true);
});

test("malformed renderer dimensions cannot reach native window APIs", () => {
  const { api, ipc } = mainHarness();
  const win = { isDestroyed: () => false, getSize() { throw new Error("Unexpected native call"); } };
  api.setState({ cfg: {}, chips: win, flyout: win });
  for (const value of [NaN, Infinity, undefined, "bad", {}]) {
    ipc["usage://chips-resize"]({}, value, 30);
    ipc["usage://flyout-resize"]({}, value, 600);
  }
});

test("new windows and navigations are denied", () => {
  const { events } = mainHarness();
  let open;
  const listeners = {};
  events["web-contents-created"]({}, { setWindowOpenHandler: (cb) => { open = cb; }, on: (name, cb) => { listeners[name] = cb; } });
  assert.deepEqual(open(), { action: "deny" });
  let prevented = 0;
  listeners["will-navigate"]({ preventDefault: () => { prevented++; } });
  listeners["will-attach-webview"]({ preventDefault: () => { prevented++; } });
  assert.equal(prevented, 2);
});

test("portable autostart points to the durable executable, not the extraction folder", () => {
  const previous = process.env.PORTABLE_EXECUTABLE_FILE;
  process.env.PORTABLE_EXECUTABLE_FILE = "D:\\Apps\\Usage Monitor.exe";
  let written = "";
  const startup = load("src/autostart.js", {
    electron: { app: { isPackaged: true } },
    fs: { mkdirSync() {}, writeFileSync: (_path, text) => { written = text; }, existsSync: () => false },
  }, ["writeShortcut"]);
  try {
    startup.writeShortcut();
    assert.ok(written.includes('D:\\Apps\\Usage Monitor.exe'));
    assert.ok(!written.includes(process.execPath));
  } finally {
    if (previous === undefined) delete process.env.PORTABLE_EXECUTABLE_FILE;
    else process.env.PORTABLE_EXECUTABLE_FILE = previous;
  }
});
