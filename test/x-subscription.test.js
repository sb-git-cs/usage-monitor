const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { load } = require("./helpers");
const { sharedWeekly, consolidate } = require("../src/subscription");
const { currentWindow } = require("../src/models");

const future = new Date(Date.now() + 86400000).toISOString();
const billing = (value = 42) => ({ creditUsagePercent: value, currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", end: future }, productUsage: [{ product: "GrokBuild", usagePercent: 15 }, { product: "Cursor", usagePercent: 10 }] });
const provider = (id, used = 42) => ({ id, display_name: id, status: { state: "ok" }, account_id: "account-a", source: "api", fetched_at: new Date().toISOString(), windows: [{ kind: "weekly", label: "Weekly", used_pct: used, resets_at: future }] });

test("combined pool requires an explicit weekly total, shared coverage and a valid reset; zero is valid", () => {
  assert.equal(sharedWeekly(billing(0)).used_pct, 0);
  assert.equal(sharedWeekly(billing(120)).used_pct, 120);
  for (const value of [undefined, null, "", " ", false, {}, [], "bad", Infinity, -1]) assert.equal(sharedWeekly({ ...billing(), creditUsagePercent: value }), null, String(value));
  const absent = billing(); delete absent.creditUsagePercent;
  assert.equal(sharedWeekly(absent), null);
  assert.equal(sharedWeekly({ ...billing(), currentPeriod: { type: "MONTHLY", end: future } }), null);
  assert.equal(sharedWeekly({ ...billing(), currentPeriod: { type: "BIWEEKLY", end: future } }), null);
  assert.equal(sharedWeekly({ ...billing(), currentPeriod: { type: "WEEKLY", end: "bad" } }), null);
  assert.equal(sharedWeekly({ ...billing(), productUsage: [{ product: "GrokBuild", usagePercent: 42 }] }), null);
  assert.equal(sharedWeekly({ ...billing(), productUsage: {} }), null);
});

test("legacy retains separate meters; combined shows the authoritative total once and keeps credits separate", () => {
  const grok = { ...provider("grok"), shared_weekly: sharedWeekly(billing()), windows: [...provider("grok").windows, { kind: "credits", label: "Credits $12.50", used_pct: null }] };
  const cursor = { ...provider("cursor", 90), account_id: "unrelated-cursor", windows: [{ kind: "monthly", label: "Included", used_pct: 90 }] };
  const original = [provider("claude"), grok, cursor];
  assert.equal(consolidate(original, "legacy"), original);
  const combined = consolidate(original, "combined");
  assert.deepEqual(combined.map((p) => p.id), ["claude", "x_subscription"]);
  const meter = combined[1];
  assert.equal(currentWindow(meter).used_pct, 42);
  assert.equal(meter.account_id, "account-a");
  assert.equal(meter.windows[1].label, "Additional Usage $12.50");
  assert.equal(consolidate(combined, "combined"), combined);
  assert.equal(original.length, 3);
});

test("Additional Usage does not replace a legacy Grok pool in chips or summaries", () => {
  const p = { ...provider("grok", 10), windows: [...provider("grok", 10).windows, { kind: "credits", label: "Credits", used_pct: 99 }] };
  assert.equal(currentWindow(p).used_pct, 10);
  assert.equal(currentWindow({ ...p, windows: p.windows.slice(1) }), null);
});

test("unverified and expired shared readings remain unavailable even with monthly or credit usage", () => {
  for (const shared of [null, { used_pct: 90, resets_at: "2020-01-01T00:00:00Z" }, { used_pct: false, resets_at: future }]) {
    const grok = { ...provider("grok"), shared_weekly: shared, windows: [{ kind: "credits", label: "Credits", used_pct: 99 }] };
    const meter = consolidate([grok, provider("cursor", 90)], "combined")[0];
    assert.equal(currentWindow(meter), null);
    assert.equal(meter.status.state, "unknown");
    assert.match(meter.status.hint, /unavailable/);
    assert.match(meter.dashboard_url, /^https:\/\/grok.com/);
  }
});

test("a verified Cursor pool can stand alone and never borrows another Grok account's credits", () => {
  const cursor = { ...provider("cursor"), account_id: "cursor-account", shared_weekly: sharedWeekly(billing(31)) };
  const grok = { ...provider("grok"), windows: [{ kind: "credits", label: "Credits $99", used_pct: null }] };
  const x = consolidate([grok, cursor], "combined")[0];
  assert.equal(currentWindow(x).used_pct, 31);
  assert.equal(x.account_id, "cursor-account");
  assert.equal(x.windows.length, 1);
  assert.equal(x.dashboard_url, "https://cursor.com/dashboard");
});

test("scoped caches survive switching regimes and restart without exposing another account's readings", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "um-cache-scopes-")); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const mocks = { "./paths": { cacheDir: () => dir, snapshotCachePath: () => path.join(dir, "snapshot.json") } };
  const cache = load("src/cache.js", mocks);
  for (const [selected, scope] of [["legacy", "a".repeat(32)], ["combined", "b".repeat(32)]])
    cache.saveSnapshot({ subscription_regime: selected, providers: [{ ...provider("grok"), cache_scope: scope }] });
  const restarted = load("src/cache.js", mocks).loadSnapshot();
  assert.equal(restarted.subscription_regime, "combined");
  assert.equal(Object.keys(restarted.cached_readings).length, 2);
  assert.equal(restarted.cached_readings[`grok|${"a".repeat(32)}`].account_id, "account-a");
});

test("cached shared readings stay stale and never notify; fresh shared pool alerts deduplicate", () => {
  let state = { fired: {} };
  const shown = [];
  class Notification { static isSupported() { return true; } constructor(o) { this.o = o; } show() { shown.push(this.o); } }
  const alerts = load("src/alerts.js", { electron: { Notification }, "./cache": { loadAlertState: () => state, saveAlertState: (s) => { state = s; } } });
  const grok = { ...provider("grok", 90), shared_weekly: sharedWeekly(billing(90)) };
  const snapshot = { providers: consolidate([grok, provider("cursor", 90)], "combined") };
  alerts.evaluate(snapshot); alerts.evaluate(snapshot);
  assert.equal(shown.length, 1);
  grok.status = { state: "stale" };
  const cached = consolidate([grok], "combined")[0];
  assert.equal(cached.status.state, "stale");
  alerts.evaluate({ providers: [cached] });
  assert.equal(shown.length, 1);
});

test("cached Additional Usage stays visibly stale when the weekly pool expires", () => {
  const grok = { ...provider("grok"), status: { state: "stale" }, source: "cache",
    shared_weekly: { kind: "weekly", label: "Weekly", used_pct: 42, resets_at: "2020-01-01T00:00:00Z" },
    windows: [{ kind: "credits", label: "Credits $12.50", used_pct: null }] };
  const x = consolidate([grok], "combined")[0];
  assert.equal(x.status.state, "stale");
  assert.equal(x.source, "cache");
  assert.match(x.status.hint, /^Stale/);
  assert.equal(currentWindow(x), null);
  assert.equal(x.windows[1].label, "Additional Usage $12.50");
});

function polling() {
  let snapshot, signedIn = "user-a", fail = false;
  const ids = ["claude", "codex", "gemini", "grok", "cursor", "copilot"];
  const mocks = { "./cache": { loadSnapshot: () => snapshot, saveSnapshot: (s) => { snapshot = s; } } };
  for (const id of ids) mocks[`./adapters/${id}`] = { displayName: id, accountRef: () => signedIn, fetchUsage: async () => ({ ...provider(id), status: { state: fail ? "fetch_failed" : "ok" }, windows: fail ? [] : provider(id).windows }) };
  return { mocks, poller: load("src/poller.js", mocks), fail: () => { fail = true; }, signIn: (v) => { signedIn = v; } };
}

test("poll caches cannot cross a regime, account selection or signed-in account", async () => {
  for (const change of ["regime", "account", "sign-in"]) {
    const p = polling();
    await p.poller.pollOnce({ subscription_regime: "legacy" }); p.fail();
    assert.equal((await p.poller.pollOnce({})).providers[0].status.state, "stale");
    const cfg = change === "regime" ? { subscription_regime: "combined" } : change === "account" ? { accounts: { claude: "account-b" } } : {};
    if (change === "sign-in") p.signIn("user-b");
    const snap = await p.poller.pollOnce(cfg);
    assert.equal(snap.providers[0].status.state, "fetch_failed", change);
    assert.equal(snap.providers[0].windows.length, 0);
  }
});

test("a refreshed token keeps its account's cache scope; tokens never key the cache", async () => {
  const p = polling();
  const first = await p.poller.pollOnce({});
  p.mocks["./adapters/claude"].linkToken = () => ({ access_token: "rotated" });
  p.fail();
  const next = await p.poller.pollOnce({});
  assert.equal(next.providers[0].cache_scope, first.providers[0].cache_scope);
  assert.equal(next.providers[0].status.state, "stale", "the last reading survives a token refresh");
  p.mocks["./adapters/claude"].accountRef = () => new Promise(() => {});
  const started = Date.now();
  const slow = await p.poller.pollOnce({});
  assert.ok(Date.now() - started < 8000, "an account lookup that never answers cannot hold the poll");
  assert.equal(slow.providers.length, 6);
});

test("switching during refresh discards the old selection and immediately refreshes the new one", async (t) => {
  const p = polling(); let release, calls = 0;
  p.mocks["./adapters/grok"].fetchUsage = (cfg) => {
    calls++;
    if (calls === 1) return new Promise((r) => { release = () => r(provider("grok")); });
    return Promise.resolve({ ...provider("grok"), plan: cfg.subscription_regime });
  };
  const seen = [], cfg = { subscription_regime: "legacy", poll_interval_secs: 60 };
  let delivered; const done = new Promise((r) => { delivered = r; });
  const poll = p.poller.start(cfg, (snapshot) => { seen.push(snapshot); delivered(); });
  t.after(() => poll.stop());
  while (!release) await new Promise((r) => setImmediate(r));
  cfg.subscription_regime = "combined"; poll.refresh(); release();
  await done;
  assert.equal(seen.length, 1);
  assert.equal(seen[0].subscription_regime, "combined");
  assert.equal(seen[0].providers.find((x) => x.id === "grok").plan, "combined");
  assert.equal(calls, 2);
});

test("settings persist the opt-in and old settings default to legacy", () => {
  let text;
  const config = load("src/config.js", { fs: { readFileSync: () => text, mkdirSync() {}, chmodSync() {}, writeFileSync: (_file, value) => { text = value; }, renameSync() {} } });
  assert.equal(config.load().subscription_regime, "legacy");
  const cfg = config.normalize({ subscription_regime: "combined", accounts: { grok: "saved" }, phone: { enabled: true } });
  assert.equal(config.save(cfg), true);
  assert.equal(config.load().subscription_regime, "combined");
  assert.equal(config.load().accounts.grok, "saved");
  assert.equal(config.load().phone.enabled, true);
  assert.equal(config.normalize({ subscription_regime: "bad" }).subscription_regime, "legacy");
});

test("forecast and Insights history segment the same account by subscription regime", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "um-regime-")); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { History } = require("../src/history"); const { Insights } = require("../src/insights");
  const h = new History({ file: path.join(dir, "history.json") }); const i = new Insights({ file: path.join(dir, "insights.json") });
  for (const subscription_regime of ["legacy", "combined"]) { const snap = { providers: [{ ...provider("grok"), subscription_regime }] }; h.record(snap); i.record(snap); }
  assert.equal(h.series.size, 2); assert.equal(Object.keys(i.data.series).length, 2);
});

test("monthly fallback retains monthly semantics even if the response also has a weekly period", () => {
  const grok = load("src/adapters/grok.js", {}, ["mapBilling"]);
  const mapped = grok.mapBilling({ currentPeriod: { type: "WEEKLY", end: future }, used: { val: 20 }, monthlyLimit: { val: 100 } });
  assert.equal(mapped.windows[0].kind, "monthly");
  assert.equal(mapped.shared_weekly, null);
  assert.equal(mapped.windows[0].resets_at, null, "monthly usage must not borrow a weekly reset");
  for (const value of [true, {}, ""]) assert.equal(grok.mapBilling({ used: { val: value }, monthlyLimit: { val: 100 } }).windows.length, 0);
});

test("Grok and Cursor permission failures remain retryable instead of pretending the login expired", async () => {
  const noPaths = { grokAuth: () => "grok.json", cursorAuth: () => "cursor.json", cursorStateDb: () => "cursor.db", cliOnPath: () => true, fileExists: () => true };
  const grok = load("src/adapters/grok.js", { fs: { statSync: () => ({ mtimeMs: 1 }), readFileSync: () => JSON.stringify({ one: { key: "token", user_id: "test" } }) },
    "../paths": noPaths, "../http": { getJson: async () => ({ status: 403 }), postForm: async () => ({ status: 403 }) } });
  const cursor = load("src/adapters/cursor.js", { fs: { readFileSync: () => JSON.stringify({ accessToken: "test-session-token-long-enough" }) },
    "../paths": noPaths, "../http": { postJson: async () => ({ status: 403 }) } });
  assert.equal((await grok.fetchUsage({})).status.state, "fetch_failed");
  assert.equal((await cursor.fetchUsage({})).status.state, "fetch_failed");
});
