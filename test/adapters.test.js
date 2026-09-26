const test = require("node:test");
const assert = require("node:assert/strict");
const { load } = require("./helpers");

const noPaths = { cliOnPath: () => false, fileExists: () => false };
const gemini = load("src/adapters/gemini.js", {}, ["mapSummary", "mapModels", "usedFromFraction", "expiryEpoch", "fetchFromHost"]);

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
    "claude-opus": { quotaInfo: { remainingFraction: 0 } },
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

test("Claude preserves rate limit response after token refresh", async () => {
  let calls = 0;
  const adapter = load("src/adapters/claude.js", {
    fs: { statSync: () => ({ mtimeMs: 1 }), readFileSync: () => JSON.stringify({ claudeAiOauth: { accessToken: "fake", refreshToken: "fake" } }), writeFileSync() {}, renameSync() {} },
    "../paths": { ...noPaths, claudeCredentials: () => "fake", fileExists: () => true },
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
    fs: { statSync: () => ({ mtimeMs: 1 }), readFileSync: () => JSON.stringify(accounts),
      writeFileSync: (_p, data) => { saved = JSON.parse(data); }, renameSync() {} },
    "../paths": { ...noPaths, grokAuth: () => "fake", fileExists: () => true },
    "../http": { getJson: async (url) => ({ status: url.includes("openid") ? 404 : 401 }),
      postForm: async () => { refreshes++; return { status: 200, json: { access_token: "fresh", refresh_token: "rotated" } }; } },
  });
  assert.equal((await adapter.fetchUsage({})).status.state, "logged_out");
  assert.equal(saved.old.key, "old-token");
  assert.equal(saved.current.key, "fresh");
  assert.equal(saved.current.refresh_token, "rotated");
  assert.equal(refreshes, 1);
});

test("Grok monthly billing fallback is not mislabeled as a weekly quota", () => {
  const adapter = load("src/adapters/grok.js", {}, ["mapBilling"]);
  const result = adapter.mapBilling({ used: { val: 25 }, monthlyLimit: { val: 100 }, productUsage: [null, {}] });
  assert.equal(result.windows[0].kind, "monthly");
  assert.equal(result.windows[0].used_pct, 25);
  assert.equal(adapter.mapBilling({ used: { val: 25 }, monthlyLimit: { val: "0" } }).windows.length, 0);
});

test("Grok omitted proto3 weekly percent is 0% while the period is live", () => {
  const adapter = load("src/adapters/grok.js", {}, ["mapBilling"]);
  const result = adapter.mapBilling({
    currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", start: "2020-01-01T00:00:00Z", end: "2099-01-01T00:00:00Z" },
    isUnifiedBillingUser: true,
  });
  assert.equal(result.windows[0].kind, "weekly");
  assert.equal(result.windows[0].used_pct, 0);
  assert.equal(result.windows[0].resets_at, "2099-01-01T00:00:00.000Z");
});

test("Grok uses productUsage when creditUsagePercent is absent", () => {
  const adapter = load("src/adapters/grok.js", {}, ["mapBilling"]);
  const result = adapter.mapBilling({
    currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", end: "2099-01-01T00:00:00Z" },
    productUsage: [{ product: "GrokBuild", usagePercent: 8 }, { product: "GrokChat", usagePercent: 2 }],
  });
  assert.equal(result.windows[0].kind, "weekly");
  assert.equal(result.windows[0].used_pct, 10);
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
