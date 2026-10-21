const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const models = require("../src/models");

test("percentages reject invalid values and preserve reported overage with zero remaining", () => {
  for (const value of [null, undefined, NaN, Infinity, -Infinity, "", " ", "bad", {}, [], true]) {
    assert.equal(models.windowOf({ usedPct: value }).used_pct, null);
    assert.equal(models.remainingPct(value), null);
  }
  for (const [input, used, remaining] of [[-10, 0, 100], [150, 150, 0], ["12.5", 12.5, 87.5], [0, 0, 100]]) {
    const win = models.windowOf({ usedPct: input, resetsAt: "invalid" });
    assert.equal(win.used_pct, used);
    assert.equal(win.remaining_pct, remaining);
    assert.equal(win.resets_at, null);
  }
});

test("expired windows become unknown without inventing reset dates or mutating input", () => {
  const snapshot = { providers: [{ status: { state: "ok" }, windows: [
    { kind: "daily", used_pct: 99, resets_at: "1970-01-01T00:00:00.000Z" },
    { kind: "quota", used_pct: 40, resets_at: "bad" },
  ] }] };
  const result = models.applyLocalResets(snapshot);
  assert.equal(result.changed, true);
  assert.equal(result.snapshot.providers[0].windows[0].used_pct, null);
  assert.equal(result.snapshot.providers[0].windows[0].resets_at, null);
  assert.equal(result.snapshot.providers[0].windows[1].used_pct, 40);
  assert.equal(result.snapshot.providers[0].status.state, "stale");
  assert.equal(snapshot.providers[0].windows[0].used_pct, 99);
  assert.equal(models.applyLocalResets(result.snapshot).changed, false);
});

test("chips show five-hour usage before a higher weekly reading", () => {
  const current = { kind: "five_hour", used_pct: 5 };
  const weekly = { kind: "weekly", used_pct: 100 };
  assert.equal(models.currentWindow({ windows: [current, weekly] }), current);
  assert.equal(models.currentWindow({ windows: [weekly, current] }), current);
  assert.equal(models.currentWindow({ windows: [{ kind: "five_hour", used_pct: null }, weekly] }), weekly);
  assert.equal(models.currentWindow({ windows: [{ used_pct: NaN }] }), null);
});

test("a reading taken after a reset that it still repeats stays current", () => {
  const past = new Date(Date.now() - 20000).toISOString();
  const week = new Date(Date.now() + 3 * 86400000).toISOString();
  const reading = (fetched) => ({ providers: [{ id: "codex", status: { state: "ok" }, fetched_at: fetched, windows: [
    { kind: "five_hour", label: "5h", used_pct: 30, resets_at: past },
    { kind: "weekly", label: "Weekly", used_pct: 92, resets_at: week },
  ] }] });
  const fresh = models.applyLocalResets(reading(new Date().toISOString())).snapshot.providers[0];
  assert.equal(fresh.status.state, "ok");
  assert.equal(fresh.windows[0].used_pct, null, "the passed window is still cleared");
  assert.equal(fresh.windows[1].used_pct, 92);
  const older = models.applyLocalResets(reading(new Date(Date.now() - 60000).toISOString())).snapshot.providers[0];
  assert.equal(older.status.state, "stale", "read before the reset");
});

test("a model's own 5h limit does not take over the chip from the plan's 5h window", () => {
  const plan = { kind: "five_hour", label: "5h", used_pct: 5 };
  const spark = { kind: "five_hour", label: "GPT-5.3-Codex-Spark 5h", used_pct: 90 };
  assert.equal(models.currentWindow({ id: "codex", windows: [plan, spark] }), plan);
  assert.equal(models.currentWindow({ id: "codex", windows: [{ ...plan, used_pct: null }, spark] }), spark);
  const pro = { kind: "five_hour", label: "Gemini Pro 5h", used_pct: 80 };
  assert.equal(models.currentWindow({ id: "gemini", windows: [{ kind: "five_hour", label: "Gemini Flash 5h", used_pct: 5 }, pro] }), pro);
});

test("shown percentages reach 100 only at the limit, and an empty current reading says why", () => {
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(require.resolve("../src/models"), "utf8"), context);
  vm.runInContext(fs.readFileSync(require.resolve("../src/ui/format"), "utf8"), context);
  for (const [used, shown] of [[99.6, "99%"], [99.4, "99%"], [100, "100%"], [100.4, "100%"], [0.4, "0%"], [62.5, "63%"]]) {
    assert.equal(context.formatUsed({ used_pct: used }), shown);
  }
  assert.equal(context.statusText({ status: { state: "ok", hint: "No metered limits" }, windows: [] }), "No metered limits");
  assert.equal(context.statusText({ status: { state: "ok" }, windows: [] }), "No usage reported");
  assert.equal(context.statusText({ status: { state: "ok" }, windows: [{ kind: "weekly", used_pct: 5 }] }), null);
});

test("daily usage is the fallback before weekly when no five-hour window exists", () => {
  const daily = { kind: "daily", used_pct: 20 };
  const weekly = { kind: "weekly", used_pct: 80 };
  assert.equal(models.currentWindow({ windows: [weekly, daily] }), daily);
  assert.equal(models.currentWindow({ windows: [weekly] }), weekly);
});

test("browser formatting shares reset logic, escapes HTML and warns at exactly 80%", () => {
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(require.resolve("../src/models"), "utf8"), context);
  vm.runInContext(fs.readFileSync(require.resolve("../src/ui/format"), "utf8"), context);
  assert.equal(context.alerting({ used_pct: 80, remaining_pct: 20 }), true);
  assert.equal(context.alerting({ used_pct: 79.99 }), false);
  assert.equal(context.formatUsed({ used_pct: NaN }), "—");
  assert.equal(context.formatUsed({ used_pct: 24.6 }), "25%");
  assert.equal(context.formatEta("bad"), "");
  assert.equal(context.escapeHtml('<img title="x">&'), "&lt;img title=&quot;x&quot;&gt;&amp;");
  assert.equal(context.flyoutLabel({ kind: "daily", label: "Pro" }), "Pro");
});

test("resets and forecasts beyond the coming week show their date, not just a weekday", () => {
  const context = vm.createContext({ Date });
  vm.runInContext(fs.readFileSync(require.resolve("../src/models"), "utf8"), context);
  vm.runInContext(fs.readFileSync(require.resolve("../src/ui/format"), "utf8"), context);
  const at = (days) => new Date(Date.now() + days * 86400000);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  assert.match(context.formatEta(at(3).toISOString()), /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) \d{1,2}:\d\d (AM|PM)$/);
  for (const days of [6.5, 13, 27]) {
    const d = at(days);
    assert.equal(context.formatEta(d.toISOString()).split(" ").slice(0, 2).join(" "), `${months[d.getMonth()]} ${d.getDate()}`);
    assert.ok(context.formatClock(d.toISOString()).startsWith(`${months[d.getMonth()]} ${d.getDate()} `));
  }
});
