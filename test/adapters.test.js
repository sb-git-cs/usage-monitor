const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { load } = require("./helpers");

const noPaths = { cliOnPath: () => false, fileExists: () => false };
const gemini = load("src/adapters/gemini.js", {}, ["mapSummary", "mapModels", "mapQuotaBuckets", "usedFromFraction", "expiryEpoch", "fetchFromHost"]);

test("Gemini's multi-day shared model pool is weekly and replaces a placeholder summary", () => {
  const adapter = load("src/adapters/gemini.js", {}, ["mapQuotaBuckets", "combineWindows", "poolKinds"]);
  const reset = new Date(Date.now() + 3 * 86400000).toISOString();
  const rows = { buckets: ["gemini-pro", "gemini-flash"].map((modelId) => ({ modelId, tokenType: "WTUS", remainingFraction: 0.07, resetTime: reset })) };
  const windows = adapter.mapQuotaBuckets(rows);
  assert.equal(windows.length, 1); assert.equal(windows[0].kind, "weekly"); assert.equal(Math.round(windows[0].used_pct), 93);
  const merged = adapter.combineWindows([{ kind: "weekly", used_pct: 0 }, { kind: "five_hour", used_pct: 0 }], windows);
  assert.equal(merged.length, 1); assert.equal(merged[0].used_pct, windows[0].used_pct);
  assert.equal(adapter.combineWindows(windows, [{ ...windows[0], used_pct: 20 }])[0].used_pct, 20, "fresh decreases must not be pinned to an older high reading");
  const near = new Date(Date.now() + 3600000).toISOString(); adapter.poolKinds.set(near, "weekly");
  assert.equal(adapter.mapQuotaBuckets({ buckets: rows.buckets.map((r) => ({ ...r, resetTime: near })) })[0].kind, "weekly");
});

test("Gemini converts remaining fractions precisely and rejects invalid readings", () => {
  assert.equal(gemini.usedFromFraction(0.25), 75);
  assert.equal(gemini.usedFromFraction(1), 0);
  for (const v of [null, "", "Infinity", true]) assert.equal(gemini.usedFromFraction(v), null);
  assert.equal(gemini.expiryEpoch("1800000000"), 1800000000);
  assert.equal(gemini.expiryEpoch("1800000000000"), 1800000000);
});

test("Gemini never displays a different provider's quota and retains keyed model IDs", () => {
  assert.deepEqual(gemini.mapSummary({ groups: [{ displayName: "Claude", buckets: [{ remainingFraction: 0 }] }] }), []);
  const windows = gemini.mapModels({ models: {
    "other-provider-model": { quotaInfo: { remainingFraction: 0 } },
    "gemini-pro": { displayName: "Pro", quotaInfo: { remainingFraction: 0.25 } },
  } });
  assert.equal(windows.length, 1);
  assert.equal(windows[0].used_pct, 75);
  assert.equal(windows[0].kind, "quota");
});

test("Gemini collects all explicitly identified Gemini quota groups", () => {
  const windows = gemini.mapSummary({ groups: ["Gemini Pro", "Gemini Flash"].map((displayName) => ({
    displayName, buckets: [{ remainingFraction: 0.5, window: "DAILY" }],
  })) });
  assert.equal(windows.length, 2);
});

test("Gemini keeps each group's weekly and 5h windows when the summary has several groups", () => {
  const adapter = load("src/adapters/gemini.js", {}, ["mapSummary", "combineWindows"]);
  const reset = (h) => new Date(Date.now() + h * 3600000).toISOString();
  const group = (displayName, weekly, fiveHour) => ({ displayName, buckets: [
    { bucketId: "weekly", window: "weekly", remainingFraction: weekly, resetTime: reset(72) },
    { bucketId: "5h", window: "5h", remainingFraction: fiveHour, resetTime: reset(3) },
  ] });
  const windows = adapter.combineWindows([], adapter.mapSummary({ groups: [group("Gemini Pro", 0.1, 0.2), group("Gemini Flash", 0.9, 0.95)] }));
  assert.deepEqual(windows.map((w) => [w.label, Math.round(w.used_pct)]),
    [["Gemini Pro Weekly", 90], ["Gemini Flash Weekly", 10], ["Gemini Pro 5h", 80], ["Gemini Flash 5h", 5]]);
});

test("Gemini reads its own buckets when the group is no longer named Gemini", () => {
  const windows = gemini.mapSummary({ groups: [{
    displayName: "Models",
    buckets: [
      { bucketId: "gemini-weekly", remaining_fraction: 0.4, reset_time: "2026-10-22T00:00:00Z", window: "weekly" },
      { bucketId: "gemini-5h", remainingFraction: 0.25, resetTime: "2026-10-16T18:00:00Z", window: "5h" },
      { bucketId: "3p-5h", remainingFraction: 0, window: "5h" },
    ],
  }] });
  assert.deepEqual(windows.map((win) => win.kind), ["weekly", "five_hour"]);
  assert.equal(windows[1].used_pct, 75);
  assert.equal(windows[1].label, "5h");
});

test("Gemini collapses the shared model pool into one 5-hour window", () => {
  const buckets = ["gemini-3-flash", "gemini-3.5-flash-lite", "claude-sonnet-4-6"].map((modelId) => ({
    modelId,
    tokenType: "WTUS",
    remainingFraction: modelId.startsWith("gemini") ? 0.72 : 1,
    resetTime: "2026-10-16T17:49:58Z",
  }));
  const windows = gemini.mapQuotaBuckets({ buckets });
  assert.equal(windows.length, 1);
  assert.equal(windows[0].kind, "five_hour");
  assert.equal(windows[0].label, "5h");
  assert.equal(windows[0].resets_at, "2026-10-16T17:49:58.000Z");
  const models = gemini.mapModels({ models: {
    "gemini-3-flash": { displayName: "Gemini 3 Flash", quotaInfo: { remainingFraction: 0.72, resetTime: "2026-10-16T17:49:58Z" } },
    "gemini-2.5-pro": { displayName: "Gemini 2.5 Pro", quotaInfo: { remainingFraction: 0.72, resetTime: "2026-10-16T17:49:58Z" } },
    "claude-sonnet-4-6": { quotaInfo: { remainingFraction: 0, resetTime: "2026-10-16T18:00:00Z" } },
  } });
  assert.equal(models.length, 1);
  assert.equal(models[0].kind, "five_hour");
});

test("Gemini keeps the weekly window for the flyout when another host only has the shared 5-hour pool", async (t) => {
  const prev = process.env.ANTIGRAVITY_ACCESS_TOKEN;
  process.env.ANTIGRAVITY_ACCESS_TOKEN = "fake";
  t.after(() => {
    if (prev == null) delete process.env.ANTIGRAVITY_ACCESS_TOKEN;
    else process.env.ANTIGRAVITY_ACCESS_TOKEN = prev;
  });
  const calls = [];
  const adapter = load("src/adapters/gemini.js", {
    "../wincred": { readGenericCredential: async () => null },
    "../paths": {
      ...noPaths,
      cliOnPath: () => true,
      geminiOAuth: () => "oauth",
      antigravityToken: () => "token",
      agyBinaryCandidates: () => [],
      cliPath: () => null,
    },
    "../http": { postJson: async (url) => {
      calls.push(url);
      if (url.endsWith("loadCodeAssist")) return { status: 200, json: { paidTier: { name: "Google AI Pro" } } };
      if (url.includes("daily-cloudcode") && url.endsWith("retrieveUserQuotaSummary")) return { status: 200, json: { groups: [{ displayName: "Claude and GPT models", buckets: [{ bucketId: "3p-5h", remainingFraction: 1, window: "5h" }] }] } };
      if (url.includes("daily-cloudcode") && url.endsWith("retrieveUserQuota")) return { status: 200, json: { buckets: [
        { modelId: "gemini-3-flash", remainingFraction: 0.12, resetTime: "2026-10-17T11:15:41Z" },
        { modelId: "gemini-2.5-pro", remainingFraction: 0.12, resetTime: "2026-10-17T11:15:41Z" },
      ] } };
      if (url.includes("https://cloudcode-pa.googleapis.com") && url.endsWith("retrieveUserQuotaSummary")) return { status: 200, json: { groups: [
        { displayName: "Gemini Models", buckets: [
          { bucketId: "gemini-weekly", remainingFraction: 0.7, resetTime: "2026-10-19T10:44:08Z", window: "weekly", displayName: "Weekly Limit Remaining" },
          { bucketId: "gemini-5h", remainingFraction: 1, resetTime: "2026-10-17T15:00:14Z", window: "5h", displayName: "Five Hour Limit Remaining" },
        ] },
        { displayName: "Claude and GPT models", buckets: [{ bucketId: "3p-weekly", remainingFraction: 0.2, window: "weekly" }] },
      ] } };
      return { status: 404, json: {} };
    } },
  });
  const result = await adapter.fetchUsage({});
  assert.deepEqual(result.windows.map((win) => win.kind), ["weekly", "five_hour"]);
  assert.equal(result.windows[0].label, "Weekly");
  assert.equal(Math.round(result.windows[0].used_pct), 30);
  assert.equal(result.windows[1].label, "5h");
  assert.equal(result.windows[1].used_pct, 88);
  assert.ok(calls.some((url) => url.startsWith("https://cloudcode-pa.googleapis.com")));
  assert.ok(calls.some((url) => url.includes("daily-cloudcode")));
});

test("Gemini does not stop on a 5-hour model pool when the other host reports weekly", async (t) => {
  const prev = process.env.ANTIGRAVITY_ACCESS_TOKEN;
  process.env.ANTIGRAVITY_ACCESS_TOKEN = "fake";
  t.after(() => {
    if (prev == null) delete process.env.ANTIGRAVITY_ACCESS_TOKEN;
    else process.env.ANTIGRAVITY_ACCESS_TOKEN = prev;
  });
  const adapter = load("src/adapters/gemini.js", {
    "../wincred": { readGenericCredential: async () => null },
    "../paths": {
      ...noPaths,
      cliOnPath: () => true,
      geminiOAuth: () => "oauth",
      antigravityToken: () => "token",
      agyBinaryCandidates: () => [],
      cliPath: () => null,
    },
    "../http": { postJson: async (url) => {
      if (url.endsWith("loadCodeAssist")) return { status: 200, json: {} };
      if (url.includes("https://cloudcode-pa.googleapis.com") && url.endsWith("retrieveUserQuotaSummary")) return { status: 200, json: { groups: [] } };
      if (url.includes("https://cloudcode-pa.googleapis.com") && url.endsWith("retrieveUserQuota")) return { status: 200, json: { buckets: [
        { modelId: "gemini-3-flash", remainingFraction: 0.12, resetTime: "2026-10-17T11:15:41Z" },
        { modelId: "gemini-2.5-pro", remainingFraction: 0.12, resetTime: "2026-10-17T11:15:41Z" },
      ] } };
      if (url.includes("daily-cloudcode") && url.endsWith("retrieveUserQuotaSummary")) return { status: 200, json: { groups: [{ displayName: "Gemini Models", buckets: [
        { bucketId: "gemini-weekly", remainingFraction: 0.4, resetTime: "2026-10-19T10:44:08Z", window: "weekly" },
        { bucketId: "gemini-5h", remainingFraction: 0.25, resetTime: "2026-10-17T15:00:14Z", window: "5h" },
      ] }] } };
      return { status: 404, json: {} };
    } },
  });
  const result = await adapter.fetchUsage({});
  assert.deepEqual(result.windows.map((win) => win.kind), ["weekly", "five_hour"]);
  assert.equal(result.windows[1].used_pct, 75);
});

test("Gemini stops requests immediately when quota API rate limits", async () => {
  let requests = 0;
  const adapter = load("src/adapters/gemini.js", { "../http": { postJson: async () => {
    requests++;
    return requests === 1 ? { status: 200, json: {} } : { status: 429 };
  } } }, ["fetchFromHost"]);
  assert.equal((await adapter.fetchFromHost("https://example.test", "fake", {})).status, 429);
  assert.equal(requests, 2);
});

test("Codex handles daily windows and malformed reset timestamps", () => {
  const adapter = load("src/adapters/codex.js", {}, ["mapWham"]);
  const result = adapter.mapWham({ rate_limit: { primary_window: {
    used_percent: 20, limit_window_seconds: 86400, reset_at: "bad",
  } } });
  assert.equal(result.windows[0].kind, "daily");
  assert.equal(result.windows[0].used_pct, 20);
  assert.equal(result.windows[0].resets_at, null);
});

test("Codex recognizes API key logins without making subscription requests", async () => {
  const adapter = load("src/adapters/codex.js", {
    fs: { readFileSync: () => JSON.stringify({ OPENAI_API_KEY: "fake" }) },
    "../paths": { ...noPaths, codexAuth: () => "fake", fileExists: () => true },
    "../http": { getJson: () => { throw new Error("Unexpected request"); } },
  });
  assert.equal((await adapter.fetchUsage()).status.state, "unknown");
});

test("Claude does not manufacture zero utilization from a reset timestamp", () => {
  const adapter = load("src/adapters/claude.js", {}, ["mapUsage"]);
  const result = adapter.mapUsage({ five_hour: { resets_at: "2030-01-01T00:00:00Z" } }, {});
  assert.equal(result.windows[0].used_pct, null);
});

test("a usage response with no recognisable window is a failed read, so the last reading is kept", async () => {
  const claude = load("src/adapters/claude.js", {
    fs: { statSync: () => ({ mtimeMs: 1 }), readFileSync: () => JSON.stringify({ claudeAiOauth: { accessToken: "fake" } }) },
    "../paths": { ...noPaths, claudeCredentials: () => "fake", fileExists: () => true },
    "../http": { getJson: async () => ({ status: 200, json: { error: { type: "schema_changed" } } }) },
  });
  const codex = load("src/adapters/codex.js", {
    fs: { readFileSync: () => JSON.stringify({ tokens: { access_token: "fake", account_id: "acct" } }) },
    "../paths": { ...noPaths, codexAuth: () => "auth.json", fileExists: () => true },
    "../http": { getJson: async () => ({ status: 200, json: { detail: "unexpected" } }) },
  });
  for (const result of [await claude.fetchUsage({}), await codex.fetchUsage()]) {
    assert.deepEqual(result.status, { state: "fetch_failed", message: "Usage response not recognized" });
  }
  const poller = load("src/poller.js", {}, ["mergeWithCache"]);
  const cached = { id: "codex", status: { state: "ok" }, windows: [{ kind: "five_hour", label: "5h", used_pct: 40 }], fetched_at: new Date().toISOString() };
  assert.equal(poller.mergeWithCache(await codex.fetchUsage(), cached).status.state, "stale");
});

test("a usage response with its fields but no active window is a real, empty reading", async () => {
  const claude = load("src/adapters/claude.js", {
    fs: { statSync: () => ({ mtimeMs: 1 }), readFileSync: () => JSON.stringify({ claudeAiOauth: { accessToken: "fake" } }) },
    "../paths": { ...noPaths, claudeCredentials: () => "fake", fileExists: () => true },
    "../http": { getJson: async () => ({ status: 200, json: { five_hour: null, seven_day: null } }) },
  });
  const codex = load("src/adapters/codex.js", {
    fs: { readFileSync: () => JSON.stringify({ tokens: { access_token: "fake", account_id: "acct" } }) },
    "../paths": { ...noPaths, codexAuth: () => "auth.json", fileExists: () => true },
    "../http": { getJson: async () => ({ status: 200, json: { plan_type: "free", rate_limit: null } }) },
  });
  for (const result of [await claude.fetchUsage({}), await codex.fetchUsage()]) {
    assert.equal(result.status.state, "ok");
    assert.ok(result.status.hint, "the card says why there is nothing to show");
    assert.deepEqual(result.windows, []);
  }
});

test("Codex names windows of other lengths by their length, not as 5h or Weekly", () => {
  const adapter = load("src/adapters/codex.js", {}, ["mapWham"]);
  const win = (used, seconds) => ({ used_percent: used, limit_window_seconds: seconds, reset_at: 2000000000 });
  const month = adapter.mapWham({ rate_limit: { primary_window: win(40, 2592000), secondary_window: win(60, 2592000) } });
  assert.deepEqual(month.windows.map((w) => [w.kind, w.label]), [["weekly_scoped", "30d"], ["weekly_scoped", "30d"]]);
  const usual = adapter.mapWham({ rate_limit: { primary_window: win(5, 18000), secondary_window: win(20, 604800) } });
  assert.deepEqual(usual.windows.map((w) => [w.kind, w.label]), [["five_hour", "5h"], ["weekly", "Weekly"]]);
  assert.equal(adapter.mapWham({ rate_limit: { primary_window: { used_percent: 5, reset_at: 2000000000 } } }).windows[0].label, "5h", "no length: the primary fallback");
});

test("Claude preserves rate limit response after token refresh", async () => {
  let calls = 0;
  const adapter = load("src/adapters/claude.js", {
    fs: { statSync: () => ({ mtimeMs: 1 }), readFileSync: () => JSON.stringify({ claudeAiOauth: { accessToken: "fake", refreshToken: "fake" } }), writeFileSync() {}, renameSync() {} },
    "../paths": { ...noPaths, claudeCredentials: () => "fake", fileExists: () => true, writeSecretFile() {} },
    "../http": { getJson: async () => ({ status: ++calls === 1 ? 401 : 429 }), postJson: async () => ({ status: 200, json: { access_token: "fresh" } }) },
  });
  const result = await adapter.fetchUsage({});
  assert.equal(result._rateLimited, true);
  assert.equal(result.status.state, "fetch_failed");
});

test("Grok updates the selected account and avoids refreshing a rotated token twice", async () => {
  const accounts = {
    old: { key: "old-token", create_time: "2024-01-01" },
    current: { key: "current-token", create_time: "2025-01-01", expires_at: "2020-01-01", refresh_token: "fake", oidc_client_id: "fake" },
  };
  let saved;
  let refreshes = 0;
  const adapter = load("src/adapters/grok.js", {
    fs: { statSync: () => ({ mtimeMs: 1 }), readFileSync: () => JSON.stringify(accounts) },
    "../paths": { ...noPaths, grokAuth: () => "fake", fileExists: () => true, writeSecretFile: (_p, data) => { saved = JSON.parse(data); } },
    "../http": { getJson: async (url) => ({ status: url.includes("openid") ? 404 : 401 }),
      postForm: async () => { refreshes++; return { status: 200, json: { access_token: "fresh", refresh_token: "rotated" } }; } },
  });
  assert.equal((await adapter.fetchUsage({})).status.state, "logged_out");
  assert.equal(saved.old.key, "old-token");
  assert.equal(saved.current.key, "fresh");
  assert.equal(saved.current.refresh_token, "rotated");
  assert.equal(refreshes, 1);
});

test("Grok reads the saved account the user picked", async () => {
  const stored = {
    old: { key: "old-token", user_id: "old-user", email: "old@example.com", create_time: "2024-01-01" },
    current: { key: "new-token", user_id: "new-user", email: "new@example.com", create_time: "2025-01-01" },
  };
  let auth = "";
  const adapter = load("src/adapters/grok.js", {
    fs: { statSync: () => ({ mtimeMs: 1 }), readFileSync: () => JSON.stringify(stored), writeFileSync() {}, renameSync() {} },
    "../paths": { ...noPaths, grokAuth: () => "fake", fileExists: () => true },
    "../http": {
      getJson: async (_url, headers) => {
        auth = headers.Authorization;
        return { status: 200, json: { config: { creditUsagePercent: 1, currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", end: "2099-01-01T00:00:00Z" } } } };
      },
      postForm: async () => ({ status: 404 }),
      request: async () => ({ status: 404 }),
    },
  });
  assert.equal((await adapter.fetchUsage({ accounts: { grok: "old-user" } })).status.state, "ok");
  assert.match(auth, /Bearer old-token/);
  await adapter.fetchUsage({});
  assert.match(auth, /Bearer new-token/);
});

test("Grok monthly billing fallback is not mislabeled as a weekly quota", () => {
  const adapter = load("src/adapters/grok.js", {}, ["mapBilling"]);
  const result = adapter.mapBilling({ used: { val: 25 }, monthlyLimit: { val: 100 }, productUsage: [null, {}] });
  assert.equal(result.windows[0].kind, "monthly");
  assert.equal(result.windows[0].used_pct, 25);
  assert.equal(adapter.mapBilling({ used: { val: 25 }, monthlyLimit: { val: "0" } }).windows.length, 0);
});

test("Grok missing weekly usage stays unavailable despite a live period", () => {
  const adapter = load("src/adapters/grok.js", {}, ["mapBilling"]);
  const result = adapter.mapBilling({
    currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", start: "2020-01-01T00:00:00Z", end: "2099-01-01T00:00:00Z" },
    isUnifiedBillingUser: true,
  });
  assert.equal(result.windows.length, 0);
});

test("Grok does not sum productUsage when the authoritative total is absent", () => {
  const adapter = load("src/adapters/grok.js", {}, ["mapBilling"]);
  const result = adapter.mapBilling({
    currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", end: "2099-01-01T00:00:00Z" },
    productUsage: [{ product: "GrokBuild", usagePercent: 8 }, { product: "GrokChat", usagePercent: 2 }],
  });
  assert.equal(result.windows.length, 0);
});

test("Grok parses credit_usage_percent from a grok.com gRPC-web frame", () => {
  const adapter = load("src/adapters/grok.js", {}, ["parseCreditsGrpcWeb"]);
  const frame = Buffer.from("00000000070a050d00000842", "hex");
  assert.equal(adapter.parseCreditsGrpcWeb(frame).creditUsagePercent, 34);
});

test("Grok fills omitted REST usage from grok.com credits gRPC", async () => {
  const accounts = { current: { key: "tok", create_time: "2025-01-01" } };
  const grpc = Buffer.from("00000000070a050d00000842", "hex");
  const adapter = load("src/adapters/grok.js", {
    fs: { statSync: () => ({ mtimeMs: 1 }), readFileSync: () => JSON.stringify(accounts), writeFileSync() {}, renameSync() {} },
    "../paths": { ...noPaths, grokAuth: () => "fake", fileExists: () => true },
    "../http": {
      getJson: async () => ({ status: 200, json: { config: { currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", start: "2020-01-01T00:00:00Z", end: "2099-01-01T00:00:00Z" } } } }),
      postForm: async () => ({ status: 404 }),
      request: async () => ({ status: 200, buffer: grpc, headers: {} }),
    },
  });
  const result = await adapter.fetchUsage({});
  assert.equal(result.status.state, "ok");
  assert.equal(result.windows[0].kind, "weekly");
  assert.equal(result.windows[0].used_pct, 34);
});

test("a linked phone gets only current access tokens, never refresh tokens", async () => {
  const jwt = (exp) => `h.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.s`;
  const future = Math.floor(Date.now() / 1000) + 3600;
  const files = (json) => ({ readFileSync: () => JSON.stringify(json), statSync: () => ({ mtimeMs: 1 }) });

  const codexAuth = { tokens: { access_token: jwt(future), refresh_token: "rt", account_id: "acct" } };
  const codex = load("src/adapters/codex.js", { fs: files(codexAuth), "../paths": { ...noPaths, codexAuth: () => "auth.json" } });
  const linked = [codex.linkToken()];
  assert.deepEqual(linked[0], { access_token: codexAuth.tokens.access_token, account_id: "acct", expires_at: future * 1000 });
  codexAuth.tokens.access_token = jwt(future - 7200);
  assert.equal(codex.linkToken(), null, "an expired token is not handed out");

  const grokAuth = { a: { key: jwt(future), refresh_token: "rt", user_id: 7, create_time: "2026" } };
  const grok = load("src/adapters/grok.js", { fs: files(grokAuth), "../paths": { ...noPaths, grokAuth: () => "grok.json" } });
  linked.push(grok.linkToken({}));
  assert.deepEqual(linked[1], { access_token: grokAuth.a.key, user_id: "7", expires_at: future * 1000 });

  const expiresAt = Date.now() + 3_600_000;
  const claudeCreds = { claudeAiOauth: { accessToken: "at", refreshToken: "rt", expiresAt, subscriptionType: "max" } };
  const claude = load("src/adapters/claude.js", { fs: files(claudeCreds), "../paths": { ...noPaths, fileExists: () => true, claudeCredentials: () => "c.json" } });
  linked.push(await claude.linkToken());
  assert.deepEqual(linked[2], { access_token: "at", expires_at: expiresAt, plan: "Max" });

  for (const token of linked) {
    assert.ok(!Object.values(token).includes("rt"), "refresh tokens stay on the computer");
  }
});

test("each tool names its signed-in account from its own files, never from a token", async () => {
  const jwt = (claims) => `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`;
  let reads = 0;
  const claude = load("src/adapters/claude.js", {
    fs: { statSync: () => ({ mtimeMs: 1 }), readFileSync: () => { reads++; return JSON.stringify({ oauthAccount: { accountUuid: "uuid-1", emailAddress: "a@b.co" } }); } },
    "../paths": { ...noPaths, home: () => "home" },
  });
  assert.equal(claude.accountRef(), "uuid-1");
  assert.equal(claude.accountRef(), "uuid-1");
  assert.equal(reads, 1, "the global config is read again only when it changes");

  const codex = load("src/adapters/codex.js", { fs: { readFileSync: () => JSON.stringify({ tokens: { access_token: jwt({ exp: 1 }), account_id: "acct" } }) }, "../paths": { ...noPaths, codexAuth: () => "auth.json" } });
  assert.equal(codex.accountRef(), "acct", "even while the token is expired");

  const stored = { old: { key: "k1", user_id: 7, create_time: "2024" }, current: { key: "k2", user_id: 8, create_time: "2025" } };
  const grok = load("src/adapters/grok.js", { fs: { statSync: () => ({ mtimeMs: 1 }), readFileSync: () => JSON.stringify(stored) }, "../paths": { ...noPaths, grokAuth: () => "grok.json" } });
  assert.equal(grok.accountRef({}), "8");
  assert.equal(grok.accountRef({ accounts: { grok: 7 } }), "7");

  let session = jwt({ sub: "user|1", exp: 2000000000, randomness: "a" });
  const cursor = load("src/adapters/cursor.js", { fs: { readFileSync: () => JSON.stringify({ accessToken: session }) }, "../paths": { ...noPaths, cursorAuth: () => "auth.json", cursorStateDb: () => "state.vscdb" } });
  assert.equal(cursor.accountRef(), "user|1");
  session = jwt({ sub: "user|1", exp: 2000003600, randomness: "b" });
  assert.equal(cursor.accountRef(), "user|1", "a renewed session is the same account");

  const saved = { token: { access_token: "a", refresh_token: "r" }, id_token: jwt({ sub: "google-1", email: "g@b.co" }) };
  const gem = load("src/adapters/gemini.js", {
    fs: { readFileSync: (p) => { if (p !== "token") throw new Error("ENOENT"); return JSON.stringify(saved); } },
    "../wincred": { readGenericCredential: async () => null },
    "../paths": { ...noPaths, antigravityToken: () => "token", geminiOAuth: () => "oauth" },
  });
  assert.equal(await gem.accountRef(), "google-1");
  delete saved.id_token;
  assert.equal(await gem.accountRef(), null, "no ID token: unidentified, not the token");
});

test("Grok does not refresh and rewrite the CLI's login on every poll while billing answers 403", async () => {
  const stored = { a: { key: "tok", refresh_token: "rt", oidc_client_id: "client", user_id: "u", expires_at: new Date(Date.now() + 3600000).toISOString() } };
  let refreshes = 0, writes = 0;
  const adapter = load("src/adapters/grok.js", {
    fs: { statSync: () => ({ mtimeMs: 1 }), readFileSync: () => JSON.stringify(stored) },
    "../paths": { ...noPaths, grokAuth: () => "grok.json", fileExists: () => true, writeSecretFile: () => { writes++; } },
    "../http": { getJson: async (url) => ({ status: url.includes("openid") ? 404 : 403 }),
      postForm: async () => { refreshes++; return { status: 200, json: { access_token: `tok${refreshes}`, refresh_token: `rt${refreshes}` } }; } },
  });
  for (let i = 0; i < 3; i++) assert.equal((await adapter.fetchUsage({})).status.state, "fetch_failed");
  assert.equal(refreshes, 1, "one refresh tells whether the 403 was an old token");
  assert.equal(writes, 1);
});

test("a refused refresh token is not resent on every poll", async () => {
  const expired = { claudeAiOauth: { accessToken: "old", refreshToken: "dead-1", expiresAt: Date.now() - 1000 } };
  let tokenStatus = 429, tokenCalls = 0;
  const claude = load("src/adapters/claude.js", {
    fs: { statSync: () => ({ mtimeMs: 1 }), readFileSync: () => JSON.stringify(expired) },
    "../paths": { ...noPaths, claudeCredentials: () => "c.json", fileExists: () => true, writeSecretFile() {} },
    "../http": { getJson: async () => ({ status: 401 }), postJson: async () => { tokenCalls++; return { status: tokenStatus, headers: { "retry-after": "120" } }; } },
  });
  const limited = await claude.fetchUsage({});
  assert.equal(limited.status.state, "fetch_failed", "a throttled token server is not a sign-out");
  assert.equal(limited._rateLimited, true);
  assert.equal(limited._retryAfter, "120");
  await claude.fetchUsage({});
  assert.equal(tokenCalls, 1, "one token request across two polls, not two per poll");
  Object.assign(expired.claudeAiOauth, { refreshToken: "dead-2" }); tokenStatus = 503;
  assert.equal((await claude.fetchUsage({})).status.message, "HTTP 503");
  Object.assign(expired.claudeAiOauth, { refreshToken: "dead-3" }); tokenStatus = 400;
  assert.equal((await claude.fetchUsage({})).status.state, "logged_out");
  assert.equal((await claude.fetchUsage({})).status.state, "logged_out");
  assert.equal(tokenCalls, 3);

  let refreshes = 0;
  const grok = load("src/adapters/grok.js", {
    fs: { statSync: () => ({ mtimeMs: 1 }), readFileSync: () => JSON.stringify({ a: { key: "tok", refresh_token: "dead", oidc_client_id: "client", user_id: "u", expires_at: "2020-01-01" } }) },
    "../paths": { ...noPaths, grokAuth: () => "grok.json", fileExists: () => true, writeSecretFile() {} },
    "../http": { getJson: async (url) => ({ status: url.includes("openid") ? 404 : 401 }), postForm: async () => { refreshes++; return { status: 400 }; } },
  });
  for (let i = 0; i < 3; i++) assert.equal((await grok.fetchUsage({})).status.state, "logged_out");
  assert.equal(refreshes, 1);
});

test("refreshed tokens survive a failed write, and the failed write leaves no copy behind", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "um-secret-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const target = path.join(dir, "auth.json");
  fs.mkdirSync(target);
  const { writeSecretFile } = require("../src/paths");
  assert.throws(() => writeSecretFile(target, "secret"));
  assert.equal(fs.existsSync(`${target}.tmp`), false);

  const fail = () => { throw new Error("EPERM"); };
  const fresh = { status: 200, json: { access_token: "fresh", refresh_token: "rotated", expires_in: 3600 } };
  let refreshes = 0;
  const seen = [];
  const creds = { claudeAiOauth: { accessToken: "old", refreshToken: "rt", expiresAt: Date.now() - 1000 } };
  const claude = load("src/adapters/claude.js", {
    fs: { statSync: () => ({ mtimeMs: 1 }), readFileSync: () => JSON.stringify(creds) },
    "../paths": { ...noPaths, claudeCredentials: () => "c.json", fileExists: () => true, writeSecretFile: fail },
    "../http": { getJson: async (_url, headers) => { seen.push(headers.Authorization); return { status: 200, json: {} }; }, postJson: async () => { refreshes++; return fresh; } },
  });
  await claude.fetchUsage({}); await claude.fetchUsage({});
  assert.deepEqual(seen, ["Bearer fresh", "Bearer fresh"]);
  assert.equal(refreshes, 1, "the spent refresh token is not sent again");
  assert.equal((await claude.linkToken()).access_token, "fresh");

  seen.length = 0;
  const stored = { a: { key: "old", refresh_token: "rt", oidc_client_id: "client", user_id: "u", expires_at: "2020-01-01" } };
  const grok = load("src/adapters/grok.js", {
    fs: { statSync: () => ({ mtimeMs: 1 }), readFileSync: () => JSON.stringify(stored) },
    "../paths": { ...noPaths, grokAuth: () => "grok.json", fileExists: () => true, writeSecretFile: fail },
    "../http": {
      getJson: async (url, headers) => {
        if (url.includes("openid")) return { status: 404 };
        seen.push(headers.Authorization);
        return { status: 200, json: { config: { creditUsagePercent: 1, currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", end: "2099-01-01T00:00:00Z" } } } };
      },
      postForm: async () => { refreshes++; return fresh; },
    },
  });
  await grok.fetchUsage({}); await grok.fetchUsage({});
  assert.deepEqual(seen, ["Bearer fresh", "Bearer fresh"]);
  assert.equal(refreshes, 2);
  assert.equal(grok.linkToken({}).access_token, "fresh");
});

test("Gemini reads a new sign-in at once instead of a remembered token", async () => {
  const saved = { token: { access_token: "OLD", refresh_token: "rt", expiry: new Date(Date.now() + 3600000).toISOString() } };
  const valid = new Set(["OLD"]);
  const used = [];
  const adapter = load("src/adapters/gemini.js", {
    fs: { readFileSync: (p) => { if (p !== "token") throw new Error("ENOENT"); return JSON.stringify(saved); } },
    "../wincred": { readGenericCredential: async () => null },
    "../paths": { ...noPaths, cliOnPath: () => true, antigravityToken: () => "token", geminiOAuth: () => "oauth", agyBinaryCandidates: () => [], cliPath: () => null },
    "../http": {
      postJson: async (url, headers) => {
        const token = headers.Authorization.slice(7);
        used.push(token);
        if (!valid.has(token)) return { status: 401 };
        return { status: 200, json: url.endsWith("loadCodeAssist") ? {} : { groups: [{ displayName: "Gemini", buckets: [{ bucketId: "gemini-5h", window: "5h", remainingFraction: 0.5 }] }] } };
      },
      postForm: async () => ({ status: 400 }),
    },
  });
  assert.equal((await adapter.fetchUsage({})).status.state, "ok");
  valid.delete("OLD"); valid.add("NEW"); saved.token.access_token = "NEW";
  used.length = 0;
  assert.equal((await adapter.fetchUsage({})).status.state, "ok");
  assert.deepEqual([...new Set(used)], ["NEW"]);
});

test("Gemini keeps quota read before a 429 unless it is an all-zero placeholder", async (t) => {
  const prev = process.env.ANTIGRAVITY_ACCESS_TOKEN;
  process.env.ANTIGRAVITY_ACCESS_TOKEN = "fake";
  t.after(() => {
    if (prev == null) delete process.env.ANTIGRAVITY_ACCESS_TOKEN;
    else process.env.ANTIGRAVITY_ACCESS_TOKEN = prev;
  });
  let remainingFraction = 0.3;
  const adapter = load("src/adapters/gemini.js", {
    "../wincred": { readGenericCredential: async () => null },
    "../paths": { ...noPaths, cliOnPath: () => true, geminiOAuth: () => "oauth", antigravityToken: () => "token", agyBinaryCandidates: () => [], cliPath: () => null },
    "../http": { postJson: async (url) => {
      if (url.endsWith("loadCodeAssist")) return { status: 200, json: {} };
      if (url.endsWith("retrieveUserQuotaSummary")) return { status: 200, json: { groups: [{ displayName: "Gemini", buckets: [{ bucketId: "gemini-weekly", window: "weekly", remainingFraction, resetTime: "2099-01-01T00:00:00Z" }] }] } };
      return { status: 429, headers: { "retry-after": "30" } };
    } },
  });
  const kept = await adapter.fetchUsage({});
  assert.equal(kept.status.state, "ok");
  assert.equal(Math.round(kept.windows[0].used_pct), 70);
  assert.equal(kept._rateLimited, true, "still backs off");
  assert.ok(Date.parse(kept._retryAfter) > Date.now());
  remainingFraction = 1;
  const placeholder = await adapter.fetchUsage({});
  assert.equal(placeholder.status.state, "fetch_failed");
  assert.equal(placeholder._rateLimited, true);
});

test("Codex reads per-model limits in the nested and the flat layout; a blank remaining is not 100%; 403 is retryable", async () => {
  const adapter = load("src/adapters/codex.js", {}, ["mapWham"]);
  const win = (used, seconds) => ({ used_percent: used, limit_window_seconds: seconds, reset_at: 2000000000 });
  const nested = adapter.mapWham({ rate_limit: { primary_window: win(40, 18000) }, additional_rate_limits: [
    { limit_name: "Spark", metered_feature: "spark", rate_limit: { allowed: true, limit_reached: false, primary_window: win(97, 18000), secondary_window: win(20, 604800) } },
  ] });
  assert.deepEqual(nested.windows.map((w) => [w.label, w.used_pct]), [["5h", 40], ["Spark 5h", 97], ["Spark Weekly", 20]]);
  const flat = adapter.mapWham({ additional_rate_limits: [{ name: "Spark", primary_window: win(5, 18000) }] });
  assert.deepEqual(flat.windows.map((w) => [w.label, w.used_pct]), [["Spark 5h", 5]]);
  for (const remaining_percent of ["", false, []]) {
    assert.equal(adapter.mapWham({ rate_limit: { primary_window: { remaining_percent, limit_window_seconds: 18000 } } }).windows[0].used_pct, null);
  }
  assert.equal(adapter.mapWham({ rate_limit: { primary_window: { remaining_percent: "25", limit_window_seconds: 18000 } } }).windows[0].used_pct, 75);

  const forbidden = load("src/adapters/codex.js", {
    fs: { readFileSync: () => JSON.stringify({ tokens: { access_token: "fake", account_id: "acct" } }) },
    "../paths": { ...noPaths, codexAuth: () => "auth.json", fileExists: () => true },
    "../http": { getJson: async () => ({ status: 403 }) },
  });
  assert.equal((await forbidden.fetchUsage()).status.state, "fetch_failed");
});
