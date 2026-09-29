// Keeps Usage Monitor current without asking. How depends on how it was installed:
//   git        a clone of the repo: fast-forward to GitHub and restart. When dependencies
//              changed, scripts/post-update.js reinstalls them after the app has exited,
//              because npm ci deletes the Electron binary the app is running from.
//   installer  the Windows installer or the Linux AppImage: electron-updater downloads the
//              latest GitHub release, installs it silently and starts the new version.
//   manual     portable exe, zip, tar.gz and the unsigned macOS app cannot replace
//              themselves: the latest release is checked and a notification links to it.
//   source     a copy without git or an installer: nothing to update from.
// Automatic checks run shortly after launch, when the computer wakes or unlocks, and every
// six hours, and retry with backoff while offline. "Install updates automatically" turns
// them off; "Check for updates now" always works.
const { execFile, spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const { app, dialog, shell, powerMonitor, Notification } = require("electron");
const { getJson } = require("./http");
const { cliPath } = require("./paths");
const log = require("./log");

const REPO = "sb-git-cs/usage-monitor";
const RELEASES_URL = `https://github.com/${REPO}/releases/latest`;
const LATEST_API = `https://api.github.com/repos/${REPO}/releases/latest`;
const RELEASES_API = `https://api.github.com/repos/${REPO}/releases?per_page=15`;
const TIMING = {
  first: 8000, // after launch, once the network is usually up
  retry: [60_000, 5 * 60_000, 15 * 60_000], // offline: back off, then wait for the next period
  period: 6 * 60 * 60_000,
  wake: 30_000, // after resume or unlock, so Wi-Fi can reconnect
  wakeGap: 30 * 60_000, // wakes closer together than this don't check again
  idle: 60_000, // how often a pending restart looks for a quiet moment
  restart: 3000, // lets the "updating" notification show first
  renotify: 3 * 24 * 60 * 60_000, // manual formats: remind about the same version after this
};

let ctx = null;
let state = null;
let checking = null;
let failures = 0;
let lastAttempt = 0;
let updater = null;
const timers = {};

function repoRoot() {
  return path.resolve(__dirname, "..");
}

function isGitCheckout() {
  try {
    return fs.existsSync(path.join(repoRoot(), ".git"));
  } catch {
    return false;
  }
}

function exists(file) {
  try {
    return fs.existsSync(file);
  } catch {
    return false;
  }
}

function installKind({ platform = process.platform, env = process.env, execPath = process.execPath, resourcesPath = process.resourcesPath } = {}) {
  if (!app.isPackaged) return isGitCheckout() ? "git" : "source";
  const updateConfig = !!resourcesPath && exists(path.join(resourcesPath, "app-update.yml"));
  if (platform === "win32") {
    if (env.PORTABLE_EXECUTABLE_FILE) return "manual";
    // The NSIS installer leaves its uninstaller next to the app; the zip does not.
    const installed = exists(path.join(path.dirname(execPath), "Uninstall Usage Monitor.exe"));
    return installed && updateConfig ? "installer" : "manual";
  }
  if (platform === "linux") return env.APPIMAGE && updateConfig ? "installer" : "manual";
  return "manual";
}

// ---- versions ------------------------------------------------------------------

function versionParts(v) {
  const [core, ...pre] = String(v || "").trim().replace(/^v/i, "").split("-");
  return {
    nums: core.split(".").map((n) => (Number.isFinite(Number(n)) ? Number(n) : 0)),
    pre: pre.join("-").split(".").filter(Boolean),
  };
}

// Semantic-version order: 1.3.0-beta.2 < 1.3.0-beta.10 < 1.3.0.
function compareVersions(a, b) {
  const x = versionParts(a);
  const y = versionParts(b);
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length, 3); i++) {
    const d = (x.nums[i] || 0) - (y.nums[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  if (!x.pre.length || !y.pre.length) return x.pre.length === y.pre.length ? 0 : x.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    if (x.pre[i] === undefined) return -1;
    if (y.pre[i] === undefined) return 1;
    const nx = /^\d+$/.test(x.pre[i]);
    const ny = /^\d+$/.test(y.pre[i]);
    if (nx && ny && Number(x.pre[i]) !== Number(y.pre[i])) return Number(x.pre[i]) > Number(y.pre[i]) ? 1 : -1;
    if (nx !== ny) return nx ? -1 : 1;
    if (x.pre[i] !== y.pre[i]) return x.pre[i] > y.pre[i] ? 1 : -1;
  }
  return 0;
}

// ---- git checkout --------------------------------------------------------------

function git(args, timeout = 45000) {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      // Never wait for a credential prompt nobody can see.
      { cwd: repoRoot(), windowsHide: true, timeout, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
      (err, stdout, stderr) => {
        if (err) {
          const e = new Error((stderr && String(stderr).trim()) || err.message);
          e.code = err.code;
          reject(e);
          return;
        }
        resolve(String(stdout || "").trim());
      }
    );
  });
}

function skip(message) {
  return Object.assign(new Error(message), { skip: true });
}

async function gitCheck() {
  try {
    await git(["symbolic-ref", "-q", "--short", "HEAD"]);
  } catch {
    return { available: false, reason: "This copy is on a detached commit, so it is not updated automatically." };
  }
  let ref = "";
  try {
    ref = await git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
  } catch {
    ref = "";
  }
  if (!ref) ref = "origin/main";
  const remote = ref.includes("/") ? ref.slice(0, ref.indexOf("/")) : "origin";
  await git(["fetch", "--quiet", remote], 60000);
  const local = await git(["rev-parse", "HEAD"]);
  const target = await git(["rev-parse", ref]);
  if (!target || local === target) return { available: false };
  const behind = Number(await git(["rev-list", "--count", `${local}..${target}`]));
  if (!behind) return { available: false };
  try {
    await git(["merge-base", "--is-ancestor", local, target]);
  } catch (err) {
    if (err.code === 1) return { available: false, reason: "This copy has commits that are not on GitHub, so it is not updated automatically." };
    throw err;
  }
  let summary = [];
  try {
    summary = (await git(["log", "--oneline", "-n", "8", `${local}..${target}`])).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  } catch {
    summary = [];
  }
  return { available: true, local, target, ref, behind, summary, version: target.slice(0, 7) };
}

async function gitApply(info) {
  if (await git(["status", "--porcelain", "--untracked-files=no"])) {
    throw skip("This copy has uncommitted changes, so the update was skipped.");
  }
  const changed = await git(["diff", "--name-only", info.local, info.target, "--", "package.json", "package-lock.json"]);
  const depsChanged = !!changed.trim();
  const node = depsChanged ? cliPath("node") : null;
  if (depsChanged && !node) throw skip("This update changes dependencies and needs Node.js on PATH to install them.");
  // Merge the exact commit that was checked, so a clone without an upstream still updates.
  await git(["merge", "--ff-only", info.target], 60000);
  return { depsChanged, node };
}

function childEnv() {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

function restartAfterGit({ depsChanged, node }) {
  if (depsChanged) {
    // Reinstalls dependencies once this process has exited, then starts the app again.
    const child = spawn(node, [path.join(repoRoot(), "scripts", "post-update.js"), "--pid", String(process.pid)], {
      cwd: repoRoot(),
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: childEnv(),
    });
    child.on("error", (err) => log.error("post-update start failed", err.message));
    child.unref();
  } else {
    app.relaunch();
  }
  quit();
}

// ---- installer (electron-updater) ------------------------------------------------

function electronUpdater() {
  if (updater) return updater;
  const { autoUpdater } = require("electron-updater");
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = false;
  autoUpdater.logger = {
    info: (m) => log.info(`updater: ${m}`),
    warn: (m) => log.warn(`updater: ${m}`),
    error: (m) => log.error(`updater: ${m}`),
    debug() {},
  };
  autoUpdater.on("error", (err) => log.warn("updater error", err && err.message));
  autoUpdater.on("download-progress", (p) => {
    const progress = Math.max(0, Math.min(100, Math.round(Number(p && p.percent) || 0)));
    if (progress !== state.progress) setState({ status: "downloading", progress });
  });
  autoUpdater.on("update-downloaded", (info) => {
    setState({ status: "ready", latest: (info && info.version) || state.latest, progress: 100 });
    installWhenIdle();
  });
  updater = autoUpdater;
  return updater;
}

function installWhenIdle() {
  clearTimeout(timers.install);
  if (state.status === "installing") return;
  if (!canRestart()) {
    timers.install = setTimeout(installWhenIdle, TIMING.idle);
    return;
  }
  setState({ status: "installing" });
  notify(`Updating to ${state.latest}`, "Usage Monitor restarts in a few seconds.");
  timers.install = setTimeout(() => {
    if (ctx && ctx.beforeRestart) ctx.beforeRestart();
    updater.quitAndInstall(true, true);
  }, TIMING.restart);
}

// ---- manual formats -------------------------------------------------------------

function downloadUrl(release, { platform = process.platform, arch = process.arch, env = process.env } = {}) {
  const assets = Array.isArray(release && release.assets) ? release.assets : [];
  const pick = (re) => {
    const a = assets.find((x) => x && re.test(String(x.name || "")));
    return a && a.browser_download_url;
  };
  let url;
  if (platform === "win32") url = env.PORTABLE_EXECUTABLE_FILE ? pick(/portable.*\.exe$/i) : pick(/-win\.zip$/i);
  else if (platform === "darwin") url = pick(new RegExp(`-${arch}\\.dmg$`, "i")) || pick(/\.dmg$/i);
  else url = env.APPIMAGE ? pick(/\.AppImage$/i) : pick(/\.tar\.gz$/i);
  const safe = (u) => typeof u === "string" && u.startsWith("https://github.com/");
  if (safe(url)) return url;
  return safe(release && release.html_url) ? release.html_url : RELEASES_URL;
}

function beta() {
  const cfg = ctx && ctx.getConfig();
  return !!cfg && cfg.update_channel === "beta";
}

// Stable reads GitHub's "latest release"; beta also considers pre-releases.
async function latestRelease() {
  const headers = { "User-Agent": `usage-monitor/${app.getVersion()}`, Accept: "application/vnd.github+json" };
  let release;
  if (beta()) {
    const res = await getJson(RELEASES_API, headers);
    if (res.status !== 200 || !Array.isArray(res.json)) throw new Error(`GitHub answered HTTP ${res.status}.`);
    release = res.json
      .filter((r) => r && !r.draft && typeof r.tag_name === "string")
      .sort((a, b) => compareVersions(b.tag_name, a.tag_name))[0];
    if (!release) return { available: false };
  } else {
    const res = await getJson(LATEST_API, headers);
    if (res.status !== 200 || !res.json || typeof res.json.tag_name !== "string") throw new Error(`GitHub answered HTTP ${res.status}.`);
    release = res.json;
  }
  const version = release.tag_name.replace(/^v/i, "");
  if (compareVersions(version, app.getVersion()) <= 0) return { available: false };
  return { available: true, version, url: downloadUrl(release) };
}

function manualHint() {
  if (process.env.PORTABLE_EXECUTABLE_FILE) return "The portable version can't replace itself while it runs. Download the new one and use it instead of this file.";
  if (process.platform === "darwin") return "macOS only lets signed apps update in place. Open the download and drag Usage Monitor to Applications.";
  return "This copy can't replace itself. Download the new version and replace this copy with it.";
}

function maybeNotifyManual() {
  const cfg = ctx.getConfig();
  const seen = cfg.update_notified_version === state.latest && Date.now() - Number(cfg.update_notified_at || 0) < TIMING.renotify;
  if (seen) return;
  cfg.update_notified_version = state.latest;
  cfg.update_notified_at = Date.now();
  if (ctx.saveConfig) ctx.saveConfig();
  notify(`Usage Monitor ${state.latest} is available`, "Click to download it.", openDownload);
}

// ---- flows ----------------------------------------------------------------------

async function gitFlow(interactive) {
  const info = await gitCheck();
  setState({ checked_at: Date.now() });
  if (!info.available) {
    setState({ status: info.reason ? "skipped" : "up-to-date", message: info.reason || null });
    if (interactive) await box("info", info.reason ? "Usage Monitor was not updated." : "You're on the latest version.", info.reason);
    return info;
  }
  setState({ status: "ready", latest: info.version });
  if (interactive) {
    const lines = info.summary.length ? `\n\n${info.summary.join("\n")}` : "";
    await box("info", "Installing the update. Usage Monitor restarts when it is done.", `${info.behind} new change${info.behind === 1 ? "" : "s"}:${lines}`);
  } else {
    await whenIdle();
  }
  setState({ status: "installing" });
  const result = await gitApply(info);
  log.info(`updated ${info.local.slice(0, 7)} -> ${info.target.slice(0, 7)}${result.depsChanged ? ", reinstalling dependencies after exit" : ""}`);
  notify("Usage Monitor updated", `Restarting with ${info.behind} new change${info.behind === 1 ? "" : "s"}.`);
  timers.restart = setTimeout(() => restartAfterGit(result), TIMING.restart);
  return { ...info, updated: true };
}

async function installerFlow(interactive) {
  const u = electronUpdater();
  u.allowPrerelease = beta();
  const result = await u.checkForUpdates();
  setState({ checked_at: Date.now() });
  if (!result || !result.isUpdateAvailable) {
    if (state.status !== "ready" && state.status !== "installing") setState({ status: "up-to-date" });
    if (interactive) await box("info", "You're on the latest version.", `Version ${state.current}`);
    return { available: false };
  }
  const version = result.updateInfo && result.updateInfo.version;
  if (state.status !== "ready" && state.status !== "installing") setState({ status: "downloading", latest: version, progress: 0 });
  if (interactive) box("info", `Downloading Usage Monitor ${version}.`, "It installs and restarts on its own when the download finishes.");
  if (result.downloadPromise) await result.downloadPromise;
  return { available: true, version };
}

async function manualFlow(interactive) {
  const info = await latestRelease();
  setState({ checked_at: Date.now() });
  if (!info.available) {
    setState({ status: "up-to-date" });
    if (interactive) await box("info", "You're on the latest version.", `Version ${state.current}`);
    return info;
  }
  setState({ status: "available", latest: info.version, url: info.url, message: manualHint() });
  if (interactive) {
    const { response } = await box("question", `Usage Monitor ${info.version} is available.`, manualHint(), ["Download", "Later"]);
    if (response === 0) openDownload();
  } else {
    maybeNotifyManual();
  }
  return info;
}

async function doCheck(interactive) {
  if (state.kind === "source") {
    if (interactive) await box("info", "This copy can't update itself.", `It was not installed from Git or an installer. Download the latest version from ${RELEASES_URL}.`);
    return { available: false, skipped: true };
  }
  if (!interactive && !autoEnabled()) return { available: false, skipped: true };
  if (["ready", "installing"].includes(state.status)) {
    if (interactive) {
      // The user asked, so a downloaded installer update goes in now rather than at the next quiet moment.
      if (state.kind === "installer" && state.status === "ready") installWhenIdle();
      box("info", `Usage Monitor ${state.latest || ""} is being installed.`.replace("  ", " "), "It restarts on its own in a moment.");
    }
    return { available: true };
  }
  setState({ status: "checking", message: null });
  try {
    if (state.kind === "git") return await gitFlow(interactive);
    if (state.kind === "installer") return await installerFlow(interactive);
    return await manualFlow(interactive);
  } catch (err) {
    const message = String((err && err.message) || err);
    if (err && err.skip) {
      log.info("update skipped:", message);
      setState({ status: "skipped", message });
      if (interactive) await box("info", "Usage Monitor was not updated.", message);
      return { available: false, skipped: true, reason: message };
    }
    log.warn("update check failed:", message);
    setState({ status: "error", message });
    if (interactive) await box("error", "Could not check for updates.", message);
    return { available: false, error: err };
  }
}

function runCheck(interactive) {
  if (checking) {
    if (interactive) box("info", "Usage Monitor is already checking for updates.", "The flyout shows how it is going.");
    return checking;
  }
  checking = doCheck(!!interactive).finally(() => { checking = null; });
  return checking;
}

async function automatic() {
  if (!ctx || state.kind === "source" || !autoEnabled()) return;
  lastAttempt = Date.now();
  const result = await runCheck(false);
  if (result && result.error) {
    if (failures < TIMING.retry.length) schedule(TIMING.retry[failures++]);
  } else {
    failures = 0;
  }
}

function schedule(ms) {
  clearTimeout(timers.next);
  timers.next = setTimeout(automatic, ms);
}

function onWake() {
  if (Date.now() - lastAttempt < TIMING.wakeGap) return;
  failures = 0;
  schedule(TIMING.wake);
}

// ---- helpers --------------------------------------------------------------------

function autoEnabled() {
  const cfg = ctx && ctx.getConfig();
  return !!cfg && cfg.auto_update !== false;
}

function canRestart() {
  return !ctx || !ctx.canRestart || ctx.canRestart();
}

function whenIdle() {
  return new Promise((resolve) => {
    const tryNow = () => {
      if (canRestart()) resolve();
      else timers.idle = setTimeout(tryNow, TIMING.idle);
    };
    tryNow();
  });
}

function quit() {
  if (ctx && ctx.beforeRestart) ctx.beforeRestart();
  // app.quit (not app.exit) so config and network records are saved on the way out.
  app.quit();
}

function notify(title, body, onClick) {
  if (ctx && ctx.isQuiet && ctx.isQuiet()) {
    log.info(`quiet hours, not shown: ${title}`);
    return;
  }
  try {
    if (!Notification.isSupported()) return;
    const n = new Notification({ title, body, silent: true });
    if (onClick) n.on("click", onClick);
    n.show();
  } catch (err) {
    log.warn("update notification failed", err.message);
  }
}

function box(type, message, detail, buttons = ["OK"]) {
  const parent = ctx && ctx.dialogParent ? ctx.dialogParent() : null;
  const opts = { type, title: "Usage Monitor", message, detail: detail || undefined, buttons, defaultId: 0, cancelId: buttons.length - 1, noLink: true };
  return parent && !parent.isDestroyed() ? dialog.showMessageBox(parent, opts) : dialog.showMessageBox(opts);
}

function publicState() {
  return { ...state, auto: autoEnabled() };
}

function setState(patch) {
  state = { ...state, ...patch };
  if (ctx && ctx.onState) {
    try {
      ctx.onState(publicState());
    } catch (err) {
      log.warn("update state broadcast failed", err.message);
    }
  }
}

// ---- public API -----------------------------------------------------------------

// ctx: getConfig(), saveConfig(), onState(state), canRestart(), beforeRestart(), dialogParent()
function start(context) {
  ctx = context;
  state = { kind: context.kind || installKind(), status: "idle", current: app.getVersion(), build: null, latest: null, progress: null, url: null, message: null, checked_at: null };
  log.info(`Usage Monitor ${state.current} started (${state.kind} install, ${process.platform} ${process.arch})`);
  if (state.kind === "git") git(["rev-parse", "--short", "HEAD"]).then((build) => setState({ build })).catch(() => {});
  setState({ status: autoEnabled() || state.kind === "source" ? "idle" : "off" });
  schedule(TIMING.first);
  timers.period = setInterval(automatic, TIMING.period);
  try {
    powerMonitor.on("resume", onWake);
    powerMonitor.on("unlock-screen", onWake);
  } catch {
    /* no power events on this system */
  }
}

function settingChanged() {
  if (!ctx) return;
  if (autoEnabled()) {
    failures = 0;
    if (["off", "idle"].includes(state.status)) setState({ status: "idle" });
    schedule(TIMING.first);
  } else {
    clearTimeout(timers.next);
    if (["idle", "up-to-date", "error", "skipped"].includes(state.status)) setState({ status: "off" });
  }
}

function openDownload() {
  shell.openExternal((state && state.url) || RELEASES_URL).catch((err) => log.warn("open download failed", err.message));
}

function checkNow() {
  return runCheck(true);
}

function action() {
  if (state && state.status === "available") openDownload();
  else if (state && !["checking", "downloading", "ready", "installing"].includes(state.status)) checkNow();
}

function getState() {
  return state ? publicState() : null;
}

function stop() {
  for (const t of Object.values(timers)) {
    clearTimeout(t);
    clearInterval(t);
  }
}

module.exports = { start, stop, checkNow, action, settingChanged, openDownload, getState, installKind, compareVersions, downloadUrl, isGitCheckout, TIMING };
