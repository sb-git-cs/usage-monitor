const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const M = require("../src/battery-model");
const { BatteryHistory, start } = require("../src/battery");
const MIN = 60000;
const base = 1800000000000;
const raw = (percent = 60, charging = false) => ({ hasBattery: true, percent, isCharging: charging, acConnected: charging });
const point = (minute, percent, state = "discharging", g = false) => ({ ...M.normalize(raw(percent, state === "charging"), base + minute * MIN), state, g });
function store(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "um-battery-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let now = base;
  const file = path.join(dir, "battery.json");
  return { file, history: new BatteryHistory({ file, now: () => now }), time: (n) => { now = base + n * MIN; } };
}

test("battery distinguishes absent, unavailable, idle power, full and charging", () => {
  assert.equal(M.normalize(null).present, null);
  assert.equal(M.normalize({ hasBattery: false }).present, false);
  assert.equal(M.normalize({ ...raw(), percent: -1 }).percent, null);
  assert.equal(M.normalize({ ...raw(), percent: 101 }).percent, null);
  assert.equal(M.label(M.normalize({ ...raw(), acConnected: true })), "Plugged in · not charging");
  assert.equal(M.label(M.normalize(raw(100, true))), "Full");
  assert.equal(M.label(M.normalize(raw(60, true))), "Estimating…");
  assert.equal(M.label(M.normalize({ ...raw(), timeRemaining: 65535 })), "Estimating…");
  assert.equal(M.normalize({ ...raw(), timeRemaining: 120 }).seconds, 7200);
  assert.equal(M.normalize({ ...raw(60, true), timeRemaining: 120 }).seconds, null, "discharge-only OS field must not become charge time");
});

test("estimates require a useful observed change and preserve valid system estimates", () => {
  assert.equal(M.estimate(point(10, 58), [point(0, 60)]).seconds, 17400);
  assert.equal(M.estimate(point(10, 62, "charging"), [point(0, 60, "charging")]).seconds, 11400);
  assert.equal(M.estimate(point(4, 58), [point(0, 60)]).seconds, null);
  assert.equal(M.estimate(point(10, 59), [point(0, 60)]).seconds, null);
  assert.equal(M.estimate({ ...point(10, 58), seconds: 120, source: "system" }, [point(0, 60)]).seconds, 120);
  assert.equal(M.estimate(point(10, 62), [point(0, 60)]).seconds, null, "opposite-direction movement is not a usable rate");
});

test("estimates never cross power transitions, resume boundaries or missing observations", () => {
  assert.equal(M.estimate(point(10, 58), [point(0, 60, "charging")]).seconds, null);
  assert.equal(M.estimate(point(25, 58), [point(0, 60)]).seconds, null);
  assert.equal(M.estimate(point(10, 58, "discharging", true), [point(0, 60)]).seconds, null);
  assert.equal(M.estimate(point(40, 58), [point(0, 60)]).seconds, null);
});

test("battery store deduplicates polls, persists transitions and starts partial history after restart", (t) => {
  const { history, time, file } = store(t);
  history.record(raw(60)); time(0.1); history.record(raw(60));
  assert.equal(history.points.length, 1);
  time(1); history.record(raw(59));
  time(1.1); history.record(raw(59, true));
  assert.equal(history.points.length, 3);
  const restarted = new BatteryHistory({ file, now: () => base + 2 * MIN });
  const reading = restarted.record(raw(60, true));
  assert.equal(reading.g, true);
  assert.equal(reading.seconds, null);
  assert.equal(restarted.view().sessions.every((s) => s.partial), true);
  assert.match(restarted.csv(7), /timestamp,percent,state,estimated_seconds/);
  assert.ok(restarted.clear());
  assert.equal(JSON.parse(fs.readFileSync(file)).points.length, 0);
});

test("failures break sessions and retention/corrupt history do not affect quota files", (t) => {
  const { history, time, file } = store(t);
  history.record(raw(60)); time(10); history.record(null); time(11);
  assert.equal(history.record(raw(55)).g, true);
  time(31 * 1440); assert.equal(history.view(30).points.length, 0);
  fs.writeFileSync(file, "broken");
  const recovered = new BatteryHistory({ file, now: () => base });
  assert.equal(recovered.error, true);
  recovered.record(raw()); assert.equal(recovered.error, false);
  const failed = new BatteryHistory({ file: path.join(file, "cannot-write.json"), now: () => base });
  failed.record(raw()); assert.equal(failed.error, true);
});

test("sessions count only observed spans and mark gaps and open ends as partial", () => {
  const sessions = M.sessions([point(0, 50, "plugged"), point(1, 50, "charging"), point(11, 60, "charging"),
    point(12, 60), point(22, 58), point(60, 40, "discharging", true)]);
  assert.equal(sessions[2].partial, false);
  assert.equal(sessions[2].delta, 10);
  assert.equal(sessions[2].duration, 10 * MIN);
  assert.equal(sessions[0].partial, true);
  assert.equal(sessions[1].partial, true);
});

test("sampler rejects late results from suspend and never publishes after stop", async (t) => {
  const { history } = store(t);
  let resolve;
  const values = [];
  const sampler = start(history, (r) => values.push(r), { read: () => new Promise((r) => { resolve = r; }), interval: 100000 });
  t.after(() => sampler.stop());
  sampler.setPaused(true); resolve(raw());
  await new Promise(setImmediate);
  assert.equal(values.length, 0);
  sampler.setPaused(false); resolve(raw());
  await new Promise(setImmediate);
  assert.equal(values.length, 1);
  sampler.refresh(); sampler.stop(); resolve(raw());
  await new Promise(setImmediate);
  assert.equal(values.length, 1);
});

test("stalled sampling becomes unavailable without launching overlapping probes", async (t) => {
  const { history } = store(t);
  let reads = 0, finish;
  const values = [];
  const sampler = start(history, (r) => values.push(r), { read: () => { reads++; return new Promise((r) => { finish = r; }); }, timeout: 10, interval: 100000 });
  t.after(() => sampler.stop());
  await new Promise((r) => setTimeout(r, 25));
  assert.equal(values.length, 1); assert.equal(values[0].percent, null);
  await sampler.refresh(); assert.equal(reads, 1);
  finish(raw()); await new Promise(setImmediate);
  assert.equal(values.length, 1, "late samples after timeout are ignored");
});
