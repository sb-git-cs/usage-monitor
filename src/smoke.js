// `--smoke-report=<file>`: a packaged build checks itself (scripts/packaged-smoke.js runs this in CI on
// Windows, macOS and Linux). The app starts as usual in a throwaway profile, then writes what the
// check needs (crashed processes, Chromium's process types and GPU status, whether each window
// painted and, where the screen can be read, whether the screen shows what was painted, and on
// Windows a round trip through the helper) and quits.
// Nothing outside the throwaway profile is read or changed: the home, config and cache folders point
// into it, and main.js skips autostart, the folder menu and the updater.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const FLAG = "--smoke-report=";
// The app gives up and reports where it was stuck before scripts/packaged-smoke.js (120 s) kills it.
const DEADLINE_MS = 95000;
let report = null;
let current = "starting";
let finished = false;
const crashes = [];
const started = Date.now();

// Each step goes to stdout as it starts, so a CI log shows where a run stopped.
function stage(name) {
  current = name;
  try { process.stdout.write(`[smoke +${((Date.now() - started) / 1000).toFixed(1)} s] ${name}\n`); } catch { /* no stdout */ }
}

function within(promise, ms, what) {
  let timer;
  const late = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} did not finish within ${ms / 1000} s`)), ms); });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

function finish(result, code) {
  if (finished) return;
  finished = true;
  fs.writeFileSync(report, JSON.stringify(result, null, 2));
  stage(`report written, exiting with ${code}`);
  require("electron").app.exit(code);
}

// Call first in main.js, before anything reads a path. Returns the report file, or null.
function begin(argv = process.argv) {
  const arg = argv.find((a) => a.startsWith(FLAG));
  if (!arg) return null;
  report = path.resolve(arg.slice(FLAG.length));
  const { app } = require("electron");
  stage("begin");
  setTimeout(() => finish({ error: `the smoke run was still at "${current}" after ${DEADLINE_MS / 1000} s`, stage: current, crashes }, 1), DEADLINE_MS);
  app.once("ready", () => stage("ready"));
  let windowsCreated = 0;
  app.on("browser-window-created", () => stage(`window ${++windowsCreated} created`));
  app.once("before-quit", () => stage("quitting"));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "usage-monitor-smoke-"));
  for (const name of ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME"]) {
    process.env[name] = path.join(dir, name.toLowerCase());
    fs.mkdirSync(process.env[name], { recursive: true });
  }
  // Its own single-instance lock too, so an installed copy that is running is left alone.
  app.setPath("userData", path.join(dir, "electron"));
  app.on("child-process-gone", (_e, d) => crashes.push({ type: d.type, reason: d.reason, exitCode: d.exitCode }));
  app.on("render-process-gone", (_e, _w, d) => crashes.push({ type: "renderer", reason: d.reason, exitCode: d.exitCode }));
  return report;
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function painted(image) {
  const bmp = image.toBitmap();
  let n = 0;
  for (let i = 3; i < bmp.length; i += 4) if (bmp[i] > 0) n++;
  return n;
}

// The share of the window's opaque pixels that the screen shows (nearly) the same; null when the
// screen cannot be read (macOS without screen-recording permission gives a blank picture).
async function onScreen(win, frame) {
  const { desktopCapturer, screen } = require("electron");
  const b = win.getBounds();
  const display = screen.getDisplayMatching(b);
  const scale = display.scaleFactor;
  const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: Math.round(display.size.width * scale), height: Math.round(display.size.height * scale) } });
  const source = sources.find((s) => String(s.display_id) === String(display.id)) || sources[0];
  if (!source || source.thumbnail.isEmpty()) return null;
  const x = Math.round((b.x - display.bounds.x) * scale), y = Math.round((b.y - display.bounds.y) * scale);
  const { width, height } = frame.getSize();
  const crop = source.thumbnail.crop({ x, y, width: Math.round(b.width * scale), height: Math.round(b.height * scale) }).resize({ width, height });
  const a = frame.toBitmap(), c = crop.toBitmap();
  let opaque = 0, close = 0, lit = 0;
  for (let i = 0; i + 3 < a.length && i + 3 < c.length; i += 4) {
    if (c[i] || c[i + 1] || c[i + 2]) lit++;
    if (a[i + 3] !== 255) continue;
    opaque++;
    if (Math.abs(a[i] - c[i]) + Math.abs(a[i + 1] - c[i + 1]) + Math.abs(a[i + 2] - c[i + 2]) <= 24) close++;
  }
  if (!opaque || !lit) return null;
  return +(100 * close / opaque).toFixed(1);
}

async function helperCheck() {
  if (process.platform !== "win32") return null;
  const winhelper = require("./winhelper");
  try {
    const sample = JSON.parse(await winhelper.request("sys", "sample storage", { timeoutMs: 20000 }));
    const scan = JSON.parse(await winhelper.request("sess", JSON.stringify({ op: "scan", pids: [process.pid], names: [] }), { timeoutMs: 20000 }));
    const cred = JSON.parse(await winhelper.request("cred", JSON.stringify({ op: "read", target: "usage-monitor:smoke:missing" }), { timeoutMs: 20000 }));
    return { ok: Array.isArray(sample.disks) && Array.isArray(scan.procs) && scan.procs.length === 1 && cred.text === null, disks: sample.disks.length };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// A token report and a session-files scan of the (empty) throwaway profile, each in its utility process.
async function offloadCheck() {
  const { createOffload } = require("./offload");
  const reports = createOffload(path.join(__dirname, "tokens.js"), { name: "smoke tokens" });
  const files = createOffload(path.join(__dirname, "session-files.js"), { factory: "createSessionFiles", options: {}, name: "smoke files" });
  try {
    const t0 = Date.now();
    const report = await within(reports.call("scanTokens", { days: 1 }), 30000, "the token report's utility process");
    const scan = await within(files.call("scan", { days: 7, only: new Set(["none"]) }), 30000, "the session-files utility process");
    return { ok: !!(report && report.summary) && Array.isArray(scan.sessions), separate: reports.separate, ms: Date.now() - t0 };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    reports.stop();
    files.stop();
  }
}

// Called once the app is ready and its windows exist; writes the report and quits, whatever happens.
function run(settleMs = 12000) {
  stage(`windows created, settling for ${settleMs / 1000} s`);
  return collect(settleMs).catch((err) => finish({ error: String(err && err.stack || err), stage: current, crashes }, 1));
}

async function collect(settleMs) {
  const { app, BrowserWindow } = require("electron");
  await wait(settleMs);
  const windows = [];
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    const entry = { page: win.webContents.getURL().split("/").pop(), visible: win.isVisible() };
    try {
      stage(`capturing ${entry.page}${entry.visible ? "" : " (hidden)"}`);
      const frame = await within(win.webContents.capturePage(), 10000, `capturing ${entry.page}`);
      entry.painted = painted(frame);
      if (entry.visible) {
        stage(`reading the screen under ${entry.page}`);
        entry.onScreenPct = await within(onScreen(win, frame), 15000, "reading the screen").catch((err) => {
          entry.onScreenError = err.message;
          return null;
        });
      }
    } catch (err) {
      entry.error = err.message;
    }
    windows.push(entry);
  }
  stage("reading process metrics");
  const result = {
    platform: process.platform, arch: process.arch, electron: process.versions.electron, packaged: app.isPackaged,
    processes: app.getAppMetrics().map((m) => ({ type: m.type, service: m.serviceName || null })),
    gpu: app.getGPUFeatureStatus(), windows,
  };
  stage("helper round trip");
  result.helper = await helperCheck();
  stage("utility process scans");
  result.offload = await offloadCheck();
  result.crashes = crashes;
  finish(result, 0);
}

module.exports = { begin, run, FLAG };
