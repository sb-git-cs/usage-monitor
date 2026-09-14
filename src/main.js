const { app, BrowserWindow, Menu, ipcMain, shell, screen } = require("electron");
const path = require("path");
const config = require("./config");
const poller = require("./poller");
const alerts = require("./alerts");
const taskbarLayout = require("./taskbarLayout");
const autostart = require("./autostart");

let cfg;
let flyout;
let chips;
let poll;
let latest;
let saveTimer = null;

function saveSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => config.save(cfg), 200);
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
  if (Math.abs(cw - w) < 2 && Math.abs(ch - h) < 2) return;
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
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
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
  placingChips = true;
  placingFlyout = true;
  win.setPosition(pos.x, pos.y);
  placingChips = false;
  placingFlyout = false;
}

function placeChipsDocked() {
  if (!chips) return;
  const [w, h] = chips.getSize();
  const extras = otherDockedRects("chips");
  let pos;
  if (cfg.chips_dock_x != null) {
    pos = taskbarLayout.snapDocked(cfg.chips_dock_x, cfg.chips_dock_y || 0, w, h, extras);
  }
  if (!pos || !pos.ok) pos = taskbarLayout.defaultDocked(w, h, extras);
  if (pos && pos.ok) {
    cfg.chips_dock_x = pos.x;
    cfg.chips_dock_y = pos.y;
    applyDockedPos(chips, pos);
  }
}

function placeChipsFloating() {
  if (!chips) return;
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

function keepWidgetOnTop(win, docked) {
  if (!win || win.isDestroyed()) return;
  win.setAlwaysOnTop(true, docked ? "screen-saver" : "pop-up-menu");
  if (!win.isVisible()) win.showInactive();
  win.moveTop();
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
  return !!(cfg && (cfg.flyout_docked || cfg.flyout_pinned));
}

function sendFlyoutState() {
  if (!flyout || flyout.isDestroyed()) return;
  flyout.webContents.send("usage://flyout-state", {
    docked: !!cfg.flyout_docked,
    pinned: !!cfg.flyout_pinned,
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
    y = Math.round(bounds.y - h - 8);
  } else {
    x = wa.x + wa.width - w - 16;
    y = wa.y + wa.height - h - 8;
  }
  const p = clampToDisplay(x, y, w, h);
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
    const p = clampToDisplay(cfg.flyout_x, cfg.flyout_y, w, h);
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
  else if (!flyout.isVisible() || !cfg.flyout_pinned) placeFlyoutNearTray(bounds);
  flyout.show();
  if (!flyoutStaysOpen()) flyout.focus();
  else flyout.showInactive();
}

function hideFlyout(force) {
  if (!flyout) return;
  if (!force && flyoutStaysOpen()) return;
  flyout.setAlwaysOnTop(false);
  flyout.minimize();
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

function buildMenu() {
  return Menu.buildFromTemplate([
    {
      label: cfg.chips_hidden ? "Show chips on taskbar" : "Hide chips",
      click: () => setChipsHidden(!cfg.chips_hidden),
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
        if (flyout && flyout.isVisible() && !flyout.isMinimized()) {
          setFlyoutPinned(false);
          hideFlyout(true);
        } else {
          setFlyoutPinned(true);
          showFlyout();
        }
      },
    },
    {
      label: "Start with Windows",
      type: "checkbox",
      checked: !!cfg.autostart,
      click: (item) => {
        cfg.autostart = autostart.apply(item.checked);
        config.save(cfg);
      },
    },
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
    { type: "separator" },
    { label: "Quit", click: () => app.quit() },
  ]);
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
      const p = clampToDisplay(x, y, w, h);
      placingFlyout = true;
      flyout.setPosition(p.x, p.y);
      placingFlyout = false;
      persistFlyoutPosition();
    }
    return;
  }
}

function popupAppMenu() {
  buildMenu().popup();
}

function createWindows() {
  flyout = createWindow({
    width: 320,
    height: 360,
    focusable: true,
    hasShadow: false,
    skipTaskbar: false,
  });
  flyout.loadFile(ui("flyout.html"));
  flyout.setAlwaysOnTop(true, cfg.flyout_docked || cfg.flyout_pinned ? "pop-up-menu" : "floating");
  flyout.on("blur", () => hideFlyout(false));
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

  chips = createWindow({
    width: 260,
    height: 28,
    focusable: true,
    hasShadow: false,
  });
  chips.loadFile(ui("chips.html"));
  chips.setAlwaysOnTop(true, cfg.chips_docked ? "pop-up-menu" : "floating");
  chips.once("ready-to-show", () => {
    if (cfg.chips_hidden) return;
    placeChips();
    keepWidgetOnTop(chips, cfg.chips_docked);
  });
  chips.on("moved", () => {
    if (placingChips || dragState) return;
    if (!cfg.chips_docked) persistChipsPosition();
  });
  chips.on("closed", () => {
    chips = null;
  });
}

function wireIpc() {
  ipcMain.on("usage://refresh", () => poll && poll.refresh());
  ipcMain.on("usage://drag-begin", (e, sx, sy) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (!win) return;
    const [x, y] = win.getPosition();
    dragState = { win, originX: x, originY: y, sx, sy };
  });
  ipcMain.on("usage://drag-to", (e, sx, sy) => {
    if (!dragState || dragState.win.isDestroyed()) return;
    const x = dragState.originX + (sx - dragState.sx);
    const y = dragState.originY + (sy - dragState.sy);
    placingFlyout = placingChips = true;
    dragState.win.setPosition(Math.round(x), Math.round(y));
    placingFlyout = placingChips = false;
  });
  ipcMain.on("usage://drag-end", () => finishDrag());
  ipcMain.on("usage://flyout-hide", () => hideFlyout(true));
  ipcMain.on("usage://flyout-toggle", () => {
    if (flyout.isVisible() && !flyoutStaysOpen()) hideFlyout(true);
    else showFlyout();
  });
  ipcMain.on("usage://flyout-toggle-pin", () => setFlyoutPinned(!cfg.flyout_pinned));
  ipcMain.on("usage://flyout-toggle-dock", () => setFlyoutDocked(!cfg.flyout_docked));
  ipcMain.handle("usage://get-flyout-state", () => ({
    docked: !!(cfg && cfg.flyout_docked),
    pinned: !!(cfg && cfg.flyout_pinned),
  }));
  ipcMain.on("usage://flyout-resize", (_e, h, w) => {
    if (!flyout) return;
    const width = Math.max(360, Math.min(760, Math.round(w || 520)));
    const height = Math.max(140, Math.min(860, Math.round(h)));
    setSizeKeepPos(flyout, width, height);
    if (cfg.flyout_docked && !dragState) placeFlyoutDocked();
  });
  ipcMain.on("usage://tray-menu", () => popupAppMenu());
  ipcMain.on("usage://open-usage", (_e, id) => {
    shell.openExternal(USAGE_URLS[id] || "https://grok.com");
  });
  ipcMain.handle("usage://get-interval", () => cfg.poll_interval_secs || 5);
  ipcMain.on("usage://set-interval", (_e, secs) => setPollInterval(secs));
  ipcMain.on("usage://chips-resize", (_e, w, h) => {
    if (!chips || chips.isDestroyed()) return;
    const width = Math.max(96, Math.min(720, Math.round(w)));
    const height = Math.max(24, Math.min(48, Math.round(h)));
    const [cw, ch] = chips.getSize();
    if (Math.abs(cw - width) < 2 && Math.abs(ch - height) < 2) return;
    setSizeKeepPos(chips, width, height);
    if (cfg.chips_docked && !cfg.chips_hidden && !dragState) placeChipsDocked();
  });
  ipcMain.handle("usage://get-chips-docked", () => !!cfg.chips_docked);
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => showFlyout());
  app.whenReady().then(() => {
    if (process.platform === "win32") {
      app.setAppUserModelId("local.usage-monitor");
    }
    app.setName("Usage Monitor");
    cfg = config.ensure();
    cfg.autostart = autostart.apply(cfg.autostart !== false);
    config.save(cfg);

    createWindows();
    wireIpc();

    flyout.webContents.on("did-finish-load", () => {
      flyout.webContents.send("usage://interval", cfg.poll_interval_secs || 5);
      sendFlyoutState();
      if (latest) flyout.webContents.send("usage://snapshot", latest);
      showFlyout();
    });
    chips.webContents.on("did-finish-load", () => {
      chips.webContents.send("usage://chips-docked", !!cfg.chips_docked);
      if (latest) chips.webContents.send("usage://snapshot", latest);
    });

    screen.on("display-metrics-changed", () => {
      taskbarLayout.invalidate();
      if (cfg.chips_docked) placeChipsDocked();
      if (cfg.flyout_docked) placeFlyoutDocked();
    });

    poll = poller.start(cfg, (snap) => {
      broadcast(snap);
      alerts.evaluate(snap, {
        notifyOnLimit: cfg.notify_on_limit_reached,
        onClick: () => showFlyout(),
      });
    });

    let lastTrayKey = "";
    setInterval(() => {
      if (dragState) return;
      const layout = taskbarLayout.loadLayout();
      const key = JSON.stringify(layout && layout.tray);
      if (key !== lastTrayKey) {
        lastTrayKey = key;
        if (cfg.chips_docked && !cfg.chips_hidden) placeChipsDocked();
        if (cfg.flyout_docked && flyout && flyout.isVisible()) placeFlyoutDocked();
      }
      if (chips && !cfg.chips_hidden) keepWidgetOnTop(chips, cfg.chips_docked);
      if (flyout && cfg.flyout_docked && flyout.isVisible()) keepWidgetOnTop(flyout, true);
    }, 2000);
  });
}

app.on("window-all-closed", (e) => {
  e.preventDefault();
});

app.on("before-quit", () => {
  app.isQuitting = true;
  if (poll) poll.stop();
});
