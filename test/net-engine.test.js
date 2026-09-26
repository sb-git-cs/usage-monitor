const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Engine, periodStart } = require("../src/net/engine");
const { Store } = require("../src/net/store");
const { normalizeNet } = require("../src/net/settings");

function setup(t, { block = true, start = new Date(2026, 8, 26, 10, 0, 0).getTime() } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "usage-monitor-engine-"));
  const store = new Store(path.join(dir, "network.db"));
  t.after(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const clock = { now: start };
  const settings = normalizeNet({});
  const engine = new Engine({ store, settings, capabilities: { block }, now: () => clock.now });
  const events = [];
  for (const name of ["block", "cap", "save", "flows"]) engine.on(name, (e) => events.push([name, e]));
  const sample = (apps, flows = []) => {
    clock.now += 1000;
    engine.ingest({ ts: clock.now, apps, flows });
  };
  return { engine, store, settings, clock, events, sample };
}

const chrome = (rx, tx) => ({ key: "c:\\apps\\chrome.exe", path: "C:\\Apps\\chrome.exe", name: "Google Chrome", rx, tx, pids: [1, 2, 3] });

test("live rates, grouped processes, range totals and per-minute averages", (t) => {
  const { engine, sample, clock } = setup(t);
  sample([chrome(2048, 512), { key: "system", name: "System", rx: 100, tx: 0 }]);
  sample([chrome(1024, 0)]);
  const view = engine.view("60");
  const row = view.rows.find((r) => r.key === "c:\\apps\\chrome.exe");
  assert.equal(row.rx_rate, 1024);
  assert.equal(row.tx_rate, 0);
  assert.equal(row.pids, 3);
  assert.equal(row.rx, 3072);
  assert.equal(row.total, 3584);
  assert.equal(row.can_block, true);
  const system = view.rows.find((r) => r.key === "system");
  assert.equal(system.rx_rate, 0, "apps missing from a sample drop to zero");
  assert.equal(system.can_block, false);
  assert.equal(view.summary.rx, 3172);
  assert.equal(view.covered_minutes, 1);
  assert.equal(row.avg_per_min, 3584);
  clock.now += 2 * 60_000;
  assert.equal(engine.view("60").rows.find((r) => r.key === row.key).avg_per_min, 3584 / 3);
});

test("ignored apps are neither recorded nor shown; focus limits tracking to chosen apps", (t) => {
  const { engine, sample } = setup(t);
  sample([chrome(10, 10), { key: "b", name: "B", rx: 5, tx: 5 }]);
  engine.ignore("b");
  sample([chrome(10, 10), { key: "b", name: "B", rx: 5, tx: 5 }]);
  assert.deepEqual(engine.view("60").rows.map((r) => r.key), ["c:\\apps\\chrome.exe"]);
  engine.unignore("b");
  assert.equal(engine.view("60").rows.find((r) => r.key === "b").rx, 5, "only the sample before ignoring was recorded");
  engine.focus("b");
  sample([chrome(10, 10), { key: "b", name: "B", rx: 5, tx: 5 }]);
  assert.deepEqual(engine.view("60").rows.map((r) => r.key), ["b"]);
  assert.equal(engine.view("60").rows[0].rx, 10);
  engine.unfocus(null);
  assert.equal(engine.view("60").rows.length, 2);
});

test("daily caps block at the limit, notify once, and lift at midnight", (t) => {
  const { engine, sample, clock, events, settings } = setup(t);
  sample([chrome(10, 0)]);
  engine.setCap(chrome().key, { limit_bytes: 1000, period: "daily" });
  sample([chrome(600, 0)]);
  assert.equal(events.filter(([n]) => n === "cap").length, 0);
  sample([chrome(300, 200)]);
  const capEvents = events.filter(([n]) => n === "cap");
  assert.equal(capEvents.length, 1);
  assert.equal(capEvents[0][1].blocked, true);
  assert.deepEqual(events.filter(([n]) => n === "block").pop()[1], { key: chrome().key, path: "C:\\Apps\\chrome.exe", blocked: true });
  sample([chrome(5000, 0)]);
  assert.equal(events.filter(([n]) => n === "cap").length, 1, "one notification per period");
  assert.equal(engine.view("60").rows[0].blocked, true);

  clock.now = periodStart("daily", clock.now) + 24 * 3600_000 + 5000;
  engine.tick();
  const rule = settings.rules[chrome().key];
  assert.equal(rule.cap.used_bytes, 0);
  assert.equal(rule.cap.enforced, false);
  assert.equal(events.filter(([n]) => n === "block").pop()[1].blocked, false);
});

test("resetting or removing a cap restores access, but a manual block stays", (t) => {
  const { engine, sample, events, settings } = setup(t);
  sample([chrome(10, 0)]);
  engine.setCap(chrome().key, { limit_bytes: 100, period: "total" });
  sample([chrome(200, 0)]);
  assert.equal(settings.rules[chrome().key].cap.enforced, true);
  engine.resetCap(chrome().key);
  assert.equal(events.filter(([n]) => n === "block").pop()[1].blocked, false);
  engine.setBlocked(chrome().key, true);
  sample([chrome(200, 0)]);
  engine.clearCap(chrome().key);
  assert.equal(events.filter(([n]) => n === "block").pop()[1].blocked, true, "the manual block survives");
  engine.setBlocked(chrome().key, false);
  assert.equal(settings.rules[chrome().key], undefined, "empty rules are removed");
});

test("raising a reached cap lifts the block; lowering below usage blocks immediately", (t) => {
  const { engine, sample, events, settings } = setup(t);
  sample([chrome(10, 0)]);
  engine.setCap(chrome().key, { limit_bytes: 100, period: "monthly" });
  sample([chrome(150, 0)]);
  engine.setCap(chrome().key, { limit_bytes: 1000, period: "monthly" });
  assert.equal(settings.rules[chrome().key].cap.enforced, false);
  assert.equal(events.filter(([n]) => n === "block").pop()[1].blocked, false);
  engine.setCap(chrome().key, { limit_bytes: 120, period: "monthly" });
  assert.equal(settings.rules[chrome().key].cap.enforced, true);
  assert.throws(() => engine.setCap(chrome().key, { limit_bytes: 0, period: "daily" }), /larger than zero/);
});

test("without blocking support caps only notify, and blocking is refused", (t) => {
  const { engine, sample, events } = setup(t, { block: false });
  sample([chrome(10, 0)]);
  engine.setCap(chrome().key, { limit_bytes: 50, period: "total" });
  sample([chrome(60, 0)]);
  assert.equal(events.filter(([n]) => n === "cap")[0][1].blocked, false);
  assert.equal(events.filter(([n]) => n === "block").length, 0);
  assert.throws(() => engine.setBlocked(chrome().key, true), /not available/);
});

test("reconcile adds missing firewall rules and removes stale ones", (t) => {
  const { engine, sample, events } = setup(t);
  sample([chrome(10, 0)]);
  engine.setBlocked(chrome().key, true);
  events.length = 0;
  engine.setActualBlocked(["C:\\Old\\stale.exe"]);
  engine.reconcile();
  assert.deepEqual(
    events.map(([, e]) => [e.path, e.blocked]),
    [
      ["C:\\Apps\\chrome.exe", true],
      ["C:\\Old\\stale.exe", false],
    ]
  );
  engine.setActualBlocked(["c:\\apps\\CHROME.exe"]);
  events.length = 0;
  engine.reconcile();
  assert.deepEqual(events, [], "paths compare case-insensitively");
  assert.equal(engine.view("60").rows[0].block_pending, false);
});

test("connections are recorded only when enabled, with domains from DNS answers", (t) => {
  const { engine, sample, store, events } = setup(t);
  const flow = { key: chrome().key, ip: "142.250.72.100", port: 443, proto: "tcp", rx: 900, tx: 100 };
  sample([chrome(900, 100)], [flow]);
  assert.deepEqual(engine.connections(chrome().key), []);
  engine.setRecordConnections(chrome().key, true);
  assert.deepEqual(events.filter(([n]) => n === "flows").pop()[1], [chrome().key]);
  engine.addDns("www.google.com", ["142.250.72.100"]);
  sample([chrome(900, 100)], [flow, { ...flow, ip: "1.1.1.1", port: 53, proto: "udp" }]);
  const conns = engine.connections(chrome().key);
  assert.equal(conns.length, 2);
  assert.equal(conns.find((c) => c.remote === "142.250.72.100").domain, "www.google.com");
  assert.equal(conns.find((c) => c.remote === "1.1.1.1").proto, "udp");
  store.flush();
  engine.setRecordConnections(chrome().key, false);
  sample([chrome(1, 1)], [{ ...flow, rx: 5 }]);
  assert.equal(engine.connections(chrome().key).find((c) => c.remote === "142.250.72.100").rx, 900, "only the sample while recording counts");
});

test("history is pruned to the retention window except for kept apps", (t) => {
  const { engine, sample, clock, settings } = setup(t);
  sample([chrome(100, 0), { key: "keep", name: "Keep", rx: 100, tx: 0 }]);
  engine.setKeepForever("keep", true);
  clock.now += 2 * 3600_000;
  engine.prune();
  const rows = engine.view("all").rows;
  assert.deepEqual(rows.map((r) => r.key), ["keep"]);
  assert.equal(settings.rules.keep.keep_forever, true);
});

test("series buckets fit the range and align to local time", (t) => {
  const { engine, sample, clock } = setup(t);
  sample([chrome(1000, 10)]);
  clock.now += 5 * 60_000;
  sample([chrome(3000, 30)]);
  const hour = engine.series(chrome().key, "60");
  assert.equal(hour.bucket_minutes, 1);
  assert.equal(hour.points.length, 60);
  assert.equal(hour.total, 4040);
  assert.equal(hour.peak.rx, 3000);
  const all = engine.series(chrome().key, "all");
  assert.equal(all.points.length, 6, "long ranges start at the first record");
  clock.now += 3 * 24 * 3600_000;
  const week = engine.series(chrome().key, "10080");
  assert.ok(week.points.length <= 60);
  assert.equal(week.total, 4040);
  assert.equal(new Date(week.points[1].start_ms).getMinutes() % Math.min(60, week.bucket_minutes), 0);
});

test("malformed samples are ignored instead of corrupting totals", (t) => {
  const { engine, sample } = setup(t);
  sample([null, { key: "" }, { key: "x", rx: -5, tx: "abc" }, { key: "y", rx: Infinity, tx: 5 }]);
  engine.ingest(null);
  engine.ingest({ apps: "bad", flows: [null, { key: "y" }] });
  assert.deepEqual(engine.view("60").rows.map((r) => [r.key, r.rx, r.tx]), [["y", 0, 5]]);
});

test("live summary: totals, busiest apps first, ignored apps left out, and stale rates drop to zero", (t) => {
  const { engine, sample, clock } = setup(t);
  sample([chrome(3000, 1000), { key: "b", name: "B", rx: 100, tx: 0 }, { key: "c", name: "C", rx: 50, tx: 50 }, { key: "d", name: "D", rx: 10, tx: 0 }]);
  engine.ignore("c");
  const s = engine.liveSummary(2);
  assert.deepEqual([s.rx_rate, s.tx_rate, s.active], [3110, 1000, 3]);
  assert.deepEqual(s.top.map((a) => a.key), [chrome().key, "b"]);
  assert.deepEqual(engine.recentTotals(60), { rx: 3110, tx: 1000 });
  clock.now += 5000;
  assert.deepEqual(engine.liveSummary(), { rx_rate: 0, tx_rate: 0, active: 0, top: [] }, "no samples for a while means no speed");
  assert.equal(engine.view("60").rows.find((r) => r.key === chrome().key).rx_rate, 0);
  assert.equal(engine.view("60").rows.find((r) => r.key === chrome().key).rx, 3000, "totals stay");
});