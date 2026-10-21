const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Insights, cycleAt, displayPrefs } = require("../src/insights");
const { History } = require("../src/history");
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "um-insights-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let now = new Date(2026, 9, 11, 12).getTime();
  const file = path.join(dir, "insights.json");
  const i = new Insights({ file, now: () => now });
  return { i, file, now: () => now, advance: (ms) => { now += ms; } };
}
const reading = (account, used, reset, state = "ok") => ({ providers: [{ id: "codex", display_name: "Codex", account, status: { state }, windows: [{ kind: "five_hour", label: "5h", used_pct: used, resets_at: reset }] }] });
test("reports separate accounts and reset segments, persist and exclude cached readings", (t) => {
  const f = fixture(t); const reset = new Date(f.now() + 3600000).toISOString();
  f.i.record(reading("a@example.com", 45, reset));
  f.advance(300000); f.i.record(reading("b@example.com", 70, reset));
  f.advance(300000); f.i.record(reading("a@example.com", 5, reset));
  f.advance(300000); f.i.record(reading("a@example.com", 10, reset));
  f.i.record(reading("a@example.com", 99, reset, "stale"));
  const report = f.i.report(); assert.equal(report.length, 2);
  const a = report.find((s) => s.points.length === 3);
  assert.notEqual(a.points[0].cycle, a.points[1].cycle);
  assert.equal(a.points[1].cycle, a.points[2].cycle, "usage drop starts one segment, not a segment per poll");
  f.i.save(true);
  assert.equal(new Insights({ file: f.file, now: f.now }).report().length, 2);
  assert.ok(!fs.readFileSync(f.file, "utf8").includes("@example.com"));
});
test("forecast history cannot cross an account switch or use a cached provider", (t) => {
  const f = fixture(t); const h = new History({ file: `${f.file}.forecast`, now: f.now });
  const reset = new Date(f.now() + 5 * 3600000).toISOString();
  for (let n = 0; n < 4; n++) { h.record(reading("first", 40 + n * 5, reset)); f.advance(300000); }
  assert.ok(h.annotate(reading("first", 55, reset)).providers[0].windows[0].forecast_at);
  assert.equal(h.annotate(reading("second", 55, reset)).providers[0].windows[0].forecast_at, undefined);
  assert.equal(h.annotate(reading("first", 55, reset, "stale")).providers[0].windows[0].forecast_at, undefined);
});
test("budget uses observed byte deltas and survives restart; snooze and warnings persist", (t) => {
  const f = fixture(t); assert.ok(f.i.setBudget({ limit: 1000, day: 1 }));
  f.i.traffic({ apps: [{ rx: 800, tx: 50 }, { rx: NaN, tx: -5 }] });
  assert.equal(f.i.budgetView().used, 850); assert.equal(f.i.budgetView().projected, null);
  assert.ok(f.i.budgetCrossing(80)); assert.equal(f.i.budgetCrossing(80), null);
  f.i.snooze(60); f.i.event("Warning", "Quota warning", "suppressed");
  const restored = new Insights({ file: f.file, now: f.now });
  assert.equal(restored.budgetView().used, 850); assert.ok(restored.isSnoozed());
  assert.equal(restored.budgetCrossing(80), null); assert.equal(restored.data.events[0].delivery, "suppressed");
  f.advance(3600001); assert.equal(restored.isSnoozed(), false);
  assert.equal(restored.snooze(-1), false); assert.equal(restored.setBudget({ limit: -1, day: 0 }), false);
});
test("byte counters alone rewrite the file at most every 15 minutes; new readings within a minute", (t) => {
  const f = fixture(t);
  const written = () => (fs.existsSync(f.file) ? fs.statSync(f.file).mtimeMs + fs.readFileSync(f.file, "utf8").length : 0);
  f.i.record(reading("a@example.com", 10, new Date(f.now() + 3600000).toISOString()));
  const first = written();
  for (let i = 0; i < 120; i++) { f.advance(1000); f.i.traffic({ apps: [{ rx: 100, tx: 0 }] }); }
  assert.equal(written(), first, "two minutes of traffic did not rewrite the file");
  f.advance(15 * 60000); f.i.traffic({ apps: [{ rx: 100, tx: 0 }] });
  assert.equal(new Insights({ file: f.file, now: f.now }).budgetView().used, 12100);
  f.advance(6 * 60000); f.i.record(reading("a@example.com", 30, new Date(f.now() + 3600000).toISOString()));
  assert.equal(new Insights({ file: f.file, now: f.now }).report()[0].points.length, 2, "a new reading is saved after a minute");
});

test("billing cycles clamp day 31 to month end and cross years correctly", () => {
  const before = cycleAt(new Date(2026, 1, 15, 12).getTime(), 31);
  assert.equal(new Date(before.start).getDate(), 31); assert.equal(new Date(before.end).getDate(), 28);
  const after = cycleAt(new Date(2026, 1, 28, 12).getTime(), 31);
  assert.equal(new Date(after.start).getDate(), 28); assert.equal(new Date(after.end).getDate(), 31);
  assert.equal(new Date(cycleAt(new Date(2026, 0, 1).getTime(), 15).start).getFullYear(), 2025);
});
test("history retention, event bound and formula-safe export", (t) => {
  const f = fixture(t); f.i.record(reading("first", 50));
  Object.values(f.i.data.series)[0].label = '=HYPERLINK("example")';
  assert.match(f.i.export(7, "csv"), /'=HYPERLINK/);
  assert.equal(JSON.parse(f.i.export(7, "json")).unit, "quota_percent_used");
  for (let n = 0; n < 205; n++) f.i.event("Warning", "Body", "requested");
  assert.equal(f.i.data.events.length, 200);
  f.advance(32 * 86400000); assert.deepEqual(f.i.report(30), []); assert.equal(f.i.data.events.length, 0);
});
test("the 14-day period reports 14 days, not the 7-day fallback", (t) => {
  const f = fixture(t);
  f.i.record(reading("a@example.com", 10, new Date(f.now() + 3600000).toISOString()));
  f.advance(10 * 86400000);
  f.i.record(reading("a@example.com", 20, new Date(f.now() + 3600000).toISOString()));
  assert.equal(f.i.report(7)[0].points.length, 1);
  assert.equal(f.i.report(14)[0].points.length, 2);
});

test("display preferences validate theme, scale, visibility and provider order", () => {
  const result = displayPrefs({ theme: "invalid", scale: 1000, hidden: ["codex", "bad"], order: ["cursor", "cursor", "bad"] });
  assert.equal(result.theme, "system"); assert.equal(result.scale, 100);
  assert.deepEqual(result.hidden, ["codex"]); assert.equal(result.order[0], "cursor"); assert.equal(result.order.length, 6);
});
test("a reset time repeated with a second of jitter keeps one segment and the five-minute spacing", (t) => {
  const f = fixture(t); const reset = f.now() + 3600000;
  for (let n = 0; n < 60; n++) { f.i.record(reading("a@example.com", 40, new Date(reset + (n % 2 ? 900 : -900)).toISOString())); f.advance(5000); }
  const [series] = f.i.report();
  assert.equal(series.points.length, 1, "a reading every 5 s is stored once per five minutes");
  f.advance(300000); f.i.record(reading("a@example.com", 41, new Date(reset + 300).toISOString()));
  assert.equal(new Set(f.i.report()[0].points.map((p) => p.cycle)).size, 1);
});
