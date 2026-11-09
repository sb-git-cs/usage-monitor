const test = require("node:test");
const assert = require("node:assert/strict");
const { load } = require("./helpers");

const DAILY_RESET = 1800000000;
const WEEKLY_RESET = 1800500000;

const userStatus = (planStatus, extra = {}) => ({ userStatus: { email: "dev@example.com", planStatus, ...extra } });

// Loads the adapter against fake files, editor databases and network answers.
function setup({ dbs = {}, files = [], onPath = false, answers = [], observed = [] } = {}) {
  const calls = [];
  const paths = {
    devinStateDbs: () => ["/u/Devin/state.vscdb", "/u/Windsurf/state.vscdb"],
    devinDataDir: () => "/data/devin",
    localAppData: () => "/local",
    cliOnPath: () => onPath,
    fileExists: (p) => files.includes(p) || p in dbs,
  };
  const adapter = load("src/adapters/windsurf.js", {
    "../paths": paths,
    "../cursor-local": { readValue: (db, key) => (dbs[db] || {})[key] || "" },
    "../accounts": { observe: (...args) => observed.push(args) },
    "../http": {
      postJson: async (url, headers, obj) => {
        calls.push({ url, headers, obj });
        const answer = answers[calls.length - 1];
        if (answer instanceof Error) throw answer;
        return answer;
      },
    },
    fs: { statSync: () => ({ mtimeMs: Date.now() - 120000 }) },
  });
  return { adapter, calls };
}

const signedIn = { "/u/Devin/state.vscdb": { windsurfAuthStatus: JSON.stringify({ apiKey: "sk-secret" }) } };
const ok = (planStatus, extra) => ({ status: 200, json: userStatus(planStatus, extra), headers: {} });

test("daily and weekly remaining percents become used windows with reset times", () => {
  const { adapter } = setup();
  const mapped = adapter.mapUserStatus(userStatus({
    dailyQuotaRemainingPercent: 75, dailyQuotaResetAtUnix: DAILY_RESET,
    weeklyQuotaRemainingPercent: 40, weeklyQuotaResetAtUnix: WEEKLY_RESET,
    planInfo: { planName: "Pro" },
  }).userStatus);
  assert.equal(mapped.plan, "Pro");
  assert.equal(mapped.email, "dev@example.com");
  assert.deepEqual(mapped.windows.map((w) => [w.kind, w.label, w.used_pct]), [["daily", "Daily", 25], ["weekly", "Weekly", 60]]);
  assert.equal(mapped.windows[0].resets_at, new Date(DAILY_RESET * 1000).toISOString());
  assert.equal(mapped.windows[1].resets_at, new Date(WEEKLY_RESET * 1000).toISOString());
});

test("hideDailyQuota drops the daily window only", () => {
  const { adapter } = setup();
  const mapped = adapter.mapUserStatus(userStatus({
    dailyQuotaRemainingPercent: 75, weeklyQuotaRemainingPercent: 40, planInfo: { planName: "Max", hideDailyQuota: true },
  }).userStatus);
  assert.deepEqual(mapped.windows.map((w) => w.kind), ["weekly"]);
});

test("a positive overage balance adds an unmetered extra usage window, zero or absent adds none", () => {
  const { adapter } = setup();
  const base = { weeklyQuotaRemainingPercent: 10 };
  const withOverage = adapter.mapUserStatus(userStatus({ ...base, overageBalanceMicros: "12345678" }).userStatus);
  const extra = withOverage.windows.find((w) => w.kind === "credits");
  assert.equal(extra.label, "Extra usage $12.35");
  assert.equal(extra.used_pct, null);
  for (const overage of [0, "0", undefined]) {
    const none = adapter.mapUserStatus(userStatus({ ...base, overageBalanceMicros: overage }).userStatus);
    assert.equal(none.windows.some((w) => w.kind === "credits"), false);
  }
});

test("legacy prompt credits give a monthly window only when the quota percents are absent", () => {
  const { adapter } = setup();
  const legacy = adapter.mapUserStatus(userStatus({ usedPromptCredits: 2500, availablePromptCredits: 7500 }).userStatus);
  assert.deepEqual(legacy.windows.map((w) => [w.kind, w.label, w.used_pct]), [["monthly", "Credits", 25]]);
  const modern = adapter.mapUserStatus(userStatus({ weeklyQuotaRemainingPercent: 50, usedPromptCredits: 2500, availablePromptCredits: 7500 }).userStatus);
  assert.deepEqual(modern.windows.map((w) => w.kind), ["weekly"]);
});

test("the first database holding a string apiKey is used", () => {
  const dbs = {
    "/u/Devin/state.vscdb": { windsurfAuthStatus: "not json" },
    "/u/Windsurf/state.vscdb": { windsurfAuthStatus: JSON.stringify({ apiKey: "sk-second" }) },
  };
  assert.deepEqual(setup({ dbs }).adapter.editorKey(), { db: "/u/Windsurf/state.vscdb", key: "sk-second" });
  const numeric = { "/u/Devin/state.vscdb": { windsurfAuthStatus: JSON.stringify({ apiKey: 7 }) } };
  assert.equal(setup({ dbs: numeric }).adapter.editorKey(), null);
});

test("a 200 sends the key in the body only and reports the usage", async () => {
  const observed = [];
  const { adapter, calls } = setup({ dbs: signedIn, answers: [ok({ dailyQuotaRemainingPercent: 90, weeklyQuotaRemainingPercent: 80, planInfo: { planName: "Pro" } })], observed });
  const result = await adapter.fetchUsage();
  assert.equal(result.status.state, "ok");
  assert.equal(result.plan, "Pro");
  assert.equal(result.windows.length, 2);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://server.self-serve.windsurf.com/exa.seat_management_pb.SeatManagementService/GetUserStatus");
  assert.equal(calls[0].headers["Connect-Protocol-Version"], "1");
  assert.equal(calls[0].obj.metadata.apiKey, "sk-secret");
  assert.equal(JSON.stringify(calls[0].headers).includes("sk-secret"), false);
  assert.equal(JSON.stringify(result).includes("sk-secret"), false);
  assert.deepEqual(observed, [["windsurf", "dev@example.com", "dev@example.com"]]);
  assert.equal(adapter.accountRef(), "dev@example.com");
});

test("accountRef is null before any reading and never the key", () => {
  assert.equal(setup({ dbs: signedIn }).adapter.accountRef(), null);
});

test("a 404 or a network error on the first host retries on the second", async () => {
  for (const first of [{ status: 404, json: null, headers: {} }, new Error("ENOTFOUND")]) {
    const { adapter, calls } = setup({ dbs: signedIn, answers: [first, ok({ weeklyQuotaRemainingPercent: 70 })] });
    const result = await adapter.fetchUsage();
    assert.equal(calls.length, 2);
    assert.equal(calls[1].url.startsWith("https://server.codeium.com/"), true);
    assert.equal(result.windows[0].used_pct, 30);
  }
});

test("401 and 403 mean logged out without a retry", async () => {
  for (const status of [401, 403]) {
    const { adapter, calls } = setup({ dbs: signedIn, answers: [{ status, json: null, headers: {} }] });
    const result = await adapter.fetchUsage();
    assert.equal(result.status.state, "logged_out");
    assert.equal(calls.length, 1);
  }
});

test("429 is a rate-limited fetch failure carrying retry-after", async () => {
  const { adapter } = setup({ dbs: signedIn, answers: [{ status: 429, json: null, headers: { "retry-after": "30" } }] });
  const result = await adapter.fetchUsage();
  assert.equal(result.status.state, "fetch_failed");
  assert.equal(result._rateLimited, true);
  assert.equal(result._retryAfter, "30");
});

test("a failed call falls back to the editor's cached plan as a stale reading", async () => {
  const cached = JSON.stringify({ planName: "Pro", quotaUsage: { dailyRemainingPercent: 60, weeklyRemainingPercent: 30, dailyResetAtUnix: DAILY_RESET, weeklyResetAtUnix: WEEKLY_RESET } });
  const dbs = { "/u/Devin/state.vscdb": { ...signedIn["/u/Devin/state.vscdb"], "windsurf.settings.cachedPlanInfo": cached } };
  for (const answers of [[new Error("down"), new Error("down")], [{ status: 500, json: null, headers: {} }]]) {
    const { adapter } = setup({ dbs, answers });
    const result = await adapter.fetchUsage();
    assert.equal(result.status.state, "stale");
    assert.equal(result.status.age_secs, 120);
    assert.equal(result.source, "cache");
    assert.equal(result.plan, "Pro");
    assert.deepEqual(result.windows.map((w) => [w.kind, w.used_pct]), [["daily", 40], ["weekly", 70]]);
  }
});

test("a failed call with no cached plan is a fetch failure", async () => {
  const { adapter } = setup({ dbs: signedIn, answers: [{ status: 500, json: null, headers: {} }] });
  const result = await adapter.fetchUsage();
  assert.equal(result.status.state, "fetch_failed");
});

test("no key: not installed, signed out, or CLI-only", async () => {
  assert.equal((await setup().adapter.fetchUsage()).status.state, "not_installed");
  const out = await setup({ dbs: { "/u/Devin/state.vscdb": {} } }).adapter.fetchUsage();
  assert.equal(out.status.state, "logged_out");
  assert.match(out.status.hint, /devin auth login/);
  assert.equal((await setup({ onPath: true }).adapter.fetchUsage()).status.state, "logged_out");
  const cli = setup({ files: [require("node:path").join("/data/devin", "credentials.toml")] });
  const result = await cli.adapter.fetchUsage();
  assert.equal(result.status.state, "ok");
  assert.equal(result.status.hint, "Usage is read from Devin Desktop");
  assert.deepEqual(result.windows, []);
  assert.equal(cli.calls.length, 0);
});
