// Hidden windows with synthetic data; never imports main.js or reads CLI credentials.
const { app, BrowserWindow, ipcMain } = require("electron");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const output = path.resolve(__dirname, "../.qa");
const source = process.argv.includes("--packaged")
  ? path.resolve(__dirname, "../dist/win-unpacked/resources/app.asar/src")
  : path.resolve(__dirname, "../src");
app.setPath("userData", path.join(output, "electron-profile"));
app.disableHardwareAcceleration();
app.on("window-all-closed", () => {});

const future = new Date(Date.now() + 3600000).toISOString();
const netSummary = {
  state: "running", message: null, rx_rate: 1.5 * 1024 ** 2, tx_rate: 30 * 1024, active: 2,
  top: [{ key: "a", name: '<img src="x" onerror="window.injected=true">', rx_rate: 1024 ** 2, tx_rate: 0 }, { key: "b", name: "Teams", rx_rate: 80 * 1024, tx_rate: 0 }],
  hour: { rx: 120 * 1024 ** 2, tx: 8 * 1024 ** 2 },
};
const snapshot = { providers: [
  { id: "claude", display_name: "Claude Code", status: { state: "ok" }, plan: '<img src="x" onerror="window.injected=true">', windows: [
    { kind: "five_hour", label: "5h", used_pct: 25, remaining_pct: 75, resets_at: future },
    { kind: "weekly", label: "Weekly", used_pct: 90, remaining_pct: 10, resets_at: future },
  ] },
  { id: "codex", display_name: "Codex", status: { state: "ok" }, windows: [
    { kind: "five_hour", label: "5h", used_pct: 80, remaining_pct: 20, resets_at: future },
  ] },
  { id: "gemini", display_name: "Gemini", status: { state: "stale" }, windows: [
    { kind: "quota", label: "Pro", used_pct: null, remaining_pct: null },
  ] },
  { id: "grok", display_name: "Grok Build", status: { state: "logged_out", hint: "Sign in" }, windows: [] },
] };

async function check(file) {
  const win = new BrowserWindow({ show: false, width: 860, height: 600, webPreferences: {
    preload: path.join(source, "preload.js"), contextIsolation: true, sandbox: true, nodeIntegration: false, offscreen: true,
  } });
  const errors = [];
  let renderedFrame = null;
  win.webContents.on("paint", (_event, _dirty, frame) => { renderedFrame = frame; });
  win.webContents.on("console-message", (details) => {
    if (details.level === "error") errors.push(details.message);
  });
  try {
    await win.loadFile(path.join(source, `ui/${file}.html`));
    win.webContents.send("usage://snapshot", snapshot);
    win.webContents.send("usage://net", netSummary);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const result = await win.webContents.executeJavaScript(`({
      text: document.body.textContent,
      injected: !!window.injected || !!document.querySelector('img'),
      widths: [...document.querySelectorAll('.fill')].map(el => el.style.width),
      reds: document.querySelectorAll('.red').length,
      cards: document.querySelectorAll('.provider').length,
      chips: document.querySelectorAll('.pct-icon').length,
      net: document.getElementById('net').hidden ? null : document.getElementById('net').textContent.replace(/\\s+/g, ' ').trim(),
      node: typeof require,
      clickable: (() => {
        const el = document.querySelector('#refresh, .pct-icon');
        const r = el.getBoundingClientRect();
        const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        return hit === el || el.contains(hit);
      })(),
    })`);
    assert.equal(result.injected, false);
    assert.equal(result.node, "undefined");
    assert.equal(result.clickable, true, `${file} controls must receive pointer events`);
    assert.deepEqual(errors, []);
    if (file === "flyout") {
      assert.match(result.net, /Download ?1\.50 MB\/s Upload ?30\.0 KB\/s/);
      assert.match(result.net, /Used in the last hour ?↓ 120 MB\s↑ 8\.00 MB/);
      assert.ok(result.net.includes(`Now: ${hostile} 1.0 MB/s · Teams 80 KB/s`), "app names render as text");
      assert.equal(result.cards, 4);
      assert.deepEqual(result.widths, ["25%", "90%", "80%", "0%"]);
      assert.equal(result.reds, 2);
    } else {
      assert.equal(result.chips, 4);
      assert.equal(result.net, "↓1.5 MB/s↑30 KB/s");
      assert.match(result.text, /25\/100/);
      assert.doesNotMatch(result.text, /90\/100/);
      assert.equal(result.reds, 1);
    }
    const deadline = Date.now() + 5000;
    while (!renderedFrame && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(renderedFrame && !renderedFrame.isEmpty(), `${file} must produce a rendered frame`);
    fs.writeFileSync(path.join(output, `${file}.png`), renderedFrame.toPNG());
    if (file === "chips") {
      // Docked on a 48px taskbar, the strip and its chips fill the full height.
      win.webContents.send("usage://chips-fill", 48);
      await new Promise((resolve) => setTimeout(resolve, 250));
      const fill = await win.webContents.executeJavaScript(`({
        bar: document.getElementById('bar').getBoundingClientRect().height,
        chip: document.querySelector('#root .pct-icon').getBoundingClientRect().height,
        net: document.getElementById('net').getBoundingClientRect().height,
        netDisplay: getComputedStyle(document.getElementById('net')).display,
      })`);
      assert.deepEqual(fill, { bar: 48, chip: 40, net: 40, netDisplay: "grid" });
      renderedFrame = null;
      const fillDeadline = Date.now() + 5000;
      while (!renderedFrame && Date.now() < fillDeadline) await new Promise((resolve) => setTimeout(resolve, 50));
      assert.ok(renderedFrame && !renderedFrame.isEmpty(), "filled chips must render");
      fs.writeFileSync(path.join(output, "chips-fill.png"), renderedFrame.toPNG());
    }
    console.log(`${file}: rendering, CSP, escaping, warning colors and preload passed`);
  } finally { win.destroy(); }
}

const MINUTE = 60000;
const now = Date.now();
const hostile = '<img src="x" onerror="window.injected=true">';
const netState = {
  platform: "win32",
  status: { state: "running", message: null, action: null, warning: null, helper: null },
  capabilities: { block: true, domains: true, udp: true, setup: true, flows: true },
  limits: ["Counts TCP and UDP traffic per app."],
  settings: { enabled: true, retention_minutes: 60, range: "60", auto_sort: true, reverse_dns: false, focus: [], ignore: [] },
  db: { dir: "C:\\Records", file: "C:\\Records\\network.db", size: 81920, custom: false },
  autostart: true,
  ranges: [{ id: "5", minutes: 5, label: "Last 5 minutes" }, { id: "60", minutes: 60, label: "Last hour" }, { id: "all", minutes: 0, label: "All records" }],
  retention: [{ minutes: 60, label: "1 hour" }, { minutes: 1440, label: "1 day" }],
};
const netRow = (key, name, rx, tx, extra = {}) => ({
  key, name, path: `C:\\Apps\\${key}.exe`, rx_rate: rx / 60, tx_rate: tx / 60, pids: 2, rx, tx, total: rx + tx, avg_per_min: (rx + tx) / 30,
  can_block: true, blocked: false, block_pending: false, keep_forever: false, record_connections: false, focused: false, cap: null, ...extra,
});
const netView = {
  ts: now, range: "60", covered_minutes: 30,
  rows: [
    netRow("chrome", "Google Chrome", 900 * 1024 ** 2, 40 * 1024 ** 2, { record_connections: true, cap: { limit_bytes: 1024 ** 3, used_bytes: 0.9 * 1024 ** 3, period: "daily", enforced: false, notified: false } }),
    netRow("evil", hostile, 5 * 1024 ** 2, 1024 ** 2, { blocked: true }),
    netRow("updater", "Updater", 300 * 1024 ** 2, 2 * 1024 ** 2, { keep_forever: true }),
  ],
  summary: { rx_rate: 1024 ** 2, tx_rate: 64 * 1024, rx: 1205 * 1024 ** 2, tx: 43 * 1024 ** 2, active: 3 },
};
const netSeries = {
  key: "chrome", bucket_minutes: 1, total: 0, span_minutes: 60, peak: null,
  points: Array.from({ length: 60 }, (_, i) => ({ start_ms: now - (59 - i) * MINUTE, rx: i % 7 ? (i * 37 % 50) * 1024 ** 2 : 0, tx: (i % 5) * 1024 ** 2 })),
};

async function checkNet() {
  const win = new BrowserWindow({ show: false, width: 1280, height: 780, webPreferences: {
    preload: path.join(source, "net-preload.js"), contextIsolation: true, sandbox: true, nodeIntegration: false, offscreen: true,
  } });
  const errors = [];
  let renderedFrame = null;
  win.webContents.on("paint", (_event, _dirty, frame) => { renderedFrame = frame; });
  win.webContents.on("console-message", (details) => {
    if (details.level === "error") errors.push(details.message);
  });
  try {
    await win.loadFile(path.join(source, "ui/net.html"));
    win.webContents.send("net:update", netView);
    await new Promise((resolve) => setTimeout(resolve, 150));
    await win.webContents.executeJavaScript(`document.querySelector('#rows tr[data-key="chrome"]').click()`);
    await new Promise((resolve) => setTimeout(resolve, 250));
    const result = await win.webContents.executeJavaScript(`({
      rows: [...document.querySelectorAll('#rows tr')].map((tr) => tr.dataset.key),
      injected: !!window.injected || !!document.querySelector('#rows img:not([src^="data:"])'),
      evilName: document.querySelector('#rows tr[data-key="evil"] .app-name').textContent,
      evilChips: document.querySelector('#rows tr[data-key="evil"] .chips').textContent,
      chromeChips: document.querySelector('#rows tr[data-key="chrome"] .chips').textContent,
      tiles: document.getElementById('tDown').textContent,
      state: document.getElementById('stateText').textContent,
      detail: document.getElementById('dName').textContent,
      bars: document.querySelectorAll('#chart .bar-rx').length,
      caps: document.getElementById('capInfo').textContent,
      node: typeof require,
    })`);
    assert.equal(result.injected, false);
    assert.equal(result.node, "undefined");
    assert.deepEqual(errors, []);
    assert.deepEqual(result.rows, ["chrome", "updater", "evil"], "sorted by total, largest first");
    assert.equal(result.evilName, hostile, "names render as text, never as HTML");
    assert.match(result.evilChips, /Blocked/);
    assert.match(result.chromeChips, /Cap 90%/);
    assert.equal(result.tiles, "1.18 GB");
    assert.equal(result.state, "Recording");
    assert.equal(result.detail, "Google Chrome");
    assert.ok(result.bars > 40, "the per-minute chart draws its bars");
    assert.match(result.caps, /922 MB of 1.00 GB used today/);

    // Pause freezes the list while updates keep arriving.
    await win.webContents.executeJavaScript(`document.getElementById('pause').click()`);
    win.webContents.send("net:update", { ...netView, rows: netView.rows.slice(0, 1) });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('#rows tr').length`), 3);
    await win.webContents.executeJavaScript(`document.getElementById('pause').click()`);
    assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('#rows tr').length`), 1);
    win.webContents.send("net:update", netView);
    win.webContents.send("net:state", { ...netState, settings: { ...netState.settings, focus: [{ key: "chrome", name: "Google Chrome" }] } });
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(await win.webContents.executeJavaScript(`document.getElementById('focusBar').hidden`), false);

    const deadline = Date.now() + 5000;
    renderedFrame = null;
    while (!renderedFrame && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(renderedFrame && !renderedFrame.isEmpty(), "net window must produce a rendered frame");
    fs.writeFileSync(path.join(output, "net.png"), renderedFrame.toPNG());
    console.log("net: rendering, CSP, escaping, sorting, chart, pause and focus passed");
  } finally { win.destroy(); }
}

app.whenReady().then(async () => {
  fs.mkdirSync(output, { recursive: true });
  ipcMain.handle("usage://get-interval", () => 5);
  ipcMain.handle("usage://get-chips-docked", () => true);
  ipcMain.handle("usage://get-flyout-state", () => ({ docked: false, pinned: false }));
  ipcMain.handle("net:state", () => netState);
  ipcMain.handle("net:icon", () => null);
  ipcMain.handle("net:series", () => netSeries);
  ipcMain.handle("net:settings", () => netState);
  try {
    await check("flyout");
    await check("chips");
    await checkNet();
    app.exit(0);
  } catch (err) {
    console.error(err);
    app.exit(1);
  }
});
