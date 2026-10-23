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

const hostile = '<img src="x" onerror="window.injected=true">';
let resizes = 0;
const accountSwitches = [];
const future = new Date(Date.now() + 3600000).toISOString();
const netSummary = {
  state: "running", message: null, rx_rate: 1.5 * 1024 ** 2, tx_rate: 30 * 1024, active: 2,
  top: [{ key: "a", name: '<img src="x" onerror="window.injected=true">', rx_rate: 1024 ** 2, tx_rate: 0 }, { key: "b", name: "Teams", rx_rate: 80 * 1024, tx_rate: 0 }],
  hour: { rx: 120 * 1024 ** 2, tx: 8 * 1024 ** 2 },
};
const snapshot = { providers: [
  { id: "claude", display_name: "Claude Code", status: { state: "ok" }, plan: '<img src="x" onerror="window.injected=true">',
    account: "alice@example.com", accounts: [{ id: "alice@example.com", label: "alice@example.com", active: true }, { id: "bob@example.com", label: hostile, active: false }], windows: [
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
const sessionsView = { auto_resume: true, can_resume: true, sessions: [
  { key: "claude:a", tool: "claude", name: '<img src="x" onerror="window.injected=true">', cwd: "D:\\work", state: "limited", resets_at: future, resume_at: future, resume: "scheduled" },
  { key: "codex:b", tool: "codex", name: "api", cwd: "D:\\api", state: "working", resets_at: null, resume_at: null, resume: null },
] };
const batteryPoints = [
  { t: Date.now() - 1200000, present: true, percent: 60, state: "discharging", seconds: null, source: null, g: true },
  { t: Date.now() - 600000, present: true, percent: 58, state: "discharging", seconds: 17400, source: "observed", g: false },
  { t: Date.now(), present: true, percent: 62, state: "charging", seconds: 3000, source: "system", g: false },
];
const batteryView = { latest: batteryPoints.at(-1), points: batteryPoints, sessions: require("../src/battery-model").sessions(batteryPoints) };
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
    win.webContents.send("usage://sessions", sessionsView);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const result = await win.webContents.executeJavaScript(`({
      sessions: (() => {
        const el = document.getElementById('sessions') || document.getElementById('sessionChip');
        return el.hidden ? null : el.textContent.replace(/\\s+/g, ' ').trim();
      })(),
      text: document.body.textContent,
      battery: document.getElementById("batteryStatus")?.textContent || document.getElementById("batteryEta")?.textContent,
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
    assert.match(result.battery, file === "chips" ? /^▲50m$/ : /~50m to full/);
    assert.equal(result.injected, false);
    assert.equal(result.node, "undefined");
    assert.equal(result.clickable, true, `${file} controls must receive pointer events`);
    assert.deepEqual(errors, []);
    if (file === "flyout") {
      const overview = await win.webContents.executeJavaScript(`({
        reporting: document.getElementById('overviewReporting').textContent,
        attention: document.getElementById('overviewAttention').textContent,
        coverage: document.getElementById('overviewCoverage').textContent,
        meters: document.querySelectorAll('[role="progressbar"]').length,
      })`);
      assert.deepEqual(overview, { reporting: "2 of 4", attention: "2 at risk", coverage: "2 unavailable or cached", meters: 4 });
      await win.webContents.executeJavaScript(`document.querySelector('.provider').focus()`);
      win.webContents.send("usage://snapshot", snapshot);
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(await win.webContents.executeJavaScript(`document.activeElement.dataset.id`), "claude", "provider focus survives polling");
      // The account menu on a card lists the saved sign-ins, switches with one pick, and offers to add one.
      const menu = await win.webContents.executeJavaScript(`(() => {
        const s = document.querySelector('.provider[data-id="claude"] .account-pick');
        return { options: [...s.options].map((o) => o.textContent), value: s.value, injected: !!s.querySelector('img') };
      })()`);
      assert.deepEqual(menu, { options: ["alice@example.com", hostile, "Add account…"], value: "alice@example.com", injected: false });
      await win.webContents.executeJavaScript(`(() => { const s = document.querySelector('.provider[data-id="claude"] .account-pick'); s.focus(); s.value = "bob@example.com"; s.dispatchEvent(new Event("change", { bubbles: true })); })()`);
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.deepEqual(accountSwitches.at(-1), ["claude", "bob@example.com"]);
      assert.equal(await win.webContents.executeJavaScript(`document.getElementById('updated').textContent`), "Switched for the test", "the switch result shows in the header");
      assert.equal(await win.webContents.executeJavaScript(`document.activeElement.classList.contains('account-pick')`), false, "the menu gives up focus after a switch so the next reading can show the account in use");
      // A reading that arrives while the menu has focus waits; it is applied when the menu closes.
      await win.webContents.executeJavaScript(`document.querySelector('.provider[data-id="claude"] .account-pick').focus()`);
      win.webContents.send("usage://snapshot", { providers: snapshot.providers.map((p) => p.id === "claude" ? { ...p, plan: "Max 20x" } : p) });
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(await win.webContents.executeJavaScript(`document.activeElement.classList.contains('account-pick')`), true);
      assert.notEqual(await win.webContents.executeJavaScript(`document.querySelector('.provider[data-id="claude"] .p-plan').textContent`), "Max 20x");
      await win.webContents.executeJavaScript(`document.activeElement.blur()`);
      await new Promise((resolve) => setTimeout(resolve, 1300));
      assert.equal(await win.webContents.executeJavaScript(`document.querySelector('.provider[data-id="claude"] .p-plan').textContent`), "Max 20x");
      await win.webContents.executeJavaScript(`(() => { const s = document.querySelector('.provider[data-id="claude"] .account-pick'); s.value = "__add"; s.dispatchEvent(new Event("change", { bubbles: true })); })()`);
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.deepEqual(accountSwitches.at(-1), ["claude", null]);
      assert.equal(await win.webContents.executeJavaScript(`document.querySelector('.provider[data-id="claude"] .account-pick').value`), "alice@example.com", "the menu returns to the account in use");
      win.webContents.send("usage://snapshot", snapshot);
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.match(result.net, /Download ?1\.50 MB\/s Upload ?30\.0 KB\/s/);
      assert.match(result.net, /Used in the last hour ?↓ 120 MB\s↑ 8\.00 MB/);
      assert.ok(result.net.includes(`Now: ${hostile} 1.0 MB/s · Teams 80 KB/s`), "app names render as text");
      assert.equal(result.cards, 4);
      assert.match(result.sessions, /^›_Sessions2 · 1 at limit Resume after limit Anthropic .* Limit reached · resumes in (1h 00m|59m) OpenAI api Working$/);
      assert.ok(result.sessions.includes(hostile), "session names render as text");
      assert.equal(await win.webContents.executeJavaScript(`document.getElementById('autoResume').checked`), true);
      const past = new Date(Date.now() - 600000).toISOString();
      win.webContents.send("usage://sessions", { auto_resume: false, can_resume: true, sessions: [
        { key: "claude:c", tool: "claude", name: "web", cwd: "D:/web", state: "limited", resets_at: past, resume_at: past, resume: "off" },
        { key: "codex:d", tool: "codex", name: "cli", cwd: "D:/cli", state: "limited", resets_at: null, resume_at: null, resume: "scheduled" },
        { key: "grok:7:1", tool: "grok", label: "Grok Build", name: "api", cwd: "D:/api", state: "running", resets_at: null, resume_at: null, resume: null },
      ] });
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.deepEqual(await win.webContents.executeJavaScript(`[...document.querySelectorAll('#sessionRows .session-state')].map((el) => el.textContent)`),
        ["Limit reset · type continue to resume", "Limit reached · reset time not reported", "Running"], "a passed or unknown reset is not shown as a countdown");
      assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('#sessionRows .session-row')[2].title`), "Grok Build · D:/api");
      assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('#sessionRows .eta').length`), 0);
      assert.equal(await win.webContents.executeJavaScript(`document.getElementById('autoResume').checked`), false);
      assert.equal(await win.webContents.executeJavaScript(`document.getElementById('godmode')`), null, "the flyout has no Godmode switch");
      win.webContents.send("usage://sessions", sessionsView);
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.deepEqual(result.widths, ["25%", "90%", "80%", "0%"]);
      assert.equal(result.reds, 2);
      // Within half an hour of midnight the forecast falls on the next day and is prefixed with it.
      assert.match(result.text, /5h reaches 100% around (?:[A-Z][a-z]{2} )?\d{1,2}:\d\d [AP]M at this pace \(\+40%\/h\)/, "burn-rate forecast line");
      const gear = await win.webContents.executeJavaScript(`(() => { const b = document.getElementById('settings'); const r = b.getBoundingClientRect(); return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) === b; })()`);
      assert.equal(gear, true, "the settings button receives clicks");
      assert.equal(await win.webContents.executeJavaScript(`document.getElementById('pair').getAttribute('aria-label')`), "Pair a phone");
      assert.equal(await win.webContents.executeJavaScript(`document.querySelector('img')`), null, "the QR image is added only while pairing");
      assert.equal(result.update, `v1.1.0 ${hostile} Check now`, "update status renders as text with its action");
      win.webContents.send("usage://update", { current: "1.1.0", status: "downloading", latest: "1.2.0", progress: 42, auto: true });
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(await win.webContents.executeJavaScript(`document.getElementById('updateStatus').textContent`), "Downloading 1.2.0… 42%");
      assert.equal(await win.webContents.executeJavaScript(`document.getElementById('updateAction').hidden`), true, "no action while an update is on its way");
      win.webContents.send("usage://prefs", { alert_threshold: 80, chips_show: {}, dark: false,
        display: { theme: "light", scale: 130, compact: true, hidden: ["grok"], order: ["codex", "claude", "gemini", "grok"] } });
      await new Promise((resolve) => setTimeout(resolve, 200));
      const large = await win.webContents.executeJavaScript(`({
        width: document.getElementById('root').getBoundingClientRect().width,
        first: document.querySelector('.provider').dataset.id,
        cards: document.querySelectorAll('.provider').length,
        light: document.getElementById('root').classList.contains('light'),
      })`);
      assert.equal(large.first, "codex"); assert.equal(large.cards, 3); assert.equal(large.light, true);
      assert.ok(large.width <= 861, "130% flyout must fit the native width limit");
      fs.writeFileSync(path.join(output, "flyout-large.png"), (await win.webContents.capturePage()).toPNG());
      win.webContents.send("usage://prefs", { alert_threshold: 80, chips_show: {}, dark: true });
      await new Promise((resolve) => setTimeout(resolve, 100));
    } else {
      assert.equal(result.chips, 4);
      assert.match(result.sessions, /^›_2⏸(1h00|59m)$/);
      assert.equal(result.net, "↓1.5 MB/s↑30 KB/s");
      assert.match(result.text, /25%/);
      assert.doesNotMatch(result.text, /90%/);
      // Claude shows its 25% five-hour window, but its weekly window at 90% turns the chip red.
      assert.equal(result.reds, 2);
      assert.match(await win.webContents.executeJavaScript(`document.querySelector('.pct-icon[data-id="claude"]').title`), /Weekly 90%/);
      assert.match(result.text, /CPU42%MEM67%GPU18%DISK9%SPACE84%/);
      // A reading that looks the same keeps the same elements and asks for no resize: re-creating
      // the chips and re-docking the window on every poll showed as a flicker beside the strip.
      await win.webContents.executeJavaScript(`document.querySelector('.pct-icon[data-id="codex"]').dataset.mark = "kept"`);
      const resizesBefore = resizes;
      const moved = { providers: snapshot.providers.map((p) => p.id !== "codex" ? p : { ...p, fetched_at: new Date().toISOString(),
        windows: [{ ...p.windows[0], forecast_at: new Date(Date.parse(p.windows[0].forecast_at) + 20000).toISOString() }] }) };
      win.webContents.send("usage://snapshot", moved);
      win.webContents.send("usage://system", { ...systemSummary, cpu: 43 });
      win.webContents.send("usage://battery", batteryView);
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.equal(await win.webContents.executeJavaScript(`document.querySelector('.pct-icon[data-id="codex"]').dataset.mark`), "kept", "chips are updated in place");
      assert.equal(resizes, resizesBefore, "an unchanged strip size asks for no window resize");
      win.webContents.send("usage://snapshot", { providers: snapshot.providers.map((p) => p.id !== "codex" ? p : { ...p, windows: [{ ...p.windows[0], used_pct: 81 }] }) });
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.match(await win.webContents.executeJavaScript(`document.querySelector('.pct-icon[data-id="codex"]').textContent`), /81%/, "a changed reading still shows");
      // Live values never change a chip's width: a network chip that grew with "1.5 MB/s" and shrank
      // with "30 KB/s" resized and re-docked the strip on every reading, which showed as a jump.
      const widths = [];
      const resizesAtStart = resizes;
      for (const [rx, tx] of [[30 * 1024, 2 * 1024], [1.5 * 1024 ** 2, 999 * 1024], [123 * 1024 ** 2, 0.4], [9.9 * 1024, 999.6 * 1024 ** 2]]) {
        win.webContents.send("usage://net", { ...netSummary, rx_rate: rx, tx_rate: tx });
        win.webContents.send("usage://system", { ...systemSummary, cpu: rx % 100, mem: 100, space: 9 });
        await new Promise((resolve) => setTimeout(resolve, 60));
        widths.push(await win.webContents.executeJavaScript(`[document.getElementById('net').getBoundingClientRect().width, document.getElementById('system').getBoundingClientRect().width, document.getElementById('bar').getBoundingClientRect().width].join('x')`));
      }
      assert.equal(new Set(widths).size, 1, `chip widths must not follow their values: ${widths.join(" ")}`);
      assert.equal(resizes, resizesAtStart, "live values must not resize the window");
      win.webContents.send("usage://net", netSummary);
      win.webContents.send("usage://system", systemSummary);
      await new Promise((resolve) => setTimeout(resolve, 60));
    }
    // The strip keeps to short forms; the panel spells them out.
    for (const [reading, long, short] of [
      [{ ...batteryView.latest, percent: 9, state: "discharging", seconds: null }, "Estimating", "…"],
      [{ ...batteryView.latest, percent: 100, state: "full", seconds: null }, "Full", "Full"],
      [{ ...batteryView.latest, percent: 80, state: "plugged", seconds: null }, "Plugged in", "Plugged"],
      [{ ...batteryView.latest, present: null, percent: null, state: "unknown", seconds: null }, "Unavailable", "—"],
      [{ ...batteryView.latest, percent: 40, state: "discharging", seconds: 7500 }, "~2h 5m left", "▼2h05"],
    ]) {
      const expected = file === "chips" ? short : long;
      win.webContents.send("usage://battery", { latest: reading, points: batteryPoints });
      await new Promise((resolve) => setTimeout(resolve, 40));
      const battery = await win.webContents.executeJavaScript(`({text: (document.getElementById('batteryEta') || document.getElementById('batteryStatus')).textContent, hidden: (document.getElementById('batteryChip') || document.getElementById('batteryCard')).hidden})`);
      assert.ok(battery.text.includes(expected), `${file}: battery ${expected}`);
      assert.equal(battery.hidden, false, "transient failure must not hide battery");
    }
    win.webContents.send("usage://battery", { latest: { present: false, percent: null, state: "unknown", seconds: null }, points: [] });
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(await win.webContents.executeJavaScript(`(document.getElementById('batteryChip') || document.getElementById('batteryCard')).hidden`), true);
    win.webContents.send("usage://battery", batteryView);
    await new Promise((resolve) => setTimeout(resolve, 60));
    const deadline = Date.now() + 5000;
    while (!renderedFrame && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(renderedFrame && !renderedFrame.isEmpty(), `${file} must produce a rendered frame`);
    const capture = await win.webContents.capturePage();
    assert.ok(!capture.isEmpty(), `${file} screenshot must not be empty`);
    fs.writeFileSync(path.join(output, `${file}.png`), capture.toPNG());
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
        session: document.getElementById('sessionChip').getBoundingClientRect().width,
        battery: document.getElementById('batteryChip').getBoundingClientRect().width,
      })`);
      assert.equal(fill.bar, 48);
      assert.equal(fill.rows, 2);
      assert.equal(fill.chip, 21);
      assert.equal(fill.net, 44);
      assert.equal(fill.netDisplay, "grid");
      // About 48px with Segoe UI; the default fonts on macOS (50px) and Ubuntu (52.5px) are wider.
      assert.ok(fill.session <= 54, `compact sessions chip: ${fill.session}px`);
      assert.ok(fill.battery <= 56, `compact battery chip: ${fill.battery}px`);
      assert.ok(fill.width - fill.session - fill.battery < 400, `compact strip including system metrics: ${fill.width}px`);
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
    const { consolidate } = require("../src/subscription");
    const grok = { id: "grok", display_name: "Grok Build", status: { state: "ok" }, source: "api",
      shared_weekly: { kind: "weekly", label: "Weekly", used_pct: 42, resets_at: future },
      windows: [{ kind: "credits", label: "Credits $12.50", used_pct: null }] };
    const combined = { subscription_regime: "combined", providers: consolidate([...snapshot.providers.filter(p => p.id !== "grok"), grok,
      { id: "cursor", windows: [{ kind: "monthly", label: "Included", used_pct: 90 }] }], "combined") };
    win.webContents.send("usage://snapshot", combined);
    await new Promise((resolve) => setTimeout(resolve, 150));
    const x = await win.webContents.executeJavaScript(`({
      count: document.querySelectorAll('[data-id="x_subscription"]').length,
      separate: document.querySelectorAll('[data-id="grok"], [data-id="cursor"]').length,
      text: document.querySelector('[data-id="x_subscription"]').textContent,
    })`);
    assert.equal(x.count, 1); assert.equal(x.separate, 0); assert.match(x.text, /42/);
    if (file === "flyout") assert.match(x.text, /Additional Usage \$12.50/);
    grok.shared_weekly = null;
    win.webContents.send("usage://snapshot", { providers: consolidate([grok], "combined") });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const unavailable = await win.webContents.executeJavaScript(`document.querySelector('[data-id="x_subscription"]').textContent`);
    assert.doesNotMatch(unavailable, /42%/);
    if (file === "flyout") assert.match(unavailable, /unavailable/);
    console.log(`${file}: rendering, CSP, escaping, warning colors, combined subscription and preload passed`);
  } finally { win.destroy(); }
}

const MINUTE = 60000;
const now = Date.now();
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
    display: { theme: "system", scale: 100, compact: false, hidden: ["copilot"], order: ["codex", "claude", "gemini", "grok", "cursor", "copilot"] },
    update: { kind: "installer", status: "up-to-date", current: "1.3.0", checked_at: Date.now() - 120000, auto: true },
    accounts: [
      { id: "grok", label: "Grok Build", signed_in: true, account: hostile, login_command: "grok login", removable: false,
        choices: [{ id: "first", label: "First account", active: true }, { id: "second", label: "Second account", active: false }] },
      { id: "codex", label: "Codex", signed_in: false, account: null, login_command: "codex login", removable: true, choices: [] },
      { id: "claude", label: "Claude Code", signed_in: true, account: "alice@example.com", login_command: "claude auth login", removable: true,
        choices: [{ id: "alice@example.com", label: "alice@example.com", active: true, saved_at: Date.now() - 90000 }, { id: "bob@example.com", label: hostile, active: false, saved_at: Date.now() - 3600000 }] },
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
  ipcMain.handle("settings:account-forget", (_e, provider, accountId) => { accountActions.push({ forget: provider, accountId }); return { ok: true }; });
  ipcMain.handle("settings:account-keep", (_e, provider) => { accountActions.push({ keep: provider }); return { ok: true, message: "Kept for the test" }; });
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
    // Saved sign-ins are tabs: the one in use is marked, the others switch with a click, saved
    // copies can be removed, and Add account / Sign in start the tool's own sign-in.
    assert.deepEqual(accountPanel.buttons, ["First account", "Second account", "Add account", "Sign in", "alice@example.com", hostile, "×", "Add account", "Keep current sign-in"]);
    assert.match(await win.webContents.executeJavaScript(`document.querySelector('#accounts .account-keep .hint').textContent`), /^2 saved for quick switching · last saved /);
    assert.match(accountPanel.instructions, /grok login/);
    assert.deepEqual(await win.webContents.executeJavaScript(`[...document.querySelectorAll('#accounts .account-tab')].map(b => b.getAttribute('aria-pressed'))`), ["true", "false", "true", "false"]);
    await win.webContents.executeJavaScript(`document.querySelectorAll('#accounts .account-tab')[1].click()`);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(accountActions.at(-1), { provider: "grok", accountId: "second" });
    await win.webContents.executeJavaScript(`document.querySelectorAll('#accounts .account-tab')[0].click()`);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(accountActions.at(-1), { provider: "grok", accountId: "second" }, "the account in use is not switched to again");
    await win.webContents.executeJavaScript(`document.querySelectorAll('#accounts .btn')[0].click()`);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(accountActions.at(-1), { provider: "grok", accountId: null });
    await win.webContents.executeJavaScript(`document.querySelectorAll('#accounts .btn')[1].click()`);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(accountActions.at(-1), { provider: "codex", accountId: null });
    await win.webContents.executeJavaScript(`document.querySelector('#accounts .account-remove').click()`);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(accountActions.at(-1), { forget: "claude", accountId: "bob@example.com" });
    await win.webContents.executeJavaScript(`document.querySelector('#accounts .account-keep .text-btn').click()`);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(accountActions.at(-1), { keep: "claude" });
    assert.equal(await win.webContents.executeJavaScript(`document.getElementById('toast').textContent`), "Kept for the test");
    await win.webContents.executeJavaScript(`(() => { const s = document.getElementById('threshold'); s.value = '70'; s.dispatchEvent(new Event('change')); })()`);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(patches.at(-1), { alert_threshold: 70 });
    assert.equal(await win.webContents.executeJavaScript(`document.getElementById('combinedSubscription').checked`), false);
    await win.webContents.executeJavaScript(`document.getElementById('combinedSubscription').click()`);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(patches.at(-1), { subscription_regime: "combined" });
    const appearance = await win.webContents.executeJavaScript(`({
      names: [...document.querySelectorAll('#displayProviders .order-name')].map((el) => el.textContent),
      shown: [...document.querySelectorAll('#displayProviders input')].map((el) => el.checked),
      firstUp: document.querySelector('#displayProviders .order-btn').disabled,
      nav: document.querySelectorAll('.nav-link').length,
      active: document.querySelectorAll('.nav-link.active').length,
    })`);
    assert.deepEqual(appearance.names, ["Codex", "Claude Code", "Gemini", "Grok Build", "Cursor", "Copilot"]);
    assert.deepEqual(appearance.shown, [true, true, true, true, true, false]);
    assert.equal(appearance.firstUp, true, "the first plan cannot move up");
    assert.equal(appearance.nav, 9);
    assert.equal(appearance.active, 1, "the section in view is marked");
    await win.webContents.executeJavaScript(`(() => { const s = document.getElementById('theme'); s.value = 'light'; s.dispatchEvent(new Event('change')); })()`);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(patches.at(-1), { display: { theme: "light" } });
    await win.webContents.executeJavaScript(`document.querySelectorAll('#displayProviders .order-btn')[1].click()`);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(patches.at(-1), { display: { order: ["claude", "codex", "gemini", "grok", "cursor", "copilot"] } });
    await win.webContents.executeJavaScript(`document.querySelectorAll('#displayProviders input')[5].click()`);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(patches.at(-1), { display: { hidden: [] } });
    const deadline = Date.now() + 5000;
    renderedFrame = null;
    win.webContents.invalidate();
    while (!renderedFrame && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(renderedFrame && !renderedFrame.isEmpty(), "settings must produce a rendered frame");
    fs.writeFileSync(path.join(output, "settings.png"), renderedFrame.toPNG());
    console.log("settings: rendering, CSP, escaping, account actions, QR, appearance and saving passed");
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

async function checkInsights() {
  const win = new BrowserWindow({ show: false, width: 1040, height: 780, webPreferences: {
    preload: path.join(source, "insights-preload.js"), contextIsolation: true, sandbox: true, nodeIntegration: false,
  } });
  const { Insights, displayPrefs } = require(path.join(source, "insights"));
  const file = path.join(output, `insights-test-${process.pid}.json`);
  let time = Date.now() - 3600000;
  const data = new Insights({ file, now: () => time });
  const cfg = { display: displayPrefs() };
  for (let n = 0; n < 4; n++) {
    data.record({ providers: [{ ...snapshot.providers[0], account: "synthetic@example.invalid", windows: [{ kind: "five_hour", label: hostile, used_pct: 10 + n * 15, resets_at: future }] }] });
    time += 900000;
  }
  data.event(hostile, "Quota warning", "suppressed");
  data.setBudget({ limit: 10e9, day: 1 }); data.traffic({ apps: [{ rx: 2e9, tx: 1e9 }] });
  const tokenCounts = { total: 150, input: 100, output: 50, cache_read: 0, cache_write: 0, reasoning: 20, turns: 1, cache_efficiency_pct: 0, avg_turn_tokens: 150 };
  const model = { ...tokenCounts, id: "0123456789abcdef", provider: "codex", model: hostile, pct: 100,
    daily: [{ ...tokenCounts, date: "2026-10-21" }] };
  const tokens = { days: 7, summary: tokenCounts, by_provider: { codex: tokenCounts }, by_model: [model],
    daily: model.daily, hourly: [], by_session: [{ ...tokenCounts, id: "abcdef0123456789", provider: "codex", first: time, last: time, models: [hostile] }] };
  const view = () => ({ series: data.report(7), events: data.data.events, snooze_until: data.data.snoozeUntil, budget: data.budgetView(),
    tokens, battery: batteryView, display: cfg.display, dark: true, diagnostics: { storage: "ok", providers: [{ id: "codex", state: "stale", last_success: future }], network: { state: "setup_required", coverage: "Partial observed traffic" } } });
  const errors = [];
  win.webContents.on("console-message", (details) => { if (details.level === "error") errors.push(details.message); });
  ipcMain.handle("insights:get", () => view());
  ipcMain.handle("insights:action", (_e, action, value) => {
    if (action === "snooze") data.snooze(Number(value));
    if (action === "display") cfg.display = displayPrefs(value);
    if (action === "budget") data.setBudget(value);
    return { ok: true };
  });
  ipcMain.handle("insights:export", () => ({ canceled: true }));
  try {
    await win.loadFile(path.join(source, "ui/insights.html"));
    await win.webContents.insertCSS("*, *::before, *::after { animation: none !important; transition: none !important; }");
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('canvas').length`), 1);
    assert.equal(await win.webContents.executeJavaScript(`!!document.querySelector('img') || !!window.injected`), false);
    assert.equal(await win.webContents.executeJavaScript(`document.getElementById('tab-tokens').classList.contains('active')`), true);
    await win.webContents.executeJavaScript(`document.getElementById('tokenModel').value = '0123456789abcdef'; document.getElementById('tokenModel').dispatchEvent(new Event('change'));`);
    assert.match(await win.webContents.executeJavaScript(`document.getElementById('dailyTokenBars').textContent`), /10-21/);
    assert.ok(await win.webContents.executeJavaScript(`document.querySelector('#dailyTokenBars .daily-bar').getBoundingClientRect().height > 20`));
    assert.equal(await win.webContents.executeJavaScript(`!!document.querySelector('img') || !!window.injected`), false);
    assert.ok(await win.webContents.executeJavaScript(`document.getElementById('events').textContent.includes(${JSON.stringify(hostile)})`));
    await win.webContents.executeJavaScript(`document.getElementById('snooze').value = '60'; document.getElementById('snooze').dispatchEvent(new Event('change'));`);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.ok(data.isSnoozed());
    assert.equal(await win.webContents.executeJavaScript(`document.getElementById('theme')`), null, "display preferences live in Settings");
    cfg.display = displayPrefs({ theme: "light", scale: 130 });
    await win.webContents.executeJavaScript(`load()`);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(await win.webContents.executeJavaScript(`document.body.classList.contains('light')`), true);
    win.setSize(620, 780);
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(await win.webContents.executeJavaScript(`document.documentElement.scrollWidth > document.documentElement.clientWidth`), false, "large text fits the narrow window");
    fs.writeFileSync(path.join(output, "insights-light.png"), (await win.webContents.capturePage()).toPNG());
    win.setSize(1040, 780);
    cfg.display = displayPrefs({ theme: "dark" });
    await win.webContents.executeJavaScript(`load()`);
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(await win.webContents.executeJavaScript(`document.body.classList.contains('light')`), false);
    fs.writeFileSync(path.join(output, "insights-dark.png"), (await win.webContents.capturePage()).toPNG());
    assert.deepEqual(errors, []);
    await win.webContents.executeJavaScript(`document.querySelector('[data-tab="battery"]').click()`);
    assert.match(await win.webContents.executeJavaScript(`document.getElementById('batterySummary').textContent`), /62%.*~50m to full/);
    assert.equal(await win.webContents.executeJavaScript(`!!document.querySelector('#batteryChart svg')`), true);
    await win.webContents.executeJavaScript(`document.querySelector('#batteryChart svg').dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }))`);
    assert.match(await win.webContents.executeJavaScript(`document.getElementById('batteryPoint').textContent`), /60%.*discharging/);
    await new Promise((resolve) => setTimeout(resolve, 180));
    assert.equal(await win.webContents.executeJavaScript(`document.getElementById('tab-battery').classList.contains('active')`), true);
    assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('#batteryChart polyline').length`), 2);
    fs.writeFileSync(path.join(output, "battery-insights.png"), (await win.webContents.capturePage()).toPNG());
    console.log("insights: battery history, keyboard inspection, charts, escaping, snooze, theme and narrow/large-text layout passed");
  } finally {
    win.destroy();
    for (const channel of ["insights:get", "insights:action", "insights:export"]) ipcMain.removeHandler(channel);
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }
}

app.whenReady().then(async () => {
  fs.mkdirSync(output, { recursive: true });
  ipcMain.on("usage://chips-resize", () => { resizes++; });
  ipcMain.handle("usage://account", (_e, provider, accountId) => { accountSwitches.push([provider, accountId]); return { ok: true, message: "Switched for the test" }; });
  ipcMain.handle("usage://get-interval", () => 5);
  ipcMain.handle("usage://get-chips-docked", () => true);
  ipcMain.handle("usage://get-flyout-state", () => ({ docked: false, pinned: false }));
  ipcMain.handle("usage://get-update", () => null);
  ipcMain.handle("usage://get-prefs", () => ({ alert_threshold: 80, chips_show: {} }));
  ipcMain.handle("usage://get-pairing", () => null);
  ipcMain.handle("usage://get-sessions", () => null);
  ipcMain.handle("usage://get-battery", () => batteryView);
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
    await checkInsights();
    app.exit(0);
  } catch (err) {
    console.error(err);
    // On GitHub Actions the failure also becomes an annotation, readable without the job log.
    if (process.env.GITHUB_ACTIONS) {
      const where = String(err.stack || "").split("\n").find((line) => line.includes("ui-smoke.js")) || "";
      const text = `${err.message} | actual: ${JSON.stringify(err.actual)?.slice(0, 300)} | ${where.trim()}`;
      console.log(`::error title=UI smoke test::${text.replace(/%/g, "%25").replace(/\r?\n/g, " ")}`);
    }
    app.exit(1);
  }
});
