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
    await new Promise((resolve) => setTimeout(resolve, 200));
    const result = await win.webContents.executeJavaScript(`({
      text: document.body.textContent,
      injected: !!window.injected || !!document.querySelector('img'),
      widths: [...document.querySelectorAll('.fill')].map(el => el.style.width),
      reds: document.querySelectorAll('.red').length,
      cards: document.querySelectorAll('.provider').length,
      chips: document.querySelectorAll('.pct-icon').length,
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
      assert.equal(result.cards, 4);
      assert.deepEqual(result.widths, ["25%", "90%", "80%", "0%"]);
      assert.equal(result.reds, 2);
    } else {
      assert.equal(result.chips, 4);
      assert.match(result.text, /25\/100/);
      assert.doesNotMatch(result.text, /90\/100/);
      assert.equal(result.reds, 1);
    }
    const deadline = Date.now() + 5000;
    while (!renderedFrame && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(renderedFrame && !renderedFrame.isEmpty(), `${file} must produce a rendered frame`);
    fs.writeFileSync(path.join(output, `${file}.png`), renderedFrame.toPNG());
    console.log(`${file}: rendering, CSP, escaping, warning colors and preload passed`);
  } finally { win.destroy(); }
}

app.whenReady().then(async () => {
  fs.mkdirSync(output, { recursive: true });
  ipcMain.handle("usage://get-interval", () => 5);
  ipcMain.handle("usage://get-chips-docked", () => true);
  ipcMain.handle("usage://get-flyout-state", () => ({ docked: false, pinned: false }));
  try {
    await check("flyout");
    await check("chips");
    app.exit(0);
  } catch (err) {
    console.error(err);
    app.exit(1);
  }
});
