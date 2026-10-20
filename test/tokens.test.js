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

test("model reports deduplicate streamed Claude messages and exclude future records and private content", (t) => {
  const f = fixture(t), now = Date.now();
  const row = (output, time = now - 1000) => ({ type: "assistant", timestamp: new Date(time).toISOString(),
    message: { id: "same-message", model: "claude-sonnet", content: "PRIVATE PROMPT", usage: { input_tokens: 100, output_tokens: output } } });
  fs.writeFileSync(path.join(f.claudeDir, "projects", "private-session.jsonl"),
    [row(10), row(30), { ...row(999, now + 60000), message: { ...row(999).message, id: "future" } }].map(JSON.stringify).join("\n"));
  const result = scanTokens({ ...f, now });
  assert.equal(result.summary.total, 130);
  assert.equal(result.summary.turns, 1);
  assert.equal(result.by_session.length, 1);
  assert.match(result.by_session[0].id, /^[a-f0-9]{16}$/);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE PROMPT|private-session|um-tokens/);
});

test("Codex reports use cumulative deltas, actual models and cached input as a subset", (t) => {
  const f = fixture(t), now = Date.now();
  const token = (input, output, cached) => ({ timestamp: new Date(now - 1000).toISOString(),
    payload: { type: "token_count", info: { total_token_usage: { input_tokens: input, output_tokens: output, cached_input_tokens: cached },
      last_token_usage: { input_tokens: 100, output_tokens: 20, cached_input_tokens: 80 } } } });
  const context = (model) => ({ type: "turn_context", payload: { model } });
  fs.writeFileSync(path.join(f.codexDir, "sessions", "rollout.jsonl"),
    [context("gpt-one"), token(100, 20, 80), token(100, 20, 80), context("gpt-two"), token(300, 70, 230)].map(JSON.stringify).join("\n"));
  const result = scanTokens({ ...f, now });
  assert.equal(result.summary.total, 370);
  assert.equal(result.summary.turns, 2);
  assert.equal(result.summary.input, 70);
  assert.equal(result.summary.cache_read, 230);
  assert.deepEqual(result.by_model.map((m) => m.model), ["gpt-two", "gpt-one"]);
  assert.equal(result.by_model[0].daily[0].total, 250);
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

test("scanTokens handles empty directories gracefully", (t) => {
  const f = fixture(t);
  const result = scanTokens({ days: 7, claudeDir: f.claudeDir, codexDir: f.codexDir });
  assert.equal(result.days, 7);
  assert.equal(result.summary.total, 0);
  assert.equal(result.summary.turns, 0);
  assert.equal(result.summary.cache_efficiency_pct, 0);
  assert.equal(result.by_model.length, 0);
  assert.equal(result.hourly.length, 24);
});

test("scanTokens extracts Claude transcripts and calculates cache efficiency and model stats", (t) => {
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

  const result = scanTokens({ days: 7, claudeDir: f.claudeDir, codexDir: f.codexDir, now: () => now });
  assert.equal(result.summary.turns, 2);
  assert.equal(result.summary.input, 300);
  assert.equal(result.summary.output, 150);
  assert.equal(result.summary.cache_read, 2700);
  assert.equal(result.summary.reasoning, 20);
  assert.equal(result.summary.total, 300 + 150 + 2700 + 10);
  // (2700 / (300 + 2700)) * 100 = 90%
  assert.equal(result.summary.cache_efficiency_pct, 90);
  assert.equal(result.by_model.length, 2);
  assert.equal(result.by_model[0].model, "opus-5");
});

test("scanTokens extracts Codex session rollouts and handles time cutoff", (t) => {
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

  const result = scanTokens({ days: 7, claudeDir: f.claudeDir, codexDir: f.codexDir, now: () => now });
  assert.equal(result.summary.turns, 1);
  assert.equal(result.summary.input, 500);
  assert.equal(result.summary.output, 80);
  assert.equal(result.summary.cache_read, 2000);
  assert.equal(result.by_provider.codex.turns, 1);
});
