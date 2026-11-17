const test = require("node:test");
const assert = require("node:assert/strict");
const { load } = require("./helpers");

function mainHarness(taskbar = {}, area = { x: 0, y: 0, width: 1920, height: 1032 }) {
  const events = {};
  const ipc = {};
  const electron = {
    app: { setName() {}, on: (event, cb) => { events[event] = cb; }, commandLine: { appendSwitch() {} }, setAppUserModelId() {}, disableHardwareAcceleration() {}, requestSingleInstanceLock: () => false, quit() {} },
    ipcMain: { on: (event, cb) => { ipc[event] = cb; }, handle() {} },
    BrowserWindow: { fromWebContents: () => null },
    screen: { getDisplayMatching: () => ({ workArea: area }) },
  };
  const signals = new Map(["SIGHUP", "SIGINT"].map(name => [name, new Set(process.listeners(name))]));
  const api = load("src/main.js", {
    electron, "./config": { save() {} }, "./poller": {}, "./alerts": {}, "./taskbarLayout": taskbar, "./autostart": {}, "./updater": {},
  }, ["wireIpc", "hideFlyout", "showFlyout", "createWindows", "stubWindows: (create, chips) => { createFlyout = create; createChips = chips; broadcastNet = sendPairing = refreshFileCounts = () => {}; }", "keepWidgetOnTop", "placeFlyoutRight", "placeChipsDocked", "noteTaskbarShown", "recoverChipsIfNeeded", "setState: (state) => { cfg = state.cfg; chips = state.chips; flyout = state.flyout; }"]);
  for (const [name, existing] of signals) {
    for (const listener of process.listeners(name)) if (!existing.has(listener)) process.removeListener(name, listener);
  }
  api.wireIpc();
  return { api, ipc, events };
}

test("a taskbar slid off the monitor counts as hidden, and a full strip counts as shown", () => {
  const layout = load("src/taskbarLayout.js");
  const monitor = { x: 0, y: 0, w: 1920, h: 1080 };
  assert.equal(layout.taskbarShown({ x: 0, y: 1032, w: 1920, h: 48 }, monitor), true);
  assert.equal(layout.taskbarShown({ x: 0, y: 1078, w: 1920, h: 48 }, monitor), false);
  assert.equal(layout.taskbarShown({ x: 1920, y: 400, w: 48, h: 400 }, monitor), false);
  assert.equal(layout.taskbarShown({ x: 0, y: 1032, w: 1920, h: 48 }, monitor, false), false);
  assert.equal(layout.taskbarShown(null, null), true);
});

test("flyout fills the display work area vertically and stays flush against its right edge", () => {
  for (const area of [{ x: 1920, y: -100, width: 2560, height: 1400 }, { x: -800, y: 40, width: 280, height: 700 }]) {
    const { api, ipc } = mainHarness({}, area);
    let bounds = { x: 0, y: 0, width: 580, height: 280 }, moves = 0;
    const flyout = { getBounds: () => bounds, setBounds: (next) => { bounds = next; moves++; } };
    api.setState({ cfg: { display: { scale: 130 } }, flyout });
    api.placeFlyoutRight();
    assert.deepEqual(bounds, { x: area.x + area.width - Math.min(806, area.width), y: area.y, width: Math.min(806, area.width), height: area.height });
    api.placeFlyoutRight(); assert.equal(moves, 1, "identical bounds must not cause resize feedback");
    ipc["usage://flyout-resize"]({}, 220, 620);
    assert.equal(bounds.height, area.height, "renderer content height cannot shrink the panel");
    assert.equal(bounds.x + bounds.width, area.x + area.width);
  }
});

test("docked chips hide with the taskbar and are not brought back while it is away", () => {
  const { api } = mainHarness();
  let visible = true;
  const chips = {
    isDestroyed: () => false,
    isVisible: () => visible,
    hide() { visible = false; },
    showInactive() { visible = true; },
    setAlwaysOnTop() {},
    webContents: { setBackgroundThrottling() {} },
  };
  api.setState({ cfg: { chips_docked: true, chips_hidden: false }, chips });
  api.noteTaskbarShown(false);
  assert.equal(visible, false);
  api.keepWidgetOnTop(chips, true);
  api.recoverChipsIfNeeded();
  assert.equal(visible, false);
  const floating = mainHarness();
  let stayed = true;
  const loose = { ...chips, isVisible: () => stayed, hide() { stayed = false; } };
  floating.api.setState({ cfg: { chips_docked: false, chips_hidden: false }, chips: loose });
  floating.api.noteTaskbarShown(false);
  assert.equal(stayed, true);
});

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

test("a visible strip that is already on top is left alone by the recovery timer", () => {
  const { api } = mainHarness();
  let onTop = false;
  let level = null;
  const calls = [];
  const chips = {
    isDestroyed: () => false, isVisible: () => true, getOpacity: () => 1, setOpacity() {}, showInactive() {},
    isAlwaysOnTop: () => onTop,
    setAlwaysOnTop(_flag, next) { onTop = true; level = next; calls.push(next); },
    webContents: { isCrashed: () => false, setBackgroundThrottling() {} },
  };
  api.setState({ cfg: { chips_docked: true, chips_hidden: false }, chips });
  api.keepWidgetOnTop(chips, true);
  assert.deepEqual(calls, ["screen-saver"]);
  for (let i = 0; i < 5; i++) api.recoverChipsIfNeeded();
  api.keepWidgetOnTop(chips, true);
  assert.deepEqual(calls, ["screen-saver"], "re-asserting always-on-top every 800 ms re-stacked (flickered) the strip");
  api.keepWidgetOnTop(chips, false);
  assert.deepEqual(calls, ["screen-saver", "pop-up-menu"], "a level change is applied");
  onTop = false;
  api.recoverChipsIfNeeded();
  assert.equal(calls.length, 3, "a strip that lost its level gets it back");
  assert.equal(level, "screen-saver");
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

// A stand-in for the Windows helper's "bar" channel: records lines sent, and can emit lines or exit.
function fakeTaskbarHelper({ up = () => true } = {}) {
  const sent = [];
  const listeners = [];
  const exits = [];
  return {
    sent,
    send(channel, line) { assert.equal(channel, "bar"); if (!up()) return false; sent.push(line); return true; },
    on(channel, fn) { assert.equal(channel, "bar"); listeners.push(fn); return () => {}; },
    onExit(fn) { exits.push(fn); return () => {}; },
    emit(line) { for (const fn of listeners) fn(line); },
    exit() { for (const fn of exits) fn(); },
  };
}

test("docked chips are handed to the taskbar helper with this process id, and released when undocked", () => {
  const helper = fakeTaskbarHelper();
  const layout = load("src/taskbarLayout.js", { electron: { screen: { screenToDipRect: (_w, r) => r } }, "./winhelper": helper });
  layout.setChipsOwner("not-a-handle", true);
  layout.setChipsOwner("123456", true);
  helper.emit("layout=" + JSON.stringify({ tray: { x: 0, y: 0, w: 100, h: 48 }, occupied: [], owner: "123456:1:0", ownerApplied: true }));
  layout.setChipsOwner("123456", true);
  layout.setChipsOwner("123456", false);
  if (process.platform !== "win32") {
    assert.deepEqual(helper.sent, [], "only Windows has a taskbar to own the chips");
    return;
  }
  assert.deepEqual(helper.sent, ["watch", `own 123456 1 0 ${process.pid}`, `own 123456 0 0 ${process.pid}`],
    "invalid handles are ignored and an applied state is not re-sent");
});

test("a taskbar read starts the helper's watch once, and reads use the layouts it streams", () => {
  let up = false;
  const helper = fakeTaskbarHelper({ up: () => up });
  const electron = {
    app: { isPackaged: false },
    screen: {
      screenToDipRect: (_w, r) => r,
      getDisplayMatching: () => ({ bounds: { x: 0, y: 0, width: 1920, height: 1080 } }),
      getPrimaryDisplay: () => ({ bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1032 } }),
    },
  };
  const layout = load("src/taskbarLayout.js", { electron, "./winhelper": helper });
  const tray = (h) => JSON.stringify({ tray: { x: 0, y: 1080 - h, w: 1920, h }, occupied: [], owner: null, ownerApplied: false, shown: true });

  // While the helper cannot start, the screen's work area stands in.
  assert.equal(layout.loadLayout().tray.h, 48);
  up = true;
  for (let i = 0; i < 5; i++) { layout.loadLayout(); layout.dockRoom(200, 44, []); layout.snapDocked(1500, 1034, 200, 44, []); }
  if (process.platform !== "win32") {
    assert.deepEqual(helper.sent, [], "only Windows probes a taskbar");
    return;
  }
  assert.deepEqual(helper.sent, ["watch"], "repeated reads start a single watch");
  helper.emit("layout=" + tray(60));
  assert.equal(layout.loadLayout().tray.h, 60, "the streamed layout is used");
  const shown = [];
  layout.watchTaskbar((value) => shown.push(value));
  helper.emit("shown=0");
  helper.emit("layout=not json");
  assert.deepEqual(shown, [false]);
  assert.equal(layout.loadLayout().tray.h, 60, "a bad line keeps the previous layout");
  layout.invalidate();
  assert.deepEqual(helper.sent, ["watch", "probe"]);
  // A helper that was restarted lost its watch; the next read starts it again.
  helper.exit();
  layout.loadLayout();
  assert.deepEqual(helper.sent, ["watch", "probe", "watch"]);
  layout.stopTaskbarWatch();
  assert.equal(helper.sent.at(-1), "stop");
});


test("panel is lazy, hidden panels are released, and reopening cancels release", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { api, ipc } = mainHarness();
  let created = 0, strips = 0, destroyed = 0, visible = false;
  const cfg = { chips_hidden: true, flyout_docked: false };
  const win = {
    isDestroyed: () => false, isVisible: () => visible, isMinimized: () => false,
    getBounds: () => ({ x: 0, y: 0, width: 620, height: 1032 }), setBounds() {},
    show() { visible = true; }, focus() {}, hide() { visible = false; },
    destroy() { destroyed++; api.setState({ cfg, flyout: null }); },
  };
  api.setState({ cfg, flyout: null });
  api.stubWindows(() => { created++; api.setState({ cfg, flyout: win }); }, () => { strips++; });
  api.createWindows();
  assert.equal(strips, 1);
  assert.equal(created, 0, "startup needs no panel renderer");
  ipc["usage://flyout-toggle"]();
  assert.equal(created, 1);
  api.hideFlyout(true);
  t.mock.timers.tick(59_000);
  assert.equal(destroyed, 0);
  api.showFlyout();
  t.mock.timers.tick(2_000);
  assert.equal(destroyed, 0, "a reopened panel must survive its old timer");
  api.hideFlyout(true);
  t.mock.timers.tick(60_000);
  assert.equal(destroyed, 1);
  ipc["usage://flyout-toggle"]();
  assert.equal(created, 2, "chips can recreate the released panel");
  cfg.flyout_docked = true;
  api.hideFlyout(false);
  t.mock.timers.tick(60_000);
  assert.equal(visible, true);
  assert.equal(destroyed, 1, "docked panel stays alive");
});
