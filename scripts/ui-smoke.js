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
    { kind: "five_hour", label: "5h", used_pct: 80, remaining_pct: 20, resets_at: future, forecast_at: new Date(Date.now() + 1800000).toISOString(), burn_per_hour: 40 },
  ] },
  { id: "gemini", display_name: "Gemini", status: { state: "stale" }, windows: [
    { kind: "quota", label: "Pro", used_pct: null, remaining_pct: null },
  ] },
  { id: "grok", display_name: "Grok Build", status: { state: "logged_out", hint: "Sign in" }, windows: [] },
] };
const systemSummary = { cpu: 42, mem: 67, gpuPresent: true, gpu: 18, disk: 9, space: 84,
  disks: [{ name: "0 C:", busy: 9 }], volumes: [{ name: '<img src="x" onerror="window.injected=true">', used: 84 * 1024 ** 3, size: 100 * 1024 ** 3 }] };

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
    if (file === "flyout") win.webContents.send("usage://update", { current: "1.1.0", build: null, status: "skipped", auto: true, message: hostile });
    win.webContents.send("usage://system", systemSummary);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const result = await win.webContents.executeJavaScript(`({
      text: document.body.textContent,
      injected: !!window.injected || !!document.querySelector('img'),
      widths: [...document.querySelectorAll('.fill')].map(el => el.style.width),
      reds: document.querySelectorAll('.red').length,
      cards: document.querySelectorAll('.provider').length,
      chips: document.querySelectorAll('.pct-icon').length,
      net: document.getElementById('net').hidden ? null : document.getElementById('net').textContent.replace(/\\s+/g, ' ').trim(),
      update: document.getElementById('update') && !document.getElementById('update').hidden ? document.getElementById('update').textContent.replace(/\\s+/g, ' ').trim() : null,
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
      assert.match(result.text, /5h reaches 100% around \d{1,2}:\d\d [AP]M at this pace \(\+40%\/h\)/, "burn-rate forecast line");
      const gear = await win.webContents.executeJavaScript(`(() => { const b = document.getElementById('settings'); const r = b.getBoundingClientRect(); return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) === b; })()`);
      assert.equal(gear, true, "the settings button receives clicks");
      assert.equal(await win.webContents.executeJavaScript(`document.getElementById('pair').textContent`), "Pair");
      assert.equal(await win.webContents.executeJavaScript(`document.querySelector('img')`), null, "the QR image is added only while pairing");
      assert.equal(result.update, `v1.1.0 ${hostile} Check now`, "update status renders as text with its action");
      win.webContents.send("usage://update", { current: "1.1.0", status: "downloading", latest: "1.2.0", progress: 42, auto: true });
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(await win.webContents.executeJavaScript(`document.getElementById('updateStatus').textContent`), "Downloading 1.2.0… 42%");
      assert.equal(await win.webContents.executeJavaScript(`document.getElementById('updateAction').hidden`), true, "no action while an update is on its way");
    } else {
      assert.equal(result.chips, 4);
      assert.equal(result.net, "↓1.5 MB/s↑30 KB/s");
      assert.match(result.text, /25%/);
      assert.doesNotMatch(result.text, /90%/);
      assert.equal(result.reds, 1);
      assert.match(result.text, /CPU42%MEM67%GPU18%DISK9%SPACE84%/);
    }
    const deadline = Date.now() + 5000;
    while (!renderedFrame && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(renderedFrame && !renderedFrame.isEmpty(), `${file} must produce a rendered frame`);
    fs.writeFileSync(path.join(output, `${file}.png`), renderedFrame.toPNG());
    if (file === "chips") {
      // Two rows fit the taskbar, with network spanning both rows.
      win.webContents.send("usage://chips-fill", 48);
      await new Promise((resolve) => setTimeout(resolve, 250));
      const fill = await win.webContents.executeJavaScript(`({
        bar: document.getElementById('bar').getBoundingClientRect().height,
        chip: document.querySelector('#root .pct-icon').getBoundingClientRect().height,
        net: document.getElementById('net').getBoundingClientRect().height,
        netDisplay: getComputedStyle(document.getElementById('net')).display,
        rows: new Set([...document.querySelectorAll('#root .pct-icon')].map(el => el.getBoundingClientRect().top)).size,
        width: document.getElementById('bar').getBoundingClientRect().width,
      })`);
      assert.equal(fill.bar, 48);
      assert.equal(fill.rows, 2);
      assert.equal(fill.chip, 21);
      assert.equal(fill.net, 44);
      assert.equal(fill.netDisplay, "grid");
      assert.ok(fill.width < 420, `compact strip including system metrics: ${fill.width}px`);
      renderedFrame = null;
      const fillDeadline = Date.now() + 5000;
      while (!renderedFrame && Date.now() < fillDeadline) await new Promise((resolve) => setTimeout(resolve, 50));
      assert.ok(renderedFrame && !renderedFrame.isEmpty(), "filled chips must render");
      fs.writeFileSync(path.join(output, "chips-fill.png"), renderedFrame.toPNG());
      for (const height of [28, 36, 60]) {
        win.webContents.send("usage://chips-fill", height);
        await new Promise((resolve) => setTimeout(resolve, 80));
        assert.deepEqual(await win.webContents.executeJavaScript(`(() => {
          const bar = document.getElementById('bar').getBoundingClientRect();
          return [...document.querySelectorAll('#root .pct-icon, .system-chip:not([hidden]), .net-chip')].filter(el => {
            const r = el.getBoundingClientRect();
            return r.top < bar.top || r.bottom > bar.bottom || el.scrollHeight > el.clientHeight;
          }).map(el => ({ name: el.textContent, client: el.clientHeight, scroll: el.scrollHeight, top: el.offsetTop, height: el.offsetHeight }));
        })()`), [], `both rows fit a ${height}px taskbar`);
      }
      win.webContents.send("usage://system", { ...systemSummary, gpuPresent: false, cpu: null, mem: null, disk: null, space: null });
      win.webContents.send("usage://chips-fill", 0);
      win.webContents.send("usage://chips-docked", false);
      await new Promise((resolve) => setTimeout(resolve, 80));
      const absent = await win.webContents.executeJavaScript(`({
        hidden: document.querySelector('[data-metric="gpu"]').hidden,
        cpu: document.querySelector('[data-metric="cpu"] .system-value').textContent,
        rows: new Set([...document.querySelectorAll('#root .pct-icon')].map(el => el.getBoundingClientRect().top)).size,
      })`);
      assert.deepEqual(absent, { hidden: true, cpu: "—", rows: 2 });
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

async function checkSettings() {
  const qr = require("qrcode-generator")(0, "M");
  qr.addData("usagemonitor://pair?h=192.168.1.20&p=47329&c=ABCDE-FGHJK-MNPQR-STVWX&n=desk");
  qr.make();
  const view = {
    platform: "win32", version: "1.3.0", login_label: "Start with Windows", intervals: [5, 15, 30, 60], thresholds: [50, 60, 70, 80, 90],
    settings: { autostart: true, poll_interval_secs: 5, chips_hidden: false, chips_docked: true, chips_show_network: true,
      chips_show: { claude: true, codex: true, gemini: true, grok: false, cpu: true, mem: true, gpu: true, disk: true, space: true },
      alert_threshold: 80, notify_on_limit_reached: true, forecast_alerts: true, quiet_hours: { enabled: true, start: "22:00", end: "07:00" },
      auto_update: true, update_channel: "stable" },
    update: { kind: "installer", status: "up-to-date", current: "1.3.0", checked_at: Date.now() - 120000, auto: true },
    accounts: [
      { id: "grok", label: "Grok Build", signed_in: true, account: hostile, login_command: "grok login",
        choices: [{ id: "first", label: "First account", active: true }, { id: "second", label: "Second account", active: false }] },
      { id: "codex", label: "Codex", signed_in: false, account: null, login_command: "codex login", choices: [] },
    ],
    phone: { enabled: true, listening: true, error: null, port: 47329, addresses: ["192.168.1.20"], name: "desk",
      devices: [{ id: "0123456789abcdef", name: hostile, created_at: Date.now() - 86400000, last_seen: Date.now() - 60000 }],
      pairing: { code: "ABCDE-FGHJK-MNPQR-STVWX", link: "usagemonitor://pair?x", expires_at: Date.now() + 540000,
        qr: `data:image/svg+xml;base64,${Buffer.from(qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true })).toString("base64")}` } },
  };
  const patches = [];
  const accountActions = [];
  ipcMain.handle("settings:get", () => view);
  ipcMain.handle("settings:set", (_e, patch) => { patches.push(patch); return view; });
  ipcMain.handle("settings:account", (_e, provider, accountId) => { accountActions.push({ provider, accountId }); return { ok: true }; });
  const win = new BrowserWindow({ show: false, width: 640, height: 1400, webPreferences: {
    preload: path.join(source, "settings-preload.js"), contextIsolation: true, sandbox: true, nodeIntegration: false, offscreen: true,
  } });
  const errors = [];
  let renderedFrame = null;
  win.webContents.on("paint", (_event, _dirty, frame) => { renderedFrame = frame; });
  win.webContents.on("console-message", (details) => {
    if (details.level === "error") errors.push(details.message);
  });
  try {
    await win.loadFile(path.join(source, "ui/settings.html"));
    await new Promise((resolve) => setTimeout(resolve, 300));
    const result = await win.webContents.executeJavaScript(`({
      injected: !!window.injected,
      node: typeof require,
      version: document.getElementById('version').textContent,
      threshold: document.getElementById('threshold').value,
      quiet: document.getElementById('quiet').checked,
      grok: document.querySelector('#chipChecks input[data-key="grok"]').checked,
      device: document.querySelector('#devices li span').textContent,
      code: document.getElementById('pairCode').textContent,
      qr: document.getElementById('pairQr').naturalWidth,
      phoneStatus: document.getElementById('phoneStatus').textContent,
    })`);
    assert.deepEqual(errors, []);
    assert.equal(result.injected, false);
    assert.equal(result.node, "undefined");
    assert.equal(result.version, "Version 1.3.0");
    assert.equal(result.threshold, "80");
    assert.equal(result.quiet, true);
    assert.equal(result.grok, false);
    assert.ok(result.device.startsWith(hostile), "device names render as text");
    assert.equal(result.code, "ABCDE-FGHJK-MNPQR-STVWX");
    assert.ok(result.qr > 0, "the pairing QR code loads under the CSP");
    assert.equal(result.phoneStatus, "Listening on 192.168.1.20:47329.");
    const accountPanel = await win.webContents.executeJavaScript(`({
      account: document.querySelector('#accounts .account-who').textContent,
      buttons: [...document.querySelectorAll('#accounts button')].map(b => b.textContent),
      instructions: document.querySelector('#accounts .hint').textContent,
      injected: !!document.querySelector('#accounts img'),
    })`);
    assert.equal(accountPanel.account, hostile, "account identities render as text");
    assert.equal(accountPanel.injected, false);
    assert.deepEqual(accountPanel.buttons, ["Switch account", "Sign in"]);
    assert.match(accountPanel.instructions, /grok login/);
    await win.webContents.executeJavaScript(`document.querySelector('#accounts button').click()`);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(accountActions.at(-1), { provider: "grok", accountId: null });
    await win.webContents.executeJavaScript(`document.querySelectorAll('#accounts button')[1].click()`);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(accountActions.at(-1), { provider: "codex", accountId: null });
    await win.webContents.executeJavaScript(`(() => { const radio = document.querySelectorAll('#accounts input')[1]; radio.checked = true; radio.dispatchEvent(new Event('change')); })()`);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(accountActions.at(-1), { provider: "grok", accountId: "second" });
    await win.webContents.executeJavaScript(`(() => { const s = document.getElementById('threshold'); s.value = '70'; s.dispatchEvent(new Event('change')); })()`);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(patches.at(-1), { alert_threshold: 70 });
    const deadline = Date.now() + 5000;
    renderedFrame = null;
    win.webContents.invalidate();
    while (!renderedFrame && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(renderedFrame && !renderedFrame.isEmpty(), "settings must produce a rendered frame");
    fs.writeFileSync(path.join(output, "settings.png"), renderedFrame.toPNG());
    console.log("settings: rendering, CSP, escaping, account actions, QR and saving passed");
  } finally { win.destroy(); }
}

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
  ipcMain.handle("usage://get-update", () => null);
  ipcMain.handle("usage://get-prefs", () => ({ alert_threshold: 80, chips_show: {} }));
  ipcMain.handle("usage://get-pairing", () => null);
  ipcMain.handle("usage://pair-phone", () => null);
  ipcMain.handle("usage://pair-cancel", () => null);
  ipcMain.handle("net:state", () => netState);
  ipcMain.handle("net:icon", () => null);
  ipcMain.handle("net:series", () => netSeries);
  ipcMain.handle("net:settings", () => netState);
  try {
    await check("flyout");
    await check("chips");
    await checkNet();
    await checkSettings();
    app.exit(0);
  } catch (err) {
    console.error(err);
    app.exit(1);
  }
});
