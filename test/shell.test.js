const test = require("node:test");
const assert = require("node:assert/strict");
const { load } = require("./helpers");

function makeWin(bounds = { x: 0, y: 0, width: 100, height: 100 }) {
  const w = {
    visible: false, bounds: { ...bounds }, sent: [],
    isDestroyed: () => false, isVisible: () => w.visible, isMinimized: () => false, isFocused: () => false,
    show() { w.visible = true; }, showInactive() { w.visible = true; }, hide() { w.visible = false; }, focus() {}, restore() {},
    getBounds: () => ({ ...w.bounds }), setBounds(b) { w.bounds = { ...w.bounds, ...b }; },
    getPosition: () => [w.bounds.x, w.bounds.y], getSize: () => [w.bounds.width, w.bounds.height],
    setPosition(x, y) { w.bounds.x = x; w.bounds.y = y; },
    setAlwaysOnTop() {}, setIgnoreMouseEvents() {}, loadFile() {}, on() {}, once() {}, setOpacity() {},
    webContents: { send: (...a) => w.sent.push(a), setBackgroundThrottling() {} },
  };
  return w;
}

function harness() {
  const ipc = {};
  const display = { bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1032 } };
  const created = [];
  function BrowserWindow(opts) { const w = makeWin(opts); created.push(w); return w; }
  BrowserWindow.fromWebContents = () => null;
  const electron = {
    app: { setName() {}, on() {}, commandLine: { appendSwitch() {} }, setAppUserModelId() {}, disableHardwareAcceleration() {}, requestSingleInstanceLock: () => false, quit() {}, getVersion: () => "1.0.0" },
    ipcMain: { on: (ch, cb) => { ipc[ch] = cb; }, handle() {} },
    BrowserWindow,
    screen: { getAllDisplays: () => [display], getDisplayMatching: () => display, getDisplayNearestPoint: () => display, getPrimaryDisplay: () => display },
    nativeTheme: { shouldUseDarkColors: true, on() {} },
    powerMonitor: { on() {}, getSystemIdleTime: () => 0 },
  };
  const signals = new Map(["SIGHUP", "SIGINT"].map((n) => [n, new Set(process.listeners(n))]));
  const api = load("src/main.js", {
    electron, "./config": { save() {}, ALLOWED_INTERVALS: [5, 15, 30, 60], ALERT_THRESHOLDS: [80], inQuietHours: () => false }, "./poller": {}, "./alerts": {},
    "./taskbarLayout": { setChipsOwner() {}, loadLayout: () => null }, "./autostart": {}, "./updater": { getState: () => null },
    "./accounts": { TOOLS: {}, list: () => [] },
  }, [
    "wireIpc", "showFlyout", "setFlyoutDocked", "placeChipsFloating", "setPollInterval", "setChipsHidden",
    "setState: (s) => { cfg = s.cfg; flyout = s.flyout; chips = s.chips; settingsWin = s.settingsWin || null; }",
    "peek: () => ({ clickAway })",
  ]);
  for (const [n, existing] of signals) for (const l of process.listeners(n)) if (!existing.has(l)) process.removeListener(n, l);
  api.wireIpc();
  return { api, ipc, display };
}

test("keeping the panel open from its own button takes the click-away overlay down, and letting it go puts it back", () => {
  const { api, ipc } = harness();
  const flyout = makeWin({ x: 1300, y: 0, width: 620, height: 1032 });
  const cfg = { flyout_docked: false, flyout_pinned: false, chips_docked: false, chips_hidden: false, display: { scale: 100 } };
  api.setState({ cfg, flyout, chips: null });
  api.showFlyout();
  const overlay = api.peek().clickAway;
  assert.equal(overlay.visible, true);
  ipc["usage://flyout-toggle-dock"]({ sender: flyout.webContents });
  assert.equal(cfg.flyout_docked, true);
  assert.equal(overlay.visible, false, "desktop clicks reach other apps while the panel is kept open");
  api.setFlyoutDocked(false);
  assert.equal(overlay.visible, true, "the next desktop click hides the panel again");
});

test("a floating strip that grows stays inside its display", () => {
  const { api, ipc, display } = harness();
  const chips = makeWin({ x: 0, y: 0, width: 340, height: 48 });
  api.setState({ cfg: { chips_docked: false, chips_hidden: false, chips_x: null, chips_y: null, display: { scale: 100 } }, flyout: null, chips });
  api.placeChipsFloating();
  ipc["usage://chips-resize"]({}, 640, 50);
  const b = chips.getBounds();
  assert.equal(b.width, 640);
  assert.ok(b.x + b.width <= display.workArea.x + display.workArea.width, `right edge ${b.x + b.width}`);
});

test("changes made from the tray reach an open Settings window", () => {
  const { api } = harness();
  let pushes = 0;
  const settingsWin = makeWin();
  settingsWin.webContents.send = (ch) => { if (ch === "settings:state") pushes++; };
  const cfg = { chips_docked: false, chips_hidden: false, poll_interval_secs: 5, display: { scale: 100 }, phone: { enabled: false, devices: [] } };
  api.setState({ cfg, flyout: null, chips: null, settingsWin });
  api.setPollInterval(30);
  api.setChipsHidden(true);
  assert.equal(cfg.poll_interval_secs, 30);
  assert.equal(pushes, 2);
});
