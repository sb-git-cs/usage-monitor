// Network usage service: wires the platform provider, the engine, the records store
// and the "Network usage" window together.
const { app, BrowserWindow, Menu, Notification, clipboard, dialog, ipcMain, nativeTheme, shell } = require("electron");
const fs = require("fs");
const path = require("path");
const dns = require("dns");
const paths = require("../paths");
const { Engine } = require("./engine");
const { Store, DB_NAME } = require("./store");
const { IconCache } = require("./icons");
const { RETENTION_MINUTES, RANGES } = require("./settings");
const { NET_RANGES, NET_RETENTION, formatBytes } = require("./format");

const NO_CAPABILITIES = { block: false, domains: false, udp: false, setup: false, flows: false };

let ctx = null;
let store = null;
let engine = null;
let provider = null;
let icons = null;
let desktop = null;
let win = null;
let tickTimer = null;
let range = "60";
let status = { state: "starting", message: null, action: null };
let storeWarning = null;

const reverse = new Map();
const reverseQueue = [];
let reverseInflight = 0;

function limits() {
  if (process.platform === "win32") {
    return [
      "Counts TCP and UDP traffic (including QUIC) per app with Windows' built-in event tracing. This needs a small helper with administrator rights.",
      "Connection recording shows domains from DNS answers plus IP addresses. Full HTTPS URLs and packet contents stay encrypted and are never read.",
      "Blocking adds a Windows Firewall rule for the program file. It has no effect while Windows Firewall is off.",
    ];
  }
  if (process.platform === "darwin") {
    return [
      "Counts per-app traffic with macOS nettop. No admin rights are needed.",
      "Blocking isn't available: macOS only allows that through a signed network extension. Data caps notify you instead.",
      "nettop doesn't see domain names. Turn on reverse lookups to see host names; the lookups go to your DNS server.",
    ];
  }
  return [
    "Counts TCP traffic per app from the kernel's socket statistics (ss). UDP and QUIC traffic (used by some video and browser traffic) can't be counted without root or a packet driver.",
    "Connections owned by other users show as “Other” unless Usage Monitor runs as root. Connections that open and close within a second can be missed.",
    "Blocking isn't available without root firewall rules. Data caps notify you instead.",
  ];
}

function dbDir() {
  return ctx.cfg.net.db_dir || paths.netDataDir();
}

function openStore() {
  try {
    store = new Store(path.join(dbDir(), DB_NAME));
  } catch (err) {
    if (!ctx.cfg.net.db_dir) throw err;
    storeWarning = `Could not open the records in ${ctx.cfg.net.db_dir} (${err.message}). Using the default folder instead.`;
    ctx.cfg.net.db_dir = null;
    ctx.save();
    store = new Store(path.join(paths.netDataDir(), DB_NAME));
  }
  if (store.recovered) storeWarning = `The records database was damaged, so it was set aside (${store.recovered.movedTo}) and a new one was started.`;
}

function createProvider() {
  if (process.platform === "win32") {
    const { WindowsProvider } = require("./providers/windows");
    return new WindowsProvider({ workDir: paths.cacheDir() });
  }
  if (process.platform === "darwin") {
    const { MacProvider } = require("./providers/macos");
    return new MacProvider();
  }
  if (process.platform === "linux") {
    const { LinuxProvider } = require("./providers/linux");
    return new LinuxProvider({ desktop });
  }
  return null;
}

function capabilities() {
  return provider ? provider.capabilities : NO_CAPABILITIES;
}

function setStatus(next) {
  status = { state: next.state, message: next.message || null, action: next.action || null, helper: next.helper || null };
  sendState();
}

function startProvider() {
  if (!provider) {
    setStatus({ state: "unsupported", message: "Network monitoring isn't available on this system." });
    return;
  }
  Promise.resolve()
    .then(() => provider.start())
    .catch((err) => setStatus({ state: "error", message: err.message }));
}

function wireProvider() {
  if (!provider) return;
  provider.on("sample", (sample) => {
    try {
      engine.ingest(sample);
    } catch (err) {
      console.error("network sample failed", err.message);
    }
  });
  provider.on("dns", (d) => engine.addDns(d.name, d.ips));
  provider.on("status", (s) => setStatus(s));
  provider.on("blocked", ({ paths: blocked, initial }) => {
    engine.setActualBlocked(blocked);
    if (initial) engine.reconcile();
    pushUpdate();
  });
  if (provider.setFlowKeys) provider.setFlowKeys(engine.flowKeys());
}

function wireEngine() {
  engine.on("block", ({ key, path: programPath, blocked }) => {
    if (!provider || !provider.setBlocked) return;
    provider.setBlocked(programPath, blocked).catch((err) => {
      const name = key ? engine.appInfo(key).name : path.basename(programPath);
      toast(`Could not ${blocked ? "block" : "unblock"} ${name}: ${err.message}`);
    });
  });
  engine.on("cap", notifyCap);
  engine.on("save", () => ctx.save());
  engine.on("flows", (keys) => provider && provider.setFlowKeys && provider.setFlowKeys(keys));
  engine.on("unresolved", reverseLookup);
}

function init(context) {
  ctx = context;
  range = ctx.cfg.net.range;
  openStore();
  if (process.platform === "linux") {
    const { DesktopIndex } = require("./desktop");
    desktop = new DesktopIndex();
  }
  icons = new IconCache({ app, desktop });
  provider = createProvider();
  engine = new Engine({ store, settings: ctx.cfg.net, capabilities: capabilities() });
  wireEngine();
  wireProvider();
  wireIpc();
  tickTimer = setInterval(tick, 1000);
  if (ctx.cfg.net.enabled) startProvider();
  else setStatus({ state: "disabled", message: "Recording is turned off." });
}

function tick() {
  try {
    engine.tick();
  } catch (err) {
    console.error("network tick failed", err.message);
  }
  pushUpdate();
}

function windowReady() {
  return win && !win.isDestroyed() && win.isVisible() && !win.isMinimized();
}

function pushUpdate() {
  if (!windowReady()) return;
  try {
    win.webContents.send("net:update", engine.view(range));
  } catch (err) {
    console.error("network view failed", err.message);
  }
}

function stateView() {
  const n = ctx.cfg.net;
  return {
    platform: process.platform,
    status: { ...status, warning: storeWarning },
    capabilities: capabilities(),
    limits: limits(),
    settings: {
      enabled: n.enabled,
      retention_minutes: n.retention_minutes,
      range,
      auto_sort: n.auto_sort,
      reverse_dns: n.reverse_dns,
      focus: n.focus,
      ignore: n.ignore,
    },
    db: { dir: dbDir(), file: store.file, size: store.sizeBytes(), custom: !!n.db_dir },
    autostart: !!ctx.cfg.autostart,
    ranges: NET_RANGES,
    retention: NET_RETENTION,
  };
}

function sendState() {
  if (win && !win.isDestroyed()) win.webContents.send("net:state", stateView());
}

function toast(text) {
  if (win && !win.isDestroyed()) win.webContents.send("net:toast", String(text));
}

function notifyCap({ key, name, limit, period, blocked }) {
  sendState();
  if (!Notification.isSupported()) return;
  const when = period === "daily" ? " for today" : period === "monthly" ? " for this month" : "";
  const n = new Notification({
    title: "Data cap reached",
    body: `${name} used its ${formatBytes(limit)} cap${when}. ${
      blocked ? "Its internet access is blocked until you reset or raise the cap." : "Blocking isn't available on this system."
    }`,
  });
  n.on("click", () => openWindow(key));
  n.show();
}

function reverseLookup(ip) {
  if (!ctx.cfg.net.reverse_dns || reverse.has(ip) || reverseQueue.length > 500) return;
  if (reverse.size > 20000) reverse.clear();
  reverse.set(ip, null);
  reverseQueue.push(ip);
  pumpReverse();
}

function pumpReverse() {
  while (reverseInflight < 4 && reverseQueue.length) {
    const ip = reverseQueue.shift();
    reverseInflight++;
    dns.promises
      .reverse(ip)
      .then((names) => {
        const host = names && names[0];
        if (!host) return;
        reverse.set(ip, host);
        engine.addDns(host, [ip]);
        store.setDomain(ip, host);
      })
      .catch(() => {})
      .finally(() => {
        reverseInflight--;
        pumpReverse();
      });
  }
}

// ---- window ------------------------------------------------------------------

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 780,
    minWidth: 760,
    minHeight: 520,
    show: false,
    title: "Network usage - Usage Monitor",
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#1a1a19" : "#fcfcfb",
    autoHideMenuBar: true,
    icon: path.join(__dirname, "..", "ui", "icon-256.png"),
    webPreferences: {
      preload: path.join(__dirname, "..", "net-preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, "..", "ui", "net.html"));
  win.on("close", (e) => {
    if (app.isQuitting) return;
    // Closing only hides the window; recording continues in the background.
    e.preventDefault();
    win.hide();
    if (process.platform === "darwin" && app.dock) app.dock.hide();
  });
  win.on("closed", () => {
    win = null;
  });
  win.on("show", pushUpdate);
  win.on("restore", pushUpdate);
  win.webContents.on("did-finish-load", () => {
    sendState();
    pushUpdate();
  });
}

function openWindow(selectKey) {
  if (!ctx) return;
  if (!win || win.isDestroyed()) createWindow();
  // Show right away: the window background matches the theme, so there is no blank flash,
  // and nothing depends on page-load events firing.
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  if (process.platform === "darwin" && app.dock) app.dock.show();
  if (typeof selectKey === "string") {
    const select = () => {
      if (win && !win.isDestroyed()) win.webContents.send("net:command", { type: "select", key: selectKey });
    };
    if (win.webContents.isLoading()) win.webContents.once("did-finish-load", select);
    else select();
  }
}
// ---- IPC -----------------------------------------------------------------------

function fromWindow(e) {
  return !!(win && !win.isDestroyed() && e.sender === win.webContents);
}

function validKey(key) {
  return typeof key === "string" && key.length > 0 && key.length < 4096;
}

async function confirm(message, detail, action = "Delete") {
  const { response } = await dialog.showMessageBox(win, {
    type: "warning",
    buttons: [action, "Cancel"],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
    message,
    detail,
  });
  return response === 0;
}

const ACTIONS = {
  block: (key) => engine.setBlocked(key, true),
  unblock: (key) => engine.setBlocked(key, false),
  "set-cap": (key, arg) => engine.setCap(key, { limit_bytes: Number(arg && arg.limit_bytes), period: arg && arg.period }),
  "clear-cap": (key) => engine.clearCap(key),
  "reset-cap": (key) => engine.resetCap(key),
  "keep-forever": (key, on) => engine.setKeepForever(key, !!on),
  "record-connections": (key, on) => engine.setRecordConnections(key, !!on),
  focus: (key) => engine.focus(key),
  unfocus: (key) => engine.unfocus(key),
  "clear-focus": () => engine.unfocus(null),
  ignore: (key) => engine.ignore(key),
  unignore: (key) => engine.unignore(key),
  "delete-app": async (key) => {
    const { name } = engine.appInfo(key);
    if (await confirm(`Delete all records for ${name}?`, "Its usage history and recorded connections are removed. This can't be undone.")) engine.deleteApp(key);
  },
  "delete-connections": async (key) => {
    const { name } = engine.appInfo(key);
    if (await confirm(`Delete recorded connections for ${name}?`, "This can't be undone.")) engine.deleteConnections(key);
  },
  "open-location": (key) => {
    const p = engine.appInfo(key).path;
    if (p) shell.showItemInFolder(p);
  },
  "copy-path": (key) => {
    const p = engine.appInfo(key).path;
    if (p) clipboard.writeText(p);
  },
};

async function runAction(type, key, arg) {
  const fn = Object.hasOwn(ACTIONS, type) ? ACTIONS[type] : null;
  if (!fn) return { ok: false, error: "Unknown action." };
  if (type !== "clear-focus" && !validKey(key)) return { ok: false, error: "No app selected." };
  try {
    await fn(key, arg);
    sendState();
    pushUpdate();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function showRowMenu(key) {
  const rule = ctx.cfg.net.rules[key];
  const info = engine.appInfo(key);
  const caps = capabilities();
  const canBlock = !!(caps.block && info.path && /\.exe$/i.test(info.path));
  const blocked = engine.desiredBlocked(rule);
  const focused = ctx.cfg.net.focus.some((a) => a.key === key);
  const act = (type, arg) => () =>
    runAction(type, key, arg).then((r) => {
      if (!r.ok) toast(r.error);
    });
  const command = (type) => () => win && win.webContents.send("net:command", { type, key });
  const template = [
    { label: blocked ? "Unblock internet" : "Block internet", enabled: canBlock, click: act(blocked ? "unblock" : "block") },
    { label: rule && rule.cap ? "Edit data cap…" : "Set data cap…", click: command("cap") },
    ...(rule && rule.cap ? [{ label: "Reset data cap", click: act("reset-cap") }] : []),
    { type: "separator" },
    { label: "Keep records forever", type: "checkbox", checked: !!(rule && rule.keep_forever), click: (item) => act("keep-forever", item.checked)() },
    { label: "Record connections", type: "checkbox", checked: !!(rule && rule.record_connections), click: (item) => act("record-connections", item.checked)() },
    { label: "View connections…", click: command("connections") },
    { type: "separator" },
    focused ? { label: "Stop focusing on this app", click: act("unfocus") } : { label: "Only track this app", click: act("focus") },
    { label: "Ignore this app", click: act("ignore") },
    { type: "separator" },
    ...(info.path
      ? [
          { label: "Open file location", click: act("open-location") },
          { label: "Copy path", click: act("copy-path") },
        ]
      : []),
    { label: "Delete this app's records…", click: act("delete-app") },
  ];
  Menu.buildFromTemplate(template).popup({ window: win });
}

async function applySettings(patch) {
  if (!patch || typeof patch !== "object") return stateView();
  const n = ctx.cfg.net;
  if ("retention_minutes" in patch && RETENTION_MINUTES.includes(Number(patch.retention_minutes))) {
    const next = Number(patch.retention_minutes);
    const shorter = next < n.retention_minutes;
    if (!shorter || (await confirm("Keep less history?", "Records older than the new limit are deleted now, except for apps kept forever.", "Keep less"))) {
      n.retention_minutes = next;
      if (shorter) engine.prune();
    }
  }
  if ("auto_sort" in patch) n.auto_sort = !!patch.auto_sort;
  if ("reverse_dns" in patch) n.reverse_dns = !!patch.reverse_dns;
  if ("enabled" in patch && !!patch.enabled !== n.enabled) {
    n.enabled = !!patch.enabled;
    if (n.enabled) startProvider();
    else {
      if (provider) provider.stop();
      setStatus({ state: "disabled", message: "Recording is turned off." });
    }
  }
  if ("autostart" in patch && ctx.setAutostart) ctx.setAutostart(!!patch.autostart);
  ctx.save();
  sendState();
  return stateView();
}

async function chooseFolder(useDefault) {
  let dir = paths.netDataDir();
  if (!useDefault) {
    const res = await dialog.showOpenDialog(win, {
      title: "Choose where to keep network records",
      properties: ["openDirectory", "createDirectory", "promptToCreate"],
      defaultPath: dbDir(),
    });
    if (res.canceled || !res.filePaths[0]) return stateView();
    dir = res.filePaths[0];
  }
  const target = path.join(dir, DB_NAME);
  let useExisting = false;
  if (fs.existsSync(target) && path.resolve(target) !== path.resolve(store.file)) {
    const { response } = await dialog.showMessageBox(win, {
      type: "question",
      buttons: ["Use those records", "Cancel"],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
      message: "That folder already has Usage Monitor records.",
      detail: "Switch to the records in that folder? Your current records stay where they are.",
    });
    if (response !== 0) return stateView();
    useExisting = true;
  }
  try {
    store.relocate(dir, { useExisting });
  } catch (err) {
    dialog.showErrorBox("Could not move the records", err.message);
    return stateView();
  }
  ctx.cfg.net.db_dir = path.resolve(dir) === path.resolve(paths.netDataDir()) ? null : dir;
  storeWarning = null;
  ctx.save();
  pushUpdate();
  return stateView();
}

async function deleteData(scope, minutes) {
  if (scope === "all") {
    if (await confirm("Delete all network records?", "Every app's history and recorded connections are removed. Settings, caps and rules are kept.")) {
      engine.deleteAll();
    }
  } else if (scope === "older" && RETENTION_MINUTES.includes(Number(minutes))) {
    const label = NET_RETENTION.find((r) => r.minutes === Number(minutes)).label;
    if (await confirm(`Delete records older than ${label}?`, "This includes apps kept forever. This can't be undone.")) engine.deleteOlderThan(Number(minutes));
  }
  pushUpdate();
  return stateView();
}

async function exportCsv(text, name) {
  if (typeof text !== "string" || text.length > 50 * 1024 * 1024) return { ok: false, error: "Nothing to export." };
  const safe = String(name || "network-usage.csv").replace(/[^\w.-]+/g, "-");
  const res = await dialog.showSaveDialog(win, {
    title: "Export network usage",
    defaultPath: path.join(app.getPath("downloads"), safe.endsWith(".csv") ? safe : `${safe}.csv`),
    filters: [{ name: "CSV", extensions: ["csv"] }],
  });
  if (res.canceled || !res.filePath) return { ok: false, canceled: true };
  // A byte-order mark makes Excel read the UTF-8 names correctly.
  fs.writeFileSync(res.filePath, `﻿${text}`, "utf8");
  return { ok: true, file: res.filePath };
}

async function helperOp(op) {
  if (!provider || !capabilities().setup) return { ok: false, error: "Not needed on this system." };
  try {
    if (op === "install") await provider.install();
    else if (op === "start") await provider.startHelper();
    else if (op === "remove") {
      if (!(await confirm("Remove the network helper?", "Usage Monitor stops recording network usage and removes the block rules it added.", "Remove"))) return { ok: false, canceled: true };
      await provider.remove();
    } else return { ok: false, error: "Unknown operation." };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function wireIpc() {
  const handle = (channel, fn) =>
    ipcMain.handle(channel, (e, ...args) => {
      if (!fromWindow(e)) return null;
      return fn(...args);
    });
  handle("net:state", () => stateView());
  handle("net:icon", (key) => (validKey(key) ? icons.get(key, engine.appInfo(key).path) : null));
  handle("net:series", (key, id) => (validKey(key) ? engine.series(key, RANGES.includes(String(id)) ? String(id) : range) : null));
  handle("net:connections", (key) => (validKey(key) ? engine.connections(key) : []));
  handle("net:action", (type, key, arg) => runAction(type, key, arg));
  handle("net:settings", (patch) => applySettings(patch));
  handle("net:choose-folder", (useDefault) => chooseFolder(useDefault === true));
  handle("net:delete", (scope, minutes) => deleteData(scope, minutes));
  handle("net:export", (text, name) => exportCsv(text, name));
  handle("net:helper", (op) => helperOp(op));
  ipcMain.on("net:range", (e, id) => {
    if (!fromWindow(e) || !RANGES.includes(String(id))) return;
    range = String(id);
    ctx.cfg.net.range = range;
    ctx.save();
    pushUpdate();
  });
  ipcMain.on("net:row-menu", (e, key) => {
    if (fromWindow(e) && validKey(key)) showRowMenu(key);
  });
  ipcMain.on("net:open-folder", (e) => {
    if (fromWindow(e)) shell.showItemInFolder(store.file);
  });
}

function shutdown() {
  clearInterval(tickTimer);
  tickTimer = null;
  if (provider) provider.stop();
  if (store) {
    try {
      store.close();
    } catch (err) {
      console.error("network records close failed", err.message);
    }
  }
}

// Live numbers for the chips and flyout. `hour` adds the last hour's totals (one small query).
function summary({ hour = false } = {}) {
  if (!engine || status.state === "unsupported") return null;
  const out = { state: status.state, message: status.message, ...engine.liveSummary(3) };
  if (hour) out.hour = engine.recentTotals(60);
  return out;
}

module.exports = { init, openWindow, shutdown, summary };
