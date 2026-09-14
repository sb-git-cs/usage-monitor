const { app, BrowserWindow, Tray, Menu, ipcMain, shell, screen } = require("electron");
const path = require("path");
const config = require("./config");
const poller = require("./poller");
const alerts = require("./alerts");
const { iconFor } = require("./trayIcons");
const { hottestWindow, statusOk, ALERT_USED_PCT } = require("./models");

let cfg;
let overlay;
let flyout;
let chips;
let trays = [];
let poll;
let latest;
let overlayPinned = false;

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

function placeChipsDocked() {
  if (!chips) return;
  const display = screen.getPrimaryDisplay();
  const info = taskbarInfo(display);
  const [w, h] = chips.getSize();
  const trayReserve = 176;
  const { bounds } = info;
  let x;
  let y;
  if (info.edge === "bottom") {
    x = bounds.x + bounds.width - trayReserve - w - 10;
    y = bounds.y + bounds.height - info.thickness + Math.round((info.thickness - h) / 2);
  } else if (info.edge === "top") {
    x = bounds.x + bounds.width - trayReserve - w - 10;
    y = bounds.y + Math.round((info.thickness - h) / 2);
  } else if (info.edge === "right") {
    x = bounds.x + bounds.width - info.thickness + Math.round((info.thickness - w) / 2);
    y = bounds.y + bounds.height - trayReserve - h - 10;
  } else {
    x = bounds.x + Math.round((info.thickness - w) / 2);
    y = bounds.y + bounds.height - trayReserve - h - 10;
  }
  placingChips = true;
  chips.setPosition(Math.round(x), Math.round(y));
  placingChips = false;
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

function setChipsDocked(docked) {
  cfg.chips_docked = !!docked;
  if (!cfg.chips_docked && chips) {
    const pos = chips.getPosition();
    cfg.chips_x = pos[0];
    cfg.chips_y = pos[1];
  }
  config.save(cfg);
  if (chips && !chips.isDestroyed()) {
    chips.setAlwaysOnTop(true, cfg.chips_docked ? "pop-up-menu" : "floating");
    chips.webContents.send("usage://chips-docked", cfg.chips_docked);
  }
  placeChips();
}

function persistChipsPosition() {
  if (!chips || cfg.chips_docked || placingChips) return;
  const pos = chips.getPosition();
  cfg.chips_x = pos[0];
  cfg.chips_y = pos[1];
  config.save(cfg);
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
  const display = screen.getPrimaryDisplay();
  const info = taskbarInfo(display);
  const [w, h] = flyout.getSize();
  const trayReserve = 176;
  const { bounds, workArea } = info;
  let x;
  let y;
  if (info.edge === "bottom") {
    x = bounds.x + bounds.width - trayReserve - w - 10;
    y = workArea.y + workArea.height - h;
  } else if (info.edge === "top") {
    x = bounds.x + bounds.width - trayReserve - w - 10;
    y = workArea.y;
  } else if (info.edge === "right") {
    x = workArea.x + workArea.width - w;
    y = bounds.y + bounds.height - trayReserve - h - 10;
  } else {
    x = workArea.x;
    y = bounds.y + bounds.height - trayReserve - h - 10;
  }
  placingFlyout = true;
  flyout.setPosition(Math.round(x), Math.round(y));
  placingFlyout = false;
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
  x = Math.max(wa.x + 8, Math.min(x, wa.x + wa.width - w - 8));
  y = Math.max(wa.y + 8, Math.min(y, wa.y + wa.height - h - 8));
  placingFlyout = true;
  flyout.setPosition(x, y);
  placingFlyout = false;
}

function persistFlyoutPosition() {
  if (!flyout || cfg.flyout_docked || placingFlyout) return;
  const pos = flyout.getPosition();
  cfg.flyout_x = pos[0];
  cfg.flyout_y = pos[1];
  config.save(cfg);
}

function setFlyoutDocked(docked) {
  cfg.flyout_docked = !!docked;
  if (cfg.flyout_docked) cfg.flyout_pinned = true;
  config.save(cfg);
  sendFlyoutState();
  if (!flyout) return;
  flyout.setAlwaysOnTop(true, cfg.flyout_docked ? "pop-up-menu" : "floating");
  if (cfg.flyout_docked) {
    placeFlyoutDocked();
    flyout.showInactive();
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
  if (cfg.flyout_docked) placeFlyoutDocked();
  else placeFlyoutNearTray(bounds);
  flyout.show();
  if (!flyoutStaysOpen()) flyout.focus();
  else flyout.showInactive();
}

function hideFlyout(force) {
  if (!flyout || !flyout.isVisible()) return;
  if (!force && flyoutStaysOpen()) return;
  flyout.hide();
}

function showOverlay(focus) {
  if (!overlay) return;
  if (focus) overlay.show();
  else overlay.showInactive();
  cfg.overlay_visible = true;
  config.save(cfg);
}

function hideOverlay() {
  if (!overlay) return;
  overlay.hide();
  cfg.overlay_visible = false;
  config.save(cfg);
}

function broadcast(snap) {
  latest = snap;
  for (const win of [overlay, flyout, chips]) {
    if (win && !win.isDestroyed()) win.webContents.send("usage://snapshot", snap);
  }
  updateTrays(snap);
}

function letter(id) {
  return id === "claude" ? "C" : id === "codex" ? "X" : "G";
}

function updateTrays(snap) {
  const providers = snap.providers || [];
  providers.forEach((p, i) => {
    const tray = trays[i];
    if (!tray) return;
    const hot = hottestWindow(p);
    const gray = !statusOk(p);
    const alerting = hot && hot.used_pct >= ALERT_USED_PCT;
    tray.setImage(iconFor(letter(p.id), hot && hot.used_pct, alerting, gray));
    const lines = [`${p.display_name}${p.plan ? " · " + p.plan : ""}`];
    if (p.windows && p.windows.length) {
      for (const w of p.windows) {
        if (w.used_pct == null) {
          lines.push(w.label);
        } else {
          const bang = w.used_pct >= ALERT_USED_PCT ? "! " : "";
          lines.push(`${bang}${w.label} ${Math.round(w.used_pct)}/100%`);
        }
      }
    } else if (p.status) {
      lines.push(p.status.hint || p.status.message || p.status.state);
    }
    tray.setToolTip(lines.join("\n"));
  });
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
  for (const win of [overlay, flyout, chips]) {
    if (win && !win.isDestroyed()) win.webContents.send("usage://interval", secs);
  }
}

function buildMenu() {
  return Menu.buildFromTemplate([
    {
      label: overlay && overlay.isVisible() ? "Hide overlay" : "Open overlay",
      click: () => {
        if (overlay.isVisible()) hideOverlay();
        else showOverlay(true);
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
      label: "Start with Windows",
      type: "checkbox",
      checked: !!cfg.autostart,
      click: (item) => {
        cfg.autostart = item.checked;
        config.save(cfg);
        app.setLoginItemSettings({ openAtLogin: !!cfg.autostart });
      },
    },
    {
      label: overlayPinned ? "Unpin overlay" : "Pin overlay",
      click: togglePin,
    },
    {
      label: "Keep flyout open",
      type: "checkbox",
      checked: !!cfg.flyout_pinned,
      click: (item) => setFlyoutPinned(item.checked),
    },
    {
      label: "Dock flyout to taskbar",
      type: "checkbox",
      checked: !!cfg.flyout_docked,
      click: (item) => setFlyoutDocked(item.checked),
    },
    {
      label: "Dock chips to taskbar",
      type: "checkbox",
      checked: !!cfg.chips_docked,
      click: (item) => setChipsDocked(item.checked),
    },
    { type: "separator" },
    { label: "Quit", click: () => app.quit() },
  ]);
}

function togglePin() {
  overlayPinned = !overlayPinned;
  cfg.overlay_pinned = overlayPinned;
  config.save(cfg);
  if (overlay) overlay.setAlwaysOnTop(true);
  if (overlay && !overlay.isDestroyed()) overlay.webContents.send("usage://pinned", overlayPinned);
}

function createTrays() {
  for (const t of trays) t.destroy();
  trays = [];
  const ids = ["claude", "codex", "grok"];
  ids.forEach((id, index) => {
    const tray = new Tray(iconFor(letter(id), null, false, true));
    tray.setToolTip("Usage Monitor");
    tray.on("click", (_e, bounds) => {
      if (flyout.isVisible() && !flyoutStaysOpen()) hideFlyout(true);
      else showFlyout(bounds);
    });
    tray.on("right-click", () => tray.popUpContextMenu(buildMenu()));
    if (index === 0) tray.setContextMenu(buildMenu());
    trays.push(tray);
  });
}

function createWindows() {
  overlay = createWindow({
    width: 380,
    height: 560,
    focusable: true,
  });
  overlay.loadFile(ui("overlay.html"));
  overlay.setAlwaysOnTop(true, "floating");
  overlay.on("closed", () => {
    overlay = null;
  });

  flyout = createWindow({
    width: 320,
    height: 360,
    focusable: true,
    hasShadow: false,
  });
  flyout.loadFile(ui("flyout.html"));
  flyout.setAlwaysOnTop(true, cfg.flyout_docked ? "pop-up-menu" : "floating");
  flyout.setIgnoreMouseEvents(true, { forward: true });
  flyout.on("blur", () => hideFlyout(false));
  flyout.on("moved", () => {
    if (placingFlyout) return;
    if (cfg.flyout_docked) {
      setFlyoutDocked(false);
      return;
    }
    persistFlyoutPosition();
  });
  flyout.on("closed", () => {
    flyout = null;
  });

  chips = createWindow({
    width: 248,
    height: 32,
    focusable: true,
    hasShadow: false,
  });
  chips.loadFile(ui("chips.html"));
  chips.setAlwaysOnTop(true, cfg.chips_docked ? "pop-up-menu" : "floating");
  chips.setIgnoreMouseEvents(true, { forward: true });
  chips.once("ready-to-show", () => {
    placeChips();
    chips.showInactive();
    chips.setIgnoreMouseEvents(true, { forward: true });
  });
  chips.on("moved", () => {
    if (placingChips) return;
    if (cfg.chips_docked) {
      setChipsDocked(false);
      return;
    }
    persistChipsPosition();
  });
  chips.on("closed", () => {
    chips = null;
  });
}

function wireIpc() {
  ipcMain.on("usage://refresh", () => poll && poll.refresh());
  ipcMain.on("usage://overlay-hide", () => hideOverlay());
  ipcMain.on("usage://flyout-hide", () => hideFlyout(true));
  ipcMain.on("usage://overlay-toggle-pin", togglePin);
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
  ipcMain.on("usage://flyout-hit", (_e, hit) => {
    if (!flyout || flyout.isDestroyed()) return;
    if (hit) flyout.setIgnoreMouseEvents(false);
    else flyout.setIgnoreMouseEvents(true, { forward: true });
  });
  ipcMain.on("usage://flyout-resize", (_e, h) => {
    if (!flyout) return;
    const height = Math.max(120, Math.min(700, Math.round(h) + 4));
    const [, cur] = flyout.getSize();
    if (Math.abs(cur - height) < 4) return;
    flyout.setSize(320, height);
    if (cfg.flyout_docked) placeFlyoutDocked();
  });
  ipcMain.on("usage://tray-menu", () => {
    if (trays[0]) trays[0].popUpContextMenu(buildMenu());
  });
  ipcMain.on("usage://open-usage", (_e, id) => {
    shell.openExternal(USAGE_URLS[id] || "https://grok.com");
  });
  ipcMain.on("usage://overlay-resize", (_e, h) => {
    if (!overlay) return;
    const height = Math.max(120, Math.min(900, Math.round(h) + 4));
    overlay.setSize(380, height);
  });
  ipcMain.handle("usage://get-interval", () => cfg.poll_interval_secs || 5);
  ipcMain.on("usage://set-interval", (_e, secs) => setPollInterval(secs));
  ipcMain.on("usage://chips-hit", (_e, hit) => {
    if (!chips || chips.isDestroyed()) return;
    if (hit) chips.setIgnoreMouseEvents(false);
    else chips.setIgnoreMouseEvents(true, { forward: true });
  });
  ipcMain.handle("usage://get-chips-docked", () => !!cfg.chips_docked);
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => showOverlay(true));
  app.whenReady().then(() => {
    if (process.platform === "win32") {
      app.setAppUserModelId("local.usage-monitor");
    }
    cfg = config.ensure();
    overlayPinned = !!cfg.overlay_pinned;
    app.setLoginItemSettings({ openAtLogin: !!cfg.autostart });

    createWindows();
    createTrays();
    wireIpc();

    overlay.webContents.on("did-finish-load", () => {
      overlay.webContents.send("usage://pinned", overlayPinned);
      overlay.webContents.send("usage://interval", cfg.poll_interval_secs || 5);
      if (latest) overlay.webContents.send("usage://snapshot", latest);
      if (cfg.overlay_visible) {
        const wa = screen.getPrimaryDisplay().workArea;
        overlay.setPosition(wa.x + wa.width - 400, wa.y + 48);
        showOverlay(false);
      }
    });
    flyout.webContents.on("did-finish-load", () => {
      flyout.webContents.send("usage://interval", cfg.poll_interval_secs || 5);
      sendFlyoutState();
      if (latest) flyout.webContents.send("usage://snapshot", latest);
      if (flyoutStaysOpen()) showFlyout();
    });
    chips.webContents.on("did-finish-load", () => {
      chips.webContents.send("usage://chips-docked", !!cfg.chips_docked);
      if (latest) chips.webContents.send("usage://snapshot", latest);
    });

    screen.on("display-metrics-changed", () => {
      placeChips();
      if (cfg.flyout_docked) placeFlyoutDocked();
    });

    poll = poller.start(cfg, (snap) => {
      broadcast(snap);
      alerts.evaluate(snap, {
        notifyOnLimit: cfg.notify_on_limit_reached,
        onClick: () => showOverlay(true),
      });
    });
  });
}

app.on("window-all-closed", (e) => {
  e.preventDefault();
});

app.on("before-quit", () => {
  if (poll) poll.stop();
});
