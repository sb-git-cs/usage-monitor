const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { load } = require("./helpers");

function setup(t, { files = {}, onPath = false, reply = { status: 200, json: {} } } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "um-qwen-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), JSON.stringify(body));
  const calls = [];
  const observed = [];
  const adapter = load("src/adapters/qwen.js", {
    "../paths": {
      qwenHome: () => dir, cliOnPath: () => onPath, fileExists: (p) => fs.existsSync(p), home: () => dir,
    },
    "../accounts": { observe: (...args) => observed.push(args) },
    "../http": { getJson: async (url, headers) => { calls.push({ url, headers }); return typeof reply === "function" ? reply() : reply; } },
  });
  return { adapter, dir, calls, observed };
}

const signedIn = (extra = {}) => ({ "subscription_credentials.json": { tokens: { access_token: "tok-secret", expiresAt: Date.now() + 3600_000, ...extra } } });

test("member_type becomes the plan name", (t) => {
  const { adapter } = setup(t);
  assert.equal(adapter.planName("lite"), "Lite");
  assert.equal(adapter.planName("plus"), "Plus");
  assert.equal(adapter.planName("PRO"), "Pro");
  assert.equal(adapter.planName(""), null);
  assert.equal(adapter.planName(undefined), null);
});

test("a reading shows the plan, no windows and the fixed no-quota hint", (t) => {
  const { adapter } = setup(t);
  const p = adapter.provider({ sub: "u1", email: "a@b.c", member_type: "plus" });
  assert.equal(p.plan, "Plus");
  assert.deepEqual(p.windows, []);
  assert.deepEqual(p.status, { state: "ok", hint: "Qwen reports no quota; a session shows its limit when it hits one" });
  assert.equal(p.source, "api");
});

test("a valid subscription sign-in calls userinfo with the bearer token and reports the plan", async (t) => {
  const { adapter, calls, observed } = setup(t, { files: signedIn(), reply: { status: 200, json: { sub: "u1", email: "a@b.c", member_type: "pro" } } });
  const p = await adapter.fetchUsage();
  assert.equal(p.status.state, "ok");
  assert.equal(p.plan, "Pro");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://auth.qwen.ai/api/oauth/userinfo");
  assert.equal(calls[0].headers.Authorization, "Bearer tok-secret");
  assert.equal(calls[0].headers.Accept, "application/json");
  assert.equal(calls[0].headers["User-Agent"], "usage-monitor");
  assert.deepEqual(observed, [["qwen", "a@b.c", "u1"]]);
  assert.ok(!JSON.stringify(p).includes("tok-secret"));
});

test("accountRef is null before a reading, then the user id, else the email", async (t) => {
  const first = setup(t, { files: signedIn(), reply: { status: 200, json: { sub: "u1", email: "a@b.c", member_type: "lite" } } });
  assert.equal(first.adapter.accountRef(), null);
  await first.adapter.fetchUsage();
  assert.equal(first.adapter.accountRef(), "u1");
  const second = setup(t, { files: signedIn(), reply: { status: 200, json: { email: "a@b.c" } } });
  await second.adapter.fetchUsage();
  assert.equal(second.adapter.accountRef(), "a@b.c");
});

test("no subscription file is logged out when Qwen is installed, not installed otherwise", async (t) => {
  const missing = setup(t);
  fs.rmSync(missing.dir, { recursive: true, force: true });
  const none = await missing.adapter.fetchUsage();
  assert.equal(none.status.state, "not_installed");
  const onPath = setup(t, { onPath: true });
  const p = await onPath.adapter.fetchUsage();
  assert.equal(p.status.state, "logged_out");
  assert.equal(p.status.hint, "Run: qwen, then /auth");
  assert.equal(onPath.calls.length, 0);
});

test("the legacy free-tier file is ignored", async (t) => {
  const { adapter, calls } = setup(t, { files: { "oauth_creds.json": { access_token: "old", expiry_date: Date.now() + 3600_000 } } });
  const p = await adapter.fetchUsage();
  assert.equal(p.status.state, "logged_out");
  assert.equal(calls.length, 0);
});

test("an expired token is logged out without a request", async (t) => {
  const { adapter, calls } = setup(t, { files: signedIn({ expiresAt: Date.now() - 1000 }) });
  const p = await adapter.fetchUsage();
  assert.equal(p.status.state, "logged_out");
  assert.equal(p.status.hint, "Run: qwen, then /auth");
  assert.equal(calls.length, 0);
});

test("401 is logged out, 429 is rate limited, other failures name the status", async (t) => {
  const four01 = await setup(t, { files: signedIn(), reply: { status: 401, json: null } }).adapter.fetchUsage();
  assert.equal(four01.status.state, "logged_out");
  const limited = await setup(t, { files: signedIn(), reply: { status: 429, json: null, headers: { "retry-after": "30" } } }).adapter.fetchUsage();
  assert.equal(limited.status.state, "fetch_failed");
  assert.equal(limited._rateLimited, true);
  assert.equal(limited._retryAfter, "30");
  const other = await setup(t, { files: signedIn(), reply: { status: 503, json: null } }).adapter.fetchUsage();
  assert.equal(other.status.state, "fetch_failed");
  assert.equal(other.status.message, "HTTP 503");
  const thrown = await setup(t, { files: signedIn(), reply: () => { throw new Error("offline"); } }).adapter.fetchUsage();
  assert.equal(thrown.status.state, "fetch_failed");
  assert.ok(!JSON.stringify(thrown).includes("tok-secret"));
});
