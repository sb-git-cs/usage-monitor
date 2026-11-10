// Hidden windows with synthetic data; never imports main.js or reads CLI credentials.
const { app, BrowserWindow, ipcMain } = require("electron");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const output = path.resolve(__dirname, "../.qa");
const source = process.argv.includes("--packaged")
  ? path.resolve(__dirname, "../dist/win-unpacked/resources/app.asar/src")
  : path.resolve(__dirname, "../src");
// --only=flyout,settings checks some pages alone while working on them; all run by default.
const CHECKS = ["flyout", "chips", "net", "settings", "insights", "files"];
const only = (process.argv.find((arg) => arg.startsWith("--only=")) || "--only=").slice(7).split(",").filter(Boolean);
const wanted = (name) => !only.length || only.includes(name);
app.setPath("userData", path.join(output, "electron-profile"));
app.disableHardwareAcceleration();
app.on("window-all-closed", () => {});

const hostile = '<img src="x" onerror="window.injected=true">';
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// One animation frame, so a fit the panel scheduled has run. A hidden offscreen window can go about a
// second without frames (Linux), or paint only when something changes, so it is asked to repaint.
async function frame(win) {
  let done = false;
  const seen = win.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no animation frame in 5 s")), 5000);
    requestAnimationFrame(() => { clearTimeout(timer); resolve(); });
  })`).finally(() => { done = true; });
  while (!done) {
    if (!win.isDestroyed()) win.webContents.invalidate();
    await wait(16);
  }
  return seen;
}
// The panel's fit, the width it asks for, and the fit again at that width.
async function settle(win) {
  await frame(win);
  await frame(win);
  await wait(100);
  await frame(win);
  await frame(win);
}
let resizes = 0;
let flyoutResizes = 0;
// The window whose width requests are applied, as main does for the real panel.
let fitWindow = null;
const resumedKeys = [];
const openedFiles = [];
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
  // The panel is as tall as the work area; a short window would compact it and hide the account menus.
  // Tall enough for that with any system font (macOS and Linux lay the panel out taller than Windows).
  const win = new BrowserWindow({ show: false, width: 860, height: file === "flyout" ? 1400 : 600, webPreferences: {
    preload: path.join(source, "preload.js"), contextIsolation: true, sandbox: true, nodeIntegration: false, offscreen: true,
  } });
  // A new window is kept within the screen (1024 px under xvfb); a resize is not.
  if (file === "flyout") win.setSize(860, 1400);
  const errors = [];
  let renderedFrame = null;
  win.webContents.on("paint", (_event, _dirty, frame) => { renderedFrame = frame; });
  win.webContents.on("console-message", (details) => {
    if (details.level === "error") errors.push(details.message);
  });
  if (file === "flyout") fitWindow = win;
  try {
    await win.loadFile(path.join(source, `ui/${file}.html`));
    win.webContents.send("usage://snapshot", snapshot);
    win.webContents.send("usage://net", netSummary);
    if (file === "flyout") win.webContents.send("usage://update", { current: "1.1.0", build: null, status: "skipped", auto: true, message: hostile });
    win.webContents.send("usage://system", systemSummary);
    win.webContents.send("usage://sessions", sessionsView);
    await new Promise((resolve) => setTimeout(resolve, 200));
    if (file === "flyout") await settle(win);
    const result = await win.webContents.executeJavaScript(`({
      sessions: (() => {
        const el = document.getElementById('sessions') || document.getElementById('sessionChip');
        // The panel's card: its heading and running sessions (the empty and recent parts are checked apart).
        const parts = el.id === 'sessions' ? [el.querySelector('.p-head'), document.getElementById('sessionRows')] : [el];
        return el.hidden ? null : parts.map((part) => part.textContent).join(' ').replace(/\\s+/g, ' ').trim();
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
      assert.match(result.sessions, /^›_Sessions2 running · 1 at limit Resume after limit Files › Anthropic .* Limit reached · resumes in (1h 00m|59m) OpenAI api Working$/);
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
      await checkRecent(win);
      // The model shows as a pill with the full id in its title, and the toggle takes it away.
      const withModels = { ...sessionsView, sessions: sessionsView.sessions.map((s, i) => ({ ...s, model: i ? "gpt-5.5-codex" : "claude-opus-5-5" })),
        recent: [{ key: "claude:r1", tool: "claude", cli: "claude", label: "Claude Code", name: "old", cwd: "D:\\work", id: "r1", godmode: false,
          closed_at: new Date().toISOString(), last_active: new Date().toISOString(), can_resume: true, reason: null, model: "claude-sonnet-4-5-20250929" }] };
      win.webContents.send("usage://sessions", withModels);
      await wait(100);
      const pills = `[...document.querySelectorAll('.pill.model')].map((el) => el.textContent + '|' + el.title)`;
      assert.deepEqual(await win.webContents.executeJavaScript(pills),
        ["opus 5.5|claude-opus-5-5", "gpt-5.5|gpt-5.5-codex", "sonnet 4.5|claude-sonnet-4-5-20250929"], "the model pill names each running and recent session");
      assert.match(await win.webContents.executeJavaScript(`document.querySelector('#sessionRows .session-row').title`), / · claude-opus-5-5$/);
      win.webContents.send("usage://prefs", { alert_threshold: 80, chips_show: {}, dark: true, show_session_model: false });
      await wait(100);
      assert.deepEqual(await win.webContents.executeJavaScript(pills), [], "the toggle hides the model pills");
      win.webContents.send("usage://prefs", { alert_threshold: 80, chips_show: {}, dark: true, show_session_model: true });
      await wait(100);
      assert.equal((await win.webContents.executeJavaScript(pills)).length, 3, "and brings them back");
      await checkFilesButtons(win, withModels);
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
      // The model tag is a fixed step: wider than without it, and the same for any model.
      const barWidth = () => win.webContents.executeJavaScript(`document.getElementById('bar').getBoundingClientRect().width`);
      const tagText = () => win.webContents.executeJavaScript(`document.querySelector('.session-model')?.textContent ?? null`);
      const modelsOf = (a, b) => ({ ...sessionsView, sessions: sessionsView.sessions.map((s, i) => ({ ...s, model: i ? b : a })) });
      const plainWidth = await barWidth();
      win.webContents.send("usage://sessions", modelsOf("claude-opus-5-5", "gpt-5.5-codex"));
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.equal(await tagText(), "gpt-5.5", "the tag names the working session's model");
      const taggedWidth = await barWidth();
      assert.ok(taggedWidth > plainWidth, "the tag adds width");
      assert.match(await win.webContents.executeJavaScript(`document.getElementById('sessionChip').title`), /api · gpt-5\.5-codex: working/);
      const resizesAtTag = resizes;
      for (const [a, b] of [["claude-sonnet-4-5-20250929", "grok-code-fast-1"], ["a-very-long-model-name-x", "o"], ["claude-opus-5-5", "gpt-5.5-codex"]]) {
        win.webContents.send("usage://sessions", modelsOf(a, b));
        await new Promise((resolve) => setTimeout(resolve, 80));
        assert.equal(await barWidth(), taggedWidth, `the strip keeps its width for ${a} and ${b}`);
      }
      assert.equal(resizes, resizesAtTag, "a different model does not resize the window");
      win.webContents.send("usage://prefs", { alert_threshold: 80, chips_show: {}, dark: true, show_session_model: false });
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.equal(await tagText(), null, "the toggle takes the tag away");
      assert.equal(await barWidth(), plainWidth, "and the strip returns to its width");
      win.webContents.send("usage://prefs", { alert_threshold: 80, chips_show: {}, dark: true });
      win.webContents.send("usage://sessions", sessionsView);
      await new Promise((resolve) => setTimeout(resolve, 150));
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
  } finally {
    fitWindow = null;
    win.destroy();
  }
}

// Recently closed sessions in the panel: text only, Resume from the keyboard, and the card's empty states.
async function checkRecent(win) {
  const js = (code) => win.webContents.executeJavaScript(code);
  const closed = new Date(Date.now() - 300000).toISOString();
  const recent = [
    { key: "claude:abc123", tool: "claude", cli: "claude", label: "Claude Code", name: hostile, cwd: `D:\\work\\${hostile}`, id: "abc123",
      started: closed, last_active: closed, closed_at: closed, godmode: true, can_resume: true, reason: null },
    { key: "cursor:def456", tool: "cursor", cli: "cursor-agent", label: "Cursor Agent", name: "exporter", cwd: "D:\\work\\exporter", id: "def456",
      started: null, last_active: closed, closed_at: closed, godmode: false, can_resume: false, reason: "not installed" },
  ];
  win.webContents.send("usage://sessions", { auto_resume: false, can_resume: true, sessions: [], recent });
  await wait(100);
  const card = await js(`(() => {
    const rows = document.querySelectorAll('#recentRows .session-row.recent');
    return {
      hidden: document.getElementById('sessions').hidden,
      empty: document.getElementById('sessionEmpty').hidden,
      count: document.getElementById('sessionCount').textContent,
      rows: rows.length,
      text: document.getElementById('recentRows').textContent,
      injected: !!window.injected || !!document.querySelector('img'),
      labels: [...document.querySelectorAll('#recentRows button.resume')].map((b) => b.getAttribute('aria-label')),
      second: rows[1].textContent.replace(/\\s+/g, ' ').trim(),
      secondButtons: rows[1].querySelectorAll('button').length,
      pill: rows[0].querySelector('.pill')?.textContent,
      title: rows[0].title,
    };
  })()`);
  assert.equal(card.hidden, false, "recent sessions keep the card shown");
  assert.equal(card.empty, false, "the card says that no session is running");
  assert.equal(card.count, "");
  assert.equal(card.rows, 2);
  assert.ok(card.text.includes(hostile), "recent names and folders render as text");
  assert.equal(card.injected, false);
  assert.deepEqual(card.labels, [`Resume ${hostile} in Claude Code`]);
  assert.match(card.second, /exporter 5m ago not installed$/);
  assert.equal(card.secondButtons, 0, "a session that can't be resumed has no button");
  assert.equal(card.pill, "godmode");
  assert.match(card.title, /^Claude Code · D:\\work\\<img .* · closed .* · skips permissions$/);
  assert.equal(await js(`(() => { const b = document.querySelector('#recentRows button.resume'); b.focus(); return document.activeElement === b; })()`), true, "Resume is reachable with the keyboard");
  await js(`document.querySelector('#recentRows button.resume').click()`);
  await wait(100);
  assert.deepEqual(resumedKeys, ["claude:abc123"]);
  assert.equal(await js(`document.getElementById('updated').textContent`), "Resumed for the test", "the reply shows in the header");
  assert.equal(await js(`document.querySelector('#recentRows button.resume').disabled`), true, "a second click waits a moment");
  // More than fit: Show all lists every one and Show fewer folds them again.
  const many = Array.from({ length: 7 }, (_, i) => ({ ...recent[1], key: `cursor:m${i}`, id: `m${i}`, name: `session ${i}` }));
  win.webContents.send("usage://sessions", { auto_resume: false, can_resume: true, sessions: sessionsView.sessions, recent: many });
  await wait(100);
  const shown = `({ rows: [...document.querySelectorAll('#recentRows .session-row')].filter((el) => el.getClientRects().length).length,
    more: document.getElementById('recentMore').hidden ? null : document.getElementById('recentMore').textContent })`;
  const folded = await js(shown);
  assert.equal(folded.more, "Show all (7)");
  assert.ok(folded.rows < 7, `folded list shows ${folded.rows} rows`);
  await js(`document.getElementById('recentMore').click()`);
  await wait(100);
  assert.deepEqual(await js(shown), { rows: 7, more: "Show fewer" });
  await js(`document.getElementById('recentMore').click()`);
  await wait(100);
  assert.deepEqual(await js(shown), folded);
  win.webContents.send("usage://sessions", { auto_resume: false, can_resume: true, sessions: [], recent: [] });
  await wait(100);
  assert.equal(await js(`document.getElementById('sessions').hidden`), true, "nothing running and nothing recent hides the card");
}

// The panel fits the screen's height: zoomed when the text size is Auto, compacted step by step when
// that is not enough, and scrolled only as the last resort.
async function checkFit() {
  const demo = require("./demo-data");
  const win = new BrowserWindow({ show: false, width: 620, height: 1080, webPreferences: {
    preload: path.join(source, "preload.js"), contextIsolation: true, sandbox: true, nodeIntegration: false, offscreen: true,
  } });
  fitWindow = win;
  const errors = [];
  win.webContents.on("console-message", (details) => {
    if (details.level === "error") errors.push(details.message);  });
  const js = (code) => win.webContents.executeJavaScript(code);
  const send = () => {
    win.webContents.send("usage://snapshot", demo.snapshot);
    win.webContents.send("usage://net", demo.netSummary);
    win.webContents.send("usage://update", demo.updateState);
    win.webContents.send("usage://sessions", demo.sessionsView);
    win.webContents.send("usage://battery", demo.batteryView);
  };
  const show = async (scale, height) => {
    win.setSize(win.getSize()[0], height);
    win.webContents.send("usage://prefs", { alert_threshold: 80, chips_show: {}, dark: true,
      display: { theme: "dark", scale, compact: false, hidden: [], order: [] } });
    send();
    await wait(400);
    await settle(win);
  };
  const measure = `(() => {
    const root = document.getElementById('root'), update = document.getElementById('update');
    const scale = root.getBoundingClientRect().height / root.offsetHeight;
    const last = [...root.children].filter((el) => el !== update && el.getClientRects().length).at(-1);
    return {
      height: innerHeight, width: innerWidth, scroll: root.scrollHeight, client: root.clientHeight, className: root.className, zoom: root.style.zoom,
      footer: innerHeight - update.getBoundingClientRect().bottom,
      gap: (update.getBoundingClientRect().top - last.getBoundingClientRect().bottom) / scale,
      sideways: document.documentElement.scrollWidth > innerWidth || root.scrollWidth > root.clientWidth + 1,
    };
  })()`;
  const seen = [];
  try {
    await win.loadFile(path.join(source, "ui/flyout.html"));
    for (const [scale, height] of [...[1400, 1080, 1032, 900, 852, 768, 720].map((h) => ["auto", h]), [130, 1080], [130, 720]]) {
      await show(scale, height);
      const m = await js(measure);
      const where = `${scale} at ${height}px (window ${m.width}x${m.height}, zoom ${m.zoom}, ${m.className})`;
      seen.push(`${height}/${scale}: zoom ${m.zoom}${m.className.includes("fit-") ? ` ${m.className.match(/fit-[\w-]+/g).join(" ")}` : ""}`);
      assert.equal(m.sideways, false, `no sideways scroll: ${where}`);
      if (scale === "auto") {
        assert.ok(m.scroll <= m.client + 1, `the panel fits: ${where}, ${m.scroll} > ${m.client}`);
        assert.ok(m.footer >= -1 && m.footer <= 14, `the footer sits at the bottom: ${where}, ${m.footer}px above it`);
        if (height === 1400) assert.ok(m.gap <= 24, `spare height is used: ${where}, ${m.gap}px above the footer`);
      }
      if (height >= 768) assert.ok(!m.className.includes("fit-scroll"), `no scrollbar: ${where}`);
      if (scale === "auto" && (height === 1080 || height === 768)) fs.writeFileSync(path.join(output, `flyout-${height}.png`), (await win.webContents.capturePage()).toPNG());
    }
    // The same readings again lay the panel out the same way and ask for no new width.
    await show("auto", 1080);
    const before = { resizes: flyoutResizes, className: (await js(measure)).className };
    for (let n = 0; n < 5; n++) {
      send();
      await wait(60);
    }
    await wait(300);
    await settle(win);
    assert.ok(flyoutResizes - before.resizes <= 1, `repeated readings asked for ${flyoutResizes - before.resizes} resizes`);
    assert.equal((await js(measure)).className, before.className, "repeated readings keep the layout");
    assert.deepEqual(errors, []);
    console.log(`flyout fit: ${seen.join(", ")}`);
  } finally {
    fitWindow = null;
    win.destroy();
  }
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
      auto_update: true, update_channel: "stable", recent_sessions: true, show_session_model: true,
      providers_enabled: { claude: true, codex: true, gemini: true, grok: true, cursor: true, copilot: true } },
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
  let recentClears = 0;
  ipcMain.handle("settings:recent-clear", () => { recentClears++; return { ok: true, message: "Cleared for the test", view }; });
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
    assert.deepEqual(appearance.names, ["Codex", "Claude Code", "Gemini", "Grok Build", "Cursor", "Copilot", "Windsurf", "Kiro", "Amp", "OpenCode", "Qwen Code", "Kimi Code"]);
    assert.deepEqual(appearance.shown, [true, true, true, true, true, false, true, true, true, true, true, true]);
    assert.equal(appearance.firstUp, true, "the first plan cannot move up");
    assert.equal(appearance.nav, 10);
    assert.equal(appearance.active, 1, "the section in view is marked");
    await win.webContents.executeJavaScript(`(() => { const s = document.getElementById('theme'); s.value = 'light'; s.dispatchEvent(new Event('change')); })()`);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(patches.at(-1), { display: { theme: "light" } });
    await win.webContents.executeJavaScript(`document.querySelectorAll('#displayProviders .order-btn')[1].click()`);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(patches.at(-1), { display: { order: ["claude", "codex", "gemini", "grok", "cursor", "copilot", "windsurf", "kiro", "amp", "opencode", "qwen", "kimi"] } });
    await win.webContents.executeJavaScript(`document.querySelectorAll('#displayProviders input')[5].click()`);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(patches.at(-1), { display: { hidden: [] } });
    // Auto text size fits the panel to the screen.
    assert.ok(await win.webContents.executeJavaScript(`[...document.getElementById('scale').options].some((o) => o.value === 'auto')`), "Auto is a text size");
    await win.webContents.executeJavaScript(`(() => { const s = document.getElementById('scale'); s.value = 'auto'; s.dispatchEvent(new Event('change')); })()`);
    await wait(100);
    assert.deepEqual(patches.at(-1), { display: { scale: "auto" } });
    // Providers: one switch for every provider in the registry; off disables the plan and strip rows.
    const registry = require("../src/models").PROVIDERS.map((p) => p.id);
    assert.deepEqual(await win.webContents.executeJavaScript(`[...document.querySelectorAll('#providerRows input')].map((b) => b.dataset.provider)`), registry, "a switch for every provider");
    assert.equal(await win.webContents.executeJavaScript(`[...document.querySelectorAll('#providerRows input')].every((b) => b.checked)`), true);
    await win.webContents.executeJavaScript(`document.querySelector('#providerRows input[data-provider="codex"]').click()`);
    await wait(100);
    assert.deepEqual(patches.at(-1), { providers_enabled: { codex: false } });
    win.webContents.send("settings:state", { ...view, settings: { ...view.settings, providers_enabled: { ...view.settings.providers_enabled, codex: false } } });
    await wait(150);
    const off = await win.webContents.executeJavaScript(`(() => {
      const row = [...document.querySelectorAll('#displayProviders li')].find((li) => li.querySelector('.order-name').textContent === 'Codex');
      const chip = document.querySelector('#chipChecks input[data-key="codex"]');
      return { off: row.classList.contains('off'), disabled: row.querySelector('input').disabled, title: row.title, chipDisabled: chip.disabled, chipTitle: chip.parentNode.title,
        other: document.querySelector('#chipChecks input[data-key="claude"]').disabled };
    })()`);
    assert.deepEqual(off, { off: true, disabled: true, title: "Switched off under Providers", chipDisabled: true, chipTitle: "Switched off under Providers", other: false });
    win.webContents.send("settings:state", view);
    await wait(150);
    // Recently closed sessions: the switch and the clear button.
    assert.equal(await win.webContents.executeJavaScript(`document.getElementById('recentSessions').checked`), true);
    await win.webContents.executeJavaScript(`document.getElementById('recentSessions').click()`);
    await wait(100);
    assert.deepEqual(patches.at(-1), { recent_sessions: false });
    // Each session's model: on by default, saved as a boolean patch.
    assert.equal(await win.webContents.executeJavaScript(`document.getElementById('showSessionModel').checked`), true);
    await win.webContents.executeJavaScript(`document.getElementById('showSessionModel').click()`);
    await wait(100);
    assert.deepEqual(patches.at(-1), { show_session_model: false });
    await win.webContents.executeJavaScript(`document.getElementById('clearRecent').click()`);
    await wait(100);
    assert.equal(recentClears, 1);
    assert.equal(await win.webContents.executeJavaScript(`document.getElementById('toast').textContent`), "Cleared for the test");
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
  const closed = new Date(Date.now() - 600000).toISOString();
  const recentSessions = [{ key: "codex:019a3c2e", tool: "codex", cli: "codex", label: "Codex", name: hostile, cwd: "D:\\work\\api", id: "019a3c2e",
    started: closed, last_active: closed, closed_at: closed, godmode: false, can_resume: true, reason: null }];
  const view = () => ({ series: data.report(7), events: data.data.events, snooze_until: data.data.snoozeUntil, budget: data.budgetView(),
    tokens, battery: batteryView, display: cfg.display, dark: true, recent_sessions: recentSessions,
    diagnostics: { storage: "ok", providers: [{ id: "codex", state: "stale", last_success: future }], network: { state: "setup_required", coverage: "Partial observed traffic" } } });
  const actions = [];
  const errors = [];
  win.webContents.on("console-message", (details) => { if (details.level === "error") errors.push(details.message); });
  ipcMain.handle("insights:get", () => view());
  ipcMain.handle("insights:action", (_e, action, value) => {
    actions.push([action, value]);
    if (action === "resume") return { ok: true, message: "Resumed for the test" };
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
    // Recently closed sessions on the Sessions tab, each with its Resume button.
    await win.webContents.executeJavaScript(`document.querySelector('[data-tab="sessions"]').click()`);
    await wait(150);
    const recent = await win.webContents.executeJavaScript(`({
      text: document.getElementById('recentSessionRows').textContent,
      injected: !!document.querySelector('#recentSessionRows img') || !!window.injected,
      buttons: document.querySelectorAll('#recentSessionRows button').length,
    })`);
    assert.ok(recent.text.includes(hostile), "recent session names render as text");
    assert.equal(recent.injected, false);
    assert.equal(recent.buttons, 1);
    await win.webContents.executeJavaScript(`document.querySelector('#recentSessionRows button').click()`);
    await wait(150);
    assert.deepEqual(actions.at(-1), ["resume", "codex:019a3c2e"]);
    assert.equal(await win.webContents.executeJavaScript(`document.getElementById('message').textContent`), "Resumed for the test", "the reply shows on the page");
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

// A session row with files shows a count button that opens the Session files window at that session.
async function checkFilesButtons(win, base) {
  const js = (code) => win.webContents.executeJavaScript(code);
  const counted = { ...base, sessions: base.sessions.map((s, i) => ({ ...s, files: i ? 0 : 3 })), recent: base.recent.map((r) => ({ ...r, files: 12 })) };
  win.webContents.send("usage://sessions", counted);
  await wait(150);
  const buttons = await js(`[...document.querySelectorAll('button.files-btn')].map((b) => [b.dataset.filesKey, b.textContent, b.getAttribute('aria-label')])`);
  assert.deepEqual(buttons, [
    ["claude:a", "3 files", `Show the 3 files from ${hostile}`],
    ["claude:r1", "12 files", "Show the 12 files from old"],
  ], "only rows with files get the button");
  const heights = await js(`[...document.querySelectorAll('#sessionRows .session-row, #recentRows .session-row:not([hidden])')].map((r) => Math.round(r.getBoundingClientRect().height))`);
  assert.equal(new Set(heights).size, 1, `the button does not change the row height: ${heights}`);
  assert.equal(await js(`document.querySelector('#sessionRows .session-row').scrollWidth <= document.querySelector('#sessionRows .session-row').clientWidth`), true, "the rows still fit the panel's width");
  await js(`document.querySelector('#sessionRows button.files-btn').click()`);
  await js(`document.querySelector('#recentRows button.files-btn').click()`);
  await js(`document.getElementById('sessionFiles').click()`);
  await js(`document.getElementById('files').click()`);
  await wait(100);
  assert.deepEqual(openedFiles.splice(0), ["claude:a", "claude:r1", null, null], "the buttons ask for the window at their session");
  // A new reading keeps the keyboard focus on the button, as it does for Resume.
  await js(`document.querySelector('#recentRows button.files-btn').focus()`);
  win.webContents.send("usage://sessions", { ...counted });
  await wait(100);
  assert.equal(await js(`document.activeElement.dataset.filesKey`), "claude:r1", "focus stays on the files button of a recent row");
  await js(`document.querySelector('#sessionRows button.files-btn').focus()`);
  win.webContents.send("usage://sessions", { ...counted });
  await wait(100);
  assert.equal(await js(`document.activeElement.dataset.filesKey`), "claude:a", "and on a running row");
  win.webContents.send("usage://sessions", base);
  await wait(100);
  assert.equal(await js(`document.querySelectorAll('button.files-btn').length`), 0, "no files, no button");
}

// The Session files window, opened through the real module with a scanner that returns demo data.
async function checkFiles() {
  const { nativeTheme, shell, clipboard } = require("electron");
  const demo = require("./demo-data");
  const filesWindow = require(path.join(source, "files-window"));
  const dir = path.join(output, `files-demo-${process.pid}`);
  fs.rmSync(dir, { recursive: true, force: true });
  const scan = demo.filesScan(dir);
  const api = path.join(dir, "api-gateway");
  // A name that would be markup, on a deleted file so that nothing has to be written for it.
  scan.sessions[0].files.push({ path: path.join(api, hostile), name: hostile, kind: "created", at: new Date().toISOString(), exists: false, size: null, modified: null });
  scan.sessions[2].name = hostile;
  scan.sessions.push({ key: "cursor:x", tool: "cursor", label: "Cursor Agent", id: "x", name: "switched off", cwd: dir, started: null, last_active: new Date().toISOString(),
    files: [{ path: path.join(dir, "off.md"), name: "off.md", kind: "created", at: new Date().toISOString(), exists: false, size: null, modified: null }] });
  for (const s of scan.sessions) {
    for (const f of s.files) {
      if (!f.exists) continue;
      fs.mkdirSync(path.dirname(f.path), { recursive: true });
      fs.writeFileSync(f.path, "demo");
    }
  }
  let result = scan;
  const asked = [];
  const scanner = { scan: async (options) => { asked.push(options); if (result instanceof Error) throw result; return result; } };
  // Records what the page sends, then hands over to the real handlers.
  const calls = [];
  const realHandle = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = (channel, fn) => realHandle(channel, (e, ...args) => { calls.push([channel, ...args]); return fn(e, ...args); });
  filesWindow.init({ scanner, providerOn: (tool) => tool !== "cursor", running: () => ["claude:demo"], prefs: () => ({ dark: true }), hidden: true });
  ipcMain.handle = realHandle;
  // Nothing is opened for real.
  const opened = [];
  const stubs = { openPath: shell.openPath, showItemInFolder: shell.showItemInFolder, writeText: clipboard.writeText };
  shell.openPath = async (p) => { opened.push(["open", p]); return ""; };
  shell.showItemInFolder = (p) => { opened.push(["reveal", p]); };
  clipboard.writeText = (t) => { opened.push(["copy", t]); };

  const before = new Set(BrowserWindow.getAllWindows());
  const errors = [];
  let win = null;
  const js = (code) => win.webContents.executeJavaScript(code);
  const text = (selector) => js(`[...document.querySelectorAll(${JSON.stringify(selector)})].map((n) => n.textContent.trim())`);
  const names = () => text(".frow .f-name");
  const sessionNames = () => text(".srow .s-name");
  const counts = () => js(`['all', 'created', 'edited', 'generated'].map((k) => document.getElementById('n-' + k).textContent).join(' ')`);
  const idOf = (name) => js(`[...document.querySelectorAll('.frow')].find((r) => r.querySelector('.f-name').textContent === ${JSON.stringify(name)}).dataset.id`);
  const refresh = async () => { await js(`load(true)`); await wait(60); };
  const selected = () => js(`document.querySelector('.srow[aria-current]')?.dataset.key ?? null`);
  const type = async (value) => { await js(`(() => { const q = document.getElementById('query'); q.value = ${JSON.stringify(value)}; q.dispatchEvent(new Event('input', { bubbles: true })); })()`); await wait(40); };
  const open = async (key) => {
    filesWindow.open(key);
    win = BrowserWindow.getAllWindows().find((w) => !before.has(w) && w.webContents.getURL().endsWith("files.html")) || BrowserWindow.getAllWindows().find((w) => !before.has(w));
    win.webContents.on("console-message", (details) => { if (details.level === "error") errors.push(details.message); });
    const until = Date.now() + 8000;
    while (Date.now() < until && !(await js(`document.getElementById('stateBox').hidden && !document.getElementById('main').hidden`).catch(() => false))) await wait(50);
    await wait(50);
  };
  try {
    await open();
    await win.webContents.insertCSS("*, *::before, *::after { animation: none !important; transition: none !important; }");
    assert.equal(win.isVisible(), false, "the smoke test drives the window without showing it");
    assert.deepEqual(asked.at(0), { days: 7 }, "the first reading is for 7 days");
    assert.equal(await js(`typeof require`), "undefined");
    assert.equal(await js(`document.title`), "Session files");

    // Sessions and files; a switched-off tool does not appear; the deleted files are not counted.
    assert.deepEqual(await sessionNames(), ["api-gateway", "Add pagination to the orders API", hostile]);
    assert.deepEqual(await text(".srow .s-count"), ["5", "3", "1"]);
    assert.equal(await js(`document.querySelectorAll('.srow .run-dot').length`), 1, "one session is running");
    assert.equal(await js(`document.querySelector('.srow .run-dot').closest('.srow').dataset.key`), "claude:demo");
    assert.equal(await counts(), "9 2 4 3");
    assert.equal(await selected(), "claude:demo", "the newest session is shown first");
    assert.deepEqual(await names(), ["q3-report.pdf", "server.js", "design-notes.md", "build.bat", "architecture-overview-with-a-very-long-name-for-the-wrapping-check.png"]);
    assert.deepEqual(await text(".frow .kind"), ["Generated", "Edited", "Created", "Created", "Edited"]);
    assert.match(await js(`document.querySelector('.kind-generated').title`), /Appeared in the session's folder while it was working/);
    assert.deepEqual(await text(".frow .f-dir"), ["out", "src", "docs", "scripts", path.join(dir, "shared")], "folders are relative to the session's folder when inside it");
    assert.match((await text(".d-strip .d-meta"))[0], /^Claude Code · started .* · last active /);
    assert.equal((await text(".d-path"))[0], api);
    assert.match(await text(".frow .c-size").then((t) => t.join("|")), /^248 KB\|17\.8 KB\|5\.20 KB\|310 B\|1\.40 MB$/);

    // Open is for documents; a script gets Show in folder as its first action.
    const rowButtons = (name) => js(`[...[...document.querySelectorAll('.frow')].find((r) => r.querySelector('.f-name').textContent === ${JSON.stringify(name)}).querySelectorAll('button')].map((b) => b.dataset.act + (b.classList.contains('primary') ? '*' : ''))`);
    assert.deepEqual(await rowButtons("q3-report.pdf"), ["open*", "reveal", "copy"]);
    assert.deepEqual(await rowButtons("build.bat"), ["reveal*", "copy"], "a .bat has no Open button");
    assert.deepEqual(await rowButtons("server.js"), ["reveal*", "copy"], "a .js has no Open button");
    assert.equal(await js(`[...document.querySelectorAll('.frow button')].every((b) => b.getAttribute('aria-label') && b.textContent.trim())`), true, "every button has text and a label");

    // Search by name and by folder, then each kind.
    await type("report");
    assert.deepEqual(await names(), ["q3-report.pdf"]);
    assert.equal(await counts(), "1 0 0 1");
    assert.equal((await sessionNames()).length, 1);
    await type("routes");
    assert.deepEqual(await sessionNames(), ["Add pagination to the orders API"]);
    assert.deepEqual(await names(), ["orders.ts"]);
    await type("zzz");
    assert.match(await js(`document.getElementById('stateBox').textContent`), /No files match\./);
    await type("");
    assert.equal(await js(`document.getElementById('stateBox').hidden`), true);
    const chip = async (kind) => { await js(`document.querySelector('.kind-chip[data-kind="${kind}"]').click()`); await wait(40); };
    await chip("generated");
    assert.deepEqual(await sessionNames(), ["api-gateway", "Add pagination to the orders API", hostile]);
    assert.deepEqual(await text(".srow .s-count"), ["1", "1", "1"]);
    assert.deepEqual(await names(), ["q3-report.pdf"]);
    assert.equal(await js(`document.querySelector('.kind-chip[data-kind="generated"]').getAttribute('aria-pressed')`), "true");
    await chip("edited");
    assert.deepEqual(await names(), ["server.js", "architecture-overview-with-a-very-long-name-for-the-wrapping-check.png"]);
    assert.deepEqual(await sessionNames(), ["api-gateway", "Add pagination to the orders API"]);
    await chip("created");
    assert.deepEqual(await names(), ["design-notes.md", "build.bat"]);
    assert.deepEqual(await sessionNames(), ["api-gateway"]);
    await chip("all");
    assert.equal((await names()).length, 5);

    // Deleted files stay out until asked for; they can still be copied but not opened.
    assert.equal((await names()).includes("old-draft.txt"), false);
    await js(`(() => { const c = document.getElementById('deleted'); c.checked = true; c.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await wait(40);
    assert.deepEqual((await names()).slice(-2), ["old-draft.txt", hostile], "deleted files follow when ticked");
    assert.deepEqual(await rowButtons("old-draft.txt"), ["copy"]);
    assert.equal(await js(`document.querySelectorAll('.frow.gone').length`), 2);
    assert.equal(await js(`!!document.querySelector('img') || !!window.injected`), false, "names render as text");
    assert.equal(await counts(), "11 4 4 3");
    await js(`(() => { const c = document.getElementById('deleted'); c.checked = false; c.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await wait(40);

    // The page sends ids, main resolves them and refuses anything else.
    await js(`document.querySelector('[data-act="open"]').click()`);
    await wait(100);
    const pdfId = await idOf("q3-report.pdf");
    assert.deepEqual(calls.at(-1), ["files:open", pdfId]);
    assert.match(pdfId, /^[0-9a-f]{16}$/);
    assert.deepEqual(opened.at(-1), ["open", path.join(api, "out", "q3-report.pdf")]);
    await js(`document.querySelector('.frow [data-act="reveal"]').click()`);
    await js(`document.querySelector('.frow [data-act="copy"]').click()`);
    await js(`document.querySelector('[data-act="folder"]').click()`);
    await wait(100);
    assert.deepEqual(opened.slice(-3), [["reveal", path.join(api, "out", "q3-report.pdf")], ["copy", path.join(api, "out", "q3-report.pdf")], ["open", api]]);
    assert.equal(await js(`document.getElementById('toast').textContent`), "Path copied.");
    assert.deepEqual(calls.slice(-3).map((c) => c[0]), ["files:reveal", "files:copy", "files:open-folder"]);
    assert.equal(calls.slice(-1)[0][1], "claude:demo", "a folder is asked for by session, not by path");
    const mark = opened.length;
    assert.deepEqual(await js(`filesApi.open(${JSON.stringify(await idOf("build.bat"))})`), { ok: false, error: "This type of file isn't opened from here. Use Show in folder." });
    assert.equal((await js(`filesApi.open(${JSON.stringify(path.join(api, "out", "q3-report.pdf"))})`)).ok, false, "a path is not an id");
    assert.equal((await js(`filesApi.reveal("0123456789abcdef")`)).ok, false);
    assert.equal((await js(`filesApi.openFolder("claude:nope")`)).ok, false);
    assert.equal((await js(`filesApi.copy({ path: ${JSON.stringify(api)} })`)).ok, false);
    assert.equal(opened.length, mark, "nothing was opened by those");
    fs.rmSync(path.join(api, "out", "q3-report.pdf"));
    assert.deepEqual(await js(`filesApi.open(${JSON.stringify(pdfId)})`), { ok: false, error: "The file is gone." }, "the file is checked again when it is opened");
    fs.writeFileSync(path.join(api, "out", "q3-report.pdf"), "demo");
    // Enter on a row does its first action.
    await js(`[...document.querySelectorAll('.frow')].find((r) => r.querySelector('.f-name').textContent === 'build.bat').focus()`);
    await js(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`);
    await wait(150);
    assert.deepEqual(opened.at(-1), ["reveal", path.join(api, "scripts", "build.bat")], "Enter on a script shows it in its folder");
    // A window other than this one gets nothing.
    const stranger = new BrowserWindow({ show: false, webPreferences: { preload: path.join(source, "files-preload.js"), contextIsolation: true, sandbox: true } });
    await stranger.loadURL("data:text/html,<p>x</p>");
    assert.equal(await stranger.webContents.executeJavaScript(`filesApi.get(7)`), null, "only the Session files window may ask");
    assert.equal(await stranger.webContents.executeJavaScript(`filesApi.open(${JSON.stringify(pdfId)})`), null);
    stranger.destroy();

    // A refresh keeps the selection, the search and the elements that did not change.
    await js(`document.querySelectorAll('.srow')[1].click()`);
    await wait(40);
    assert.equal(await selected(), "codex:019a3c2e-58f1-7d40-b6a2-3e9c4f1d8a05");
    await js(`document.querySelector('.srow').dataset.mark = "kept"; document.querySelector('.frow').dataset.mark = "kept"`);
    const readings = asked.length;
    await refresh();
    assert.equal(asked.length, readings + 1);
    assert.equal(await selected(), "codex:019a3c2e-58f1-7d40-b6a2-3e9c4f1d8a05", "the choice survives a refresh");
    assert.equal(await js(`document.querySelector('.srow').dataset.mark + document.querySelector('.frow').dataset.mark`), "keptkept", "an unchanged reading rebuilds nothing");
    await type("o");
    result = { ...scan, sessions: scan.sessions.map((s, i) => i ? s : { ...s, files: [...s.files, { ...s.files[0], path: path.join(api, "out", "extra.pdf"), name: "extra.pdf" }] }) };
    await refresh();
    assert.equal(await js(`document.getElementById('query').value`), "o", "the search text survives a refresh");
    assert.equal(await selected(), "codex:019a3c2e-58f1-7d40-b6a2-3e9c4f1d8a05");
    await type("");
    assert.deepEqual(await text(".srow .s-count"), ["6", "3", "1"], "a new file shows up");
    assert.match(await js(`document.getElementById('updated').textContent`), /^Updated /);

    // A session asked for from the panel.
    filesWindow.open("grok:demo");
    await wait(150);
    assert.equal(await selected(), "grok:demo", "opening again selects the session");
    assert.deepEqual(await names(), ["bundle.js"]);

    // Narrow width: one column and nothing sideways.
    win.setSize(700, 700);
    await wait(250);
    await js(`document.querySelectorAll('.srow')[0].click()`);
    await wait(100);
    const narrow = await js(`({
      columns: getComputedStyle(document.getElementById('main')).gridTemplateColumns.split(' ').length,
      page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      table: (() => { const w = document.querySelector('.table-wrap'); return w.scrollWidth - w.clientWidth; })(),
      list: (() => { const w = document.querySelector('.sessions'); return w.scrollWidth - w.clientWidth; })(),
      bar: (() => { const w = document.querySelector('.toolbar'); return w.scrollWidth - w.clientWidth; })(),
    })`);
    assert.deepEqual(narrow, { columns: 1, page: 0, table: 0, list: 0, bar: 0 }, "700 px has one column and no horizontal overflow");
    fs.writeFileSync(path.join(output, "files-narrow.png"), (await win.webContents.capturePage()).toPNG());
    win.setSize(980, 700);
    await wait(250);

    // The states: empty, another period, a failed reading, then coverage notes.
    result = { sessions: [], coverage: { skipped: 0, truncated: false } };
    await refresh();
    assert.match(await js(`document.getElementById('stateBox').textContent`), /No session has produced a file in the last 7 days\./);
    await js(`(() => { const d = document.getElementById('days'); d.value = '30'; d.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await wait(150);
    assert.deepEqual(asked.at(-1), { days: 30 });
    assert.match(await js(`document.getElementById('stateBox').textContent`), /last 30 days\./);
    result = new Error("boom");
    await refresh();
    assert.equal(await js(`document.getElementById('banner').hidden`), false);
    assert.equal(await js(`document.getElementById('bannerText').textContent`), "Couldn't read the session records.");
    result = { ...scan, coverage: { skipped: 2, truncated: true } };
    await js(`document.getElementById('retry').click()`);
    await wait(150);
    assert.equal(await js(`document.getElementById('banner').hidden`), true);
    assert.match(await js(`document.getElementById('coverage').textContent`), /^2 session records couldn't be read\. A session or a folder was too large/);
    result = scan;
    await refresh();
    assert.equal(await js(`document.getElementById('coverage').hidden`), true, "the note shows only when something was left out");
    assert.deepEqual(errors, []);

    // A session asked for before the window exists is the one shown first.
    win.destroy();
    await wait(100);
    await open("codex:019a3c2e-58f1-7d40-b6a2-3e9c4f1d8a05");
    assert.equal(await selected(), "codex:019a3c2e-58f1-7d40-b6a2-3e9c4f1d8a05");

    // Light and dark.
    win.setSize(980, 700);
    for (const theme of ["light", "dark"]) {
      nativeTheme.themeSource = theme;
      await wait(250);
      assert.equal(await js(`matchMedia('(prefers-color-scheme: dark)').matches`), theme === "dark");
      assert.equal(await js(`getComputedStyle(document.body).backgroundColor`), theme === "dark" ? "rgb(18, 18, 17)" : "rgb(244, 244, 242)");
      await js(`document.querySelectorAll('.srow')[0].click()`);
      await wait(100);
      // A hidden window paints only when asked.
      for (let n = 0; n < 5; n++) { win.webContents.invalidate(); await wait(60); }
      const shot = await win.webContents.capturePage();
      assert.ok(!shot.isEmpty(), `files ${theme} must render`);
      fs.writeFileSync(path.join(output, `files-${theme}.png`), shot.toPNG());
    }
    assert.deepEqual(errors, []);
    console.log("files: sessions and files, kinds, search, deleted files, Open limits, ids instead of paths, refresh, states, narrow width and both themes passed");
  } finally {
    nativeTheme.themeSource = "system";
    shell.openPath = stubs.openPath;
    shell.showItemInFolder = stubs.showItemInFolder;
    clipboard.writeText = stubs.writeText;
    for (const w of BrowserWindow.getAllWindows()) if (!before.has(w)) w.destroy();
    for (const channel of ["files:get", "files:open", "files:reveal", "files:copy", "files:open-folder"]) ipcMain.removeHandler(channel);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

app.whenReady().then(async () => {
  fs.mkdirSync(output, { recursive: true });
  ipcMain.on("usage://chips-resize", () => { resizes++; });
  // Like main: the window takes the width the panel asks for, within 320..860 px.
  ipcMain.on("usage://flyout-resize", (e, _h, w) => {
    flyoutResizes++;    if (fitWindow && e.sender === fitWindow.webContents) fitWindow.setSize(Math.max(320, Math.min(860, Math.round(w))), fitWindow.getSize()[1]);
  });
  ipcMain.on("usage://open-files", (_e, key) => { openedFiles.push(key); });
  ipcMain.handle("usage://resume-session", (_e, key) => { resumedKeys.push(key); return { ok: true, message: "Resumed for the test" }; });
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
    const unknown = only.filter((name) => !CHECKS.includes(name));
    if (unknown.length) throw new Error(`--only takes ${CHECKS.join(", ")}; unknown: ${unknown.join(", ")}`);
    if (wanted("flyout")) {
      await check("flyout");
      await checkFit();
    }
    if (wanted("chips")) await check("chips");
    if (wanted("net")) await checkNet();
    if (wanted("settings")) await checkSettings();
    if (wanted("insights")) await checkInsights();
    if (wanted("files")) await checkFiles();
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
