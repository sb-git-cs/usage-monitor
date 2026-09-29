const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { History, forecast, slopePerHour } = require("../src/history");

const MIN = 60_000;
const T0 = Date.UTC(2026, 8, 29, 9, 0);

function points(from, used, perMinute, count, gap = 5) {
  return Array.from({ length: count }, (_, i) => ({ t: from + i * gap * MIN, used: used + i * gap * perMinute }));
}

test("slope is percent per hour", () => {
  assert.equal(Math.round(slopePerHour(points(T0, 10, 0.5, 5)) * 10) / 10, 30);
});

test("a window burning fast is projected to run out before its reset", () => {
  const pts = points(T0, 40, 0.5, 7); // 40% -> 55% over 30 minutes, 30%/h
  const now = T0 + 30 * MIN;
  const win = { kind: "five_hour", used_pct: 55, resets_at: new Date(now + 3 * 60 * MIN).toISOString() };
  const f = forecast(pts, win, now);
  assert.ok(f, "on course to run out");
  assert.equal(f.rate_per_hour, 30);
  assert.equal(f.at, new Date(now + 90 * MIN).toISOString(), "45% left at 30%/h is 90 minutes");
});

test("no forecast when the window resets first, usage is flat, or there is too little history", () => {
  const now = T0 + 30 * MIN;
  const win = { kind: "five_hour", used_pct: 55, resets_at: new Date(now + 60 * MIN).toISOString() };
  assert.equal(forecast(points(T0, 40, 0.5, 7), win, now), null, "resets before reaching 100%");
  assert.equal(forecast(points(T0, 55, 0, 7), { ...win, resets_at: null }, now), null, "flat");
  assert.equal(forecast(points(T0 + 25 * MIN, 50, 1, 2), { ...win, resets_at: null }, now), null, "two points");
  assert.equal(forecast(points(T0 + 26 * MIN, 50, 1, 4, 1), { ...win, resets_at: null }, now), null, "less than ten minutes");
  assert.equal(forecast(points(T0, 40, 0.5, 7), { ...win, used_pct: 100, resets_at: null }, now), null, "already used up");
});

test("history records fresh readings once a minute, starts over on a new window and persists", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "um-history-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "h.json");
  let now = T0;
  const h = new History({ file, now: () => now });
  const reading = (used, resets, state = "ok") => ({ providers: [{ id: "codex", status: { state }, windows: [{ kind: "five_hour", label: "5h", used_pct: used, resets_at: resets }] }] });
  const resets = new Date(T0 + 4 * 60 * MIN).toISOString();
  for (let i = 0; i <= 30; i += 1) {
    now = T0 + i * 20_000; // every 20 s for 10 minutes
    h.record(reading(40 + i * 0.3, resets));
  }
  const key = "codex|five_hour|5h";
  assert.equal(h.series.get(key).points.length, 11, "one point per minute");
  h.record(reading(99, resets, "stale"));
  assert.equal(h.series.get(key).points.length, 11, "cached readings are not recorded");
  now += 20 * MIN;
  const annotated = h.annotate(reading(49, resets));
  assert.ok(annotated.providers[0].windows[0].forecast_at, "a steady climb gets a forecast");
  h.flush();
  const reloaded = new History({ file, now: () => now });
  assert.equal(reloaded.series.get(key).points.length, 11);
  now += MIN;
  reloaded.record(reading(3, new Date(now + 5 * 60 * MIN).toISOString()));
  assert.equal(reloaded.series.get(key).points.length, 1, "a new reset time starts a new series");
});
