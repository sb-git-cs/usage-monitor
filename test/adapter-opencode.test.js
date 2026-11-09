const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { load } = require("./helpers");

const FUTURE = Date.now() + 3600_000;
const RESET = "2026-11-12T10:00:00.000Z";

function setup(t, { calls = [], reply = () => ({ status: 200, json: { usage: {} } }) } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "um-opencode-"));
  const saved = process.env.OPENCODE_DB;
  delete process.env.OPENCODE_DB;
  t.after(() => {
    if (saved === undefined) delete process.env.OPENCODE_DB; else process.env.OPENCODE_DB = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const paths = { opencodeDataDir: () => dir, cliOnPath: () => false, fileExists: fs.existsSync };
  const http = { getJson: async (url, headers) => { calls.push({ url, headers }); return reply(url, headers); } };
  const adapter = load("src/adapters/opencode.js", { "../paths": paths, "../http": http });
  return { dir, adapter, calls };
}

function makeDb(file, credentials = [], accounts = []) {
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE credential (integration_id TEXT, value TEXT, active INTEGER)");
  db.exec("CREATE TABLE account (email TEXT)");
  for (const [integration, value, active] of credentials) {
    db.prepare("INSERT INTO credential VALUES (?, ?, ?)").run(integration, JSON.stringify(value), active);
  }
  for (const email of accounts) db.prepare("INSERT INTO account VALUES (?)").run(email);
  db.close();
}

const usage = { usage: {
  rolling: { status: "ok", percent: 12, resetsAt: RESET },
  weekly: { status: "ok", percent: 40.5, resetsAt: Date.parse(RESET) },
  monthly: { status: "rate-limited", resetsAt: Math.floor(Date.parse(RESET) / 1000) },
} };

test("mapUsage maps the three windows from percent, ISO and epoch resets", () => {
  const { adapter } = setup({ after() {} });
  const w = adapter.mapUsage(usage);
  assert.deepEqual(w.map((x) => [x.kind, x.label, x.used_pct]), [["five_hour", "5h", 12], ["weekly", "Weekly", 40.5], ["monthly", "Monthly", 100]]);
  for (const x of w) assert.equal(x.resets_at, RESET);
});

test("mapUsage skips a missing window and scales a 0-1 ratio", () => {
  const { adapter } = setup({ after() {} });
  assert.deepEqual(adapter.mapUsage({ usage: { weekly: { percent: 30 } } }).map((x) => x.kind), ["weekly"]);
  assert.deepEqual(adapter.mapUsage({ usage: {} }), []);
  assert.deepEqual(adapter.mapUsage(null), []);
  const ratio = adapter.mapUsage({ usage: { rolling: { percent: 0.25 }, weekly: { percent: 0.5 } } });
  assert.deepEqual(ratio.map((x) => x.used_pct), [25, 50]);
  assert.equal(adapter.mapUsage({ usage: { rolling: { percent: 1 } } })[0].used_pct, 1);
});

test("mapBudgets turns spent over limit into a Budget window", () => {
  const { adapter } = setup({ after() {} });
  const w = adapter.mapBudgets([{ limitDollars: 50, spentDollars: 12.5, resetsAt: RESET, scope: "workspace" }, { limitDollars: 0, spentDollars: 1 }]);
  assert.equal(w.length, 1);
  assert.equal(w[0].label, "Budget");
  assert.equal(w[0].used_pct, 25);
  assert.deepEqual(adapter.mapBudgets({ error: "x" }), []);
});

test("credential takes the active opencode row, oauth or key, and ignores others", (t) => {
  const { dir, adapter } = setup(t);
  makeDb(path.join(dir, "opencode.db"), [
    ["opencode", { type: "key", key: "old", metadata: { orgID: "org_old" } }, 0],
    ["openai", { type: "key", key: "other", metadata: { orgID: "org_x" } }, 1],
    ["opencode", { type: "oauth", access: "tok", expires: FUTURE, metadata: { orgID: "org_1" } }, 1],
  ]);
  assert.deepEqual({ ...adapter.credential() }, { token: "tok", orgID: "org_1" });
  makeDb(path.join(dir, "opencode-beta.db"), [["opencode", { type: "key", key: "k2", metadata: {} }, 1]]);
  fs.rmSync(path.join(dir, "opencode.db"));
  assert.deepEqual({ ...adapter.credential() }, { token: "k2", orgID: "" });
});

test("credential falls back to the v1 auth.json opencode-go key", (t) => {
  const { dir, adapter } = setup(t);
  assert.equal(adapter.credential(), null);
  fs.writeFileSync(path.join(dir, "auth.json"), JSON.stringify({ openai: { type: "api", key: "no" }, "opencode-go": { type: "api", key: "v1key" } }));
  assert.deepEqual({ ...adapter.credential() }, { token: "v1key", orgID: "" });
});

test("no credential is not installed or logged out depending on the install", async (t) => {
  const { adapter } = setup(t);
  const gone = load("src/adapters/opencode.js", { "../paths": { opencodeDataDir: () => path.join(os.tmpdir(), "um-opencode-missing"), cliOnPath: () => false, fileExists: () => false } });
  assert.equal((await gone.fetchUsage()).status.state, "not_installed");
  const result = await adapter.fetchUsage();
  assert.equal(result.status.state, "logged_out");
  assert.equal(result.status.hint, "Run: opencode auth login");
});

test("an expired oauth login is logged out and makes no request", async (t) => {
  const { dir, adapter, calls } = setup(t);
  makeDb(path.join(dir, "opencode.db"), [["opencode", { type: "oauth", access: "tok", expires: Date.now() - 1000, metadata: { orgID: "o" } }, 1]]);
  assert.equal((await adapter.fetchUsage()).status.state, "logged_out");
  assert.equal(calls.length, 0);
});

test("a v1 key without an org is ok with a hint and no request", async (t) => {
  const { dir, adapter, calls } = setup(t);
  fs.writeFileSync(path.join(dir, "auth.json"), JSON.stringify({ "opencode-go": { type: "api", key: "v1key" } }));
  const result = await adapter.fetchUsage();
  assert.deepEqual(result.status, { state: "ok", hint: "No Go subscription found" });
  assert.equal(calls.length, 0);
});

function signedIn(dir) {
  makeDb(path.join(dir, "opencode.db"), [["opencode", { type: "key", key: "secret-key", metadata: { orgID: "org_9" } }, 1]], ["me@example.com"]);
}

test("a 200 sends the documented headers and returns windows plus budgets", async (t) => {
  const { dir, adapter, calls } = setup(t, { reply: (url) => url.includes("budgets")
    ? { status: 200, json: [{ limitDollars: 10, spentDollars: 5, resetsAt: RESET }] }
    : { status: 200, json: usage } });
  signedIn(dir);
  const result = await adapter.fetchUsage();
  assert.equal(result.status.state, "ok");
  assert.deepEqual(result.windows.map((w) => w.label), ["5h", "Weekly", "Monthly", "Budget"]);
  assert.equal(calls[0].url, "https://opencode.ai/zen/go/v1/usage");
  assert.equal(calls[0].headers.Authorization, "Bearer secret-key");
  assert.equal(calls[0].headers["x-opencode-org-id"], "org_9");
  assert.equal(calls[0].headers["User-Agent"], "usage-monitor");
  assert.equal(calls[1].headers["x-org-id"], "org_9");
  assert.ok(!JSON.stringify(result).includes("secret-key"));
});

test("budget failures are skipped without losing the usage windows", async (t) => {
  for (const budget of [{ status: 403, json: null }, "throw"]) {
    const { dir, adapter } = setup(t, { reply: (url) => {
      if (!url.includes("budgets")) return { status: 200, json: usage };
      if (budget === "throw") throw new Error("down");
      return budget;
    } });
    signedIn(dir);
    assert.equal((await adapter.fetchUsage()).windows.length, 3);
  }
});

test("401, 403, 429 and other statuses map to their states", async (t) => {
  const cases = [
    [{ status: 401 }, "logged_out"],
    [{ status: 403 }, "ok"],
    [{ status: 429, headers: { "retry-after": "30" } }, "fetch_failed"],
    [{ status: 500 }, "fetch_failed"],
  ];
  for (const [res, state] of cases) {
    const { dir, adapter } = setup(t, { reply: () => res });
    signedIn(dir);
    const result = await adapter.fetchUsage();
    assert.equal(result.status.state, state, String(res.status));
    if (res.status === 403) { assert.equal(result.status.hint, "No Go subscription"); assert.deepEqual(result.windows, []); }
    if (res.status === 429) { assert.equal(result._rateLimited, true); assert.equal(result._retryAfter, "30"); }
    if (res.status === 500) assert.equal(result.status.message, "HTTP 500");
  }
});

test("a thrown request is fetch_failed", async (t) => {
  const { dir, adapter } = setup(t, { reply: () => { throw new Error("timeout"); } });
  signedIn(dir);
  const result = await adapter.fetchUsage();
  assert.equal(result.status.state, "fetch_failed");
  assert.equal(result.status.message, "timeout");
});

test("accountRef is the account email, or null", (t) => {
  const { dir, adapter } = setup(t);
  assert.equal(adapter.accountRef(), null);
  signedIn(dir);
  assert.equal(adapter.accountRef(), "me@example.com");
});

test("OPENCODE_DB overrides the database path", (t) => {
  const { dir, adapter } = setup(t);
  const file = path.join(dir, "custom.db");
  makeDb(file, [["opencode", { type: "key", key: "k", metadata: { orgID: "o" } }, 1]]);
  process.env.OPENCODE_DB = file;
  assert.deepEqual({ ...adapter.credential() }, { token: "k", orgID: "o" });
});
