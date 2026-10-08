const { app, BrowserWindow, Menu, Tray, nativeImage, nativeTheme, ipcMain, shell, screen, dialog } = require("electron");
const path = require("path");
const os = require("os");
const config = require("./config");
const poller = require("./poller");
const alerts = require("./alerts");
const { applyLocalResets } = require("./models");
const taskbarLayout = require("./taskbarLayout");
const autostart = require("./autostart");
const updater = require("./updater");
const log = require("./log");
const netUsage = require("./net");
const systemUsage = require("./system");
const { History } = require("./history");
const { PhoneLink } = require("./phone");
const accounts = require("./accounts");
const claude = require("./adapters/claude");
const codex = require("./adapters/codex");
const gemini = require("./adapters/gemini");
const grok = require("./adapters/grok");
const cursor = require("./adapters/cursor");
const { formatRateShort } = require("./net/format");

const IS_WINDOWS = process.platform === "win32";
const LOGIN_LABEL = IS_WINDOWS ? "Start with Windows" : process.platform === "darwin" ? "Open at login" : "Start at login";

let cfg;
let flyout;
let chips;
let clickAway;
let tray;
let chipsPopped = false;
let ignoreFlyoutBlur = false;
let poll;
let latest;
let systemPoll;
let latestSystem;
let history;
let phone;
let settingsWin = null;
let saveTimer = null;

function saveSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => config.save(cfg), 200);
}

// Keeps a window inside the work area, so the taskbar never covers part of it.
function clampToWorkArea(x, y, w, h) {
  const wa = screen.getDisplayNearestPoint({ x: Math.round(x || 0), y: Math.round(y || 0) }).workArea;
  return {
    x: Math.round(Math.min(Math.max(x, wa.x), wa.x + wa.width - w)),
    y: Math.round(Math.min(Math.max(y, wa.y), wa.y + wa.height - h)),
  };
}

function clampToDisplay(x, y, w, h) {
  const display = screen.getDisplayNearestPoint({ x: x || 0, y: y || 0 });
  const b = display.bounds;
  return {
    x: Math.round(Math.min(Math.max(x, b.x), b.x + b.width - w)),
    y: Math.round(Math.min(Math.max(y, b.y), b.y + b.height - h)),
  };
}

function setSizeKeepPos(win, w, h) {
  if (!win || win.isDestroyed()) return;
  const [x, y] = win.getPosition();
  const [cw, ch] = win.getSize();
  if (cw === w && ch === h) return;
  placingFlyout = true;
  placingChips = true;
  win.setBounds({ x, y, width: Math.round(w), height: Math.round(h) });
  placingFlyout = false;
  placingChips = false;
}

let dragState = null;

const USAGE_URLS = {
  claude: "https://claude.ai/settings/usage",
  codex: "https://chatgpt.com/codex/settings/usage",
  gemini: "https://antigravity.google",
  grok: "https://grok.com",
};

function ui(file) {
  return path.join(__dirname, "ui", file);
}

function createWindow(opts) {
  return new BrowserWindow({
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    skipTaskbar: true,
    title: "Usage Monitor",
    alwaysOnTop: true,
    fullscreenable: false,
    backgroundColor: "#00000000",
    roundedCorners: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
    ...opts,
  });
}

let placingChips = false;

function taskbarInfo(display) {
  const { bounds, workArea } = display;
  const topGap = workArea.y - bounds.y;
  const leftGap = workArea.x - bounds.x;
  const rightGap = bounds.x + bounds.width - (workArea.x + workArea.width);
  const bottomGap = bounds.y + bounds.height - (workArea.y + workArea.height);
  const gaps = [
    { edge: "top", thickness: topGap },
    { edge: "left", thickness: leftGap },
    { edge: "right", thickness: rightGap },
    { edge: "bottom", thickness: bottomGap },
  ];
  gaps.sort((a, b) => b.thickness - a.thickness);
  const best = gaps[0];
  return {
    edge: best.thickness > 8 ? best.edge : "bottom",
    thickness: Math.max(best.thickness, 48),
    bounds,
    workArea,
  };
}

function otherDockedRects(except) {
  const out = [];
  if (except !== "flyout" && flyout && cfg.flyout_docked && flyout.isVisible() && !flyout.isDestroyed()) {
    const b = flyout.getBounds();
    out.push({ x: b.x, y: b.y, w: b.width, h: b.height, name: "flyout" });
  }
  if (except !== "chips" && chips && cfg.chips_docked && chips.isVisible() && !chips.isDestroyed()) {
    const b = chips.getBounds();
    out.push({ x: b.x, y: b.y, w: b.width, h: b.height, name: "chips" });
  }
  return out;
}

function applyDockedPos(win, pos) {
  if (!win || !pos || !pos.ok) return;
  const [x, y] = win.getPosition();
  // Snapped positions are whole pixels, so an exact match cannot jitter; a 1px miss shows on the taskbar.
  if (x === pos.x && y === pos.y) return;
  placingChips = true;
  placingFlyout = true;
  win.setPosition(pos.x, pos.y);
  placingChips = false;
  placingFlyout = false;
}

// Docked on a horizontal taskbar, the strip fills the taskbar with 2px spare above and below (0 = natural size).
let chipsFill = 0;

function taskbarFillHeight() {
  const layout = taskbarLayout.loadLayout();
  const tray = layout && layout.tray;
  if (!tray || tray.w < tray.h) return 0;
  return Math.max(24, Math.min(120, Math.floor(tray.h) - 4));
}

// Native window handle of the chips as a decimal string, for the taskbar helper script.
function chipsHandle() {
  try {
    if (!chips || chips.isDestroyed()) return null;
    const buf = chips.getNativeWindowHandle();
    return (buf.length >= 8 ? buf.readBigUInt64LE(0) : BigInt(buf.readUInt32LE(0))).toString();
  } catch {
    return null;
  }
}

function setChipsFill(height) {
  const next = Number.isFinite(height) && height > 0 ? Math.round(height) : 0;
  // While docked in the taskbar the strip is owned by it, so it stays visible when Windows
  // raises the taskbar above other windows (Start menu, Quick Settings). Floating or popped-out
  // chips must not be owned, or they would cover the Start menu.
  if (taskbarLayout.setChipsOwner) taskbarLayout.setChipsOwner(chipsHandle(), next > 0);
  if (next === chipsFill) return;
  chipsFill = next;
  if (chips && !chips.isDestroyed()) chips.webContents.send("usage://chips-fill", chipsFill);
}

function setChipsPopped(popped) {
  const next = !!popped;
  if (chipsPopped === next) return;
  chipsPopped = next;
  if (chips && !chips.isDestroyed()) chips.webContents.send("usage://chips-popped", chipsPopped);
}

function popChipsAboveTaskbar(w, h, extras) {
  const along = cfg.chips_dock_x != null ? cfg.chips_dock_x : chips.getPosition()[0];
  const pos = taskbarLayout.anchorAboveTaskbar(w, h, extras, along);
  if (!pos || !pos.ok) return false;
  setChipsFill(0);
  cfg.chips_dock_x = pos.x;
  cfg.chips_dock_y = pos.y;
  applyDockedPos(chips, pos);
  setChipsPopped(true);
  keepWidgetOnTop(chips, true);
  if (!chips.isVisible() && !cfg.chips_hidden) chips.showInactive();
  return true;
}

function placeChipsDocked() {
  if (!chips || chips.isDestroyed()) return;
  const [w, currentHeight] = chips.getSize();
  // Test the docked height, not the taller floating window (which includes its outer margin).
  const fillHeight = taskbarFillHeight();
  const h = fillHeight || currentHeight;
  const extras = otherDockedRects("chips");
  const room = taskbarLayout.dockRoom(w, h, extras);
  if (!room.fits) {
    popChipsAboveTaskbar(w, currentHeight, extras);
    return;
  }
  setChipsFill(fillHeight);
  setSizeKeepPos(chips, w, h);
  // Always snap the cross axis too: being inside the taskbar does not mean it is centered.
  let pos;
  if (cfg.chips_dock_x != null) {
    pos = taskbarLayout.snapDocked(cfg.chips_dock_x, cfg.chips_dock_y || 0, w, h, extras);
  }
  if (!pos || !pos.ok) pos = taskbarLayout.defaultDocked(w, h, extras);
  if (pos && pos.ok) {
    cfg.chips_dock_x = pos.x;
    cfg.chips_dock_y = pos.y;
    applyDockedPos(chips, pos);
    setChipsPopped(false);
    setChipsFill(taskbarFillHeight());
    keepWidgetOnTop(chips, true);
    return;
  }
  popChipsAboveTaskbar(w, h, extras);
}

function placeChipsFloating() {
  if (!chips) return;
  setChipsPopped(false);
  setChipsFill(0);
  const [w, h] = chips.getSize();
  let x = cfg.chips_x;
  let y = cfg.chips_y;
  const display =
    x != null && y != null
      ? screen.getDisplayNearestPoint({ x, y })
      : screen.getPrimaryDisplay();
  const b = display.bounds;
  if (x == null || y == null) {
    const wa = display.workArea;
    x = wa.x + wa.width - w - 12;
    y = wa.y + wa.height - h - 8;
  }
  x = Math.min(Math.max(x, b.x), b.x + b.width - w);
  y = Math.min(Math.max(y, b.y), b.y + b.height - h);
  placingChips = true;
  chips.setPosition(Math.round(x), Math.round(y));
  placingChips = false;
}

function placeChips() {
  if (!chips) return;
  if (cfg.chips_docked) placeChipsDocked();
  else placeChipsFloating();
}

function sendChipsLoading() {
  if (chips && !chips.isDestroyed()) chips.webContents.send("usage://loading");
}

function keepWidgetOnTop(win, docked) {
  if (!win || win.isDestroyed()) return;
  if (win === chips && cfg?.chips_hidden) return;
  const level = docked ? "screen-saver" : "pop-up-menu";
  win.setAlwaysOnTop(true, level, 1);
  try {
    win.webContents.setBackgroundThrottling(false);
  } catch {
    /* ignore */
  }
  if (!win.isVisible()) win.showInactive();
}

function restoreVisibility() {
  if (cfg) {
    cfg.chips_hidden = false;
    config.save(cfg);
  }
  if (!chips || chips.isDestroyed()) return;
  sendChipsLoading();
  placeChips();
  chips.setOpacity(1);
  chips.showInactive();
  keepWidgetOnTop(chips, cfg && cfg.chips_docked);
  try {
    chips.setOpacity(0.99);
    chips.setOpacity(1);
  } catch {
    /* ignore */
  }
  if (latest) {
    setTimeout(() => {
      if (chips && !chips.isDestroyed() && latest) chips.webContents.send("usage://snapshot", latest);
    }, 120);
  }
}

function recoverChipsIfNeeded() {
  if (!chips || chips.isDestroyed() || !cfg || cfg.chips_hidden || dragState) return;
  let crashed = false;
  let hidden = false;
  try {
    crashed = chips.webContents.isCrashed();
    hidden = !chips.isVisible() || chips.getOpacity() < 0.2;
  } catch {
    crashed = true;
  }
  if (crashed) {
    restoreVisibility();
    return;
  }
  if (hidden) {
    chips.setOpacity(1);
    chips.showInactive();
  }
  keepWidgetOnTop(chips, cfg.chips_docked);
}

function createTray() {
  if (tray && !tray.isDestroyed()) return;
  let icon = nativeImage.createFromPath(ui("tray-32.png"));
  if (icon.isEmpty()) icon = nativeImage.createFromPath(ui("tray-16.png"));
  if (icon.isEmpty()) return;
  // The macOS menu bar expects a 16pt icon; a 32px image would render twice as large.
  if (process.platform === "darwin") icon = icon.resize({ width: 16, height: 16, quality: "best" });
  tray = new Tray(icon);
  tray.setToolTip("Usage Monitor — click to show chips");
  tray.on("click", () => restoreVisibility());
  tray.on("double-click", () => {
    restoreVisibility();
    showFlyout();
  });
  tray.on("right-click", () => popupAppMenu());
  refreshTrayMenu();
}

// Linux AppIndicator trays do not report clicks; they only show an attached menu.
// It is replaced only when its labels change, because replacing it closes an open menu.
let trayMenuKey = "";
function refreshTrayMenu() {
  if (process.platform !== "linux" || !tray || tray.isDestroyed() || !cfg) return;
  const flyoutOpen = !!(flyout && !flyout.isDestroyed() && flyout.isVisible() && !flyout.isMinimized());
  const update = updater.getState();
  const key = [cfg.chips_hidden, cfg.chips_show_network, cfg.poll_interval_secs, cfg.autostart, cfg.auto_update, flyoutOpen, update && update.status].join("|");
  if (key === trayMenuKey) return;
  trayMenuKey = key;
  tray.setContextMenu(buildMenu());
}

function setChipsHidden(hidden) {
  cfg.chips_hidden = !!hidden;
  config.save(cfg);
  if (!chips || chips.isDestroyed()) return;
  if (cfg.chips_hidden) chips.hide();
  else {
    placeChips();
    keepWidgetOnTop(chips, cfg.chips_docked);
  }
}

function setChipsDocked(docked, opts = {}) {
  cfg.chips_docked = !!docked;
  if (!cfg.chips_docked && chips) {
    const pos = chips.getPosition();
    cfg.chips_x = opts.keepPos && opts.x != null ? opts.x : pos[0];
    cfg.chips_y = opts.keepPos && opts.y != null ? opts.y : pos[1];
  }
  config.save(cfg);
  if (chips && !chips.isDestroyed()) {
    keepWidgetOnTop(chips, cfg.chips_docked);
    chips.webContents.send("usage://chips-docked", cfg.chips_docked);
  }
  if (cfg.chips_docked) placeChipsDocked();
  else if (!opts.keepPos) placeChipsFloating();
  else if (chips) {
    setChipsFill(0);
    const [w, h] = chips.getSize();
    const p = clampToDisplay(cfg.chips_x, cfg.chips_y, w, h);
    placingChips = true;
    chips.setPosition(p.x, p.y);
    placingChips = false;
  }
}

function persistChipsPosition() {
  if (!chips || cfg.chips_docked || placingChips) return;
  const pos = chips.getPosition();
  cfg.chips_x = pos[0];
  cfg.chips_y = pos[1];
  saveSoon();
}

let placingFlyout = false;

function flyoutStaysOpen() {
  return !!(cfg && cfg.flyout_docked);
}

function unionRects(rects) {
  let x = Infinity;
  let y = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const b of rects) {
    x = Math.min(x, b.x);
    y = Math.min(y, b.y);
    right = Math.max(right, b.x + b.width);
    bottom = Math.max(bottom, b.y + b.height);
  }
  return { x, y, width: right - x, height: bottom - y };
}

function virtualScreen() {
  return unionRects(screen.getAllDisplays().map((d) => d.bounds));
}

function virtualWorkArea() {
  return unionRects(screen.getAllDisplays().map((d) => d.workArea));
}

function hideClickAway() {
  if (clickAway && !clickAway.isDestroyed() && clickAway.isVisible()) clickAway.hide();
}

function showClickAway() {
  if (!flyout || cfg.flyout_docked) {
    hideClickAway();
    return;
  }
  const area = virtualWorkArea();
  if (!clickAway || clickAway.isDestroyed()) {
    clickAway = new BrowserWindow({
      ...area,
      frame: false,
      transparent: true,
      skipTaskbar: true,
      resizable: false,
      focusable: true,
      hasShadow: false,
      show: false,
      fullscreenable: false,
      backgroundColor: "#00000000",
      webPreferences: {
        preload: path.join(__dirname, "preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    clickAway.setIgnoreMouseEvents(false);
    clickAway.loadFile(ui("clickaway.html"));
    clickAway.on("closed", () => {
      clickAway = null;
    });
  } else {
    clickAway.setBounds(area);
  }
  clickAway.setAlwaysOnTop(true, "floating");
  clickAway.showInactive();
  flyout.setAlwaysOnTop(true, "pop-up-menu", 1);
  keepWidgetOnTop(chips, cfg.chips_docked);
}

function sendFlyoutState() {
  if (!flyout || flyout.isDestroyed()) return;
  flyout.webContents.send("usage://flyout-state", {
    docked: !!cfg.flyout_docked,
    pinned: !!cfg.flyout_pinned,
    canDock: IS_WINDOWS,
  });
}

function placeFlyoutDocked() {
  if (!flyout) return;
  const [w, h] = flyout.getSize();
  const extras = otherDockedRects("flyout");
  const pos = taskbarLayout.anchorAboveTaskbar(w, h, extras, cfg.flyout_dock_x);
  if (pos && pos.ok) {
    cfg.flyout_dock_x = pos.x;
    cfg.flyout_dock_y = pos.y;
    applyDockedPos(flyout, pos);
  }
}

function placeFlyoutNearTray(bounds) {
  if (!flyout) return;
  const wa = screen.getPrimaryDisplay().workArea;
  const [w, h] = flyout.getSize();
  let x;
  let y;
  if (cfg.flyout_docked) {
    placeFlyoutDocked();
    return;
  }
  if (cfg.flyout_pinned && cfg.flyout_x != null && cfg.flyout_y != null) {
    x = cfg.flyout_x;
    y = cfg.flyout_y;
  } else if (bounds && bounds.x != null) {
    x = Math.round(bounds.x + bounds.width / 2 - w / 2);
    y = Math.round(bounds.y - h);
  } else {
    // Bottom edge flush with the top of the taskbar.
    x = wa.x + wa.width - w - 16;
    y = wa.y + wa.height - h;
  }
  const p = clampToWorkArea(x, y, w, h);
  placingFlyout = true;
  flyout.setPosition(p.x, p.y);
  placingFlyout = false;
}

function persistFlyoutPosition() {
  if (!flyout || cfg.flyout_docked || placingFlyout) return;
  const pos = flyout.getPosition();
  cfg.flyout_x = pos[0];
  cfg.flyout_y = pos[1];
  saveSoon();
}

function setFlyoutDocked(docked, opts = {}) {
  cfg.flyout_docked = !!docked;
  if (cfg.flyout_docked) cfg.flyout_pinned = true;
  if (!cfg.flyout_docked && flyout) {
    const pos = flyout.getPosition();
    cfg.flyout_x = opts.keepPos && opts.x != null ? opts.x : pos[0];
    cfg.flyout_y = opts.keepPos && opts.y != null ? opts.y : pos[1];
  }
  config.save(cfg);
  sendFlyoutState();
  if (!flyout) return;
  flyout.setAlwaysOnTop(true, cfg.flyout_docked ? "pop-up-menu" : "floating");
  if (cfg.flyout_docked) {
    placeFlyoutDocked();
    flyout.setAlwaysOnTop(true, "pop-up-menu");
    if (!flyout.isVisible()) flyout.showInactive();
  } else if (opts.keepPos && flyout) {
    const [w, h] = flyout.getSize();
    const p = clampToWorkArea(cfg.flyout_x, cfg.flyout_y, w, h);
    placingFlyout = true;
    flyout.setPosition(p.x, p.y);
    placingFlyout = false;
  }
}

function setFlyoutPinned(pinned) {
  cfg.flyout_pinned = !!pinned;
  if (!cfg.flyout_pinned) cfg.flyout_docked = false;
  config.save(cfg);
  sendFlyoutState();
  if (cfg.flyout_pinned && flyout && !flyout.isVisible()) flyout.showInactive();
}

function showFlyout(bounds) {
  if (!flyout) return;
  if (flyout.isMinimized()) flyout.restore();
  if (cfg.flyout_docked) placeFlyoutDocked();
  else if (!flyout.isVisible()) placeFlyoutNearTray(bounds);
  flyout.show();
  flyout.focus();
  broadcastNet();
  sendPairing();
  if (chips && !cfg.chips_hidden) keepWidgetOnTop(chips, cfg.chips_docked);
}

function hideFlyout(force) {
  if (!flyout) return;
  if (!force && flyoutStaysOpen()) return;
  hideClickAway();
  flyout.hide();
  if (chips && !cfg.chips_hidden) keepWidgetOnTop(chips, cfg.chips_docked);
}

function broadcast(snap) {
  latest = snap;
  for (const win of [flyout, chips]) {
    if (win && !win.isDestroyed()) win.webContents.send("usage://snapshot", snap);
  }
}

function setPollInterval(secs) {
  const next = config.ALLOWED_INTERVALS.includes(Number(secs)) ? Number(secs) : 5;
  cfg.poll_interval_secs = next;
  config.save(cfg);
  if (poll) poll.setIntervalSecs(next);
  broadcastInterval();
}

function broadcastInterval() {
  const secs = cfg.poll_interval_secs || 5;
  for (const win of [flyout, chips]) {
    if (win && !win.isDestroyed()) win.webContents.send("usage://interval", secs);
  }
}

// Live network speed for the chips (always) and the flyout (only while it is open).
const TRAY_TIP = "Usage Monitor — click to show chips";
let lastTrayTip = TRAY_TIP;
function broadcastNet() {
  if (!cfg) return;
  const flyoutOpen = !!(flyout && !flyout.isDestroyed() && flyout.isVisible());
  const chipsOn = !!(chips && !chips.isDestroyed() && !cfg.chips_hidden);
  let summary = null;
  try {
    summary = netUsage.summary({ hour: flyoutOpen });
  } catch (err) {
    console.error("network summary failed", err.message);
  }
  if (chipsOn) chips.webContents.send("usage://net", cfg.chips_show_network !== false ? summary : null);
  if (flyoutOpen) flyout.webContents.send("usage://net", summary);
  if (tray && !tray.isDestroyed()) {
    const tip =
      summary && summary.state === "running"
        ? `Usage Monitor — ↓ ${formatRateShort(summary.rx_rate)}  ↑ ${formatRateShort(summary.tx_rate)}`
        : TRAY_TIP;
    if (tip !== lastTrayTip) {
      lastTrayTip = tip;
      tray.setToolTip(tip);
    }
  }
}

function buildMenu() {
  return Menu.buildFromTemplate([
    { label: "Network usage…", click: () => netUsage.openWindow() },
    { label: "Settings…", click: () => openSettings() },
    { type: "separator" },
    { label: "Show chips", click: () => restoreVisibility() },
    {
      label: cfg.chips_hidden ? "Show chips on taskbar" : "Hide chips",
      click: () => setChipsHidden(!cfg.chips_hidden),
    },
    {
      label: "Show network speed on chips",
      type: "checkbox",
      checked: cfg.chips_show_network !== false,
      click: (item) => {
        cfg.chips_show_network = item.checked;
        config.save(cfg);
        broadcastNet();
        refreshTrayMenu();
      },
    },
    { label: "Refresh now", click: () => poll && poll.refresh() },
    {
      label: "Refresh every",
      submenu: config.ALLOWED_INTERVALS.map((secs) => ({
        label: `${secs} seconds`,
        type: "radio",
        checked: Number(cfg.poll_interval_secs) === secs,
        click: () => setPollInterval(secs),
      })),
    },
    { type: "separator" },
    {
      label: flyout && flyout.isVisible() && !flyout.isMinimized() ? "Hide flyout" : "Open flyout",
      click: () => {
        if (flyout && flyout.isVisible() && !flyout.isMinimized()) hideFlyout(true);
        else showFlyout();
      },
    },
    {
      label: LOGIN_LABEL,
      type: "checkbox",
      checked: !!cfg.autostart,
      click: (item) => {
        cfg.autostart = autostart.apply(item.checked);
        config.save(cfg);
        refreshTrayMenu();
        sendSettings();
      },
    },
    {
      label: "Install updates automatically",
      type: "checkbox",
      checked: cfg.auto_update !== false,
      click: (item) => {
        cfg.auto_update = item.checked;
        config.save(cfg);
        updater.settingChanged();
        refreshTrayMenu();
        sendSettings();
      },
    },
    { label: "Check for updates now", click: () => runUpdateCheck() },
    { label: updateMenuLabel(), enabled: false },
    ...(IS_WINDOWS ? taskbarMenuItems() : []),
    { type: "separator" },
    { label: "Quit", click: () => app.quit() },
  ]);
}

// Taskbar snapping is specific to the Windows taskbar.
function taskbarMenuItems() {
  return [
    {
      label: cfg.flyout_docked ? "Unsnap flyout from taskbar" : "Snap flyout to taskbar",
      click: () => {
        if (cfg.flyout_docked) {
          setFlyoutDocked(false);
        } else {
          setFlyoutPinned(true);
          setFlyoutDocked(true);
          showFlyout();
        }
      },
    },
    {
      label: cfg.chips_docked ? "Unsnap chips from taskbar" : "Snap chips to taskbar",
      click: () => setChipsDocked(!cfg.chips_docked),
    },
  ];
}

function finishDrag() {
  if (!dragState || dragState.win.isDestroyed()) {
    dragState = null;
    return;
  }
  const win = dragState.win;
  dragState = null;
  const [x, y] = win.getPosition();
  const [w, h] = win.getSize();

  if (win === chips) {
    if (cfg.chips_docked) {
      const snapped = taskbarLayout.snapDocked(x, y, w, h, otherDockedRects("chips"));
      if (snapped.ok) {
        cfg.chips_dock_x = snapped.x;
        cfg.chips_dock_y = snapped.y;
        applyDockedPos(chips, snapped);
        config.save(cfg);
      }
    } else {
      const p = clampToDisplay(x, y, w, h);
      placingChips = true;
      chips.setPosition(p.x, p.y);
      placingChips = false;
      persistChipsPosition();
    }
    return;
  }

  if (win === flyout) {
    if (cfg.flyout_docked) {
      const snapped = taskbarLayout.anchorAboveTaskbar(w, h, otherDockedRects("flyout"), x);
      if (snapped && snapped.ok) {
        cfg.flyout_dock_x = snapped.x;
        cfg.flyout_dock_y = snapped.y;
        applyDockedPos(flyout, snapped);
        config.save(cfg);
      }
    } else {
      const p = clampToWorkArea(x, y, w, h);
      placingFlyout = true;
      flyout.setPosition(p.x, p.y);
      placingFlyout = false;
      persistFlyoutPosition();
    }
    return;
  }
}

const UPDATE_LABELS = {
  checking: "checking for updates…",
  "up-to-date": "up to date",
  downloading: "downloading an update…",
  ready: "update ready",
  installing: "installing an update…",
  available: "update available",
  off: "automatic updates off",
};

function updateMenuLabel() {
  const u = updater.getState();
  const version = `Version ${app.getVersion()}`;
  const note = u && (u.status === "available" && u.latest ? `${u.latest} available` : UPDATE_LABELS[u.status]);
  return note ? `${version} — ${note}` : version;
}

function sendUpdateState(state) {
  if (flyout && !flyout.isDestroyed()) flyout.webContents.send("usage://update", state);
  refreshTrayMenu();
  sendSettings();
}

// ---- settings window -----------------------------------------------------------------

function prefs() {
  return { alert_threshold: cfg.alert_threshold, chips_show: cfg.chips_show };
}

function broadcastPrefs() {
  for (const win of [flyout, chips]) {
    if (win && !win.isDestroyed()) win.webContents.send("usage://prefs", prefs());
  }
}

function settingsView() {
  const keys = ["autostart", "poll_interval_secs", "chips_hidden", "chips_docked", "chips_show_network", "chips_show", "alert_threshold",
    "notify_on_limit_reached", "forecast_alerts", "quiet_hours", "auto_update", "update_channel"];
  return {
    platform: process.platform,
    version: app.getVersion(),
    login_label: LOGIN_LABEL,
    intervals: config.ALLOWED_INTERVALS,
    thresholds: config.ALERT_THRESHOLDS,
    settings: Object.fromEntries(keys.map((k) => [k, cfg[k]])),
    update: updater.getState(),
    phone: phone ? withQr(phone.status()) : null,
    accounts: accounts.list(),
  };
}

function present(snapshot) {
  if (!snapshot) return snapshot;
  return { ...snapshot, providers: (snapshot.providers || []).map((provider) => accounts.decorate(provider)) };
}

const ACCOUNT_TOOLS = Object.keys(accounts.TOOLS);

async function beginAccountSwitch(provider, accountId) {
  if (!ACCOUNT_TOOLS.includes(provider)) return { ok: false, error: "Unknown tool" };
  const row = accounts.list().find((item) => item.id === provider);
  if (accountId) {
    if (!accounts.select(provider, accountId)) return { ok: false, error: "That account is not saved on this computer." };
    cfg.accounts[provider] = accountId;
    config.save(cfg);
    if (latest) {
      latest = present(latest);
      broadcast(latest);
    }
    if (poll) poll.refresh();
    sendSettings();
    return { ok: true, view: settingsView(), message: `${row ? row.label : "The meters"} will use that account.` };
  }
  const opened = await accounts.openLogin(provider);
  if (!opened.ok) return opened;
  return { ok: true, view: settingsView(), message: `Sign-in opened in your browser. To change the account the meters read, also sign in with ${row ? row.login_command : "the tool"}.` };
}

function askAccountSwitch(provider, accountId) {
  if (!ACCOUNT_TOOLS.includes(provider)) return;
  if (accountId && !accounts.hasChoice(provider, accountId)) return;
  const row = accounts.list().find((item) => item.id === provider);
  const name = row ? row.label : provider;
  const choice = accountId && row && row.choices.find((item) => item.id === accountId);
  const parent = settingsWin && !settingsWin.isDestroyed()
    ? settingsWin
    : flyout && !flyout.isDestroyed() ? flyout : null;
  const options = {
    type: "question",
    buttons: ["Switch", "Cancel"],
    defaultId: 1,
    cancelId: 1,
    title: "Usage Monitor",
    message: choice
      ? `Your phone asked to use ${choice.label} for ${name}.`
      : `Your phone asked to switch the ${name} account. Sign-in opens on this computer.`,
    detail: choice
      ? "The meters on this computer will follow that saved sign-in."
      : "The provider's sign-in page opens in your browser. To change the meters, also sign in through the tool on this computer.",
  };
  const box = parent ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options);
  box.then((result) => {
    if (result.response === 0) return beginAccountSwitch(provider, accountId);
  }).catch(() => {});
}

function askDirectReading(device) {
  const parent = settingsWin && !settingsWin.isDestroyed()
    ? settingsWin
    : flyout && !flyout.isDestroyed() ? flyout : null;
  const options = {
    type: "question",
    buttons: ["Allow", "Cancel"],
    defaultId: 1,
    cancelId: 1,
    title: "Usage Monitor",
    message: `Let ${device.name} read your plan usage directly?`,
    detail: "The phone receives this computer's current Claude Code, Codex, Gemini, Grok and Cursor access tokens, "
      + "so its meters keep updating away from this computer until each token expires. It uses them only to read usage. "
      + "Sign-in refresh tokens stay here. Stop it any time in Settings → Phone.",
  };
  const box = parent ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options);
  box.then((result) => {
    if (result.response === 0 && phone) phone.setDirect(device.id, true);
  }).catch(() => {});
}

// Access tokens for a phone allowed to read usage directly. Copilot is not metered on phones.
async function phoneTokens() {
  const tools = { claude, codex, gemini, grok, cursor };
  const tokens = {};
  await Promise.all(Object.entries(tools).map(async ([id, adapter]) => {
    try {
      const token = await adapter.linkToken(cfg);
      if (token && token.access_token) tokens[id] = token;
    } catch {
      /* that tool is not signed in */
    }
  }));
  return tokens;
}

function refreshAccounts() {
  const preferred = cfg && cfg.accounts;
  accounts.refresh(preferred).then(() => {
    if (latest) {
      latest = present(latest);
      broadcast(latest);
    }
    sendSettings();
  }).catch(() => {});
}

let qrCache = { link: null, url: null };
function pairingActive() {
  return !!(phone && phone.status().pairing);
}
function withQr(status) {
  if (status.pairing) {
    if (qrCache.link !== status.pairing.link) {
      const qr = require("qrcode-generator")(0, "M");
      qr.addData(status.pairing.link);
      qr.make();
      const svg = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
      qrCache = { link: status.pairing.link, url: `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}` };
    }
    status.pairing.qr = qrCache.url;
  }
  return status;
}

function sendPairing() {
  const status = phone ? withQr(phone.status()) : null;
  if (flyout && !flyout.isDestroyed()) flyout.webContents.send("usage://pairing", status);
  if (!flyout || flyout.isDestroyed() || !flyout.isVisible()) return;
  // A code on screen has to stay visible while the phone is scanned, so clicks on the
  // desktop must not dismiss the flyout. The flyout still hides from its own controls.
  if ((status && status.pairing) || (cfg && cfg.flyout_docked)) hideClickAway();
  else showClickAway();
}

function beginPairing() {
  if (!phone) return null;
  const wasOff = !cfg.phone.enabled;
  const status = withQr(phone.beginPairing());
  if (wasOff) config.save(cfg);
  return status;
}

function sendSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send("settings:state", settingsView());
}

function openSettings() {
  refreshAccounts();
  if (settingsWin && !settingsWin.isDestroyed()) {
    if (settingsWin.isMinimized()) settingsWin.restore();
    settingsWin.show();
    settingsWin.focus();
    return;
  }
  settingsWin = new BrowserWindow({
    width: 640,
    height: 760,
    minWidth: 520,
    minHeight: 480,
    show: false,
    title: "Settings - Usage Monitor",
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#1a1a19" : "#fcfcfb",
    autoHideMenuBar: true,
    icon: ui("icon-256.png"),
    webPreferences: {
      preload: path.join(__dirname, "settings-preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  settingsWin.setMenuBarVisibility(false);
  settingsWin.loadFile(ui("settings.html"));
  settingsWin.once("ready-to-show", () => settingsWin && settingsWin.show());
  settingsWin.on("closed", () => {
    settingsWin = null;
    // The code keeps working for its 10 minutes. Put it on the flyout so it stays on screen.
    if (pairingActive()) showFlyout();
  });
}

function bool(value) {
  return typeof value === "boolean" ? value : null;
}

// Applies a patch from the settings window. Every field is checked; unknown ones are ignored.
function applySettings(patch) {
  if (!patch || typeof patch !== "object") return settingsView();
  if (bool(patch.autostart) !== null) cfg.autostart = autostart.apply(patch.autostart);
  if ("poll_interval_secs" in patch && config.ALLOWED_INTERVALS.includes(Number(patch.poll_interval_secs))) setPollInterval(Number(patch.poll_interval_secs));
  if (bool(patch.chips_hidden) !== null && patch.chips_hidden !== cfg.chips_hidden) setChipsHidden(patch.chips_hidden);
  if (IS_WINDOWS && bool(patch.chips_docked) !== null && patch.chips_docked !== cfg.chips_docked) setChipsDocked(patch.chips_docked);
  if (bool(patch.chips_show_network) !== null) {
    cfg.chips_show_network = patch.chips_show_network;
    broadcastNet();
  }
  if (patch.chips_show && typeof patch.chips_show === "object") {
    for (const key of config.CHIP_KEYS) if (bool(patch.chips_show[key]) !== null) cfg.chips_show[key] = patch.chips_show[key];
  }
  if (config.ALERT_THRESHOLDS.includes(Number(patch.alert_threshold))) cfg.alert_threshold = Number(patch.alert_threshold);
  if (bool(patch.notify_on_limit_reached) !== null) cfg.notify_on_limit_reached = patch.notify_on_limit_reached;
  if (bool(patch.forecast_alerts) !== null) cfg.forecast_alerts = patch.forecast_alerts;
  if (patch.quiet_hours && typeof patch.quiet_hours === "object") {
    cfg.quiet_hours = config.normalize({ quiet_hours: { ...cfg.quiet_hours, ...patch.quiet_hours } }).quiet_hours;
  }
  let updatesChanged = false;
  if (bool(patch.auto_update) !== null && patch.auto_update !== cfg.auto_update) {
    cfg.auto_update = patch.auto_update;
    updatesChanged = true;
  }
  if (config.UPDATE_CHANNELS.includes(patch.update_channel) && patch.update_channel !== cfg.update_channel) {
    cfg.update_channel = patch.update_channel;
    updatesChanged = true;
  }
  let phoneChanged = false;
  if (bool(patch.phone_enabled) !== null && patch.phone_enabled !== cfg.phone.enabled) {
    cfg.phone.enabled = patch.phone_enabled;
    phoneChanged = true;
  }
  const port = Number(patch.phone_port);
  if (Number.isInteger(port) && port >= 1024 && port <= 65535 && port !== cfg.phone.port) {
    cfg.phone.port = port;
    phoneChanged = true;
  }
  config.save(cfg);
  if (updatesChanged) updater.settingChanged();
  if (phoneChanged && phone) phone.apply();
  broadcastPrefs();
  if (latest) broadcast(latest);
  refreshTrayMenu();
  const view = settingsView();
  sendSettings();
  return view;
}

// What a paired phone receives: the plan meters (with forecasts) and a few live readings.
function phonePayload() {
  let net = null;
  try {
    const s = netUsage.summary({ hour: true });
    if (s) net = { state: s.state, rx_rate: s.rx_rate, tx_rate: s.tx_rate, hour: s.hour || null, top: (s.top || []).slice(0, 3) };
  } catch {
    net = null;
  }
  return {
    v: 1,
    app_version: app.getVersion(),
    name: os.hostname(),
    generated_at: new Date().toISOString(),
    alert_threshold: cfg.alert_threshold,
    providers: ((latest && latest.providers) || []).map((p) => ({
      id: p.id,
      display_name: p.display_name,
      plan: p.plan || null,
      status: { state: (p.status && p.status.state) || "unknown", hint: (p.status && (p.status.hint || p.status.message)) || null },
      fetched_at: p.fetched_at || null,
      account: typeof p.account === "string" ? p.account : null,
      accounts: Array.isArray(p.accounts)
        ? p.accounts.filter((item) => item && typeof item.id === "string" && typeof item.label === "string").map((item) => ({ id: item.id, label: item.label, active: !!item.active }))
        : [],
      windows: (p.windows || []).map((w) => ({
        kind: w.kind,
        label: w.label,
        used_pct: Number.isFinite(w.used_pct) ? w.used_pct : null,
        resets_at: w.resets_at || null,
        forecast_at: w.forecast_at || null,
        burn_per_hour: Number.isFinite(w.burn_per_hour) ? w.burn_per_hour : null,
      })),
    })),
    system: latestSystem
      ? { cpu: latestSystem.cpu, mem: latestSystem.mem, gpu: latestSystem.gpuPresent ? latestSystem.gpu : null, disk: latestSystem.disk, disk_rate: latestSystem.diskRate, space: latestSystem.space }
      : null,
    network: net,
  };
}

async function runUpdateCheck() {
  ignoreFlyoutBlur = true;
  try {
    return await updater.checkNow();
  } finally {
    setTimeout(() => {
      ignoreFlyoutBlur = false;
    }, 300);
  }
}

function startUpdater() {
  updater.start({
    getConfig: () => cfg,
    saveConfig: () => config.save(cfg),
    onState: sendUpdateState,
    // Restart for an update only while nobody is dragging a widget or working in Network usage.
    canRestart: () => !dragState && !netUsage.isWindowFocused() && !(settingsWin && !settingsWin.isDestroyed() && settingsWin.isFocused()),
    isQuiet: () => config.inQuietHours(cfg),
    beforeRestart: () => {
      app.isQuitting = true;
    },
    dialogParent: () => (flyout && !flyout.isDestroyed() && flyout.isVisible() ? flyout : null),
  });
}

// Floating widgets keep their saved coordinates; after a monitor is unplugged those can lie
// off every screen, so pull them back onto the nearest display.
function reclampWidgets() {
  if (!cfg) return;
  if (chips && !chips.isDestroyed()) {
    if (cfg.chips_docked) placeChipsDocked();
    else if (!cfg.chips_hidden) placeChipsFloating();
  }
  if (flyout && !flyout.isDestroyed()) {
    if (cfg.flyout_docked) placeFlyoutDocked();
    else if (flyout.isVisible()) {
      const [x, y] = flyout.getPosition();
      const [w, h] = flyout.getSize();
      const p = clampToWorkArea(x, y, w, h);
      if (p.x !== x || p.y !== y) {
        placingFlyout = true;
        flyout.setPosition(p.x, p.y);
        placingFlyout = false;
      }
    }
  }
}

function popupAppMenu() {
  ignoreFlyoutBlur = true;
  const menu = buildMenu();
  const done = () => {
    setTimeout(() => {
      ignoreFlyoutBlur = false;
    }, 200);
  };
  if (tray && !tray.isDestroyed()) {
    tray.popUpContextMenu(menu);
    done();
    return;
  }
  menu.popup({ callback: done });
}

function createWindows() {
  flyout = createWindow({
    width: 580,
    height: 280,
    focusable: true,
    hasShadow: false,
  });
  flyout.loadFile(ui("flyout.html"));
  flyout.setAlwaysOnTop(true, cfg.flyout_docked || cfg.flyout_pinned ? "pop-up-menu" : "floating");
  flyout.on("blur", () => {
    if (ignoreFlyoutBlur || (cfg && cfg.flyout_docked) || pairingActive()) return;
    setTimeout(() => {
      if (ignoreFlyoutBlur || (cfg && cfg.flyout_docked) || pairingActive()) return;
      if (flyout && flyout.isFocused()) return;
      hideFlyout(true);
    }, 180);
  });
  flyout.on("moved", () => {
    if (placingFlyout || dragState) return;
    if (!cfg.flyout_docked) persistFlyoutPosition();
  });
  flyout.on("close", (e) => {
    if (app.isQuitting) return;
    e.preventDefault();
    hideFlyout(true);
  });
  flyout.on("closed", () => {
    flyout = null;
  });

  createChips();
}

function createChips() {
  const win = createWindow({
    width: 340,
    height: 48,
    focusable: false,
    hasShadow: false,
  });
  chips = win;
  win.loadFile(ui("chips.html"));
  win.setAlwaysOnTop(true, cfg.chips_docked ? "screen-saver" : "pop-up-menu", 1);
  win.once("ready-to-show", () => {
    if (cfg.chips_hidden || chips !== win) return;
    placeChips();
    keepWidgetOnTop(win, cfg.chips_docked);
  });
  win.on("moved", () => {
    if (placingChips || dragState) return;
    if (!cfg.chips_docked) persistChipsPosition();
  });
  win.webContents.on("did-finish-load", () => {
    win.webContents.send("usage://chips-docked", !!cfg.chips_docked);
    win.webContents.send("usage://chips-popped", chipsPopped);
    win.webContents.send("usage://chips-fill", chipsFill);
    win.webContents.send("usage://prefs", prefs());
    if (latest) win.webContents.send("usage://snapshot", latest);
    if (latestSystem) win.webContents.send("usage://system", latestSystem);
  });
  win.webContents.on("render-process-gone", () => {
    try {
      sendChipsLoading();
      win.webContents.reload();
    } catch {
      /* ignore */
    }
  });
  win.on("closed", () => {
    if (chips === win) chips = null;
    // Windows destroys the strip together with the taskbar that owns it (for example when
    // Explorer restarts), so bring it back unless the app is quitting.
    if (!app.isQuitting) {
      setTimeout(() => {
        if (!chips && !app.isQuitting) createChips();
      }, 1500);
    }
  });
  if (process.platform === "win32") {
    const pin = () => {
      setTimeout(() => {
        if (dragState || !cfg || cfg.chips_hidden) return;
        keepWidgetOnTop(chips, cfg.chips_docked);
      }, 30);
    };
    try {
      win.hookWindowMessage(0x0006, pin);
      win.hookWindowMessage(0x001c, pin);
    } catch {
      /* ignore */
    }
  }
}

function wireIpc() {
  ipcMain.on("usage://refresh", () => poll && poll.refresh());
  ipcMain.on("usage://drag-begin", (e, sx, sy) => {
    if (!Number.isFinite(sx) || !Number.isFinite(sy)) return;
    const win = BrowserWindow.fromWebContents(e.sender);
    if (!win || (win !== chips && win !== flyout)) return;
    const [x, y] = win.getPosition();
    dragState = { win, originX: x, originY: y, sx, sy };
  });
  ipcMain.on("usage://drag-to", (e, sx, sy) => {
    if (!dragState || dragState.win.isDestroyed()) return;
    if (!Number.isFinite(sx) || !Number.isFinite(sy) || e.sender !== dragState.win.webContents) return;
    const x = dragState.originX + (sx - dragState.sx);
    const y = dragState.originY + (sy - dragState.sy);
    placingFlyout = placingChips = true;
    dragState.win.setPosition(Math.round(x), Math.round(y));
    placingFlyout = placingChips = false;
  });
  ipcMain.on("usage://drag-end", () => finishDrag());
  ipcMain.on("usage://flyout-hide", () => hideFlyout(true));
  ipcMain.on("usage://flyout-toggle", () => {
    if (!flyout || flyout.isDestroyed()) return;
    if (flyout.isVisible() && !flyoutStaysOpen()) hideFlyout(true);
    else showFlyout();
  });
  ipcMain.on("usage://flyout-toggle-pin", () => setFlyoutPinned(!cfg.flyout_pinned));
  ipcMain.on("usage://flyout-toggle-dock", () => setFlyoutDocked(!cfg.flyout_docked));
  ipcMain.handle("usage://get-flyout-state", () => ({
    docked: !!(cfg && cfg.flyout_docked),
    pinned: !!(cfg && cfg.flyout_pinned),
    canDock: IS_WINDOWS,
  }));
  ipcMain.on("usage://flyout-resize", (_e, h, w) => {
    if (!flyout || !Number.isFinite(h) || !Number.isFinite(w)) return;
    const width = Math.max(560, Math.min(860, Math.round(w || 580)));
    const height = Math.max(140, Math.min(860, Math.round(h)));
    if (cfg.flyout_docked || dragState) {
      setSizeKeepPos(flyout, width, height);
      if (cfg.flyout_docked && !dragState) placeFlyoutDocked();
      return;
    }
    const [x, y] = flyout.getPosition();
    const [cw, ch] = flyout.getSize();
    if (cw === width && ch === height) return;
    // A flyout resting on the taskbar grows upward; otherwise it grows down but stays in the work area.
    const wa = screen.getDisplayMatching(flyout.getBounds()).workArea;
    const onTaskbar = y + ch >= wa.y + wa.height - 2;
    const p = clampToWorkArea(x, onTaskbar ? wa.y + wa.height - height : y, width, height);
    placingFlyout = true;
    flyout.setBounds({ x: p.x, y: p.y, width, height });
    placingFlyout = false;
  });
  ipcMain.on("usage://tray-menu", () => popupAppMenu());
  ipcMain.on("usage://open-network", () => netUsage.openWindow());
  ipcMain.on("usage://open-usage", (_e, id) => {
    if (Object.hasOwn(USAGE_URLS, id)) shell.openExternal(USAGE_URLS[id]).catch((err) => console.error("open usage failed", err.message));
  });
  ipcMain.handle("usage://get-interval", () => cfg.poll_interval_secs || 5);
  ipcMain.on("usage://set-interval", (_e, secs) => setPollInterval(secs));
  ipcMain.on("usage://chips-resize", (_e, w, h) => {
    if (!chips || chips.isDestroyed() || !Number.isFinite(w) || !Number.isFinite(h)) return;
    const width = Math.max(96, Math.min(720, Math.round(w)));
    const height = Math.max(24, Math.min(120, Math.round(h)));
    const [cw, ch] = chips.getSize();
    if (Math.abs(cw - width) < 2 && Math.abs(ch - height) < 2) return;
    const [cx, cy] = chips.getPosition();
    setSizeKeepPos(chips, width, height);
    if (cfg.chips_docked && !cfg.chips_hidden && !dragState) {
      const layout = taskbarLayout.loadLayout();
      const tray = layout && layout.tray;
      const horizontal = !tray || tray.w >= tray.h;
      placingChips = true;
      if (horizontal) chips.setPosition(cx + cw - width, cy);
      else chips.setPosition(cx, cy + ch - height);
      placingChips = false;
      placeChipsDocked();
    }
  });
  ipcMain.handle("usage://get-chips-docked", () => !!cfg.chips_docked);
  ipcMain.handle("usage://get-update", () => updater.getState());
  ipcMain.handle("usage://get-prefs", () => prefs());
  ipcMain.on("usage://open-settings", () => openSettings());
  ipcMain.handle("usage://pair-phone", () => beginPairing());
  ipcMain.handle("usage://pair-cancel", () => {
    if (phone) phone.cancelPairing();
    return phone ? withQr(phone.status()) : null;
  });
  ipcMain.handle("usage://get-pairing", () => (phone ? withQr(phone.status()) : null));
  const fromSettings = (e) => !!(settingsWin && !settingsWin.isDestroyed() && e.sender === settingsWin.webContents);
  ipcMain.handle("settings:get", (e) => (fromSettings(e) ? settingsView() : null));
  ipcMain.handle("settings:set", (e, patch) => (fromSettings(e) ? applySettings(patch) : null));
  ipcMain.handle("settings:phone", (e, op, arg) => {
    if (!fromSettings(e) || !phone) return null;
    if (op === "pair") beginPairing();
    else if (op === "cancel") phone.cancelPairing();
    else if (op === "remove" && typeof arg === "string") phone.removeDevice(arg);
    else if (op === "unlink" && typeof arg === "string") phone.setDirect(arg, false);
    return settingsView();
  });
  ipcMain.handle("settings:account", (e, provider, accountId) => {
    if (!fromSettings(e)) return null;
    return beginAccountSwitch(provider, typeof accountId === "string" && accountId ? accountId : null);
  });
  ipcMain.on("settings:check-updates", (e) => {
    if (fromSettings(e)) runUpdateCheck();
  });
  ipcMain.on("settings:open-network", (e) => {
    if (fromSettings(e)) netUsage.openWindow();
  });
  ipcMain.on("settings:open-logs", (e) => {
    if (fromSettings(e)) shell.openPath(path.dirname(log.logFile())).catch(() => {});
  });
  ipcMain.on("usage://update-action", () => {
    ignoreFlyoutBlur = true;
    updater.action();
    setTimeout(() => {
      ignoreFlyoutBlur = false;
    }, 300);
  });
}

app.setName("Usage Monitor");
app.on("web-contents-created", (_event, contents) => {
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  contents.on("will-navigate", (event) => event.preventDefault());
  contents.on("will-attach-webview", (event) => event.preventDefault());
});
process.on("SIGHUP", () => {});
process.on("SIGINT", () => {});
if (process.platform === "win32") {
  app.setAppUserModelId("Shivam.UsageMonitor");
  app.commandLine.appendSwitch("wm-window-animations-disabled");
  app.commandLine.appendSwitch("disable-renderer-backgrounding");
  app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");
  app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  log.install();
  // `--network` (e.g. from a shortcut) opens the Network usage window instead of the flyout.
  app.on("second-instance", (_event, argv) => {
    if (argv.includes("--network")) netUsage.openWindow();
    else showFlyout();
  });
  app.whenReady().then(() => {
    // macOS needs an Edit menu for copy/paste shortcuts; elsewhere the widgets have no menu bar.
    Menu.setApplicationMenu(
      process.platform === "darwin" ? Menu.buildFromTemplate([{ role: "appMenu" }, { role: "editMenu" }, { role: "windowMenu" }]) : null
    );
    if (process.platform === "darwin" && app.dock) app.dock.hide();
    cfg = config.ensure();
    cfg.autostart = autostart.apply(cfg.autostart !== false);
    config.save(cfg);
    try {
      netUsage.init({
        cfg,
        save: () => saveSoon(),
        setAutostart: (enabled) => {
          cfg.autostart = autostart.apply(enabled);
          config.save(cfg);
          refreshTrayMenu();
        },
      });
      if (process.argv.includes("--network")) netUsage.openWindow();
    } catch (err) {
      console.error("network monitor unavailable", err.message);
    }

    history = new History();
    phone = new PhoneLink({
      getConfig: () => cfg,
      saveConfig: () => config.save(cfg),
      payload: phonePayload,
      tokens: phoneTokens,
      onChange: () => {
        sendSettings();
        sendPairing();
      },
      onAccount: askAccountSwitch,
      onLink: askDirectReading,
    });
    phone.apply();

    createWindows();
    createTray();
    wireIpc();
    startUpdater();
    systemPoll = systemUsage.start((snapshot) => {
      latestSystem = snapshot;
      if (chips && !chips.isDestroyed()) chips.webContents.send("usage://system", snapshot);
    });

    flyout.webContents.on("did-finish-load", () => {
      flyout.webContents.send("usage://interval", cfg.poll_interval_secs || 5);
      sendFlyoutState();
      flyout.webContents.send("usage://update", updater.getState());
      flyout.webContents.send("usage://prefs", prefs());
      if (latest) flyout.webContents.send("usage://snapshot", latest);
      sendPairing();
      if (flyoutStaysOpen()) showFlyout();
    });
    const revive = (win) => {
      if (!win || win.isDestroyed()) return;
      win.webContents.on("render-process-gone", () => {
        try {
          if (win === chips) sendChipsLoading();
          win.webContents.reload();
        } catch {
          /* ignore */
        }
      });
    };
    revive(flyout);

    let metricsTimer = null;
    const displaysChanged = () => {
      clearTimeout(metricsTimer);
      metricsTimer = setTimeout(() => {
        taskbarLayout.invalidate();
        reclampWidgets();
      }, 300);
    };
    screen.on("display-metrics-changed", displaysChanged);
    screen.on("display-removed", displaysChanged);
    screen.on("display-added", displaysChanged);

    if (!latest) sendChipsLoading();
    refreshAccounts();
    poll = poller.start(cfg, (snap) => {
      const { snapshot: fresh } = applyLocalResets(snap);
      history.record(fresh);
      const snapshot = present(history.annotate(fresh));
      latest = snapshot;
      broadcast(snapshot);
      alerts.evaluate(snapshot, {
        notifyOnLimit: cfg.notify_on_limit_reached,
        threshold: cfg.alert_threshold,
        forecastAlerts: cfg.forecast_alerts,
        quiet: config.inQuietHours(cfg),
        onClick: () => showFlyout(),
      });
    });

    setInterval(() => {
      if (!latest) return;
      const { snapshot, changed } = applyLocalResets(latest);
      if (!changed) return;
      latest = snapshot;
      broadcast(snapshot);
      if (poll) poll.refresh();
    }, 1000);

    setInterval(() => {
      if (dragState) return;
      recoverChipsIfNeeded();
    }, 800);
    setInterval(refreshAccounts, 60_000);
    if (process.platform === "linux") setInterval(refreshTrayMenu, 3000);
    setInterval(broadcastNet, 1000);
    setInterval(() => {
      if (dragState) return;
      if (chips && !cfg.chips_hidden && !chips.isDestroyed() && cfg.chips_docked) {
        placeChipsDocked();
      }
    }, 8000);
  });
}

app.on("window-all-closed", (e) => {
  e.preventDefault();
});

app.on("before-quit", () => {
  app.isQuitting = true;
  clearTimeout(saveTimer);
  if (cfg) {
    try { config.save(cfg); } catch (err) { console.error("config write failed", err.message); }
  }
  if (poll) poll.stop();
  if (history) history.flush();
  if (phone) phone.stop();
  updater.stop();
  if (systemPoll) systemPoll.stop();
  netUsage.shutdown();
  if (tray && !tray.isDestroyed()) tray.destroy();
});
