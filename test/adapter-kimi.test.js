const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { load } = require("./helpers");

const SECRET = "tok-secret-0123456789";

function setup(t, { files = {}, calls = [], reply = {}, onPath = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "um-kimi-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [name, text] of Object.entries(files)) {
    const file = path.join(dir, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof text === "string" ? text : JSON.stringify(text));
  }
  const observed = [];
  const adapter = load("src/adapters/kimi.js", {
    "../paths": { kimiCodeHome: () => dir, cliOnPath: () => onPath, fileExists: fs.existsSync },
    "../accounts": { observe: (...a) => observed.push(a) },
    "../http": {
      getJson: async (url, headers) => {
        calls.push({ url, headers });
        const r = reply[url.endsWith("/me") ? "me" : "usages"];
        if (r instanceof Error) throw r;
        return r || { status: 200, json: {}, headers: {} };
      },
    },
  });
  return { adapter, observed, calls, dir };
}

const future = () => Math.floor(Date.now() / 1000) + 3600;
const signedIn = (extra = {}) => ({ "credentials/kimi-code.json": { access_token: SECRET, expires_at: future(), ...extra } });

test("new plans report only the 5-hour bucket, string ratios and all three reset formats work", (t) => {
  const { adapter } = setup(t);
  const iso = "2026-11-10T15:00:00.000Z";
  const sec = Date.parse(iso) / 1000;
  const w = adapter.mapWindows({ limit_5h: { used_ratio: "0.25", reset_time: iso } });
  assert.equal(w.length, 1);
  assert.equal(w[0].kind, "five_hour");
  assert.equal(w[0].label, "5h");
  assert.equal(w[0].used_pct, 25);
  assert.equal(w[0].resets_at, iso);
  assert.equal(adapter.resetsAt(sec), iso);
  assert.equal(adapter.resetsAt(sec * 1000), iso);
  assert.equal(adapter.resetsAt(String(sec)), iso);
  assert.equal(adapter.resetsAt("nonsense"), null);
  assert.equal(adapter.resetsAt(undefined), null);
});

test("legacy plans map all four buckets in order and skip a bucket without a ratio", (t) => {
  const { adapter } = setup(t);
  const all = adapter.mapWindows({
    limit_5h: { used_ratio: 0.1 }, limit_7d: { used_ratio: 0.5 },
    limit_month_total: { used_ratio: "0.75" }, limit_month_code: { used_ratio: 1 },
  });
  assert.deepEqual(all.map((x) => [x.kind, x.label, x.used_pct]), [
    ["five_hour", "5h", 10], ["weekly", "Weekly", 50], ["monthly", "Monthly", 75], ["monthly", "Code", 100],
  ]);
  const some = adapter.mapWindows({ limit_5h: { used_ratio: null }, limit_7d: { used_ratio: "" }, limit_month_total: {}, limit_month_code: { used_ratio: 0.2 } });
  assert.deepEqual(some.map((x) => x.label), ["Code"]);
  assert.deepEqual(adapter.mapWindows(null), []);
});

test("a good answer gives windows, the plan and the account, and sends the documented request", async (t) => {
  const usages = { usages: { limit_5h: { used_ratio: 0.4 }, limit_7d: { used_ratio: 0.2 } } };
  const { adapter, observed, calls } = setup(t, {
    files: signedIn(),
    reply: { usages: { status: 200, json: usages, headers: {} }, me: { status: 200, json: { user_level_name: "Moderato", email: "a@b.co" }, headers: {} } },
  });
  assert.equal(adapter.accountRef(), null);
  const r = await adapter.fetchUsage();
  assert.equal(r.status.state, "ok");
  assert.equal(r.plan, "Moderato");
  assert.equal(r.windows.length, 2);
  assert.deepEqual(observed, [["kimi", "a@b.co", "a@b.co"]]);
  assert.equal(adapter.accountRef(), "a@b.co");
  assert.deepEqual(calls.map((c) => c.url).sort(), ["https://api.kimi.ai/coding/v1/me", "https://api.kimi.ai/coding/v1/usages"]);
  assert.equal(calls[0].headers.Authorization, `Bearer ${SECRET}`);
  assert.equal(calls[0].headers.Accept, "application/json");
  assert.equal(calls[0].headers["User-Agent"], "usage-monitor");
  assert.ok(!JSON.stringify(r).includes(SECRET));
});

test("a failing /me keeps the usage and the account reference stays unset", async (t) => {
  const { adapter } = setup(t, {
    files: signedIn(),
    reply: { usages: { status: 200, json: { usages: { limit_5h: { used_ratio: 0.4 } } }, headers: {} }, me: new Error("down") },
  });
  const r = await adapter.fetchUsage();
  assert.equal(r.status.state, "ok");
  assert.equal(r.plan, null);
  assert.equal(adapter.accountRef(), null);
});

test("region marker and KIMI_CODE_BASE_URL choose the host, with or without the /coding/v1 prefix", async (t) => {
  const mainland = setup(t, { files: { ...signedIn(), region: "mainland-cn\n" } });
  await mainland.adapter.fetchUsage();
  assert.equal(mainland.calls[0].url, "https://api.kimi.com/coding/v1/usages");
  for (const value of ["https://proxy.test", "https://proxy.test/", "https://proxy.test/coding/v1"]) {
    const prev = process.env.KIMI_CODE_BASE_URL;
    process.env.KIMI_CODE_BASE_URL = value;
    t.after(() => { if (prev === undefined) delete process.env.KIMI_CODE_BASE_URL; else process.env.KIMI_CODE_BASE_URL = prev; });
    const s = setup(t, { files: signedIn() });
    await s.adapter.fetchUsage();
    assert.equal(s.calls[0].url, "https://proxy.test/coding/v1/usages");
  }
});

test("no sign-in: not installed without the tool, logged out with it", async (t) => {
  const none = setup(t);
  fs.rmSync(none.dir, { recursive: true, force: true });
  const r = await none.adapter.fetchUsage();
  assert.equal(r.status.state, "not_installed");
  const present = setup(t);
  const p = await present.adapter.fetchUsage();
  assert.equal(p.status.state, "logged_out");
  assert.equal(p.status.hint, "Run: kimi login");
  assert.equal((await setup(t, { onPath: true }).adapter.fetchUsage()).status.state, "logged_out");
});

test("an expired token is logged out and no request is made", async (t) => {
  const s = setup(t, { files: { "credentials/kimi-code.json": { access_token: SECRET, expires_at: 1000 } } });
  const r = await s.adapter.fetchUsage();
  assert.equal(r.status.state, "logged_out");
  assert.equal(r.status.hint, "Run: kimi login");
  assert.equal(s.calls.length, 0);
});

test("another credentials file with an access token is used; the config.toml key is the fallback", async (t) => {
  const other = setup(t, { files: { "credentials/zzz.json": { access_token: "other-token-1234567" }, "credentials/readme.json": { note: 1 } } });
  await other.adapter.fetchUsage();
  assert.equal(other.calls[0].headers.Authorization, "Bearer other-token-1234567");
  const toml = [
    "[providers.\"other\"]", "api_key = \"wrong\"",
    "[providers.\"managed:kimi-code\"]", "base_url = \"x\"", "api_key = \"sk-kimi-abc\" # note",
    "[models]", "api_key = \"nope\"",
  ].join("\r\n");
  const key = setup(t, { files: { "config.toml": toml } });
  await key.adapter.fetchUsage();
  assert.equal(key.calls[0].headers.Authorization, "Bearer sk-kimi-abc");
  const expired = setup(t, { files: { "credentials/kimi-code.json": { access_token: SECRET, expires_at: 1000 }, "config.toml": toml } });
  await expired.adapter.fetchUsage();
  assert.equal(expired.calls[0].headers.Authorization, "Bearer sk-kimi-abc");
});

test("HTTP failures map to states", async (t) => {
  const run = async (res) => (await setup(t, { files: signedIn(), reply: { usages: res } }).adapter.fetchUsage());
  const unauthorized = await run({ status: 401, json: null, headers: {} });
  assert.equal(unauthorized.status.state, "logged_out");
  assert.equal(unauthorized.status.hint, "Run: kimi login");
  const missing = await run({ status: 404, json: null, headers: {} });
  assert.equal(missing.status.state, "fetch_failed");
  assert.equal(missing.status.message, "usage endpoint unavailable");
  const limited = await run({ status: 429, json: null, headers: { "retry-after": "30" } });
  assert.equal(limited.status.state, "fetch_failed");
  assert.equal(limited._rateLimited, true);
  assert.equal(limited._retryAfter, "30");
  const broken = await run({ status: 500, json: null, headers: {} });
  assert.equal(broken.status.message, "HTTP 500");
  const thrown = await run(new Error("offline"));
  assert.equal(thrown.status.state, "fetch_failed");
  assert.ok(!JSON.stringify(thrown).includes(SECRET));
});
