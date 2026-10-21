const test = require("node:test");
const assert = require("node:assert/strict");
const { summarize } = require("../src/ui/overview");
const now = Date.parse("2026-10-11T12:00:00Z");
const future = (minutes) => new Date(now + minutes * 60000).toISOString();
const provider = (state, windows) => ({ display_name: "Test", status: { state }, windows });

test("overview counts providers once and selects the earliest future reset", () => {
  const result = summarize([
    provider("ok", [{ used_pct: 90, resets_at: future(60) }, { used_pct: 95, resets_at: future(30) }]),
    provider("ok", [{ used_pct: 20, resets_at: future(10), forecast_at: future(5) }]),
    provider("ok", [{ used_pct: 10, resets_at: future(-1) }]),
  ], 80, now);
  assert.equal(result.reporting, 3);
  assert.equal(result.attention, 2);
  assert.equal(result.atRisk.length, 2);
  assert.equal(result.nextReset.at, now + 10 * 60000);
});

test("cached, failed and unknown readings never drive current advice", () => {
  const result = summarize([
    provider("stale", [{ used_pct: 99, resets_at: future(1) }]),
    provider("fetch_failed", [{ used_pct: 95 }]),
    provider("ok", [{ used_pct: null }]),
    provider("logged_out", []),
  ], 80, now);
  assert.deepEqual(result, { reporting: 0, attention: 0, unavailable: 4, nextReset: null, atRisk: [] });
});

test("custom threshold and expired or invalid forecasts are respected", () => {
  const result = summarize([
    provider("ok", [{ used_pct: 70, forecast_at: future(-1), resets_at: future(10) }]),
    provider("ok", [{ used_pct: 10, forecast_at: future(20), resets_at: future(10) }]),
    provider("ok", [{ used_pct: 10, forecast_at: "invalid" }]),
  ], 60, now);
  assert.equal(result.attention, 1);
  assert.deepEqual(summarize([], 80, now), { reporting: 0, attention: 0, unavailable: 0, nextReset: null, atRisk: [] });
});
