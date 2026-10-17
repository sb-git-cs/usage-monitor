const test = require("node:test");
const assert = require("node:assert/strict");
const { load } = require("./helpers");

const noPaths = { cliOnPath: () => false, fileExists: () => false };
const gemini = load("src/adapters/gemini.js", {}, ["mapSummary", "mapModels", "mapQuotaBuckets", "usedFromFraction", "expiryEpoch", "fetchFromHost"]);

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
