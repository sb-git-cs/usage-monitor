const test = require("node:test");
const assert = require("node:assert/strict");
const { costOf, claudeKey } = require("../src/pricing");

const tokens = (fields) => ({ input: 0, cache_read: 0, cache_write: 0, cache_write_1h: 0, output: 0, ...fields });
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);

test("Claude costs use each cache write's lifetime, fast mode and US-only inference", () => {
  // Opus 5.5: $4 input, $5 5-minute write, $8 1-hour write, $0.20 cache read, $20 output per million.
  const item = tokens({ input: 1000, cache_read: 1_000_000, cache_write: 200_000, cache_write_1h: 150_000, output: 10_000 });
  close(costOf("claude", "opus-5-5", item), (1000 * 4 + 50_000 * 5 + 150_000 * 8 + 1_000_000 * 0.20 + 10_000 * 20) / 1e6);
  close(costOf("claude", "opus-5-5", item), 1.854);
  // Fast mode: $8 / $40, with the cache multipliers on top of the fast input price.
  close(costOf("claude", "opus-5-5", { ...item, speed: "fast" }), (1000 * 8 + 50_000 * 10 + 150_000 * 16 + 1_000_000 * 0.40 + 10_000 * 40) / 1e6);
  close(costOf("claude", "opus-5-5", { ...item, geo: "us" }), 1.854 * 1.1);
  // Fable 5.2 reads cache at 0.025x input.
  close(costOf("claude", "fable-5-2", tokens({ cache_read: 1_000_000, output: 1_000_000 })), 0.20 + 40);
  // Fast mode and US-only inference only change the models that have them.
  close(costOf("claude", "sonnet-4-5", tokens({ input: 1_000_000, speed: "fast", geo: "us" })), 3);
});

test("Haiku 5.5 prompts over 100,000 tokens, cache included, pay the higher prices", () => {
  close(costOf("claude", "haiku-5-5", tokens({ input: 50_000, cache_read: 40_000, output: 1000 })), (50_000 * 0.10 + 40_000 * 0.01 + 1000 * 0.50) / 1e6);
  close(costOf("claude", "haiku-5-5", tokens({ input: 50_000, cache_read: 60_000, output: 1000 })), (50_000 * 0.50 + 60_000 * 0.05 + 1000 * 2.50) / 1e6);
});

test("OpenAI costs price cached and newly cached input, and prompts over 272K tokens at the long rates", () => {
  // gpt-6.1-sol: $2 input, $0.10 cached, $2.50 cache write, $10 output; over 272K: $4, $0.20, $5, $15.
  close(costOf("codex", "gpt-6.1-sol", tokens({ input: 10_000, cache_read: 80_000, cache_write: 10_000, output: 1000 })),
    (10_000 * 2 + 80_000 * 0.10 + 10_000 * 2.5 + 1000 * 10) / 1e6);
  close(costOf("codex", "gpt-6.1-sol", tokens({ input: 50_000, cache_read: 200_000, cache_write: 50_000, output: 1000 })),
    (50_000 * 4 + 200_000 * 0.20 + 50_000 * 5 + 1000 * 15) / 1e6);
  // A model without a cache-write price pays plain input for written tokens.
  close(costOf("codex", "gpt-5.1", tokens({ cache_write: 1_000_000 })), 1.25);
});

test("dated snapshots are priced as their model; unlisted models stay unpriced instead of guessed", () => {
  assert.equal(claudeKey("claude-sonnet-4-5-20250929"), "sonnet-4-5");
  close(costOf("claude", "sonnet-4-5-20250929", tokens({ input: 1_000_000 })), 3);
  assert.equal(costOf("claude", "claude-unknown", tokens({ input: 1 })), null);
  assert.equal(costOf("codex", "gpt-5.1-codex-max", tokens({ input: 1 })), null);
  assert.equal(costOf("gemini", "anything", tokens({ input: 1 })), null);
});
