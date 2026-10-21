const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { load } = require("./helpers");
const { request } = require("../src/http");

const PLAN_IDS = ["claude", "codex", "gemini", "grok", "cursor", "copilot"];

function provider(id, used = 50) {
  return { id, display_name: id, status: { state: "ok" }, windows: [{ kind: "daily", label: "Pro", used_pct: used }], fetched_at: new Date().toISOString() };
}

test("polls coalesce concurrent refreshes and deliver fresh data despite cache write failure", async () => {
  let calls = 0;
  const mocks = { "./cache": { loadSnapshot: () => null, saveSnapshot() { throw new Error("disk full"); } } };
  for (const id of PLAN_IDS) mocks[`./adapters/${id}`] = {
    fetchUsage: async () => { calls++; await new Promise((r) => setTimeout(r, 5)); return provider(id); },
  };
  const poller = load("src/poller.js", mocks);
  const [first, second] = await Promise.all([poller.pollOnce({}), poller.pollOnce({})]);
  assert.equal(calls, PLAN_IDS.length);
  assert.equal(first, second);
  assert.equal(first.providers.length, PLAN_IDS.length);
});

test("timed-out adapters cannot overlap refresh operations, and late results are consumed", async () => {
  let release;
  let calls = 0;
  let snapshot = null;
  const mocks = { "./cache": { loadSnapshot: () => snapshot, saveSnapshot: (s) => { snapshot = s; } } };
  for (const id of PLAN_IDS) mocks[`./adapters/${id}`] = {
    fetchUsage: async () => provider(id),
  };
  mocks["./adapters/claude"].fetchUsage = () => { calls++; return new Promise((r) => { release = r; }); };
  const poller = load("src/poller.js", mocks, ["pending", "withTimeout"]);
  // Seed the same pending operation used by pollOnce, timing out without waiting 12s.
  poller.pending.claude = mocks["./adapters/claude"].fetchUsage();
  await assert.rejects(poller.withTimeout(poller.pending.claude, 5), /timeout/);
  const result = poller.pollOnce({});
  release(provider("claude", 93));
  assert.equal((await result).providers[0].windows[0].used_pct, 93);
  assert.equal(calls, 1);
});

test("rate limiting backs off empty readings without misrepresenting them as stale usage", async () => {
  let snapshot;
  let calls = 0;
  const mocks = { "./cache": { loadSnapshot: () => snapshot, saveSnapshot: (s) => { snapshot = s; } } };
  for (const id of PLAN_IDS) mocks[`./adapters/${id}`] = {
    fetchUsage: async () => { calls++; return { ...provider(id), windows: [], status: { state: "fetch_failed" }, _rateLimited: true }; },
  };
  const poller = load("src/poller.js", mocks);
  await poller.pollOnce({});
  const next = await poller.pollOnce({});
  assert.equal(calls, PLAN_IDS.length);
  assert.equal(next.providers[0].status.state, "fetch_failed");
});

test("failed fetches retain last good readings and their original timestamp", () => {
  const poller = load("src/poller.js", {}, ["mergeWithCache"]);
  const cached = provider("claude", 88);
  const merged = poller.mergeWithCache({ status: { state: "fetch_failed" } }, cached);
  assert.equal(merged.windows[0].used_pct, 88);
  assert.equal(merged.fetched_at, cached.fetched_at);
  assert.equal(merged.status.state, "stale");
  const loggedOut = { status: { state: "logged_out" } };
  assert.equal(poller.mergeWithCache(loggedOut, cached), loggedOut);
});

test("config rejects malformed booleans, coordinates and intervals without sharing defaults", () => {
  let raw = { poll_interval_secs: 0, chips_hidden: "false", chips_x: "bad", adapters: { claude: null } };
  const cfg = load("src/config.js", { fs: { readFileSync: () => JSON.stringify(raw) } });
  const first = cfg.load();
  assert.equal(first.poll_interval_secs, 5);
  assert.equal(first.chips_hidden, false);
  assert.equal(first.chips_x, null);
  assert.equal(first.adapters.claude.refresh_tokens, true);
  first.adapters.claude.refresh_tokens = false;
  raw = null;
  assert.equal(cfg.load().adapters.claude.refresh_tokens, true);
});

test("malformed snapshot and alert caches safely recover", () => {
  let raw = { providers: "bad" };
  const cache = load("src/cache.js", { fs: { readFileSync: () => JSON.stringify(raw) } });
  assert.equal(cache.loadSnapshot(), null);
  raw = { providers: [null, { id: "claude", windows: {} }, provider("claude")] };
  assert.equal(cache.loadSnapshot().providers.length, 1);
  raw = "bad";
  assert.deepEqual(cache.loadAlertState(), { fired: {} });
});

test("alerts distinguish model pools, deduplicate 100% toasts and ignore stale readings", () => {
  let state = { fired: { invalid: null } };
  const shown = [];
  class Notification {
    static isSupported() { return true; }
    constructor(options) { this.options = options; }
    show() { shown.push(this.options); }
  }
  const alerts = load("src/alerts.js", {
    electron: { Notification }, "./cache": { loadAlertState: () => state, saveAlertState: (s) => { state = s; } },
  });
  const p = provider("gemini", 100);
  p.windows.push({ kind: "daily", label: "Flash", used_pct: 85 });
  alerts.evaluate({ providers: [p] }, { notifyOnLimit: true });
  assert.equal(shown.length, 2);
  assert.match(shown[0].body, /limit reached/);
  alerts.evaluate({ providers: [p] }, { notifyOnLimit: true });
  assert.equal(shown.length, 2);
  p.windows.push({ kind: "daily", label: "Other", used_pct: 90 });
  p.status.state = "stale";
  alerts.evaluate({ providers: [p] });
  assert.equal(shown.length, 2);
});

test("HTTP rejects unsupported protocols, truncated bodies and oversized responses", async () => {
  await assert.rejects(request("GET", "file:///test"), /Unsupported protocol/);
  const server = http.createServer((req, res) => {
    if (req.url === "/large") { res.end(Buffer.alloc(2 * 1024 * 1024 + 1)); return; }
    res.writeHead(200, { "Content-Length": 1000 });
    res.write("short");
    setTimeout(() => res.destroy(), 5);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    await assert.rejects(request("GET", base + "/large"), /Response too large/);
    await assert.rejects(request("GET", base + "/short"), /aborted/);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test("taskbar converts physical pixels, detects negative-monitor edges and rejects partial docking", () => {
  const screen = {
    screenToDipRect: (_win, rect) => Object.fromEntries(Object.entries(rect).map(([k, v]) => [k, v / 2])),
    getDisplayMatching: () => ({ bounds: { x: 0, y: -1080, width: 1920, height: 1080 } }),
  };
  const layout = load("src/taskbarLayout.js", { electron: { screen } }, ["toDipLayout", "axisOf", "cache"]);
  const converted = layout.toDipLayout({ tray: { x: 0, y: 2000, w: 3840, h: 80 }, occupied: [] });
  assert.deepEqual(converted.tray, { x: 0, y: 1000, w: 1920, h: 40 });
  assert.equal(layout.axisOf({ x: 0, y: -40, w: 1920, h: 40 }).edge, "bottom");
  layout.cache.at = Date.now();
  layout.cache.data = { tray: { x: 0, y: -40, w: 1920, h: 40 }, occupied: [] };
  assert.equal(layout.isWellDocked(-10, -40, 100, 28), false);
  assert.equal(layout.isWellDocked(10, -40, 100, 28), true);
});

test("while nobody is at the computer providers are asked once a minute, and at once on return", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let calls = 0;
  const mocks = { "./cache": { loadSnapshot: () => null, saveSnapshot() {} } };
  for (const id of PLAN_IDS) mocks[`./adapters/${id}`] = { fetchUsage: async () => { if (id === "claude") calls++; return provider(id); } };
  const poller = load("src/poller.js", mocks);
  const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };
  const poll = poller.start({ poll_interval_secs: 5 }, () => {});
  await settle();
  assert.equal(calls, 1);
  poll.setAway(true);
  for (let i = 0; i < 11; i++) { t.mock.timers.tick(5000); await settle(); }
  assert.equal(calls, 1, "no reading for 55 seconds while away");
  t.mock.timers.tick(5000);
  await settle();
  assert.equal(calls, 2, "one reading a minute while away");
  poll.setAway(false);
  await settle();
  assert.equal(calls, 3, "back: read at once");
  t.mock.timers.tick(5000);
  await settle();
  assert.equal(calls, 4, "then at the chosen interval");
  poll.stop();
});

test("alerts treat a jittered reset time as the same window and keep only entries that warned", () => {
  let state = { fired: { "codex|five_hour|5h|29876459": { crossed80: false, crossed100: false }, old: { crossed80: true, until: "2020-01-01T00:00:00Z" } } };
  const shown = [];
  class Notification { static isSupported() { return true; } constructor(o) { this.o = o; } show() { shown.push(this.o.body); } }
  const alerts = load("src/alerts.js", { electron: { Notification }, "./cache": { loadAlertState: () => state, saveAlertState: (s) => { state = s; } } });
  const hour = new Date(Date.now() + 3 * 3600000); hour.setUTCMinutes(0, 0, 0);
  const at = (used, ms) => ({ providers: [{ ...provider("claude", used), account_id: "a@b.co", windows: [{ kind: "five_hour", label: "5h", used_pct: used, resets_at: new Date(hour.getTime() + ms).toISOString() }] }] });
  for (const [used, ms] of [[81, 411], [82, -191], [83, 347], [84, -483]]) alerts.evaluate(at(used, ms), { threshold: 80 });
  assert.deepEqual(shown, ["5h 81/100% used"], "one warning per window, whichever side of the minute the reset lands");
  assert.equal(Object.keys(state.fired).length, 1, "stale and never-warned entries are dropped");
  for (let i = 0; i < 20; i++) alerts.evaluate({ providers: [{ ...provider("codex", 10), windows: [{ kind: "five_hour", label: "5h", used_pct: 10, resets_at: new Date(Date.now() + 3600000 + i * 600000).toISOString() }] }] });
  assert.equal(Object.keys(state.fired).length, 1, "windows below the threshold add nothing to the saved state");
});

test("rate limits honour Retry-After, otherwise back off further with each refusal, and recover", async () => {
  let snapshot, status = { _rateLimited: true, _retryAfter: "600" };
  const mocks = { "./cache": { loadSnapshot: () => snapshot, saveSnapshot: (s) => { snapshot = s; } } };
  for (const id of PLAN_IDS) mocks[`./adapters/${id}`] = { fetchUsage: async () => ({ ...provider(id), ...(status ? { windows: [], status: { state: "fetch_failed" }, ...status } : {}) }) };
  const poller = load("src/poller.js", mocks, ["backoff", "backoffMs"]);
  const wait = () => Object.values(poller.backoff)[0].until - Date.now();
  await poller.pollOnce({});
  assert.ok(Math.abs(wait() - 600_000) < 2000, "the provider's ten minutes");
  assert.equal(snapshot.providers[0]._retryAfter, undefined);
  assert.equal(poller.backoffMs(undefined, 1), 60_000);
  assert.equal(poller.backoffMs(null, 3), 240_000, "doubling without a Retry-After");
  assert.equal(poller.backoffMs("5", 1), 60_000, "never faster than a minute");
  assert.equal(poller.backoffMs(undefined, 20), 3_600_000, "never longer than an hour");
  assert.ok(Math.abs(poller.backoffMs(new Date(Date.now() + 1_200_000).toUTCString(), 1) - 1_200_000) < 2000, "an HTTP date");
  for (const scope of Object.keys(poller.backoff)) poller.backoff[scope].until = 0;
  status = null;
  await poller.pollOnce({});
  assert.equal(Object.keys(poller.backoff).length, 0, "a good reading clears the back-off");
});
