const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

// Loaded lazily so the helpers below can be tested without Electron.
const electron = () => require("electron");

// Opening runs whatever the system associates with the type, and a model wrote these files, so only
// documents and media are opened; for anything else the page offers Show in folder.
const OPENABLE = new Set(["pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods", "odp", "rtf", "csv", "md", "txt", "html", "htm",
  "png", "jpg", "jpeg", "gif", "svg", "webp", "mp3", "mp4", "wav", "epub", "json", "log"]);

function canOpen(name) {
  const base = String(name || "").split(/[\\/]/).pop();
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return false;
  return OPENABLE.has(base.slice(dot + 1).toLowerCase());
}

// The file's folder relative to the session's folder when it is inside it ("" for the folder itself),
// else the absolute folder. Either kind of separator works; the file's own style is kept.
function relDir(filePath, cwd) {
  const p = String(filePath || "");
  const cut = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  const absolute = cut > 0 ? p.slice(0, cut) : p.slice(0, cut + 1);
  if (typeof cwd !== "string" || !cwd) return absolute;
  const ci = /^[A-Za-z]:|^\\\\/.test(p);
  const norm = (s) => (ci ? s.toLowerCase() : s);
  const dirParts = absolute.split(/[\\/]/);
  const cwdParts = cwd.split(/[\\/]/);
  while (cwdParts.length > 1 && cwdParts.at(-1) === "") cwdParts.pop();
  if (cwdParts.length > dirParts.length || !cwdParts.every((part, i) => norm(part) === norm(dirParts[i]))) return absolute;
  return dirParts.slice(cwdParts.length).join(p.includes("\\") ? "\\" : "/");
}

function fileId(key, filePath) {
  return crypto.createHash("sha256").update(`${key}\n${filePath}`).digest("hex").slice(0, 16);
}

// The view for the page, plus the id -> path map that is the only way the page can name a file.
function buildView(result, { days, running = [], providerOn = () => true, select = null, now = Date.now() } = {}) {
  const index = new Map();
  const live = new Set(running);
  const sessions = [];
  for (const s of (result && result.sessions) || []) {
    if (!s || typeof s.key !== "string" || !providerOn(s.tool)) continue;
    const files = [];
    for (const f of s.files || []) {
      if (!f || typeof f.path !== "string" || !f.path) continue;
      const id = fileId(s.key, f.path);
      index.set(id, { key: s.key, path: f.path });
      files.push({ id, name: f.name || f.path.split(/[\\/]/).pop(), dir: relDir(f.path, s.cwd), kind: f.kind, at: f.at,
        exists: !!f.exists, size: f.size ?? null, modified: f.modified ?? null, can_open: !!f.exists && canOpen(f.path), output: f.output === true });
    }
    if (!files.length) continue;
    sessions.push({ key: s.key, tool: s.tool, label: s.label, name: s.name, cwd: s.cwd, started: s.started, last_active: s.last_active,
      running: live.has(s.key), files });
  }
  const coverage = (result && result.coverage) || {};
  return { view: { days, sessions, coverage: { skipped: coverage.skipped || 0, truncated: !!coverage.truncated }, scanned_at: now, select }, index };
}

let win = null;
let ctx;
let index = new Map();
let previous = new Map();
// A key asked for before the page has loaded, handed over with its first view.
let pendingSelect = null;
const scans = new Map();
// key -> folder of the sessions in the last view, so the page names a session, never a path.
const lastSessions = new Map();

function lookup(id) {
  return typeof id === "string" ? index.get(id) || previous.get(id) || null : null;
}

// One scan per period at a time; callers that arrive meanwhile share it.
function scan(days) {
  if (!scans.has(days)) {
    const run = Promise.resolve().then(() => ctx.scanner.scan({ days })).finally(() => scans.delete(days));
    scans.set(days, run);
  }
  return scans.get(days);
}

async function view(days) {
  const period = days === 30 ? 30 : 7;
  let result;
  try {
    result = await scan(period);
  } catch (err) {
    require("./log").error("session files", err && err.message);
    return { days: period, error: "Couldn't read the session records." };
  }
  const built = buildView(result, { days: period, running: ctx.running(), providerOn: ctx.providerOn, select: pendingSelect });
  pendingSelect = null;
  previous = index;
  index = built.index;
  return built.view;
}

// Every action re-checks the file on disk: it may have been moved or replaced since the scan.
function regularFile(entry) {
  try {
    return fs.statSync(entry.path).isFile();
  } catch {
    return false;
  }
}

async function openFile(id) {
  const entry = lookup(id);
  if (!entry) return { ok: false, error: "That file is no longer in the list." };
  if (!canOpen(entry.path)) return { ok: false, error: "This type of file isn't opened from here. Use Show in folder." };
  if (!regularFile(entry)) return { ok: false, error: "The file is gone." };
  const problem = await electron().shell.openPath(entry.path);
  return problem ? { ok: false, error: problem } : { ok: true };
}

function revealFile(id) {
  const entry = lookup(id);
  if (!entry) return { ok: false, error: "That file is no longer in the list." };
  if (!fs.existsSync(entry.path)) return { ok: false, error: "The file is gone." };
  electron().shell.showItemInFolder(entry.path);
  return { ok: true };
}

function copyPath(id) {
  const entry = lookup(id);
  if (!entry) return { ok: false, error: "That file is no longer in the list." };
  electron().clipboard.writeText(entry.path);
  return { ok: true };
}

async function openFolder(key) {
  const session = typeof key === "string" ? lastSessions.get(key) : null;
  if (!session || !session.cwd) return { ok: false, error: "That session has no folder." };
  try {
    if (!fs.statSync(session.cwd).isDirectory()) throw new Error("not a folder");
  } catch {
    return { ok: false, error: "The folder is gone." };
  }
  const problem = await electron().shell.openPath(session.cwd);
  return problem ? { ok: false, error: problem } : { ok: true };
}

function init(context) {
  ctx = context;
  const { ipcMain } = electron();
  const own = (e) => win && !win.isDestroyed() && e.sender === win.webContents;
  ipcMain.handle("files:get", async (e, days) => {
    if (!own(e)) return null;
    const v = await view(days);
    if (!v.error) {
      lastSessions.clear();
      for (const s of v.sessions) lastSessions.set(s.key, { cwd: s.cwd });
    }
    return v;
  });
  ipcMain.handle("files:open", (e, id) => (own(e) ? openFile(id) : null));
  ipcMain.handle("files:reveal", (e, id) => (own(e) ? revealFile(id) : null));
  ipcMain.handle("files:copy", (e, id) => (own(e) ? copyPath(id) : null));
  ipcMain.handle("files:open-folder", (e, key) => (own(e) ? openFolder(key) : null));
}

function open(key) {
  const select = typeof key === "string" && key ? key : null;
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    if (win.webContents.isLoading()) pendingSelect = select;
    else if (select) win.webContents.send("files:select", select);
    return;
  }
  const { BrowserWindow, nativeTheme } = electron();
  pendingSelect = select;
  win = new BrowserWindow({
    width: 1080,
    height: 720,
    minWidth: 620,
    minHeight: 420,
    show: false,
    title: "Session files - Usage Monitor",
    icon: path.join(__dirname, "ui/icon-256.png"),
    backgroundColor: (ctx.prefs ? ctx.prefs().dark : nativeTheme.shouldUseDarkColors) ? "#1a1a19" : "#fcfcfb",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "files-preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.setMenuBarVisibility(false);
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (e) => e.preventDefault());
  win.loadFile(path.join(__dirname, "ui/files.html"));
  // hidden: the UI smoke test drives the window without showing it.
  win.once("ready-to-show", () => win && !ctx.hidden && win.show());
  win.on("closed", () => {
    win = null;
    index = new Map();
    previous = new Map();
    lastSessions.clear();
  });
}

module.exports = { init, open, canOpen, relDir, fileId, buildView };
