// Regression tests for the 2026-09-28 audit findings (docs/audit-2026-09-28.md).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { load } = require("./helpers");
const { Engine } = require("../src/net/engine");
const { Store } = require("../src/net/store");
const { normalizeNet } = require("../src/net/settings");

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "usage-monitor-audit-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }));
  return dir;
}

test("A-07: 'check for updates at startup' becomes 'install updates automatically', keeping an opt-out", () => {
  for (const [before, expected] of [[false, false], [true, true], [undefined, true]]) {
    let written = null;
    const raw = { config_version: 5, poll_interval_secs: 5, ...(before === undefined ? {} : { check_updates_on_startup: before }) };
    const config = load("src/config.js", {
      fs: { readFileSync: () => JSON.stringify(raw), mkdirSync() {}, writeFileSync: (_f, text) => { written = JSON.parse(text); }, renameSync() {} },
    });
    const cfg = config.ensure();
    assert.equal(cfg.auto_update, expected);
    assert.equal(cfg.config_version, 6);
    assert.equal("check_updates_on_startup" in written, false, "the old key is dropped");
    assert.equal(written.auto_update, expected);
  }
  const fresh = load("src/config.js", { fs: { readFileSync: () => { throw new Error("ENOENT"); }, mkdirSync() {}, writeFileSync() {}, renameSync() {} } });
  assert.equal(fresh.ensure().auto_update, true, "on by default for new installs");
});

test("A-08: Gemini reads Credential Manager at most once a minute, and once per two minutes when signed out", async () => {
  let reads = 0;
  let blob = null;
  const gemini = load("src/adapters/gemini.js", { "../wincred": { readGenericCredential: async () => { reads++; return blob; } } }, ["readWinCred", "wincred"]);
  for (let i = 0; i < 20; i++) assert.equal(await gemini.readWinCred(), null);
  assert.equal(reads, 1, "a miss is not retried on every poll");
  gemini.wincred.at -= 2 * 60_000 + 1;
  blob = { token: { access_token: "a" } };
  assert.deepEqual(await gemini.readWinCred(), blob);
  assert.equal(await gemini.readWinCred(), blob);
  assert.equal(reads, 2);
  gemini.wincred.at -= 60_001;
  await gemini.readWinCred();
  assert.equal(reads, 3, "a stored login is re-read after a minute");
});

test("A-09: the agy binary is read asynchronously, once per version, even when no OAuth client is inside", async (t) => {
  const dir = tempDir(t);
  const bin = path.join(dir, "agy");
  fs.writeFileSync(bin, "no client in here");
  let reads = 0;
  const realFs = require("node:fs");
  const mockFs = { ...realFs, readFileSync: () => { throw new Error("sync read on the main thread"); }, promises: {
    stat: (p) => realFs.promises.stat(p),
    readFile: (p, enc) => { reads++; return realFs.promises.readFile(p, enc); },
  } };
  const gemini = load("src/adapters/gemini.js", { fs: mockFs }, ["extractOauthClient"]);
  assert.equal(await gemini.extractOauthClient(bin), null);
  assert.equal(await gemini.extractOauthClient(bin), null);
  assert.equal(reads, 1, "a miss is remembered until the binary changes");
  // Synthetic values, assembled at runtime so no credential-shaped string sits in the source.
  const clientId = ["1071234567890-fake", "apps", "googleusercontent", "com"].join(".");
  const clientSecret = ["GOCSPX", "notARealSecretForTests0"].join("-");
  fs.writeFileSync(bin, `x ${clientId} y ${clientSecret} z`);
  const future = new Date(Date.now() + 5000);
  fs.utimesSync(bin, future, future);
  assert.deepEqual(await gemini.extractOauthClient(bin), { clientId, clientSecret });
  assert.equal(reads, 2);
});

test("A-10: floating chips on an unplugged monitor are pulled back onto a remaining screen", () => {
  const moves = [];
  const primary = { bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1040 } };
  const electron = {
    app: { setName() {}, on() {}, commandLine: { appendSwitch() {} }, setAppUserModelId() {}, requestSingleInstanceLock: () => false, quit() {} },
    ipcMain: { on() {}, handle() {} },
    BrowserWindow: { fromWebContents: () => null },
    screen: { getDisplayNearestPoint: () => primary, getPrimaryDisplay: () => primary },
  };
  const api = load("src/main.js", {
    electron, "./config": { save() {} }, "./poller": {}, "./alerts": {}, "./taskbarLayout": {}, "./autostart": {}, "./updater": {}, "./log": { install() {} },
  }, ["reclampWidgets", "setState: (state) => { cfg = state.cfg; chips = state.chips; flyout = state.flyout; }"]);
  const chips = {
    isDestroyed: () => false, getSize: () => [300, 28], getNativeWindowHandle: () => Buffer.alloc(8),
    setPosition: (x, y) => moves.push([x, y]), webContents: { send() {} },
  };
  // Saved on a second monitor to the right that is no longer connected.
  api.setState({ cfg: { chips_docked: false, chips_hidden: false, chips_x: 2600, chips_y: 400 }, chips, flyout: null });
  api.reclampWidgets();
  assert.deepEqual(moves, [[1620, 400]]);
});

test("A-11: the log file captures errors and rotates at 1 MB", (t) => {
  const dir = tempDir(t);
  const log = load("src/log.js", { "./paths": { logDir: () => dir } });
  log.error("first", new Error("boom"));
  const text = fs.readFileSync(path.join(dir, "main.log"), "utf8");
  assert.match(text, /\[error\] first Error: boom/);
  const line = "x".repeat(10_000);
  for (let i = 0; i < 120; i++) log.info(line);
  assert.ok(fs.existsSync(path.join(dir, "main.old.log")), "the previous log is kept");
  assert.ok(fs.statSync(path.join(dir, "main.log")).size <= 1024 * 1024);
});

test("A-12: unchanged caches are not rewritten on every poll", () => {
  const writes = [];
  const cache = load("src/cache.js", {
    fs: { readFileSync: () => "{}", mkdirSync() {}, writeFileSync: (file) => writes.push(file), renameSync() {} },
  });
  const snap = (used, at) => ({ generated_at: at, providers: [{ id: "claude", status: { state: "ok" }, windows: [{ kind: "five_hour", used_pct: used }], fetched_at: at }] });
  assert.equal(cache.saveSnapshot(snap(10, "2026-09-28T10:00:00Z")), true);
  assert.equal(cache.saveSnapshot(snap(10, "2026-09-28T10:00:05Z")), false, "only timestamps changed");
  assert.equal(cache.saveSnapshot(snap(11, "2026-09-28T10:00:10Z")), true, "a new reading is saved right away");
  assert.equal(cache.saveAlertState({ fired: {} }), true);
  assert.equal(cache.saveAlertState({ fired: {} }), false);
  assert.equal(writes.length, 3);
});

test("A-14: a failing records flush is reported without breaking the engine, and cleared once saving works", (t) => {
  const dir = tempDir(t);
  const store = new Store(path.join(dir, "network.db"));
  t.after(() => store.close());
  const clock = { now: Date.now() };
  const engine = new Engine({ store, settings: normalizeNet({}), now: () => clock.now });
  const flush = store.flush.bind(store);
  store.flush = () => { throw new Error("SQLITE_FULL: database or disk is full"); };
  engine.ingest({ ts: clock.now, apps: [{ key: "a", name: "A", rx: 10, tx: 0 }] });
  clock.now += 11_000;
  assert.doesNotThrow(() => engine.tick());
  assert.match(engine.flushError, /disk is full/);
  assert.equal(engine.recentTotals(60).rx, 10, "the unsaved bytes are still counted");
  store.flush = flush;
  clock.now += 11_000;
  engine.tick();
  assert.equal(engine.flushError, null);
});

test("A-17: connection domains are updated through an index on the remote address", (t) => {
  const dir = tempDir(t);
  const store = new Store(path.join(dir, "network.db"));
  t.after(() => store.close());
  const plan = store.db.prepare("EXPLAIN QUERY PLAN UPDATE connections SET domain = ? WHERE remote = ? AND domain IS NULL").all("example.com", "1.2.3.4");
  assert.ok(plan.some((row) => /connections_remote/.test(row.detail)), JSON.stringify(plan));
});
