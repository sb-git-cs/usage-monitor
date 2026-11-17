const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { scanTokens, modelExport } = require("../src/tokens");

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "um-tokens-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const claudeDir = path.join(dir, "claude");
  const codexDir = path.join(dir, "codex");
  fs.mkdirSync(path.join(claudeDir, "projects"), { recursive: true });
  fs.mkdirSync(path.join(codexDir, "sessions"), { recursive: true });
  return { dir, claudeDir, codexDir };
}

test("model reports deduplicate streamed Claude messages and exclude future records and private content", async (t) => {
  const f = fixture(t), now = Date.now();
  const row = (output, time = now - 1000) => ({ type: "assistant", timestamp: new Date(time).toISOString(),
    message: { id: "same-message", model: "claude-sonnet", content: "PRIVATE PROMPT", usage: { input_tokens: 100, output_tokens: output } } });
  fs.writeFileSync(path.join(f.claudeDir, "projects", "private-session.jsonl"),
    [row(10), row(30), { ...row(999, now + 60000), message: { ...row(999).message, id: "future" } }].map(JSON.stringify).join("\n"));
  const result = await scanTokens({ ...f, now });
  assert.equal(result.summary.total, 130);
  assert.equal(result.summary.turns, 1);
  assert.equal(result.by_session.length, 1);
  assert.match(result.by_session[0].id, /^[a-f0-9]{16}$/);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE PROMPT|private-session|um-tokens/);
});

test("Codex reports use cumulative deltas, actual models and cached input as a subset", async (t) => {
  const f = fixture(t), now = Date.now();
  const token = (input, output, cached) => ({ timestamp: new Date(now - 1000).toISOString(),
    payload: { type: "token_count", info: { total_token_usage: { input_tokens: input, output_tokens: output, cached_input_tokens: cached },
      last_token_usage: { input_tokens: 100, output_tokens: 20, cached_input_tokens: 80 } } } });
  const context = (model) => ({ type: "turn_context", payload: { model } });
  fs.writeFileSync(path.join(f.codexDir, "sessions", "rollout.jsonl"),
    [context("gpt-one"), token(100, 20, 80), token(100, 20, 80), context("gpt-two"), token(300, 70, 230)].map(JSON.stringify).join("\n"));
  const result = await scanTokens({ ...f, now });
  assert.equal(result.summary.total, 370);
  assert.equal(result.summary.turns, 2);
  assert.equal(result.summary.input, 70);
  assert.equal(result.summary.cache_read, 230);
  assert.deepEqual(result.by_model.map((m) => m.model), ["gpt-two", "gpt-one"]);
  assert.equal(result.by_model[0].daily[0].total, 250);
});

test("sessions are named by folder and title, split by model, and a sub-agent counts toward its session", async (t) => {
  const f = fixture(t), now = Date.now(), at = new Date(now - 60_000).toISOString();
  const project = path.join(f.claudeDir, "projects", "C--work-shop");
  fs.mkdirSync(path.join(project, "s1", "subagents"), { recursive: true });
  const assistant = (id, model, usage) => ({ type: "assistant", timestamp: at, cwd: "C:\\work\\shop", message: { id, model, content: "SECRET CONTENT", usage } });
  fs.writeFileSync(path.join(project, "s1.jsonl"), [
    { type: "user", cwd: "C:\\work\\shop", timestamp: at, message: { content: "SECRET PROMPT" } },
    { type: "ai-title", aiTitle: "Fix checkout" },
    assistant("m1", "claude-opus-5-5", { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 100_000,
      cache_creation_input_tokens: 2000, cache_creation: { ephemeral_1h_input_tokens: 2000, ephemeral_5m_input_tokens: 0 } }),
  ].map(JSON.stringify).join("\n"));
  fs.writeFileSync(path.join(project, "s1", "subagents", "agent-a1.jsonl"),
    JSON.stringify(assistant("m2", "claude-haiku-4-5", { input_tokens: 4000, output_tokens: 1000 })));
  const day = path.join(f.codexDir, "sessions", "2026", "11", "17");
  fs.mkdirSync(day, { recursive: true });
  fs.writeFileSync(path.join(day, "rollout-1.jsonl"), [
    { type: "session_meta", payload: { id: "thread-1", cwd: "/home/u/api" } },
    { type: "turn_context", payload: { model: "gpt-6.1-sol", cwd: "/home/u/api" } },
    { timestamp: at, payload: { type: "token_count", info: { last_token_usage: { input_tokens: 10_000, cached_input_tokens: 8000, cache_write_input_tokens: 1000, output_tokens: 300 } } } },
  ].map(JSON.stringify).join("\n"));
  fs.writeFileSync(path.join(f.codexDir, "session_index.jsonl"), JSON.stringify({ id: "thread-1", thread_name: "Speed up API" }));
  const r = await scanTokens({ ...f, now });

  assert.equal(r.summary.sessions, 2, "the sub-agent is part of its session, not a session of its own");
  const shop = r.by_session.find((s) => s.provider === "claude");
  assert.deepEqual([shop.folder, shop.title, shop.agents], ["shop", "Fix checkout", 1]);
  assert.deepEqual(shop.models.map((m) => [m.model, m.total]), [["opus-5-5", 103_500], ["haiku-4-5", 5000]]);
  const opus = (1000 * 4 + 2000 * 8 + 100_000 * 0.20 + 500 * 20) / 1e6, haiku = (4000 * 1 + 1000 * 5) / 1e6;
  assert.ok(Math.abs(shop.models[0].cost - opus) < 1e-9 && Math.abs(shop.cost - (opus + haiku)) < 1e-9);
  const api = r.by_session.find((s) => s.provider === "codex");
  assert.deepEqual([api.folder, api.title], ["api", "Speed up API"]);
  // Newly cached tokens are split out of input; the total is unchanged.
  assert.deepEqual([api.models[0].input, api.models[0].cache_read, api.models[0].cache_write, api.total], [1000, 8000, 1000, 10_300]);
  assert.ok(Math.abs(api.cost - (1000 * 2 + 8000 * 0.10 + 1000 * 2.5 + 300 * 10) / 1e6) < 1e-9);
  // Cumulative per model, and every token had a list price.
  assert.deepEqual(r.by_model.map((m) => [m.model, m.sessions]), [["opus-5-5", 1], ["gpt-6.1-sol", 1], ["haiku-4-5", 1]]);
  assert.equal(r.pricing.priced_pct, 100);
  assert.ok(Math.abs(r.summary.cost - r.by_session.reduce((n, s) => n + s.cost, 0)) < 1e-6);
  assert.doesNotMatch(JSON.stringify(r), /SECRET|um-tokens|rollout-1|agent-a1/);
});

test("tokens of a model without a list price are counted but not priced", async (t) => {
  const f = fixture(t), now = Date.now();
  fs.writeFileSync(path.join(f.claudeDir, "projects", "x.jsonl"), JSON.stringify({ type: "assistant", timestamp: new Date(now - 1000).toISOString(),
    message: { id: "a", model: "claude-mystery-9", usage: { input_tokens: 300, output_tokens: 100 } } }));
  const r = await scanTokens({ ...f, now });
  assert.equal(r.summary.total, 400);
  assert.equal(r.summary.cost, 0);
  assert.equal(r.summary.unpriced, 400);
  assert.equal(r.summary.priced, false);
  assert.equal(r.pricing.priced_pct, 0);
});

test("the session export has a row per session and model with its cost, and follows the model filter", () => {
  const model = (id, name, cost) => ({ id, model: name, turns: 1, total: 10, input: 4, cache_read: 3, cache_write: 1, output: 2, reasoning: 0, cost, priced: cost != null, unpriced: cost == null ? 10 : 0 });
  const tokens = { days: 7, by_model: [{ ...model("a", "opus-5-5", 1.5), provider: "claude", sessions: 2, daily: [] }],
    by_session: [{ id: "s1", provider: "claude", folder: "shop", title: "=cmd|' /C calc'!A0", first: 0, last: 1000, agents: 0,
      models: [model("a", "opus-5-5", 1.5), model("b", "mystery", null)] }] };
  const all = modelExport(tokens, "sessions-csv").split("\n");
  assert.equal(all[0], "provider,session,folder,title,first_seen,last_seen,model,observations,total_tokens,input_uncached,cache_read,cache_write,output,reasoning_subset,api_cost_usd");
  assert.equal(all.length, 3);
  assert.match(all[1], /"'=cmd/, "a title cannot run as a spreadsheet formula");
  assert.match(all[1], /"opus-5-5",.*"1\.5000"$/);
  assert.match(all[2], /"mystery",.*""$/, "an unpriced model has no cost, not $0");
  assert.equal(modelExport(tokens, "sessions-csv", "a").split("\n").length, 2);
  assert.match(modelExport(tokens, "models-csv"), /^provider,model,sessions,.*api_cost_usd\n"claude","opus-5-5","2",.*"1\.5000"$/);
  const json = JSON.parse(modelExport(tokens, "models-json", "b"));
  assert.deepEqual(json.by_session[0].models.map((m) => m.model), ["mystery"]);
  assert.match(json.cost_unit, /not billed per token/);
});

test("model exports filter by model, preserve daily totals and neutralize spreadsheet formulas", () => {
  const model = { id: "a", provider: "codex", model: '=HYPERLINK("bad")', total: 12, input: 10, output: 2, turns: 1, daily: [{ date: "2026-10-21", total: 12 }] };
  const tokens = { days: 7, by_model: [model, { ...model, id: "b", model: "other" }] };
  const csv = modelExport(tokens, "models-csv", "a");
  assert.match(csv, /"'=HYPERLINK/);
  assert.doesNotMatch(csv, /other/);
  assert.match(modelExport(tokens, "models-daily-csv", "a"), /2026-10-21/);
  assert.equal(JSON.parse(modelExport(tokens, "models-json", "a")).by_model.length, 1);
});

test("scanTokens handles empty directories gracefully", async (t) => {
  const f = fixture(t);
  const result = await scanTokens({ days: 7, claudeDir: f.claudeDir, codexDir: f.codexDir });
  assert.equal(result.days, 7);
  assert.equal(result.summary.total, 0);
  assert.equal(result.summary.turns, 0);
  assert.equal(result.summary.cache_efficiency_pct, 0);
  assert.equal(result.by_model.length, 0);
  assert.equal(result.hourly.length, 24);
});

test("scanTokens extracts Claude transcripts and calculates cache efficiency and model stats", async (t) => {
  const f = fixture(t);
  const now = new Date(2026, 9, 17, 12).getTime();
  const projDir = path.join(f.claudeDir, "projects", "my-project");
  fs.mkdirSync(projDir, { recursive: true });

  const line1 = JSON.stringify({
    timestamp: new Date(now - 3600000).toISOString(),
    message: { model: "claude-sonnet-4-6", usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 900, cache_creation_input_tokens: 10, output_tokens_details: { thinking_tokens: 20 } } },
  });
  const line2 = JSON.stringify({
    timestamp: new Date(now - 7200000).toISOString(),
    message: { model: "claude-opus-5", usage: { input_tokens: 200, output_tokens: 100, cache_read_input_tokens: 1800, cache_creation_input_tokens: 0 } },
  });
  fs.writeFileSync(path.join(projDir, "session-1.jsonl"), `${line1}\n${line2}\n`);

  const result = await scanTokens({ days: 7, claudeDir: f.claudeDir, codexDir: f.codexDir, now: () => now });
  assert.equal(result.summary.turns, 2);
  assert.equal(result.summary.input, 300);
  assert.equal(result.summary.output, 150);
  assert.equal(result.summary.cache_read, 2700);
  assert.equal(result.summary.reasoning, 20);
  assert.equal(result.summary.total, 300 + 150 + 2700 + 10);
  // 2700 / (300 + 2700 + 10 cache writes) = 89.7%
  assert.equal(result.summary.cache_efficiency_pct, 89.7);
  assert.equal(result.by_model.length, 2);
  assert.equal(result.by_model[0].model, "opus-5");
});

test("scanTokens extracts Codex session rollouts and handles time cutoff", async (t) => {
  const f = fixture(t);
  const now = new Date(2026, 9, 17, 12).getTime();
  const todayDir = path.join(f.codexDir, "sessions", "2026", "10", "17");
  fs.mkdirSync(todayDir, { recursive: true });

  const recent = JSON.stringify({
    timestamp: new Date(now - 1800000).toISOString(),
    payload: { type: "token_count", info: { last_token_usage: { input_tokens: 2500, output_tokens: 80, cached_input_tokens: 2000, reasoning_output_tokens: 40, total_tokens: 2580 } } },
  });
  const ancient = JSON.stringify({
    timestamp: new Date(now - 15 * 86400000).toISOString(),
    payload: { type: "token_count", info: { last_token_usage: { input_tokens: 1000, output_tokens: 200, cached_input_tokens: 0, total_tokens: 1200 } } },
  });
  fs.writeFileSync(path.join(todayDir, "rollout-1.jsonl"), `${recent}\n`);

  const oldDayDir = path.join(f.codexDir, "sessions", "2026", "10", "01");
  fs.mkdirSync(oldDayDir, { recursive: true });
  fs.writeFileSync(path.join(oldDayDir, "rollout-old.jsonl"), `${ancient}\n`);

  const result = await scanTokens({ days: 7, claudeDir: f.claudeDir, codexDir: f.codexDir, now: () => now });
  assert.equal(result.summary.turns, 1);
  assert.equal(result.summary.input, 500);
  assert.equal(result.summary.output, 80);
  assert.equal(result.summary.cache_read, 2000);
  assert.equal(result.by_provider.codex.turns, 1);
});

test("a Claude message repeated in a resumed session file is counted once", async (t) => {
  const f = fixture(t), now = new Date(2026, 9, 17, 12).getTime();
  const row = (id, time) => JSON.stringify({ type: "assistant", requestId: `req_${id}`, timestamp: new Date(time).toISOString(),
    message: { id, model: "claude-sonnet", usage: { input_tokens: 100, output_tokens: 50 } } });
  const dir = path.join(f.claudeDir, "projects", "p");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "a.jsonl"), [row("msg_1", now - 5000), row("msg_2", now - 4000)].join("\n"));
  fs.writeFileSync(path.join(dir, "b.jsonl"), [row("msg_1", now - 5000), row("msg_2", now - 4000), row("msg_3", now - 3000)].join("\n"));
  const result = await scanTokens({ ...f, now: () => now });
  assert.equal(result.summary.turns, 3);
  assert.equal(result.summary.total, 450);
});

test("Claude rows with no tokens are skipped", async (t) => {
  const f = fixture(t), now = new Date(2026, 9, 17, 12).getTime();
  const row = (id, model, usage) => JSON.stringify({ type: "assistant", timestamp: new Date(now - 1000).toISOString(), message: { id, model, usage } });
  const dir = path.join(f.claudeDir, "projects", "p");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "a.jsonl"), [row("a", "<synthetic>", { input_tokens: 0, output_tokens: 0 }), row("b", "claude-sonnet", { input_tokens: 5, output_tokens: 5 })].join("\n"));
  const result = await scanTokens({ ...f, now: () => now });
  assert.equal(result.summary.turns, 1);
  assert.deepEqual(result.by_model.map((m) => m.model), ["sonnet"]);
});

test("cache efficiency counts cache writes as prompt tokens", async (t) => {
  const f = fixture(t), now = new Date(2026, 9, 17, 12).getTime();
  const dir = path.join(f.claudeDir, "projects", "p");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "a.jsonl"), JSON.stringify({ type: "assistant", timestamp: new Date(now - 1000).toISOString(),
    message: { id: "a", model: "claude-sonnet", usage: { input_tokens: 5, output_tokens: 1, cache_creation_input_tokens: 20000, cache_read_input_tokens: 40000 } } }));
  const result = await scanTokens({ ...f, now: () => now });
  assert.equal(result.summary.cache_efficiency_pct, 66.7);
});

test("a 7-day period is seven full local days with empty days filled in", async (t) => {
  const f = fixture(t), now = new Date(2026, 9, 21, 12).getTime();
  const at = (d, h) => new Date(2026, 9, d, h).getTime();
  const row = (id, time) => JSON.stringify({ type: "assistant", timestamp: new Date(time).toISOString(),
    message: { id, model: "claude-sonnet", usage: { input_tokens: 10, output_tokens: 0 } } });
  const dir = path.join(f.claudeDir, "projects", "p");
  fs.mkdirSync(dir, { recursive: true });
  // Oct 14 is outside a 7-day period ending Oct 21; Oct 15 at 00:30 is inside it.
  fs.writeFileSync(path.join(dir, "a.jsonl"), [row("old", at(14, 23)), row("first", new Date(2026, 9, 15, 0, 30).getTime()), row("last", at(21, 9))].join("\n"));
  const result = await scanTokens({ days: 7, ...f, now: () => now });
  assert.deepEqual(result.daily.map((d) => d.date), ["2026-10-15", "2026-10-16", "2026-10-17", "2026-10-18", "2026-10-19", "2026-10-20", "2026-10-21"]);
  assert.equal(result.daily[1].total, 0);
  assert.equal(result.daily[1].turns, 0);
  assert.equal(result.summary.total, 20);
  assert.equal(result.daily.reduce((n, d) => n + d.total, 0), result.summary.total);
});


test("token cache bounds retained rows without limiting report contents", () => {
  const { load } = require("./helpers");
  const api = load("src/tokens.js", {}, ["cacheFile", "fileCache", "MAX_CACHED_ROWS", "rowCount: () => cachedRows"]);
  const value = (n) => ({ items: Array.from({ length: n }, () => ({ t: 1 })) });
  api.cacheFile("first", value(12000));
  api.cacheFile("second", value(12000));
  assert.equal(api.fileCache.has("first"), false);
  assert.equal(api.rowCount(), 12000);
  api.cacheFile("second", value(3));
  assert.equal(api.rowCount(), 3);
  api.cacheFile("oversized", value(api.MAX_CACHED_ROWS + 1));
  assert.equal(api.fileCache.has("oversized"), false);
  assert.equal(api.rowCount(), 3);
});

test("streamed transcripts preserve unicode, CRLF, final lines and oversize coverage", async (t) => {
  const f = fixture(t), now = Date.now();
  const row = { timestamp: new Date(now - 1000).toISOString(), message: { model: "claude-\u6a21\u578b", usage: { input_tokens: 7, output_tokens: 2 } } };
  const lines = [JSON.stringify({ padding: "x".repeat(65530) }), JSON.stringify(row), "x".repeat(8 * 1024 * 1024 + 1), JSON.stringify(row)];
  fs.writeFileSync(path.join(f.claudeDir, "projects", "stream.jsonl"), lines.join("\r\n"));
  const report = await scanTokens({ ...f, now });
  assert.equal(report.summary.total, 18);
  assert.equal(report.summary.turns, 2);
  assert.equal(report.by_model[0].model, "\u6a21\u578b");
  assert.equal(report.coverage.truncated, true);
});
