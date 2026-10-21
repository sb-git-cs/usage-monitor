const test = require("node:test");
const assert = require("node:assert/strict");
const { slopePerHour, analyzeBurn, computeHealth } = require("../src/burn");

test("slopePerHour returns 0 for single point or flat points", () => {
  assert.equal(slopePerHour([]), 0);
  assert.equal(slopePerHour([{ t: 1000, used: 50 }]), 0);
  assert.equal(slopePerHour([{ t: 1000, used: 50 }, { t: 3600000 + 1000, used: 50 }]), 0);
});

test("slopePerHour computes linear regression slope in %/hr", () => {
  const points = [
    { t: 0, used: 10 },
    { t: 1800000, used: 20 },
    { t: 3600000, used: 30 },
  ];
  // 20% in 1 hour = 20 %/h
  assert.equal(Math.round(slopePerHour(points)), 20);
});

test("analyzeBurn calculates burn rates, runway hours, safe rate, and exhaustion risk", () => {
  const now = 10000000;
  const resetInTwoHours = new Date(now + 2 * 3600000).toISOString();

  const series = [
    {
      id: "series-fast",
      provider: "claude",
      label: "5h",
      kind: "five_hour",
      account: "acc1",
      points: [
        { t: now - 3600000, used: 60, reset: resetInTwoHours },
        { t: now - 1800000, used: 75, reset: resetInTwoHours },
        { t: now, used: 90, reset: resetInTwoHours },
      ],
    },
    {
      id: "series-safe",
      provider: "codex",
      label: "Weekly",
      kind: "weekly",
      account: "acc2",
      points: [
        { t: now - 3600000, used: 20, reset: resetInTwoHours },
        { t: now, used: 21, reset: resetInTwoHours },
      ],
    },
  ];

  const analysis = analyzeBurn(series, () => now);
  assert.equal(analysis.length, 2);

  const fast = analysis.find((w) => w.id === "series-fast");
  assert.equal(fast.used, 90);
  assert.ok(fast.burn_rate >= 29); // 30%/h
  // Safe rate to survive 2 hours with 10% remaining is 5%/h
  assert.equal(fast.safe_rate, 5);
  // Runway remaining with 10% left at 30%/h is ~0.3h
  assert.ok(fast.runway_hours < 1);
  assert.equal(fast.will_exhaust, true);
  assert.equal(fast.status, "critical");

  const safe = analysis.find((w) => w.id === "series-safe");
  assert.equal(safe.used, 21);
  assert.equal(safe.burn_rate, 1);
  assert.equal(safe.safe_rate, 39.5); // (100 - 21) / 2
  assert.equal(safe.will_exhaust, false);
  assert.equal(safe.status, "sustainable");
});

test("computeHealth assigns grades and generates actionable recommendations", () => {
  const windows = [
    { provider: "claude", label: "5h", status: "critical", used: 92, burn_rate: 25, runway_hours: 0.3, hours_to_reset: 2, safe_rate: 4 },
  ];
  const health = computeHealth(windows, []);
  assert.ok(health.score <= 80);
  assert.ok(health.recommendations.length > 0);
  assert.equal(health.recommendations[0].type, "warning");
});

test("analyzeBurn leaves out windows that have reset since, or are no longer being read", () => {
  const now = 100 * 3600000;
  const series = (id, lastAt, reset) => ({ id, provider: "gemini", label: "5h", kind: "five_hour", account: "a",
    points: [{ t: lastAt - 600000, used: 90, reset }, { t: lastAt, used: 100, reset }] });
  const analysis = analyzeBurn([
    series("reset-passed", now - 60000, new Date(now - 1000).toISOString()),
    series("no-longer-read", now - 2 * 3600000, new Date(now + 3600000).toISOString()),
    series("current", now - 60000, new Date(now + 3600000).toISOString()),
  ], () => now);
  assert.deepEqual(analysis.map((w) => w.id), ["current"]);
  assert.equal(computeHealth(analysis, []).score, 70, "only the live exhausted window costs health");
});
