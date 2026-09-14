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

function placeChips() {
  if (!chips) return;
  const wa = screen.getPrimaryDisplay().workArea;
  const [w, h] = chips.getSize();
  chips.setPosition(wa.x + wa.width - w - 12, wa.y + wa.height - h - 8);
}

function placeFlyoutNearTray(bounds) {
  if (!flyout) return;
  const wa = screen.getPrimaryDisplay().workArea;
  const [w, h] = flyout.getSize();
  let x;
  let y;
  if (bounds && bounds.x != null) {
    x = Math.round(bounds.x + bounds.width / 2 - w / 2);
    y = Math.round(bounds.y - h - 8);
  } else {
    x = wa.x + wa.width - w - 16;
    y = wa.y + wa.height - h - 40;
  }
  x = Math.max(wa.x + 8, Math.min(x, wa.x + wa.width - w - 8));
  y = Math.max(wa.y + 8, Math.min(y, wa.y + wa.height - h - 8));
  flyout.setPosition(x, y);
}

function showFlyout(bounds) {
  placeFlyoutNearTray(bounds);
  flyout.show();
  flyout.focus();
}

function hideFlyout() {
  if (flyout && flyout.isVisible()) flyout.hide();
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
      if (flyout.isVisible()) hideFlyout();
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
  });
  flyout.loadFile(ui("flyout.html"));
  flyout.on("blur", () => hideFlyout());
  flyout.on("closed", () => {
    flyout = null;
  });

  chips = createWindow({
    width: 230,
    height: 30,
    focusable: false,
  });
  chips.loadFile(ui("chips.html"));
  chips.setAlwaysOnTop(true, "status");
  chips.setIgnoreMouseEvents(false);
  chips.once("ready-to-show", () => {
    placeChips();
    chips.showInactive();
  });
  chips.on("closed", () => {
    chips = null;
  });
}

function wireIpc() {
  ipcMain.on("usage://refresh", () => poll && poll.refresh());
  ipcMain.on("usage://overlay-hide", () => hideOverlay());
  ipcMain.on("usage://flyout-hide", hideFlyout);
  ipcMain.on("usage://overlay-toggle-pin", togglePin);
  ipcMain.on("usage://flyout-toggle", () => {
    if (flyout.isVisible()) hideFlyout();
    else showFlyout();
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
      if (latest) flyout.webContents.send("usage://snapshot", latest);
    });
    chips.webContents.on("did-finish-load", () => {
      if (latest) chips.webContents.send("usage://snapshot", latest);
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
