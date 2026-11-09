const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { load } = require("./helpers");

const NOW = Date.parse("2026-11-10T12:00:00Z");

function setup(t, { post, onPath = false, existing = [], key } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "um-amp-"));
  const saved = { AMP_API_KEY: process.env.AMP_API_KEY };
  if (key) process.env.AMP_API_KEY = key; else delete process.env.AMP_API_KEY;
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    if (saved.AMP_API_KEY === undefined) delete process.env.AMP_API_KEY; else process.env.AMP_API_KEY = saved.AMP_API_KEY;
  });
  const calls = [];
  const observed = [];
  const adapter = load("src/adapters/amp.js", {
    "../paths": {
      cliOnPath: () => onPath,
      fileExists: (p) => existing.includes(p) || fs.existsSync(p),
      ampDataDir: () => path.join(dir, "amp"),
      ampHome: () => path.join(dir, "home"),
      home: () => path.join(dir, "profile"),
    },
    "../accounts": { observe: (...args) => observed.push(args) },
    "../http": { postJson: async (url, headers, body) => { calls.push({ url, headers, body }); return post(); } },
  });
  fs.mkdirSync(path.join(dir, "profile"));
  return { adapter, dir: path.join(dir, "amp"), calls, observed };
}

const text = (displayText) => ({ status: 200, json: { ok: true, result: { displayText } } });

test("Amp Free percentage becomes a daily window that resets at 20:00 New York time", () => {
  const { parseDisplayText } = load("src/adapters/amp.js");
  const r = parseDisplayText("Amp Free: 62% remaining today (resets daily)", NOW);
  assert.equal(r.plan, "Free");
  assert.equal(r.windows.length, 1);
  assert.deepEqual([r.windows[0].kind, r.windows[0].label, r.windows[0].used_pct], ["daily", "Daily", 38]);
  assert.equal(r.windows[0].resets_at, "2026-11-11T01:00:00.000Z"); // EST, UTC-5
});

test("The New York 20:00 reset follows summer time and the change back to winter time", () => {
  const { parseDisplayText } = load("src/adapters/amp.js");
  const reset = (iso) => parseDisplayText("Amp Free: 50% remaining today", Date.parse(iso)).windows[0].resets_at;
  assert.equal(reset("2026-07-10T12:00:00Z"), "2026-07-11T00:00:00.000Z"); // EDT, UTC-4
  assert.equal(reset("2026-07-11T00:30:00Z"), "2026-07-12T00:00:00.000Z"); // 20:30 in New York: tomorrow
  assert.equal(reset("2026-11-01T03:00:00Z"), "2026-11-02T01:00:00.000Z"); // 20:00 on Nov 1 is already EST
});

test("Legacy Amp Free dollars become a daily window without a reset time", () => {
  const { parseDisplayText } = load("src/adapters/amp.js");
  const r = parseDisplayText("Amp Free: $7.50 / $10 remaining (replenishes +$0.42 / hour)", NOW);
  assert.equal(r.windows[0].used_pct, 25);
  assert.equal(r.windows[0].resets_at, null);
});

test("A tier line becomes a monthly Usage window ending on the period's last day", () => {
  const { parseDisplayText } = load("src/adapters/amp.js");
  const line = "Amp Individual Tier: agent usage $30 of $200 remaining · period 2026-10-20 to 2026-11-20 · orb usage 3h of 10h · resets upon renewal in 10 days";
  const r = parseDisplayText(line, NOW);
  assert.equal(r.plan, "Individual");
  assert.deepEqual([r.windows[0].kind, r.windows[0].label, r.windows[0].used_pct], ["monthly", "Usage", 85]);
  assert.equal(r.windows[0].resets_at, "2026-11-20T23:59:59.000Z");
  const noDates = parseDisplayText("Amp Megawatt Tier: agent usage $50 of $100 remaining · resets upon renewal in 3 days", NOW);
  assert.equal(noDates.windows[0].resets_at, new Date(NOW + 3 * 86400000).toISOString());
});

test("A subscription line gives Usage and Orbs windows, in either wording", () => {
  const { parseDisplayText } = load("src/adapters/amp.js");
  for (const line of [
    "Amp Gigawatt Subscription: 80% other usage and 25% orb usage remaining - resets upon renewal in 12 days",
    "Subscription Gigawatt: 80% other usage and 25% orb usage remaining - resets upon renewal in 12 days",
  ]) {
    const r = parseDisplayText(line, NOW);
    assert.equal(r.plan, "Gigawatt");
    assert.deepEqual(r.windows.map((w) => [w.label, w.used_pct]), [["Usage", 20], ["Orbs", 75]]);
    assert.equal(r.windows[0].resets_at, new Date(NOW + 12 * 86400000).toISOString());
  }
});

test("Credit balances are credits windows with no percentage", () => {
  const { parseDisplayText } = load("src/adapters/amp.js");
  const r = parseDisplayText("Individual credits: $12.34 remaining\nWorkspace Acme Corp: $1,500 remaining", NOW);
  assert.deepEqual(r.windows.map((w) => [w.kind, w.label, w.used_pct, w.remaining_pct, w.resets_at]), [
    ["credits", "$12.34 credits", null, null, null],
    ["credits", "$1,500 credits", null, null, null],
  ]);
});

test("Markdown, bullets and a signed-in line in a multi-line text are read together", () => {
  const { parseDisplayText } = load("src/adapters/amp.js");
  const r = parseDisplayText([
    "**Signed in as** dev@example.com (Acme)",
    "Signed in as dev@example.com (Acme)",
    "- **Amp Free**: 90% remaining today (resets daily)",
    "Amp Free: 90% remaining today (resets daily)",
    "Individual credits: $5 remaining",
    "Something unrelated",
  ].join("\n"), NOW);
  assert.equal(r.email, "dev@example.com");
  assert.equal(r.windows.length, 3);
  assert.equal(parseDisplayText("Nothing to see", NOW).windows.length, 0);
  assert.equal(parseDisplayText(null, NOW).email, null);
});

test("The key comes from AMP_API_KEY first, then secrets.json, and a missing key is no key", async (t) => {
  const s = setup(t, { post: async () => text("Amp Free: 50% remaining today") });
  fs.mkdirSync(s.dir);
  fs.writeFileSync(path.join(s.dir, "secrets.json"), JSON.stringify({
    "apiKey@https://other.example/": "other-key", "apiKey@https://ampcode.com/": "file-key",
  }));
  await s.adapter.fetchUsage();
  assert.equal(s.calls[0].headers.Authorization, "Bearer file-key");
  process.env.AMP_API_KEY = "env-key";
  await s.adapter.fetchUsage();
  assert.equal(s.calls[1].headers.Authorization, "Bearer env-key");
  delete process.env.AMP_API_KEY;
  fs.writeFileSync(path.join(s.dir, "secrets.json"), JSON.stringify({ "apiKey@https://amp.example/": "any-key" }));
  await s.adapter.fetchUsage();
  assert.equal(s.calls[2].headers.Authorization, "Bearer any-key");
  fs.writeFileSync(path.join(s.dir, "secrets.json"), JSON.stringify({ accounts: [{ apiKey: "nested" }], "apiKey@x": "" }));
  const r = await s.adapter.fetchUsage();
  assert.equal(s.calls.length, 3);
  assert.equal(r.status.state, "logged_out");
});

test("A usage call posts the balance method and returns the parsed windows", async (t) => {
  const s = setup(t, { post: async () => text("Signed in as me@example.com (Org)\nAmp Free: 40% remaining today (resets daily)"), key: "k" });
  const r = await s.adapter.fetchUsage();
  assert.equal(s.calls[0].url, "https://ampcode.com/api/internal?userDisplayBalanceInfo");
  assert.deepEqual(s.calls[0].body, { method: "userDisplayBalanceInfo", params: {} });
  assert.equal(s.calls[0].headers["User-Agent"], "usage-monitor");
  assert.equal(r.status.state, "ok");
  assert.equal(r.plan, "Free");
  assert.equal(r.windows[0].used_pct, 60);
  assert.deepEqual(s.observed, [["amp", "me@example.com", "me@example.com"]]);
  assert.equal(s.adapter.accountRef(), "me@example.com");
  assert.ok(!JSON.stringify(r).includes('"k"'));
});

test("Text with no metered line is ok with a hint", async (t) => {
  const s = setup(t, { post: async () => text("Signed in as me@example.com (Org)"), key: "k" });
  const r = await s.adapter.fetchUsage();
  assert.equal(r.status.state, "ok");
  assert.equal(r.status.hint, "No metered limits");
  assert.deepEqual(r.windows, []);
});

test("No key is not_installed without the CLI and logged_out with it", async (t) => {
  const none = setup(t, { post: async () => assert.fail("no call without a key") });
  const r = await none.adapter.fetchUsage();
  assert.equal(r.status.state, "not_installed");
  const present = setup(t, { post: async () => assert.fail("no call without a key"), onPath: true });
  const r2 = await present.adapter.fetchUsage();
  assert.equal(r2.status.state, "logged_out");
  assert.equal(r2.status.hint, "Run: amp login");
});

test("Sign-in failures, rate limits and errors map to their states", async (t) => {
  const run = async (res) => setup(t, { post: async () => res, key: "k" }).adapter.fetchUsage();
  for (const res of [
    { status: 200, json: { ok: false, error: { code: "auth-required", message: "sign in" } } },
    { status: 401, json: null },
    { status: 403, json: null },
  ]) {
    const r = await run(res);
    assert.equal(r.status.state, "logged_out");
    assert.equal(r.status.hint, "Run: amp login");
  }
  const limited = await run({ status: 429, json: null, headers: { "retry-after": "30" } });
  assert.equal(limited.status.state, "fetch_failed");
  assert.equal(limited._rateLimited, true);
  assert.equal(limited._retryAfter, "30");
  const bad = await run({ status: 200, json: { ok: false, error: { code: "oops", message: "Balance unavailable" } } });
  assert.deepEqual([bad.status.state, bad.status.message], ["fetch_failed", "Balance unavailable"]);
  const server = await run({ status: 500, json: null });
  assert.deepEqual([server.status.state, server.status.message], ["fetch_failed", "HTTP 500"]);
  const thrown = await setup(t, { post: async () => { throw new Error("offline"); }, key: "k" }).adapter.fetchUsage();
  assert.equal(thrown.status.state, "fetch_failed");
});
