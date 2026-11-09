const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { load } = require("./helpers");
const config = require("../src/config");
const { PROVIDERS } = require("../src/models");
const { createWatcher } = require("../src/sessions");

const IDS = PROVIDERS.map((p) => p.id);
const future = new Date(Date.now() + 86400000).toISOString();
const reading = (id) => ({ id, display_name: id, status: { state: "ok" }, windows: [{ kind: "weekly", label: "Weekly", used_pct: 10, resets_at: future }], fetched_at: new Date().toISOString() });

test("providers_enabled defaults to every provider on, drops unknown ids and never shares its defaults", () => {
  assert.deepEqual(config.PROVIDER_IDS, IDS);
  const fresh = config.normalize({});
  assert.deepEqual(Object.keys(fresh.providers_enabled), IDS);
  assert.ok(Object.values(fresh.providers_enabled).every((on) => on === true));
  const cfg = config.normalize({ providers_enabled: { gemini: false, codex: "no", bogus: false, claude: 0 } });
  assert.equal(cfg.providers_enabled.gemini, false);
  assert.equal(cfg.providers_enabled.codex, true, "anything but false keeps a provider on");
  assert.equal(cfg.providers_enabled.claude, true);
  assert.equal("bogus" in cfg.providers_enabled, false);
  cfg.providers_enabled.cursor = false;
  assert.equal(config.normalize({}).providers_enabled.cursor, true);
  assert.equal(config.DEFAULTS.providers_enabled.cursor, true);
});

// main.js with fakes for everything that touches a window, a file or a process.
function harness(t, extra = {}) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "um-providers-"));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const electron = {
    app: { setName() {}, on() {}, commandLine: { appendSwitch() {} }, setAppUserModelId() {}, disableHardwareAcceleration() {}, requestSingleInstanceLock: () => false, quit() {}, getVersion: () => "1.3.0" },
    ipcMain: { on() {}, handle() {} },
    BrowserWindow: { fromWebContents: () => null },
    Menu: { buildFromTemplate: (template) => template },
    nativeTheme: { themeSource: "system", shouldUseDarkColors: false },
    Notification: class { static isSupported() { return false; } },
    screen: { getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) },
  };
  const signals = new Map(["SIGHUP", "SIGINT"].map((name) => [name, new Set(process.listeners(name))]));
  const accounts = { ...require("../src/accounts"), refresh: async () => [] };
  const api = load("src/main.js", {
    electron, "./config": { ...config, save: () => true }, "./poller": {}, "./alerts": {}, "./taskbarLayout": {}, "./accounts": accounts,
    "./autostart": { apply: (on) => on }, "./updater": { getState: () => null }, "./log": { install() {} },
    "./paths": { cliOnPath: () => false, cacheDir: () => folder },
  }, ["applySettings", "settingsView", "prefs", "present", "getLatest: () => latest", "getSessions: () => latestSessions",
    "setState: (s) => { if ('cfg' in s) cfg = s.cfg; if ('latest' in s) latest = s.latest; if ('poll' in s) poll = s.poll; if ('sessionWatch' in s) sessionWatch = s.sessionWatch; }"]);
  for (const [name, existing] of signals) for (const l of process.listeners(name)) if (!existing.has(l)) process.removeListener(name, l);
  const cfg = config.normalize(extra.config || {});
  const calls = { refresh: 0, scan: 0 };
  const view = { auto_resume: false, sessions: [{ key: "a", tool: "gemini" }, { key: "b", tool: "claude" }], recent: [{ key: "c", tool: "gemini" }, { key: "d", tool: "codex" }] };
  api.setState({
    cfg,
    latest: { subscription_regime: cfg.subscription_regime, providers: IDS.map(reading) },
    poll: { refresh: () => { calls.refresh++; } },
    sessionWatch: { view: () => view, refresh: () => { calls.scan++; }, stop() {} },
  });
  return { api, cfg, calls };
}

test("switching a provider off drops its reading, sessions and account row at once; on shows a placeholder and polls", (t) => {
  const { api, cfg, calls } = harness(t);
  api.applySettings({ providers_enabled: { gemini: false } });
  assert.equal(cfg.providers_enabled.gemini, false);
  assert.equal(api.getLatest().providers.some((p) => p.id === "gemini"), false);
  assert.equal(api.getLatest().providers.length, IDS.length - 1);
  assert.deepEqual(api.getSessions().sessions.map((s) => s.tool), ["claude"]);
  assert.deepEqual(api.getSessions().recent.map((s) => s.tool), ["codex"]);
  const view = api.settingsView();
  assert.equal(view.settings.providers_enabled.gemini, false);
  assert.equal(view.accounts.some((row) => row.id === "gemini"), false);
  assert.equal(view.accounts.some((row) => row.id === "claude"), true);
  assert.equal(api.prefs().providers_enabled.gemini, false);
  assert.equal(calls.refresh, 0, "switching off needs no poll");

  api.applySettings({ providers_enabled: { gemini: "yes", bogus: false } });
  assert.equal(cfg.providers_enabled.gemini, false, "only a boolean is accepted");
  assert.equal("bogus" in cfg.providers_enabled, false);

  api.applySettings({ providers_enabled: { gemini: true } });
  const placeholder = api.getLatest().providers.find((p) => p.id === "gemini");
  assert.equal(placeholder.status.hint, "Reading…");
  assert.equal(placeholder.display_name, "Gemini");
  assert.equal(calls.refresh, 1);
  assert.equal(calls.scan, 1, "the sessions are scanned again");
  assert.equal(api.settingsView().accounts.some((row) => row.id === "gemini"), true);
});

test("the shared X Subscription pool stays while Grok or Cursor is on, and goes when both are off", (t) => {
  const { api, cfg } = harness(t, { config: { subscription_regime: "combined" } });
  const pool = { id: "x_subscription", display_name: "X Subscription", status: { state: "ok" }, windows: [] };
  api.setState({ latest: { subscription_regime: "combined", providers: [reading("claude"), pool] } });
  api.applySettings({ providers_enabled: { grok: false } });
  assert.deepEqual(api.getLatest().providers.map((p) => p.id), ["claude", "x_subscription"], "cursor alone still feeds the pool");
  api.applySettings({ providers_enabled: { cursor: false } });
  assert.deepEqual(api.getLatest().providers.map((p) => p.id), ["claude"]);
  // A poll that no longer lists either tool must not bring the pool back.
  assert.deepEqual(api.present({ subscription_regime: "combined", providers: [reading("claude")] }).providers.map((p) => p.id), ["claude"]);
  api.applySettings({ providers_enabled: { cursor: true } });
  assert.deepEqual(api.getLatest().providers.map((p) => p.id), ["claude", "x_subscription"]);
  assert.equal(cfg.providers_enabled.cursor, true);
});

test("the poller never calls an adapter that is off and leaves it out of the snapshot", async () => {
  let saved = null;
  const calls = [];
  const mocks = { "./cache": { loadSnapshot: () => saved, saveSnapshot: (s) => { saved = s; } } };
  for (const id of IDS) mocks[`./adapters/${id}`] = { fetchUsage: async () => { calls.push(id); return reading(id); } };
  const poller = load("src/poller.js", mocks);
  const cfg = { providers_enabled: { gemini: false } };
  const snapshot = await poller.pollOnce(cfg);
  assert.equal(calls.includes("gemini"), false);
  assert.equal(snapshot.providers.some((p) => p.id === "gemini"), false);
  assert.equal(snapshot.providers.length, IDS.length - 1);
  // On, then off again.
  await poller.pollOnce({ providers_enabled: {} });
  assert.equal(calls.includes("gemini"), true);
  calls.length = 0;
  const off = await poller.pollOnce(cfg);
  assert.equal(calls.length, IDS.length - 1);
  assert.equal(off.providers.some((p) => p.id === "gemini"), false);
});

test("a toggle during a poll starts a fresh one instead of delivering the old set", async () => {
  const calls = [];
  const mocks = { "./cache": { loadSnapshot: () => null, saveSnapshot() {} } };
  for (const id of IDS) mocks[`./adapters/${id}`] = { fetchUsage: async () => { calls.push(id); await new Promise((r) => setTimeout(r, 5)); return reading(id); } };
  const poller = load("src/poller.js", mocks);
  const cfg = { providers_enabled: {} };
  const first = poller.pollOnce(cfg);
  cfg.providers_enabled = { codex: false };
  const second = await poller.pollOnce(cfg);
  assert.equal((await first).providers.length, IDS.length);
  assert.equal(second.providers.some((p) => p.id === "codex"), false);
});

test("the sessions watcher leaves a switched-off tool out of its sessions and its recent list", async () => {
  const none = fs.mkdtempSync(path.join(os.tmpdir(), "um-providers-sessions-"));
  const procs = [{ pid: 51, ppid: 1, name: "agy", start: String((BigInt(Date.now() - 3600_000) + 11644473600000n) * 10000n), cwd: "D:/work/web/", cmd: "agy" }];
  const request = async (req) => (req.op === "scan" ? { procs } : req.op === "screen" ? { text: ">" } : { ok: true });
  const recorded = [];
  const sessionLog = {
    record: (running) => recorded.push(running), seed() {}, flush() {},
    recent: () => [
      { key: "claude:x", tool: "claude", cli: "claude", label: "Claude Code", id: "x", last_active: 2, closed_at: 2 },
      { key: "codex:y", tool: "codex", cli: "codex", label: "Codex", id: "y", last_active: 1, closed_at: 1 },
    ],
  };
  const enabled = { gemini: true, claude: true, codex: true };
  try {
    const w = createWatcher({ getConfig: () => ({ providers_enabled: enabled }), platform: "win32", request, sessionLog, records: { read: () => [] },
      which: () => true, folderExists: () => true, claudeDir: () => none, codexDir: () => none, grokDir: () => none, cursorDir: () => none });
    let view = await w.scan();
    assert.deepEqual(view.sessions.map((s) => s.tool), ["gemini"]);
    assert.deepEqual(view.recent.map((r) => r.tool), ["claude", "codex"]);
    enabled.gemini = false;
    enabled.codex = false;
    view = await w.scan();
    assert.deepEqual(view.sessions, []);
    assert.deepEqual(view.recent.map((r) => r.tool), ["claude"]);
    assert.equal(recorded.at(-1).some((s) => s.tool === "gemini"), true, "the log keeps recording the tool that is off");
  } finally {
    fs.rmSync(none, { recursive: true, force: true });
  }
});

test("accounts.refresh reads no files of a tool that is switched off", async () => {
  const home = path.join("/home/tester");
  const read = [];
  const file = (...parts) => path.join(home, ...parts);
  const files = { [file(".claude.json")]: JSON.stringify({ oauthAccount: { emailAddress: "claude@example.com" } }), [file(".codex", "auth.json")]: JSON.stringify({ tokens: { access_token: "t" } }) };
  const accounts = load("src/accounts.js", {
    "./account-vault": { TOOLS: [], capture: () => false, list: () => [], has: () => false, forget: () => false, activate: () => ({ ok: true }) },
    "./adapters/gemini": { knownIdentity: () => null },
    fs: { readFileSync: (f) => { read.push(f); if (!Object.hasOwn(files, f)) throw new Error("missing"); return files[f]; } },
    "./paths": {
      home: () => home, claudeCredentials: () => file(".claude", ".credentials.json"), codexAuth: () => file(".codex", "auth.json"), grokAuth: () => file(".grok", "auth.json"),
      geminiOAuth: () => file(".gemini", "oauth_creds.json"), antigravityToken: () => file(".gemini", "token"), fileExists: (f) => Object.hasOwn(files, f),
    },
    "./wincred": { readGenericCredential: async () => { read.push("wincred"); return null; } },
    "./github-auth": { token: async () => { read.push("github"); return ""; }, forget() {}, users: () => ({ active: null, logins: [] }), switchUser: async () => false },
    electron: { shell: { openExternal: async () => {} } },
  });
  let rows = await accounts.refresh({}, (id) => id !== "claude" && id !== "gemini" && id !== "copilot");
  const by = Object.fromEntries(rows.map((row) => [row.id, row]));
  assert.equal(by.claude.signed_in, false);
  assert.equal(by.codex.signed_in, true);
  assert.equal(read.some((f) => f.includes(".claude")), false, "no Claude file was opened");
  assert.equal(read.includes("wincred") || read.includes("github"), false, "no Gemini or Copilot sign-in was looked up");
  read.length = 0;
  rows = await accounts.refresh({});
  assert.equal(rows.find((row) => row.id === "claude").account, "claude@example.com", "everything is read when nothing is off");
});
