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

test("analyzeBurn reads the pace of the current reset cycle only", () => {
  const now = 50 * 3600000;
  const reset = (h) => new Date(now + h * 3600000).toISOString();
  const old = [80, 88, 96].map((used, i) => ({ t: now - (50 - i * 10) * 60000, used, reset: reset(-0.4), cycle: "a" }));
  const fresh = [2, 15, 28, 40].map((used, i) => ({ t: now - (18 - i * 6) * 60000, used, reset: reset(4.6), cycle: "b" }));
  const [w] = analyzeBurn([{ id: "s", provider: "claude", label: "5h", kind: "five_hour", points: [...old, ...fresh] }], () => now);
  assert.ok(w.burn_rate > 100, `rising fast since the reset, got ${w.burn_rate}`);
  assert.equal(w.status, "critical");
  assert.equal(w.will_exhaust, true);
});

test("a window that resets before it runs out is not critical, and a sustainable 5-hour pace is not elevated", () => {
  const now = 50 * 3600000;
  const reset = new Date(now + 3600000).toISOString();
  const near = [86, 87, 88].map((used, i) => ({ t: now - (40 - i * 20) * 60000, used, reset }));
  const steady = [10, 13, 16].map((used, i) => ({ t: now - (40 - i * 20) * 60000, used, reset: new Date(now + 4 * 3600000).toISOString() }));
  const list = analyzeBurn([
    { id: "near", provider: "codex", label: "5h", kind: "five_hour", points: near },
    { id: "steady", provider: "claude", label: "5h", kind: "five_hour", points: steady },
  ], () => now);
  const byId = Object.fromEntries(list.map((w) => [w.id, w]));
  assert.equal(byId.near.will_exhaust, false);
  assert.equal(byId.near.status, "elevated", "88% but resets first");
  assert.equal(byId.steady.status, "sustainable", "9%/h with 21%/h safe");
});

test("recommendations use plan names and never contradict their numbers", () => {
  const health = computeHealth([
    { provider: "claude", label: "5h", status: "critical", used: 92, burn_rate: 25, runway_hours: 0.3, hours_to_reset: 2, safe_rate: 4, will_exhaust: true },
    { provider: "codex", label: "Weekly", status: "critical", used: 90, burn_rate: 3, runway_hours: 3.3, hours_to_reset: null, safe_rate: null, will_exhaust: false },
    { provider: "gemini", label: "5h", status: "elevated", used: 75, burn_rate: -6, runway_hours: null, hours_to_reset: 1, safe_rate: 25, will_exhaust: false },
  ], []);
  const text = health.recommendations.map((r) => `${r.title} ${r.body}`).join(" | ");
  assert.match(text, /Claude Code 5h runs out before it resets/);
  assert.match(text, /Codex Weekly is close to its limit/);
  assert.doesNotMatch(text, /null|undefined|\+-|NaN/);
  assert.match(text, /reset time is not reported/);
});

test("health counts plan warnings, not other notifications", () => {
  const now = 10 * 86400000;
  const events = [
    { at: now - 1000, title: "Session resumed", body: "x" },
    { at: now - 2000, title: "Data cap reached", body: "x" },
    { at: now - 3000, title: "Network budget warning", body: "x" },
  ];
  assert.equal(computeHealth([], events, () => now).score, 100);
  assert.equal(computeHealth([], [{ at: now - 1000, title: "Usage Monitor — Codex", body: "5h window: 80% used" }], () => now).score, 95);
  assert.equal(computeHealth([], [], () => now).recommendations[0].title, "No current readings");
});
