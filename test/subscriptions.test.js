const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { load } = require("./helpers");

const FAKE_TOKEN = `gho_${"a".repeat(36)}`;

test("github tokens are recognized and passwords are ignored", () => {
  const auth = load("src/github-auth.js");
  assert.equal(auth.usable(FAKE_TOKEN), FAKE_TOKEN);
  assert.equal(auth.usable("password"), "");
  assert.equal(auth.usable(`${FAKE_TOKEN}\n`), FAKE_TOKEN);
  const encoded = Buffer.from(FAKE_TOKEN, "utf16le").toString("base64");
  assert.equal(auth.decodeBlob(encoded), FAKE_TOKEN);
  assert.equal(auth.decodeBlob(Buffer.from("not-a-token", "utf8").toString("base64")), "");
});

test("a hosts.yml oauth token is read and never returned from an empty file", async () => {
  const hosts = path.join(os.tmpdir(), `um-hosts-${Date.now()}.yml`);
  const text = `github.com:\n  oauth_token: ${FAKE_TOKEN}\n`;
  const auth = load("src/github-auth.js", {
    fs: { readFileSync: (file) => (file === hosts ? text : (_ => { throw new Error("missing"); })()) },
    "./paths": { ghHosts: () => [hosts], cliPath: () => null, cliOnPath: () => false },
    child_process: { spawn() { throw new Error("no credential prompt"); } },
  });
  assert.equal(await auth.token(), FAKE_TOKEN);
  assert.equal(await auth.token(), FAKE_TOKEN);
  auth.forget();
  fs.writeFileSync(hosts, "github.com:\n  oauth_token: hunter2\n");
  const refused = load("src/github-auth.js", {
    fs: { readFileSync: () => fs.readFileSync(hosts, "utf8") },
    "./paths": { ghHosts: () => [hosts], cliPath: () => null, cliOnPath: () => false },
    child_process: { spawn() { throw new Error("no credential prompt"); } },
  });
  assert.equal(await refused.token(), "");
  fs.unlinkSync(hosts);
});

test("cursor reports the signed-in plan and stays hidden when it is absent", async () => {
  const authPath = path.join(os.tmpdir(), `um-cursor-auth-${Date.now()}.json`);
  const body = {
    accessToken: "cursor-session-token-0123456789",
    refreshToken: "cursor-refresh-secret",
  };
  const plan = { planInfo: { planName: "Free", price: "Free", billingCycleEnd: "1791963961194" } };
  const usage = {
    billingCycleEnd: "1791963961194",
    planUsage: { totalPercentUsed: 1.5, autoPercentUsed: 3, apiPercentUsed: 0 },
  };
  const calls = [];
  const present = load("src/adapters/cursor.js", {
    fs: { readFileSync: (file) => (file === authPath ? JSON.stringify(body) : (_ => { throw new Error("missing"); })()) },
    "../paths": {
      cursorAuth: () => authPath,
      cursorStateDb: () => path.join(os.tmpdir(), "missing-cursor.db"),
      cliOnPath: () => false,
      fileExists: (file) => file === authPath,
    },
    "../cursor-local": { readValue: () => "" },
    "../http": { postJson: async (url) => { calls.push(url); return { status: 200, json: url.includes("GetPlanInfo") ? plan : usage }; } },
  });
  const result = await present.fetchUsage();
  assert.equal(result.status.state, "ok");
  assert.equal(result.plan, "Free");
  assert.deepEqual(result.windows.map((win) => [win.label, win.used_pct]), [["Included", 1.5], ["Auto", 3], ["API", 0]]);
  assert.equal(result.windows[0].resets_at, new Date(1791963961194).toISOString());
  assert.equal(calls.length, 2);
  assert.equal(JSON.stringify(result).includes("cursor-session"), false);
  assert.equal(JSON.stringify(result).includes("cursor-refresh"), false);

  const absent = load("src/adapters/cursor.js", {
    fs: { readFileSync() { throw new Error("missing"); } },
    "../paths": { cursorAuth: () => "nope", cursorStateDb: () => "nope", cliOnPath: () => false, fileExists: () => false },
    "../cursor-local": { readValue: () => "" },
    "../http": { postJson: async () => { throw new Error("should not be called"); } },
  });
  assert.equal((await absent.fetchUsage()).status.state, "not_installed");
});

test("copilot meters included allowances and skips an empty premium bucket", async () => {
  const seen = [];
  const adapter = load("src/adapters/copilot.js", {
    "../paths": { ghHosts: () => [], cliOnPath: () => false, fileExists: () => false },
    "../github-auth": { token: async () => FAKE_TOKEN, forget() {} },
    "../accounts": { observe: (id, account, accountId) => seen.push([id, account, accountId]) },
    "../http": { getJson: async () => ({ status: 200, json: {
      login: "octocat",
      access_type_sku: "free_limited_copilot",
      copilot_plan: "individual",
      analytics_tracking_id: "should-not-leak",
      quota_reset_date_utc: "2026-10-01T00:00:00.000Z",
      quota_snapshots: {
        chat: { percent_remaining: 100, entitlement: 200, remaining: 200, unlimited: false, has_quota: true },
        completions: { percent_remaining: 75, entitlement: 2000, remaining: 1500, unlimited: false, has_quota: true },
        premium_interactions: { percent_remaining: 0, entitlement: 0, remaining: 0, unlimited: false, has_quota: false },
      },
    } }) },
  });
  const result = await adapter.fetchUsage();
  assert.equal(result.plan, "Free");
  assert.deepEqual(result.windows.map((win) => [win.label, win.used_pct, win.resets_at]), [
    ["Chat", 0, "2026-10-01T00:00:00.000Z"],
    ["Completions", 25, "2026-10-01T00:00:00.000Z"],
  ]);
  assert.deepEqual(seen, [["copilot", "octocat", "octocat"]]);
  assert.equal(JSON.stringify(result).includes(FAKE_TOKEN), false);
  assert.equal(JSON.stringify(result).includes("should-not-leak"), false);

  const denied = load("src/adapters/copilot.js", {
    "../paths": { ghHosts: () => [], cliOnPath: () => true, fileExists: () => false },
    "../github-auth": { token: async () => "", forget() {} },
    "../accounts": { observe() {} },
    "../http": { getJson: async () => { throw new Error("should not be called"); } },
  });
  assert.equal((await denied.fetchUsage()).status.state, "logged_out");
});

test("copilot names the gh login from hosts.yml, so each GitHub account keeps its own cache and history", () => {
  let text = `github.com:\r\n    users:\r\n        octocat:\r\n            oauth_token: ${FAKE_TOKEN}\r\n    git_protocol: https\r\n    user: octocat\r\n    oauth_token: ${FAKE_TOKEN}\r\n`;
  const adapter = load("src/adapters/copilot.js", {
    fs: { readFileSync: (file) => { if (file !== "second.yml") throw new Error("missing"); return text; } },
    "../paths": { ghHosts: () => ["first.yml", "second.yml"], cliOnPath: () => false, fileExists: () => false },
    "../github-auth": { token: async () => { throw new Error("the login never comes from the token"); } },
    "../accounts": { observe() {} },
  });
  assert.equal(adapter.accountRef(), "octocat");
  text = text.replace("user: octocat", "user: hubot");
  assert.equal(adapter.accountRef(), "hubot", "gh auth switch is a different account");
  text = `github.com:\n    oauth_token: ${FAKE_TOKEN}\n`;
  assert.equal(adapter.accountRef(), null, "no login: unidentified");
});

test("cursor and copilot stay off the snapshot until they are installed", async () => {
  const ids = ["claude", "codex", "gemini", "grok", "cursor", "copilot"];
  const mocks = { "./cache": { loadSnapshot: () => null, saveSnapshot() {} } };
  for (const id of ids) {
    mocks[`./adapters/${id}`] = { fetchUsage: async () => ({ id, status: { state: "ok" }, windows: [], display_name: id }) };
  }
  mocks["./adapters/cursor"].fetchUsage = async () => ({ id: "cursor", status: { state: "not_installed" }, windows: [] });
  mocks["./adapters/copilot"].fetchUsage = async () => ({ id: "copilot", status: { state: "logged_out" }, windows: [] });
  const poller = load("src/poller.js", mocks);
  const snap = await poller.pollOnce({});
  assert.deepEqual(snap.providers.map((item) => item.id), ["claude", "codex", "gemini", "grok", "copilot"]);
});

test("Cursor and Copilot reject missing and malformed quota numbers", () => {
  const cursor = load("src/adapters/cursor.js", {}, ["provider"]);
  const copilot = load("src/adapters/copilot.js");
  for (const value of [null, undefined, "", " ", false, true, [], {}, "unknown", Infinity]) {
    assert.deepEqual(cursor.provider(null, { planUsage: { totalPercentUsed: value } }).windows, []);
    assert.equal(copilot.quotaWindow({ percent_remaining: value }, "Chat", null), null);
    assert.equal(copilot.quotaWindow({ entitlement: 200, remaining: value }, "Chat", null), null);
  }
  assert.equal(cursor.provider(null, { planUsage: { totalPercentUsed: "0" } }).windows[0].used_pct, 0);
  assert.equal(copilot.quotaWindow({ entitlement: "200", remaining: "150" }, "Chat", null).used_pct, 25);
});

test("Copilot and Cursor readings with nothing metered stay current and say so", async () => {
  const copilot = load("src/adapters/copilot.js", {
    "../paths": { ghHosts: () => [], cliOnPath: () => false, fileExists: () => false },
    "../github-auth": { token: async () => FAKE_TOKEN, forget() {} },
    "../accounts": { observe() {} },
    "../http": { getJson: async () => ({ status: 200, json: { quota_snapshots: { chat: { unlimited: true }, completions: { unlimited: true }, premium_interactions: { unlimited: true } } } }) },
  });
  const cursor = load("src/adapters/cursor.js", {}, ["provider"]);
  for (const result of [await copilot.fetchUsage(), cursor.provider(null, {})]) {
    assert.deepEqual(result.status, { state: "ok", hint: "No metered limits" });
    assert.deepEqual(result.windows, []);
  }
  assert.deepEqual(cursor.provider(null, { planUsage: { totalPercentUsed: 5 } }).status, { state: "ok" });
});

test("Cursor ignores an out-of-range billing date without losing valid usage", () => {
  const cursor = load("src/adapters/cursor.js", {}, ["provider"]);
  const result = cursor.provider(null, { billingCycleEnd: "1e100", planUsage: { totalPercentUsed: 25 } });
  assert.equal(result.windows[0].used_pct, 25);
  assert.equal(result.windows[0].resets_at, null);
});

test("copilot treats GitHub's rate-limit 403 as a back-off, and other 403s as retryable, not a sign-out", async () => {
  let res;
  const adapter = load("src/adapters/copilot.js", {
    "../paths": { ghHosts: () => [], cliOnPath: () => true, fileExists: () => false },
    "../github-auth": { token: async () => FAKE_TOKEN, forget() {} },
    "../accounts": { observe() {} },
    "../http": { getJson: async () => res },
  });
  const reset = Math.floor(Date.now() / 1000) + 900;
  res = { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) } };
  const limited = await adapter.fetchUsage();
  assert.equal(limited.status.state, "fetch_failed");
  assert.equal(limited._rateLimited, true);
  assert.equal(Date.parse(limited._retryAfter), reset * 1000);
  res = { status: 403, headers: {} };
  const denied = await adapter.fetchUsage();
  assert.equal(denied.status.state, "fetch_failed", "the last reading is kept");
  assert.equal(denied._rateLimited, undefined);
  res = { status: 401, headers: {} };
  assert.equal((await adapter.fetchUsage()).status.state, "logged_out");
});
