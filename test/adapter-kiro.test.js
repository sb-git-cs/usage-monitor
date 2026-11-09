const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { load } = require("./helpers");

const ARN = "arn:aws:codewhisperer:eu-west-1:123456789012:profile/ABCDEF123456";
const future = () => new Date(Date.now() + 3600_000).toISOString();
const past = () => new Date(Date.now() - 3600_000).toISOString();

// A fake home: the IDE cache dir and one CLI data dir, plus the calls the adapter makes.
function setup(t, { ide, db, response, throws } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "um-kiro-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cache = path.join(root, "sso");
  const data = path.join(root, "data");
  fs.mkdirSync(cache, { recursive: true });
  if (db) fs.mkdirSync(data, { recursive: true });
  if (ide) fs.writeFileSync(path.join(cache, "kiro-auth-token.json"), JSON.stringify(ide));
  if (db) {
    const conn = new DatabaseSync(path.join(data, "data.sqlite3"));
    conn.exec("CREATE TABLE auth_kv (key TEXT PRIMARY KEY, value TEXT); CREATE TABLE state (key TEXT PRIMARY KEY, value TEXT)");
    for (const [k, v] of Object.entries(db.auth || {})) conn.prepare("INSERT INTO auth_kv VALUES (?, ?)").run(k, JSON.stringify(v));
    if (db.profile !== undefined) conn.prepare("INSERT INTO state VALUES (?, ?)").run("api.codewhisperer.profile", db.profile);
    conn.close();
  }
  const calls = [];
  const observed = [];
  const adapter = load("src/adapters/kiro.js", {
    "../paths": {
      awsSsoCache: () => cache,
      kiroDataDirs: () => [path.join(root, "missing"), data],
      kiroHome: () => path.join(root, "home"),
      cliOnPath: () => false,
      fileExists: (p) => fs.existsSync(p),
    },
    "../accounts": { observe: (...a) => observed.push(a) },
    "../http": {
      postJson: async (url, headers, body) => {
        calls.push({ url, headers, body });
        if (throws) throw new Error(throws);
        return { headers: {}, ...response };
      },
    },
  });
  return { adapter, calls, observed };
}

const usage = {
  subscriptionInfo: { subscriptionTitle: "KIRO PRO" },
  userInfo: { email: "dev@example.com" },
  usageBreakdownList: [{
    displayName: "Credits",
    currentUsageWithPrecision: 120.5,
    currentOveragesWithPrecision: 20.5,
    usageLimitWithPrecision: 1000,
    nextDateReset: 1790000000,
  }],
};

test("credit windows use the precision fields minus overages", (t) => {
  const { adapter } = setup(t);
  const [w] = adapter.mapUsage(usage);
  assert.equal(w.kind, "monthly");
  assert.equal(w.label, "Credits");
  assert.equal(w.used_pct, 10);
  assert.equal(w.resets_at, new Date(1790000000 * 1000).toISOString());
});

test("plain fields stand in, a missing name reads Credits, a zero limit is skipped", (t) => {
  const { adapter } = setup(t);
  const windows = adapter.mapUsage({ usageBreakdownList: [
    { currentUsage: 25, usageLimit: 100, nextDateReset: 1790000000 },
    { displayName: "Zero", currentUsage: 0, usageLimit: 0 },
    { displayName: "Bad", usageLimitWithPrecision: "x" },
  ] });
  assert.equal(windows.length, 1);
  assert.equal(windows[0].label, "Credits");
  assert.equal(windows[0].used_pct, 25);
  assert.deepEqual(adapter.mapUsage({}), []);
});

test("free-trial credits become a Trial window ending at the trial expiry", (t) => {
  const { adapter } = setup(t);
  const windows = adapter.mapUsage({ usageBreakdownList: [{
    displayName: "Credits", currentUsageWithPrecision: 10, usageLimitWithPrecision: 50, nextDateReset: 1790000000,
    freeTrialInfo: { currentUsageWithPrecision: 100, usageLimitWithPrecision: 500, freeTrialExpiry: 1791000000 },
  }, { displayName: "Other", currentUsage: 1, usageLimit: 10, freeTrialInfo: { usageLimitWithPrecision: 0 } }] });
  assert.deepEqual(windows.map((w) => w.label), ["Credits", "Trial", "Other"]);
  assert.equal(windows[1].used_pct, 20);
  assert.equal(windows[1].resets_at, new Date(1791000000 * 1000).toISOString());
});

test("the IDE token file wins over the CLI database", (t) => {
  const { adapter } = setup(t, {
    ide: { accessToken: "ide-token", expiresAt: future() },
    db: { auth: { "kirocli:social:token": { access_token: "db-token", expires_at: future() } } },
  });
  assert.equal(adapter.findToken().found.token, "ide-token");
});

test("the database serves when the IDE file is missing, snake or camel keys, ARN as text or JSON", (t) => {
  let s = setup(t, { db: { auth: { "kirocli:odic:token": { access_token: "snake", expires_at: future() } }, profile: ARN } });
  let found = s.adapter.findToken().found;
  assert.equal(found.token, "snake");
  assert.equal(found.profileArn, ARN);
  s = setup(t, { db: { auth: { "kirocli:social:token": { accessToken: "camel", expiresAt: future() } }, profile: JSON.stringify({ arn: ARN, profile_name: "x" }) } });
  found = s.adapter.findToken().found;
  assert.equal(found.token, "camel");
  assert.equal(found.profileArn, ARN);
});

test("an expired IDE token falls through to a live database token; all expired reports expired", (t) => {
  let s = setup(t, {
    ide: { accessToken: "old", expiresAt: past() },
    db: { auth: { "kirocli:odic:token": { access_token: "fresh", expires_at: future() } } },
  });
  assert.equal(s.adapter.findToken().found.token, "fresh");
  s = setup(t, { ide: { accessToken: "old", expiresAt: past() } });
  assert.deepEqual(s.adapter.findToken(), { expired: true });
  s = setup(t);
  assert.deepEqual(s.adapter.findToken(), { expired: false });
});

test("the region comes from the profile ARN, else us-east-1", (t) => {
  const { adapter } = setup(t);
  assert.equal(adapter.regionOf(ARN), "eu-west-1");
  assert.equal(adapter.regionOf(""), "us-east-1");
  assert.equal(adapter.usageUrl(""), "https://q.us-east-1.amazonaws.com/?origin=CLI&resourceType=CREDIT");
  assert.equal(adapter.usageUrl(ARN), `https://q.eu-west-1.amazonaws.com/?origin=CLI&resourceType=CREDIT&profileArn=${encodeURIComponent(ARN)}`);
});

test("no token: logged out when Kiro is there, not installed when it is not", async (t) => {
  let s = setup(t);
  assert.equal((await s.adapter.fetchUsage()).status.state, "not_installed");
  s = setup(t, { db: { auth: {} } });
  const out = await s.adapter.fetchUsage();
  assert.equal(out.status.state, "logged_out");
  assert.equal(out.status.hint, "Open Kiro or run: kiro-cli login");
  assert.equal(s.calls.length, 0);
});

test("an expired token is logged out and never sent", async (t) => {
  const s = setup(t, { ide: { accessToken: "old", expiresAt: past() } });
  const out = await s.adapter.fetchUsage();
  assert.equal(out.status.state, "logged_out");
  assert.equal(out.status.hint, "Open Kiro or run: kiro-cli login");
  assert.equal(s.calls.length, 0);
});

test("a 200 reading sends the documented call and maps plan, windows and account", async (t) => {
  const s = setup(t, { ide: { accessToken: "tok", expiresAt: future(), profileArn: ARN }, response: { status: 200, json: usage } });
  const out = await s.adapter.fetchUsage();
  assert.equal(out.status.state, "ok");
  assert.equal(out.plan, "KIRO PRO");
  assert.equal(out.windows.length, 1);
  const call = s.calls[0];
  assert.match(call.url, /^https:\/\/q\.eu-west-1\.amazonaws\.com\/\?origin=CLI&resourceType=CREDIT&profileArn=/);
  assert.equal(call.headers["x-amz-target"], "AmazonCodeWhispererService.GetUsageLimits");
  assert.equal(call.headers["Content-Type"], "application/x-amz-json-1.0");
  assert.equal(call.headers.Authorization, "Bearer tok");
  assert.deepEqual(call.body, { profileArn: ARN });
  assert.deepEqual(s.observed, [["kiro", "dev@example.com", "dev@example.com"]]);
  assert.equal(s.adapter.accountRef(), "dev@example.com");
});

test("without a known profile the body is empty", async (t) => {
  const s = setup(t, { ide: { accessToken: "tok", expiresAt: future() }, response: { status: 200, json: {} } });
  const out = await s.adapter.fetchUsage();
  assert.deepEqual(s.calls[0].body, {});
  assert.equal(out.status.hint, "No metered limits");
});

test("AccessDenied bodies and 401/403 mean logged out", async (t) => {
  const ide = { accessToken: "tok", expiresAt: future() };
  for (const response of [
    { status: 400, json: { __type: "com.amazon.aws#AccessDeniedException" } },
    { status: 401, json: null },
    { status: 403, json: { code: "Forbidden" } },
  ]) {
    const out = await setup(t, { ide, response }).adapter.fetchUsage();
    assert.equal(out.status.state, "logged_out");
  }
});

test("throttling is a rate-limited fetch_failed; other statuses name the code", async (t) => {
  const ide = { accessToken: "tok", expiresAt: future() };
  let out = await setup(t, { ide, response: { status: 400, json: { __type: "ThrottlingException" } } }).adapter.fetchUsage();
  assert.equal(out.status.state, "fetch_failed");
  assert.equal(out._rateLimited, true);
  out = await setup(t, { ide, response: { status: 429, json: null, headers: { "retry-after": "30" } } }).adapter.fetchUsage();
  assert.equal(out._rateLimited, true);
  assert.equal(out._retryAfter, "30");
  out = await setup(t, { ide, response: { status: 500, json: null } }).adapter.fetchUsage();
  assert.equal(out.status.state, "fetch_failed");
  assert.equal(out.status.message, "HTTP 500");
  out = await setup(t, { ide, throws: "timeout" }).adapter.fetchUsage();
  assert.equal(out.status.message, "timeout");
});

test("accountRef falls back to the ARN's trailing id and never returns the token", (t) => {
  assert.equal(setup(t, { ide: { accessToken: "secret", expiresAt: future(), profileArn: ARN } }).adapter.accountRef(), "ABCDEF123456");
  assert.equal(setup(t, { ide: { accessToken: "secret", expiresAt: future() } }).adapter.accountRef(), null);
  assert.equal(setup(t).adapter.accountRef(), null);
});
