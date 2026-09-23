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
  assert.equal(context.formatUsedTotal({ used_pct: NaN }, true), "—");
  assert.equal(context.formatEta("bad"), "");
  assert.equal(context.escapeHtml('<img title="x">&'), "&lt;img title=&quot;x&quot;&gt;&amp;");
  assert.equal(context.flyoutLabel({ kind: "daily", label: "Pro" }), "Pro");
});
