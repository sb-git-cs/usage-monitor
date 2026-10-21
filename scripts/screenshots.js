// Regenerates docs/screenshots from the real UI rendered offscreen with demo data.
// Run with: npm run screenshots   (no real logins, usage or paths are read)
// Add -- --keep-network to reuse docs/screenshots/network.png instead of re-rendering it,
// for example on macOS or Linux, where the Windows program icons in the demo don't exist.
const { app, BrowserWindow, ipcMain, nativeImage, nativeTheme } = require("electron");
const fs = require("fs");
const os = require("os");
const path = require("path");

const SRC = path.resolve(__dirname, "../src");
const OUT = path.resolve(__dirname, "../docs/screenshots");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "usage-monitor-shots-"));
const MB = 1024 ** 2;
const GB = 1024 ** 3;
const MIN = 60000;
const KEEP_NETWORK = process.argv.includes("--keep-network");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.setPath("userData", path.join(os.tmpdir(), "usage-monitor-shots-profile"));
app.disableHardwareAcceleration();
app.on("window-all-closed", () => {});

// ---- demo data -------------------------------------------------------------------

const now = Date.now();
const inMin = (m) => new Date(now + m * MIN).toISOString();
const win = (kind, label, used, resetsIn) => ({ kind, label, used_pct: used, remaining_pct: used == null ? null : 100 - used, resets_at: resetsIn ? inMin(resetsIn) : null });
const fetched = new Date(now - 40_000).toISOString();
const snapshot = {
  providers: [
    { id: "claude", display_name: "Claude Code", status: { state: "ok" }, plan: "Max 20x", windows: [win("five_hour", "5h", 82, 74), win("weekly", "Weekly", 41, 4 * 1440 + 120)] },
    { id: "codex", display_name: "Codex", status: { state: "ok" }, plan: "Plus", windows: [win("five_hour", "5h", 18, 182), win("weekly", "Weekly", 33, 5 * 1440)] },
    { id: "gemini", display_name: "Gemini", status: { state: "ok" }, plan: "Google AI Pro", windows: [win("five_hour", "5h", 12, 250), win("weekly", "Weekly", 28, 5 * 1440)] },
    { id: "grok", display_name: "Grok Build", status: { state: "ok" }, plan: "SuperGrok", windows: [win("weekly", "Weekly", 55, 3 * 1440 + 60), win("credits", "Credits $12.40", null, 0)] },
    { id: "cursor", display_name: "Cursor", status: { state: "ok" }, plan: "Pro", account: "cursor@example.com", windows: [win("monthly", "Included", 42, 12 * 1440), win("monthly", "Auto", 18, 12 * 1440)] },
    { id: "copilot", display_name: "Copilot", status: { state: "ok" }, plan: "Pro", account: "octocat", windows: [win("monthly", "Chat", 36, 10 * 1440), win("monthly", "Premium", 64, 10 * 1440)] },
  ],
};
snapshot.providers.find((p) => p.id === "grok").shared_weekly = win("weekly", "Weekly", 55, 3 * 1440 + 60);
for (const p of snapshot.providers) p.fetched_at = fetched;
const batteryPoints = Array.from({ length: 48 }, (_, i) => ({ t: now - (47 - i) * 2.5 * MIN, present: true, percent: Math.round((84 - i * 0.55) * 10) / 10,
  state: "discharging", seconds: 3 * 3600 + 40 * 60, source: "power", g: false }));
const batteryView = { latest: batteryPoints.at(-1), points: batteryPoints };

const netSummary = {
  state: "running",
  message: null,
  rx_rate: 3.4 * MB,
  tx_rate: 220 * 1024,
  active: 7,
  top: [
    { key: "msedge", name: "Microsoft Edge", rx_rate: 2.9 * MB, tx_rate: 60 * 1024 },
    { key: "drive", name: "Google Drive", rx_rate: 190 * 1024, tx_rate: 220 * 1024 },
    { key: "git", name: "Git for Windows", rx_rate: 96 * 1024, tx_rate: 4 * 1024 },
  ],
  hour: { rx: 1.46 * GB, tx: 212 * MB },
};

const updateState = { kind: "installer", status: "up-to-date", current: require("../package.json").version, build: null, auto: true, checked_at: now };
const sessionReset = new Date(now + 47 * 60_000).toISOString();
const sessionsView = { auto_resume: true, can_resume: true, sessions: [
  { key: "claude:demo", tool: "claude", label: "Claude Code", name: "api-gateway", cwd: "D:\\work\\api-gateway", state: "working", resets_at: null, resume_at: null, resume: null },
  { key: "cursor:demo", tool: "cursor", label: "Cursor Agent", name: "Wire up the exporter", cwd: "D:\\work\\exporter", state: "idle", resets_at: null, resume_at: null, resume: null },
  { key: "grok:demo", tool: "grok", label: "Grok Build", name: "web-dashboard", cwd: "D:\\work\\web-dashboard", state: "limited",
    resets_at: sessionReset, resume_at: new Date(Date.parse(sessionReset) + 60_000).toISOString(), resume: "scheduled" },
] };

function findDefender() {
  const base = "C:\\ProgramData\\Microsoft\\Windows Defender\\Platform";
  try {
    const dir = fs.readdirSync(base).sort().pop();
    return dir ? path.join(base, dir, "MsMpEng.exe") : null;
  } catch {
    return null;
  }
}

function findDrive() {
  const base = "C:\\Program Files\\Google\\Drive File Stream";
  try {
    const dir = fs.readdirSync(base).filter((d) => /^\d/.test(d)).sort().pop();
    return dir ? path.join(base, dir, "GoogleDriveFS.exe") : null;
  } catch {
    return null;
  }
}

// Shown paths are generic; icons come from the same programs when they exist on this PC.
const apps = [
  { key: "msedge", name: "Microsoft Edge", path: "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", rx: 612 * MB, tx: 38 * MB, rxr: 2.9 * MB, txr: 60 * 1024, pids: 14, record_connections: true, cap: { limit_bytes: 2 * GB, used_bytes: 1.12 * GB, period: "daily", period_start: now, enforced: false, notified: false } },
  { key: "drive", name: "Google Drive", path: "C:\\Program Files\\Google\\Drive File Stream\\GoogleDriveFS.exe", icon: findDrive(), rx: 188 * MB, tx: 402 * MB, rxr: 190 * 1024, txr: 220 * 1024, pids: 6, keep_forever: true },
  { key: "chrome", name: "Google Chrome", path: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", rx: 244 * MB, tx: 21 * MB, rxr: 180 * 1024, txr: 12 * 1024, pids: 22 },
  { key: "steam", name: "Steam", path: "C:\\Program Files (x86)\\Steam\\steam.exe", rx: 96 * MB, tx: 1.4 * MB, rxr: 0, txr: 0, pids: 3, blocked: true },
  { key: "svchost", name: "Host Process for Windows Services", path: "C:\\Windows\\System32\\svchost.exe", rx: 52 * MB, tx: 6.1 * MB, rxr: 40 * 1024, txr: 3 * 1024, pids: 9 },
  { key: "git", name: "Git for Windows", path: "C:\\Program Files\\Git\\mingw64\\bin\\git.exe", rx: 31 * MB, tx: 4.2 * MB, rxr: 96 * 1024, txr: 4 * 1024, pids: 2 },
  { key: "node", name: "Node.js JavaScript Runtime", path: "C:\\Program Files\\nodejs\\node.exe", rx: 18 * MB, tx: 2.3 * MB, rxr: 12 * 1024, txr: 2 * 1024, pids: 3 },
  { key: "defender", name: "Antimalware Service Executable", path: "C:\\ProgramData\\Microsoft\\Windows Defender\\Platform\\MsMpEng.exe", icon: findDefender(), rx: 8.4 * MB, tx: 1.1 * MB, rxr: 0, txr: 0, pids: 1 },
  { key: "curl", name: "The curl executable", path: "C:\\Windows\\System32\\curl.exe", rx: 10 * MB, tx: 700, rxr: 0, txr: 0, pids: 1 },
  { key: "system", name: "System", path: null, rx: 120 * 1024, tx: 14 * 1024, rxr: 0, txr: 0, pids: 1 },
];

const rows = apps.map((a) => ({
  key: a.key,
  name: a.name,
  path: a.path,
  rx_rate: a.rxr,
  tx_rate: a.txr,
  pids: a.pids,
  rx: a.rx,
  tx: a.tx,
  total: a.rx + a.tx,
  avg_per_min: (a.rx + a.tx) / 60,
  can_block: !!a.path,
  blocked: !!a.blocked,
  block_pending: false,
  keep_forever: !!a.keep_forever,
  record_connections: !!a.record_connections,
  focused: false,
  cap: a.cap || null,
}));
const sum = (f) => rows.reduce((s, r) => s + r[f], 0);
const netView = {
  ts: now,
  range: "60",
  covered_minutes: 60,
  rows,
  summary: { rx_rate: sum("rx_rate"), tx_rate: sum("tx_rate"), rx: sum("rx"), tx: sum("tx"), active: rows.filter((r) => r.rx_rate || r.tx_rate).length },
};

const bucketStart = Math.floor(now / MIN) * MIN;
const edgeSeries = {
  key: "msedge",
  bucket_minutes: 1,
  span_minutes: 60,
  points: Array.from({ length: 60 }, (_, i) => {
    const wave = 4 + 3 * Math.sin(i / 5) + 2 * Math.sin(i / 2.3);
    const burst = [12, 13, 31, 32, 33, 47, 58].includes(i) ? 18 + (i % 7) * 3 : 0;
    const rx = Math.max(0.3, wave + burst) * MB;
    return { start_ms: bucketStart - (59 - i) * MIN, rx, tx: rx * (0.04 + (i % 4) * 0.015) };
  }),
};
edgeSeries.total = edgeSeries.points.reduce((s, p) => s + p.rx + p.tx, 0);
edgeSeries.peak = edgeSeries.points.reduce((a, b) => (a.rx + a.tx >= b.rx + b.tx ? a : b));

const netState = {
  platform: "win32",
  status: { state: "running", message: null, action: null, warning: null, helper: { installed: true, outdated: false } },
  capabilities: { block: true, domains: true, udp: true, setup: true, flows: true },
  limits: [],
  settings: { enabled: true, retention_minutes: 60, range: "60", auto_sort: true, reverse_dns: false, focus: [], ignore: [] },
  db: { dir: "C:\\Users\\you\\AppData\\Local\\UsageMonitor", file: "C:\\Users\\you\\AppData\\Local\\UsageMonitor\\network.db", size: 2.4 * MB, custom: false },
  autostart: true,
  ranges: require("../src/net/format").NET_RANGES,
  retention: require("../src/net/format").NET_RETENTION,
};

// ---- rendering ---------------------------------------------------------------------

async function renderPage(page, { width, height, transparent, crop, setup }) {
  const w = new BrowserWindow({
    show: false,
    width,
    height,
    frame: false,
    transparent: !!transparent,
    backgroundColor: transparent ? "#00000000" : "#1a1a19",
    webPreferences: {
      preload: path.join(SRC, page === "net" ? "net-preload.js" : "preload.js"),
      contextIsolation: true,
      sandbox: true,
      offscreen: true,
    },
  });
  let frame = null;
  w.webContents.on("paint", (_e, _dirty, image) => {
    frame = image;
  });
  try {
    await w.loadFile(path.join(SRC, "ui", `${page}.html`));
    await setup(w);
    await sleep(900);
    frame = null;
    w.webContents.invalidate();
    const deadline = Date.now() + 5000;
    while (!frame && Date.now() < deadline) await sleep(50);
    if (!frame) throw new Error(`${page} did not render`);
    if (!crop) return frame;
    const rect = await w.webContents.executeJavaScript(
      `(() => { const r = document.querySelector(${JSON.stringify(crop)}).getBoundingClientRect(); return { x: Math.floor(r.x), y: Math.floor(r.y), width: Math.ceil(r.width), height: Math.ceil(r.height) }; })()`
    );
    return frame.crop(rect);
  } finally {
    w.destroy();
  }
}

async function renderScene(html, width, height) {
  const file = path.join(TMP, `scene-${Date.now()}.html`);
  fs.writeFileSync(file, html);
  // Keep scenes within 1000px: Windows clamps offscreen windows to the screen work area.
  const w = new BrowserWindow({ show: false, width, height, frame: false, webPreferences: { offscreen: true } });
  let frame = null;
  w.webContents.on("paint", (_e, _dirty, image) => {
    frame = image;
  });
  try {
    await w.loadFile(file);
    await sleep(600);
    frame = null;
    w.webContents.invalidate();
    const deadline = Date.now() + 5000;
    while (!frame && Date.now() < deadline) await sleep(50);
    return frame;
  } finally {
    w.destroy();
  }
}

function saveTmp(name, image) {
  fs.writeFileSync(path.join(TMP, name), image.toPNG());
  return { name, ...image.getSize() };
}

const FONT = `"Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif`;
// Tall enough for the demo's six plans, sessions, network and battery cards and the footer.
const FLYOUT_H = 1000;

function taskbar(chipsImg, width) {
  return `<div class="taskbar">
    <div class="center">
      <svg viewBox="0 0 20 20"><rect x="1" y="1" width="8" height="8" rx="1"/><rect x="11" y="1" width="8" height="8" rx="1"/><rect x="1" y="11" width="8" height="8" rx="1"/><rect x="11" y="11" width="8" height="8" rx="1"/></svg>
      <svg viewBox="0 0 20 20"><circle cx="8" cy="8" r="6" fill="none" stroke-width="2"/><path d="M12.5 12.5 18 18" stroke-width="2"/></svg>
      <svg viewBox="0 0 20 20"><rect x="2" y="4" width="11" height="11" rx="1.5" fill="none" stroke-width="1.6"/><rect x="7" y="2" width="11" height="11" rx="1.5" fill="none" stroke-width="1.6"/></svg>
    </div>
    <img class="chips" src="${chipsImg.name}" width="${chipsImg.width}" height="${chipsImg.height}" style="left:${width - 150 - chipsImg.width}px">
    <div class="tray">^</div>
    <div class="clock">3:42 PM<br>9/26/2026</div>
  </div>`;
}

const TASKBAR_CSS = `
  .taskbar { position: absolute; left: 0; right: 0; bottom: 0; height: 48px; background: rgba(28, 31, 38, 0.97); border-top: 1px solid rgba(255,255,255,0.08); }
  .taskbar .center { position: absolute; left: 50%; top: 14px; transform: translateX(-50%); display: flex; gap: 26px; }
  .taskbar svg { width: 20px; height: 20px; fill: #cfd6e4; stroke: #cfd6e4; }
  .taskbar .chips { position: absolute; top: 2px; }
  .taskbar .tray { position: absolute; right: 118px; top: 13px; color: #cfd6e4; font-size: 14px; }
  .taskbar .clock { position: absolute; right: 14px; top: 7px; color: #e8ecf3; font-size: 12px; line-height: 17px; text-align: right; }`;

async function main() {
  nativeTheme.themeSource = "dark";
  fs.mkdirSync(OUT, { recursive: true });

  ipcMain.handle("usage://get-interval", () => 5);
  ipcMain.handle("usage://get-chips-docked", () => true);
  ipcMain.handle("usage://get-flyout-state", () => ({ docked: false, pinned: false, canDock: true }));
  ipcMain.handle("usage://get-prefs", () => ({ alert_threshold: 80, chips_show: {}, dark: true }));
  ipcMain.handle("usage://get-pairing", () => null);
  ipcMain.handle("usage://get-update", () => updateState);
  ipcMain.handle("usage://get-sessions", () => sessionsView);
  ipcMain.handle("usage://get-battery", () => batteryView);
  ipcMain.handle("net:state", () => netState);
  ipcMain.handle("net:settings", () => netState);
  ipcMain.handle("net:series", () => edgeSeries);
  ipcMain.handle("net:connections", () => []);
  ipcMain.handle("net:icon", async (_e, key) => {
    const a = apps.find((x) => x.key === key);
    const file = a && (a.icon || a.path);
    if (!file || !fs.existsSync(file)) return null;
    const image = await app.getFileIcon(file, { size: "normal" });
    return image.isEmpty() ? null : image.toDataURL();
  });

  for (const regime of ["legacy", "combined"]) {
    const demo = { ...snapshot, subscription_regime: regime, providers: require("../src/subscription").consolidate(snapshot.providers, regime) };
    for (const page of ["flyout", "chips"]) {
      const shot = await renderPage(page, { width: page === "flyout" ? 620 : 860, height: page === "flyout" ? FLYOUT_H : 80, transparent: true,
        crop: page === "flyout" ? "#root" : "#bar", setup: async (w) => {
          w.webContents.send("usage://snapshot", demo); w.webContents.send("usage://net", netSummary);
          w.webContents.send("usage://update", updateState);
          w.webContents.send("usage://sessions", sessionsView);
          if (page === "chips") w.webContents.send("usage://chips-fill", 44);
        } });
      fs.writeFileSync(path.join(OUT, `${page}-${regime}.png`), shot.toPNG());
    }
  }

  const flyout = saveTmp(
    "flyout.png",
    await renderPage("flyout", {
      width: 620,
      height: FLYOUT_H,
      transparent: true,
      crop: "#root",
      setup: async (w) => {
        w.webContents.send("usage://snapshot", snapshot);
        w.webContents.send("usage://net", netSummary);
        w.webContents.send("usage://update", updateState);
        w.webContents.send("usage://sessions", sessionsView);
      },
    })
  );
  const chips = saveTmp(
    "chips.png",
    await renderPage("chips", {
      width: 700,
      height: 80,
      transparent: true,
      crop: "#bar",
      setup: async (w) => {
        w.webContents.send("usage://chips-docked", true);
        w.webContents.send("usage://chips-fill", 44);
        w.webContents.send("usage://system", { cpu: 24, mem: 52, gpuPresent: true, gpu: 12, disk: 8, space: 68 });
        w.webContents.send("usage://snapshot", snapshot);
        w.webContents.send("usage://net", netSummary);
        w.webContents.send("usage://sessions", sessionsView);
      },
    })
  );
  const kept = KEEP_NETWORK ? nativeImage.createFromPath(path.join(OUT, "network.png")) : null;
  if (kept && kept.isEmpty()) throw new Error("--keep-network: docs/screenshots/network.png is missing");
  const netImage = kept || await renderPage("net", {
    width: 1280,
    height: 780,
    setup: async (w) => {
      w.webContents.send("net:update", netView);
      await sleep(300);
      await w.webContents.executeJavaScript(`document.querySelector('#rows tr[data-key="msedge"]').click()`);
    },
  });
  if (!kept) fs.writeFileSync(path.join(OUT, "network.png"), netImage.toPNG());
  const network = saveTmp("network.png", netImage);

  // Desktop scene: network window, flyout resting on the taskbar, chips in the taskbar.
  const W = 1440;
  const H = 900;
  const desk = await renderScene(
    `<!doctype html><html><head><meta charset="utf-8"><style>
      html, body { margin: 0; width: ${W}px; height: ${H}px; overflow: hidden; font-family: ${FONT}; }
      body { background: radial-gradient(1200px 700px at 30% 20%, #1d3553 0%, #0f1b2d 55%, #0b1422 100%); }
      .badge { position: absolute; left: 22px; top: 18px; padding: 6px 10px; border: 1px solid rgba(255,255,255,0.25); border-radius: 8px; color: #e5e7eb; font-size: 13px; letter-spacing: 0.04em; background: rgba(15, 23, 42, 0.6); }
      .window { position: absolute; left: 40px; top: 66px; border-radius: 8px; box-shadow: 0 24px 60px rgba(0,0,0,0.5); border: 1px solid rgba(255,255,255,0.08); }
      .flyout { position: absolute; right: 0; top: 0; height: ${H - 48}px; width: auto; box-shadow: -18px 0 40px rgba(0,0,0,0.35); }
      ${TASKBAR_CSS}
    </style></head><body>
      <div class="badge">TASKBAR CHIPS · CLICK ONE FOR THE PANEL, OR OPEN THE FULL NETWORK MONITOR</div>
      <img class="window" src="${network.name}" width="${Math.round(network.width * 0.6)}" height="${Math.round(network.height * 0.6)}">
      <img class="flyout" src="${flyout.name}">
      ${taskbar(chips, W)}
    </body></html>`,
    W,
    H
  );
  fs.writeFileSync(path.join(OUT, "tray-flyout.png"), desk.toPNG());

  // Overview poster: each surface with a short explanation. Scenes stay within 1000px high
  // (Windows clamps offscreen windows to the work area), so the panel is scaled to fit.
  const OH = 1000;
  const FS = Math.min(1, (OH - 175 - 70) / flyout.height);
  const fw = Math.round(flyout.width * FS);
  const fh = Math.round(flyout.height * FS);
  const RX = 48 + fw + 56;
  const netTop = 595;
  const NS = Math.min((W - RX - 48) / network.width, (OH - netTop - 45) / network.height);
  const overview = await renderScene(
    `<!doctype html><html><head><meta charset="utf-8"><style>
      html, body { margin: 0; width: ${W}px; height: ${OH}px; overflow: hidden; background: #0b0f17; color: #e5e7eb; font-family: ${FONT}; }
      h1 { position: absolute; left: 48px; top: 30px; margin: 0; font-size: 30px; }
      .sub { position: absolute; left: 48px; top: 80px; color: #aab2c0; font-size: 14px; }
      h2 { margin: 0 0 12px; font-size: 13px; letter-spacing: 0.1em; color: #cbd5e1; }
      .note { color: #8b95a7; font-size: 12.5px; line-height: 1.5; margin-top: 10px; }
      .sec { position: absolute; }
      .panel img { border-radius: 10px; border: 1px solid rgba(255,255,255,0.08); }
      .strip { position: relative; width: ${W - RX - 48}px; height: 48px; background: rgba(28, 31, 38, 0.97); border-radius: 6px; border: 1px solid rgba(255,255,255,0.06); }
      .strip img { position: absolute; left: 16px; top: 2px; }
      .toast { width: 560px; background: #202020; border: 1px solid #333; border-radius: 8px; padding: 11px 16px; margin-bottom: 10px; box-shadow: 0 12px 30px rgba(0,0,0,0.4); border-left: 4px solid #ef4444; }
      .toast.cap { border-left-color: #d95926; }
      .toast small { color: #9ca3af; font-size: 11.5px; }
      .toast b { display: block; font-size: 14px; margin: 3px 0 2px; }
      .toast span { font-size: 12.5px; color: #d1d5db; }
      .net img { border-radius: 8px; border: 1px solid rgba(255,255,255,0.08); }
      .legend { position: absolute; left: 48px; top: 106px; display: flex; gap: 28px; font-size: 13px; color: #cbd5e1; }
      .legend i { display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin-right: 8px; }
    </style></head><body>
      <h1>Usage Monitor</h1>
      <div class="sub">Plan meters for Claude Code, Codex, Gemini, Grok Build, Cursor and GitHub Copilot, plus per-app network usage. Windows, macOS and Linux. Numbers are % used.</div>
      <div class="legend"><span><i style="background:#22c55e"></i>Below your warning level</span><span><i style="background:#ef4444"></i>At or above it (80% by default)</span><span><i style="background:#3987e5"></i>Download</span><span><i style="background:#d95926"></i>Upload</span></div>
      <div class="sec panel" style="left:48px; top:150px">
        <h2>1. PANEL</h2>
        <img src="${flyout.name}" width="${fw}" height="${fh}">
        <div class="note" style="width:${fw}px">Opens at the right edge of the screen: summary, plan cards, coding sessions, network and battery.</div>
      </div>
      <div class="sec" style="left:${RX}px; top:150px">
        <h2>2. TASKBAR CHIPS</h2>
        <div class="strip"><img src="${chips.name}" width="${chips.width}" height="${chips.height}"></div>
        <div class="note">Each plan's % used, coding sessions, download and upload speed, battery, CPU, memory, GPU,<br>disk and storage. On Windows the strip fills the taskbar height. Click a chip for the panel.</div>
      </div>
      <div class="sec" style="left:${RX}px; top:315px">
        <h2>3. NOTIFICATIONS</h2>
        <div class="toast"><small>Usage Monitor — Claude Code</small><b>5h window: 82% used</b><span>Silent, once per window. Clicking opens the panel.</span></div>
        <div class="toast cap"><small>Usage Monitor</small><b>Data cap reached</b><span>Microsoft Edge used its 2.00 GB cap for today. Its internet access is blocked until you reset or raise the cap.</span></div>
      </div>
      <div class="sec net" style="left:${RX}px; top:${netTop}px">
        <h2>4. NETWORK USAGE</h2>
        <img src="${network.name}" width="${Math.round(network.width * NS)}" height="${Math.round(network.height * NS)}">
      </div>
    </body></html>`,
    W,
    OH
  );
  fs.writeFileSync(path.join(OUT, "overview.png"), overview.toPNG());
  const written = ["tray-flyout.png", "overview.png", ...(kept ? [] : ["network.png"])];
  console.log(`wrote ${written.map((f) => path.join("docs", "screenshots", f)).join(", ")}`);
}

app.whenReady().then(async () => {
  let code = 0;
  try {
    await main();
  } catch (err) {
    console.error(err);
    code = 1;
  }
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* temp files are removed by the OS eventually */
  }
  app.exit(code);
});
