const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { execFileSync } = require("node:child_process");
const { load } = require("./helpers");

const SOURCE = path.resolve(__dirname, "../src/updater.js");
const quiet = { info() {}, warn() {}, error() {} };
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

function electronMock({ packaged = false, version = "1.1.0", shown = [], quits = [] } = {}) {
  const power = new EventEmitter();
  class Notification extends EventEmitter {
    static isSupported() { return true; }
    constructor(options) { super(); this.options = options; }
    show() { shown.push(this); }
  }
  return {
    power,
    electron: {
      app: { isPackaged: packaged, getVersion: () => version, quit: () => quits.push("quit"), relaunch: () => quits.push("relaunch") },
      dialog: { showMessageBox: async () => ({ response: 1 }) },
      shell: { openExternal: async (url) => shown.push({ opened: url }) },
      powerMonitor: power,
      Notification,
    },
  };
}

function loadUpdater(file, mocks) {
  const updater = load(file, { "./log": quiet, "./http": {}, "./paths": { cliPath: () => null }, ...mocks }, ["gitCheck", "gitApply", "automatic", "timers"]);
  Object.assign(updater.TIMING, { first: 60_000, retry: [5, 5, 5], period: 60_000, wake: 5, wakeGap: 0, idle: 5, restart: 0, renotify: 60_000 });
  return updater;
}

// ---- git checkouts, against real repositories -------------------------------------

let hasGit = true;
try {
  execFileSync("git", ["--version"], { stdio: "ignore" });
} catch {
  hasGit = false;
}

function sh(cwd, ...args) {
  return execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

// origin (bare) <- dev pushes commits; app is the clone that updates itself.
function repos(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "um-update-"));
  t.after(() => {
    try {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      /* Windows can hold git's read-only pack files briefly; the OS cleans temp later */
    }
  });
  const origin = path.join(root, "origin.git");
  const dev = path.join(root, "dev");
  const appDir = path.join(root, "app");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  execFileSync("git", ["clone", "-q", origin, dev], { stdio: "ignore" });
  sh(dev, "symbolic-ref", "HEAD", "refs/heads/main");
  fs.writeFileSync(path.join(dev, "README.md"), "one\n");
  fs.writeFileSync(path.join(dev, "package-lock.json"), "{}\n");
  sh(dev, "add", ".");
  sh(dev, "commit", "-q", "-m", "first");
  sh(dev, "push", "-q", "-u", "origin", "main");
  execFileSync("git", ["clone", "-q", origin, appDir], { stdio: "ignore" });
  // The module under test runs from the clone's src/, like a real checkout (untracked there).
  fs.mkdirSync(path.join(appDir, "src"));
  fs.copyFileSync(SOURCE, path.join(appDir, "src", "updater.js"));
  const commit = (file, text, message) => {
    fs.writeFileSync(path.join(dev, file), text);
    sh(dev, "commit", "-q", "-am", message);
    sh(dev, "push", "-q", "origin", "main");
  };
  const updater = (cliNode = "/usr/bin/node") => loadUpdater(path.join(appDir, "src", "updater.js"), {
    electron: electronMock().electron,
    "./paths": { cliPath: () => cliNode },
  });
  return { dev, appDir, commit, updater, head: () => sh(appDir, "rev-parse", "HEAD"), remoteHead: () => sh(dev, "rev-parse", "HEAD") };
}

test("git: a checkout behind GitHub fast-forwards without reinstalling unchanged dependencies", { skip: !hasGit }, async (t) => {
  const r = repos(t);
  r.commit("README.md", "two\n", "second");
  const updater = r.updater();
  const info = await updater.gitCheck();
  assert.equal(info.available, true);
  assert.equal(info.behind, 1);
  assert.match(info.summary[0], /second/);
  const result = await updater.gitApply(info);
  assert.equal(result.depsChanged, false);
  assert.equal(r.head(), r.remoteHead());
  assert.equal((await updater.gitCheck()).available, false, "up to date afterwards");
});

test("git: dependency changes are flagged for reinstall after exit, and need Node.js on PATH", { skip: !hasGit }, async (t) => {
  const r = repos(t);
  r.commit("package-lock.json", '{"v":2}\n', "bump deps");
  const before = r.head();
  const noNode = r.updater(null);
  const info = await noNode.gitCheck();
  await assert.rejects(noNode.gitApply(info), (err) => err.skip && /Node\.js/.test(err.message));
  assert.equal(r.head(), before, "nothing merged when dependencies can't be installed");
  const result = await r.updater("/usr/bin/node").gitApply(info);
  assert.equal(result.depsChanged, true);
  assert.equal(result.node, "/usr/bin/node");
  assert.equal(r.head(), r.remoteHead());
});

test("git: a clone without an upstream branch still updates from origin/main", { skip: !hasGit }, async (t) => {
  const r = repos(t);
  sh(r.appDir, "branch", "--unset-upstream");
  r.commit("README.md", "two\n", "second");
  const updater = r.updater();
  const info = await updater.gitCheck();
  assert.equal(info.ref, "origin/main");
  await updater.gitApply(info);
  assert.equal(r.head(), r.remoteHead());
});

test("git: uncommitted changes, local commits and detached checkouts are left alone", { skip: !hasGit }, async (t) => {
  const r = repos(t);
  r.commit("README.md", "two\n", "second");
  const updater = r.updater();

  fs.writeFileSync(path.join(r.appDir, "README.md"), "edited\n");
  const before = r.head();
  await assert.rejects(updater.gitApply(await updater.gitCheck()), (err) => err.skip && /uncommitted/.test(err.message));
  assert.equal(r.head(), before);
  sh(r.appDir, "checkout", "-q", "--", "README.md");

  fs.writeFileSync(path.join(r.appDir, "local.txt"), "mine\n");
  sh(r.appDir, "add", "local.txt");
  sh(r.appDir, "commit", "-q", "-m", "local work");
  const diverged = await updater.gitCheck();
  assert.equal(diverged.available, false);
  assert.match(diverged.reason, /not on GitHub/);

  sh(r.appDir, "checkout", "-q", "--detach");
  assert.match((await updater.gitCheck()).reason, /detached/);
});

test("git: a copy that is ahead of GitHub reports no update", { skip: !hasGit }, async (t) => {
  const r = repos(t);
  fs.writeFileSync(path.join(r.appDir, "ahead.txt"), "x\n");
  sh(r.appDir, "add", "ahead.txt");
  sh(r.appDir, "commit", "-q", "-m", "ahead");
  const info = await r.updater().gitCheck();
  assert.equal(info.available, false);
  assert.equal(info.reason, undefined);
});

// ---- scheduling and flows ---------------------------------------------------------

function gitProcess({ behind = 1, deps = "" } = {}) {
  const commands = [];
  return {
    commands,
    child_process: {
      execFile: (cmd, args, opts, cb) => {
        commands.push({ cmd, args, env: opts.env });
        const map = { "symbolic-ref": "main", "rev-parse": args.includes("@{u}") ? "origin/main" : args.includes("HEAD") ? (args.includes("--short") ? "aaaaaaa" : "a".repeat(40)) : "b".repeat(40),
          "rev-list": String(behind), log: "bbbbbbb new", status: "", diff: deps };
        setImmediate(() => cb(null, map[args[0]] || "", ""));
      },
      spawn: (cmd, args) => {
        commands.push({ cmd, args, spawned: true });
        return Object.assign(new EventEmitter(), { unref() {} });
      },
    },
  };
}

function context(overrides = {}) {
  const cfg = { auto_update: true, ...overrides.cfg };
  const states = [];
  return { cfg, states, ctx: { getConfig: () => cfg, saveConfig() {}, onState: (s) => states.push(s), canRestart: () => true, beforeRestart() {}, dialogParent: () => null, ...overrides.ctx } };
}

test("automatic git update merges, notifies and relaunches through app.quit so shutdown runs", async (t) => {
  const shown = [];
  const quits = [];
  const git = gitProcess();
  const updater = loadUpdater("src/updater.js", { electron: electronMock({ shown, quits }).electron, child_process: git.child_process });
  const { ctx, states } = context();
  updater.start({ ...ctx, kind: "git" });
  t.after(() => updater.stop());
  await updater.automatic();
  await tick(10);
  const merge = git.commands.find((c) => c.args[0] === "merge");
  assert.deepEqual(merge.args, ["merge", "--ff-only", "b".repeat(40)]);
  assert.equal(merge.env.GIT_TERMINAL_PROMPT, "0", "git never waits for a hidden credential prompt");
  assert.ok(!git.commands.some((c) => c.args[0] === "pull"), "merges the checked commit instead of git pull");
  assert.ok(!git.commands.some((c) => c.args[0] === "ci" || c.cmd.includes("npm")), "npm ci never runs inside the app");
  assert.deepEqual(quits, ["relaunch", "quit"]);
  assert.ok(shown.some((n) => n.options && /updated/i.test(n.options.title)));
  assert.ok(states.some((s) => s.status === "installing"));
});

test("git update with dependency changes hands off to post-update.js and quits without relaunching", async (t) => {
  const quits = [];
  const git = gitProcess({ deps: "package-lock.json" });
  const updater = loadUpdater("src/updater.js", {
    electron: electronMock({ quits }).electron,
    child_process: git.child_process,
    "./paths": { cliPath: (name) => (name === "node" ? "/usr/bin/node" : null) },
  });
  const { ctx } = context();
  updater.start({ ...ctx, kind: "git" });
  t.after(() => updater.stop());
  await updater.automatic();
  await tick(10);
  const spawned = git.commands.find((c) => c.spawned);
  assert.equal(spawned.cmd, "/usr/bin/node");
  assert.match(spawned.args[0], /post-update\.js$/);
  assert.deepEqual(spawned.args.slice(1), ["--pid", String(process.pid)]);
  assert.deepEqual(quits, ["quit"]);
});

test("a pending restart waits until nobody is using the app", async (t) => {
  const quits = [];
  let busy = true;
  const git = gitProcess();
  const updater = loadUpdater("src/updater.js", { electron: electronMock({ quits }).electron, child_process: git.child_process });
  const { ctx, states } = context({ ctx: { canRestart: () => !busy } });
  updater.start({ ...ctx, kind: "git" });
  t.after(() => updater.stop());
  const run = updater.automatic();
  await tick(30);
  assert.ok(!git.commands.some((c) => c.args[0] === "merge"), "nothing changes on disk while the user is busy");
  assert.equal(states.at(-1).status, "ready");
  busy = false;
  await run;
  await tick(10);
  assert.deepEqual(quits, ["relaunch", "quit"]);
});

test("installer builds download with electron-updater and install silently, then restart", async (t) => {
  const autoUpdater = new EventEmitter();
  const installs = [];
  autoUpdater.checkForUpdates = async () => {
    setImmediate(() => autoUpdater.emit("update-downloaded", { version: "1.2.0" }));
    return { isUpdateAvailable: true, updateInfo: { version: "1.2.0" }, downloadPromise: Promise.resolve() };
  };
  autoUpdater.quitAndInstall = (...args) => installs.push(args);
  let restarting = false;
  const updater = loadUpdater("src/updater.js", { electron: electronMock({ packaged: true }).electron, "electron-updater": { autoUpdater } });
  const { ctx, states } = context({ ctx: { beforeRestart: () => { restarting = true; } } });
  updater.start({ ...ctx, kind: "installer" });
  t.after(() => updater.stop());
  await updater.automatic();
  await tick(20);
  assert.equal(autoUpdater.autoDownload, true);
  assert.equal(autoUpdater.autoInstallOnAppQuit, true);
  assert.equal(autoUpdater.listenerCount("error") > 0, true, "an updater error never becomes an uncaught 'error' event");
  assert.deepEqual(installs, [[true, true]], "silent install, app starts again afterwards");
  assert.equal(restarting, true, "windows are allowed to close before the installer runs");
  assert.ok(states.some((s) => s.status === "installing" && s.latest === "1.2.0"));
});

test("formats that can't update themselves notify once per version with a download link", async (t) => {
  const shown = [];
  const release = {
    tag_name: "v1.2.0",
    html_url: "https://github.com/sb-git-cs/usage-monitor/releases/tag/v1.2.0",
    assets: [{ name: "UsageMonitor-portable-1.2.0.exe", browser_download_url: "https://github.com/sb-git-cs/usage-monitor/releases/download/v1.2.0/UsageMonitor-portable-1.2.0.exe" }],
  };
  let requests = 0;
  const updater = loadUpdater("src/updater.js", {
    electron: electronMock({ packaged: true, shown }).electron,
    "./http": { getJson: async (url) => { requests++; assert.match(url, /api\.github\.com\/repos\/sb-git-cs\/usage-monitor\/releases\/latest/); return { status: 200, json: release }; } },
  });
  const { ctx, cfg, states } = context();
  updater.start({ ...ctx, kind: "manual" });
  t.after(() => updater.stop());
  await updater.automatic();
  await updater.automatic();
  assert.equal(requests, 2);
  const toasts = shown.filter((n) => n.options);
  assert.equal(toasts.length, 1, "the same version is not announced on every check");
  assert.match(toasts[0].options.title, /1\.2\.0 is available/);
  assert.equal(cfg.update_notified_version, "1.2.0");
  assert.equal(states.at(-1).status, "available");
  toasts[0].emit("click");
  await tick();
  assert.ok(shown.some((s) => s.opened === release.html_url || /releases/.test(s.opened || "")));
});

test("offline checks retry with backoff, and waking the computer checks again", async (t) => {
  let requests = 0;
  const mock = electronMock({ packaged: true });
  const updater = loadUpdater("src/updater.js", {
    electron: mock.electron,
    "./http": { getJson: async () => { requests++; throw new Error("getaddrinfo ENOTFOUND api.github.com"); } },
  });
  const { ctx, states } = context();
  updater.start({ ...ctx, kind: "manual" });
  t.after(() => updater.stop());
  await updater.automatic();
  assert.equal(states.at(-1).status, "error");
  await tick(60);
  assert.equal(requests, 4, "one check plus three retries, then it waits for the next period");
  mock.power.emit("resume");
  await tick(30);
  assert.ok(requests >= 5, "resume starts a new round of checks");
});

test("turning automatic updates off stops automatic checks; a manual check still works", async (t) => {
  let requests = 0;
  const updater = loadUpdater("src/updater.js", {
    electron: electronMock({ packaged: true }).electron,
    "./http": { getJson: async () => { requests++; return { status: 200, json: { tag_name: "v1.1.0" } }; } },
  });
  const { ctx, cfg, states } = context({ cfg: { auto_update: false } });
  updater.start({ ...ctx, kind: "manual" });
  t.after(() => updater.stop());
  assert.equal(states.at(-1).status, "off");
  assert.equal(states.at(-1).auto, false);
  await updater.automatic();
  assert.equal(requests, 0);
  await updater.checkNow();
  assert.equal(requests, 1);
  assert.equal(states.at(-1).status, "up-to-date");
  cfg.auto_update = true;
  updater.settingChanged();
  assert.equal(updater.getState().auto, true);
});

// ---- install kinds and versions ----------------------------------------------------

test("install kind follows how the app was installed", () => {
  const present = new Set();
  const updater = loadUpdater("src/updater.js", {
    electron: electronMock({ packaged: true }).electron,
    fs: { existsSync: (p) => present.has(p) },
  });
  const res = path.join("R");
  const win = { platform: "win32", env: {}, execPath: path.join("C", "Usage Monitor.exe"), resourcesPath: res };
  assert.equal(updater.installKind(win), "manual", "zip: no uninstaller");
  present.add(path.join("C", "Uninstall Usage Monitor.exe"));
  assert.equal(updater.installKind(win), "manual", "no update metadata in the build");
  present.add(path.join(res, "app-update.yml"));
  assert.equal(updater.installKind(win), "installer");
  assert.equal(updater.installKind({ ...win, env: { PORTABLE_EXECUTABLE_FILE: "D:\\UM.exe" } }), "manual", "portable");
  assert.equal(updater.installKind({ platform: "linux", env: { APPIMAGE: "/opt/UM.AppImage" }, resourcesPath: res }), "installer");
  assert.equal(updater.installKind({ platform: "linux", env: {}, resourcesPath: res }), "manual", "tar.gz");
  assert.equal(updater.installKind({ platform: "darwin", env: {}, resourcesPath: res }), "manual", "unsigned macOS");
});

test("versions compare numerically and downloads match the platform", () => {
  const updater = loadUpdater("src/updater.js", { electron: electronMock().electron });
  assert.equal(updater.compareVersions("1.10.0", "1.9.9"), 1);
  assert.equal(updater.compareVersions("v1.1.0", "1.1"), 0);
  assert.equal(updater.compareVersions("1.1.0", "1.2.0-beta.1"), -1);
  const base = "https://github.com/sb-git-cs/usage-monitor/releases/download/v1.2.0/";
  const release = { html_url: "https://github.com/sb-git-cs/usage-monitor/releases/tag/v1.2.0", assets: [
    "UsageMonitor-portable-1.2.0.exe", "Usage Monitor-1.2.0-win.zip", "UsageMonitor-1.2.0-arm64.dmg", "UsageMonitor-1.2.0-x64.dmg", "usage-monitor-1.2.0.tar.gz",
  ].map((name) => ({ name, browser_download_url: base + name })) };
  assert.equal(updater.downloadUrl(release, { platform: "win32", env: { PORTABLE_EXECUTABLE_FILE: "x" } }), base + "UsageMonitor-portable-1.2.0.exe");
  assert.equal(updater.downloadUrl(release, { platform: "win32", env: {} }), base + "Usage Monitor-1.2.0-win.zip");
  assert.equal(updater.downloadUrl(release, { platform: "darwin", arch: "arm64", env: {} }), base + "UsageMonitor-1.2.0-arm64.dmg");
  assert.equal(updater.downloadUrl(release, { platform: "linux", env: {} }), base + "usage-monitor-1.2.0.tar.gz");
  const hostile = { html_url: "https://evil.example/", assets: [{ name: "UsageMonitor-portable-9.exe", browser_download_url: "https://evil.example/x.exe" }] };
  assert.equal(updater.downloadUrl(hostile, { platform: "win32", env: { PORTABLE_EXECUTABLE_FILE: "x" } }), "https://github.com/sb-git-cs/usage-monitor/releases/latest", "only GitHub links are opened");
});

test("releases publish the update metadata installed copies read", () => {
  const pkg = require("../package.json");
  assert.deepEqual(pkg.build.publish, [{ provider: "github", owner: "sb-git-cs", repo: "usage-monitor", releaseType: "release" }]);
  assert.ok(pkg.dependencies["electron-updater"], "electron-updater ships inside the app");
  const workflow = fs.readFileSync(path.resolve(__dirname, "../.github/workflows/release.yml"), "utf8");
  assert.match(workflow, /dist\/latest\*\.yml/);
  assert.match(workflow, /dist\/\*\.blockmap/);
});

test("post-update.js waits for the app to exit, reinstalls dependencies, then starts it again", { skip: process.platform === "win32" }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "um-post-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const dir of ["scripts", "src", "bin", "data"]) fs.mkdirSync(path.join(root, dir));
  fs.copyFileSync(path.resolve(__dirname, "../scripts/post-update.js"), path.join(root, "scripts", "post-update.js"));
  fs.copyFileSync(path.resolve(__dirname, "../src/paths.js"), path.join(root, "src", "paths.js"));
  const marker = (name) => path.join(root, name);
  // Stand-ins for npm and for start.js, which would launch Electron.
  fs.writeFileSync(path.join(root, "bin", "npm"), `#!/bin/sh\necho "$PWD $@" > "${marker("npm-ran")}"\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(root, "scripts", "start.js"), `require("fs").writeFileSync(${JSON.stringify(marker("started"))}, "yes");\n`);
  const { spawn } = require("node:child_process");
  const exited = new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(root, "scripts", "post-update.js"), "--pid", "999999999"], {
      env: { ...process.env, PATH: `${path.join(root, "bin")}${path.delimiter}${process.env.PATH}`, HOME: path.join(root, "data"), XDG_DATA_HOME: path.join(root, "data") },
      stdio: "ignore",
    });
    child.on("exit", resolve);
  });
  await exited;
  const deadline = Date.now() + 5000;
  while (!fs.existsSync(marker("started")) && Date.now() < deadline) await tick(50);
  assert.match(fs.readFileSync(marker("npm-ran"), "utf8"), /ci --no-audit --no-fund/);
  assert.ok(fs.readFileSync(marker("npm-ran"), "utf8").startsWith(root), "npm ci runs in the checkout");
  assert.equal(fs.readFileSync(marker("started"), "utf8"), "yes");
  const base = process.platform === "darwin" ? path.join(root, "data", "Library", "Application Support") : path.join(root, "data");
  const logText = fs.readFileSync(path.join(base, "UsageMonitor", "logs", "update.log"), "utf8");
  assert.match(logText, /dependencies installed/);
});
