const test = require("node:test");
const assert = require("node:assert/strict");
const { load } = require("./helpers");

function mainHarness(taskbar = {}) {
  const events = {};
  const ipc = {};
  const electron = {
    app: { setName() {}, on: (event, cb) => { events[event] = cb; }, commandLine: { appendSwitch() {} }, setAppUserModelId() {}, requestSingleInstanceLock: () => false, quit() {} },
    ipcMain: { on: (event, cb) => { ipc[event] = cb; }, handle() {} },
    BrowserWindow: { fromWebContents: () => null },
  };
  const signals = new Map(["SIGHUP", "SIGINT"].map(name => [name, new Set(process.listeners(name))]));
  const api = load("src/main.js", {
    electron, "./config": { save() {} }, "./poller": {}, "./alerts": {}, "./taskbarLayout": taskbar, "./autostart": {}, "./updater": {},
  }, ["wireIpc", "keepWidgetOnTop", "placeChipsDocked", "setState: (state) => { cfg = state.cfg; chips = state.chips; flyout = state.flyout; }"]);
  for (const [name, existing] of signals) {
    for (const listener of process.listeners(name)) if (!existing.has(listener)) process.removeListener(name, listener);
  }
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

test("two-row chips resize before docking and center completely inside the taskbar", () => {
  for (const trayHeight of [32, 40, 48, 60]) {
    for (const startHeight of [50, trayHeight - 4, trayHeight - 3]) {
      const top = 1080 - trayHeight;
      const layout = load("src/taskbarLayout.js", { electron: { screen: {
        getDisplayMatching: () => ({ bounds: { x: 0, y: 0, width: 1920, height: 1080 } }),
      } } }, ["cache"]);
      layout.cache.at = Date.now();
      layout.cache.data = { tray: { x: 0, y: top, w: 1920, h: trayHeight }, occupied: [
        { x: 43, y: top, w: 672, h: trayHeight }, { x: 1662, y: top, w: 258, h: trayHeight },
      ] };
      let bounds = { x: 1286, y: top, width: 376, height: startHeight };
      const messages = [];
      const chips = {
        isDestroyed: () => false, isVisible: () => true, getNativeWindowHandle: () => Buffer.alloc(8),
        getSize: () => [bounds.width, bounds.height], getPosition: () => [bounds.x, bounds.y],
        setBounds: b => { bounds = b; }, setPosition: (x, y) => { bounds = { ...bounds, x, y }; }, setAlwaysOnTop() {},
        webContents: { send: (...args) => messages.push(args), setBackgroundThrottling() {} },
      };
      const { api } = mainHarness({ ...layout, setChipsOwner() {} });
      api.setState({ cfg: { chips_docked: true, chips_dock_x: 1286, chips_dock_y: top }, chips });
      api.placeChipsDocked();
      assert.equal(bounds.height, trayHeight - 4, `floating height ${startHeight}, taskbar ${trayHeight}`);
      assert.equal(bounds.y, top + 2, "equal top and bottom insets, even when the old bounds already fit");
      assert.ok(bounds.x >= 715 && bounds.x + bounds.width <= 1662, "avoids taskbar buttons and notification area");
      assert.ok(messages.some(([channel, value]) => channel === "usage://chips-fill" && value === trayHeight - 4));
      assert.ok(!messages.some(([channel, value]) => channel === "usage://chips-popped" && value));
    }
  }
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

test("docked chips are handed to the taskbar probe with this process id, and released when undocked", () => {
  const calls = [];
  const layout = load("src/taskbarLayout.js", {
    electron: { screen: { screenToDipRect: (_w, r) => r } },
    child_process: { execFile: (_cmd, args, _opts, cb) => { calls.push(args); cb(null, JSON.stringify({ tray: { x: 0, y: 0, w: 100, h: 48 }, occupied: [], ownerApplied: true })); } },
  });
  layout.setChipsOwner("not-a-handle", true);
  layout.setChipsOwner("123456", true);
  layout.setChipsOwner("123456", true);
  layout.setChipsOwner("123456", false);
  if (process.platform !== "win32") {
    assert.deepEqual(calls, [], "only Windows has a taskbar to own the chips");
    return;
  }
  assert.equal(calls.length, 2, "invalid handles are ignored and an applied state is not re-sent");
  const flag = (args, name) => args[args.indexOf(name) + 1];
  assert.deepEqual([flag(calls[0], "-Hwnd"), flag(calls[0], "-Own"), flag(calls[0], "-AppPid")], ["123456", "1", String(process.pid)]);
  assert.equal(flag(calls[1], "-Own"), "0");
});
