// Demo readings for the screenshots and the UI smoke test. Nothing here is read from this computer.
const MB = 1024 ** 2;
const GB = 1024 ** 3;
const MIN = 60000;

const now = Date.now();
const inMin = (m) => new Date(now + m * MIN).toISOString();
const agoMin = (m) => new Date(now - m * MIN).toISOString();
const win = (kind, label, used, resetsIn) => ({ kind, label, used_pct: used, remaining_pct: used == null ? null : 100 - used, resets_at: resetsIn ? inMin(resetsIn) : null });
const fetched = new Date(now - 40_000).toISOString();
const snapshot = {
  providers: [
    { id: "claude", display_name: "Claude Code", status: { state: "ok" }, plan: "Max 20x", windows: [win("five_hour", "5h", 82, 74), win("weekly", "Weekly", 41, 4 * 1440 + 120)] },
    { id: "codex", display_name: "Codex", status: { state: "ok" }, plan: "Plus", windows: [win("five_hour", "5h", 18, 182), win("weekly", "Weekly", 33, 5 * 1440)] },
    { id: "gemini", display_name: "Gemini", status: { state: "ok" }, plan: "Google AI Pro", windows: [win("five_hour", "5h", 12, 250), win("weekly", "Weekly", 28, 5 * 1440)] },
    { id: "grok", display_name: "Grok Build", status: { state: "ok" }, plan: "SuperGrok", windows: [win("weekly", "Weekly", 55, 3 * 1440 + 60), win("credits", "Credits $12.40", null, 0)] },
    { id: "cursor", display_name: "Cursor", status: { state: "ok" }, plan: "Pro", account: "cursor@example.com", windows: [win("monthly", "Included", 42, 12 * 1440), win("monthly", "Auto", 18, 12 * 1440)] },
    { id: "copilot", display_name: "Copilot", status: { state: "ok" }, plan: "Pro", account: "octocat", windows: [win("monthly", "Chat", 36, 10 * 1440), win("monthly", "Premium", 64, 10 * 1440)] },
  ],
};
snapshot.providers.find((p) => p.id === "grok").shared_weekly = win("weekly", "Weekly", 55, 3 * 1440 + 60);
for (const p of snapshot.providers) p.fetched_at = fetched;
const batteryPoints = Array.from({ length: 48 }, (_, i) => ({ t: now - (47 - i) * 2.5 * MIN, present: true, percent: Math.round((84 - i * 0.55) * 10) / 10,
  state: "discharging", seconds: 3 * 3600 + 40 * 60, source: "power", g: false }));
const batteryView = { latest: batteryPoints.at(-1), points: batteryPoints };

const netSummary = {
  state: "running",
  message: null,
  rx_rate: 3.4 * MB,
  tx_rate: 220 * 1024,
  active: 7,
  top: [
    { key: "msedge", name: "Microsoft Edge", rx_rate: 2.9 * MB, tx_rate: 60 * 1024 },
    { key: "drive", name: "Google Drive", rx_rate: 190 * 1024, tx_rate: 220 * 1024 },
    { key: "git", name: "Git for Windows", rx_rate: 96 * 1024, tx_rate: 4 * 1024 },
  ],
  hour: { rx: 1.46 * GB, tx: 212 * MB },
};

const updateState = { kind: "installer", status: "up-to-date", current: require("../package.json").version, build: null, auto: true, checked_at: now };
const sessionReset = new Date(now + 47 * 60_000).toISOString();
// Closed sessions as the watcher lists them, newest first.
const recent = (tool, cli, label, id, name, cwd, closedMin, extra = {}) => ({ key: `${tool}:${id}`, tool, cli, label, name, cwd, id,
  started: agoMin(closedMin + 95), last_active: agoMin(closedMin), closed_at: agoMin(closedMin), godmode: false, can_resume: true, reason: null, ...extra });
const sessionsView = { auto_resume: true, can_resume: true, sessions: [
  { key: "claude:demo", tool: "claude", label: "Claude Code", name: "api-gateway", cwd: "D:\\work\\api-gateway", state: "working", resets_at: null, resume_at: null, resume: null, model: "claude-opus-5-5", files: 5 },
  { key: "cursor:demo", tool: "cursor", label: "Cursor Agent", name: "Wire up the exporter", cwd: "D:\\work\\exporter", state: "idle", resets_at: null, resume_at: null, resume: null, model: null },
  { key: "grok:demo", tool: "grok", label: "Grok Build", name: "web-dashboard", cwd: "D:\\work\\web-dashboard", state: "limited",
    resets_at: sessionReset, resume_at: new Date(Date.parse(sessionReset) + 60_000).toISOString(), resume: "scheduled", model: "grok-code-fast-1", files: 1 },
], recent: [
  recent("claude", "claude", "Claude Code", "4f1c2a9e-7b3d-4e8a-9c21-5d6f0e8b1a37", "Refactor the billing webhooks", "D:\\work\\billing-service", 18, { model: "claude-opus-5-5", files: 12 }),
  recent("codex", "codex", "Codex", "019a3c2e-58f1-7d40-b6a2-3e9c4f1d8a05", "Add pagination to the orders API", "D:\\work\\orders-api", 74, { godmode: true, model: "gpt-5.5-codex", files: 3 }),
  recent("grok", "grok", "Grok Build", "8d2e61f0-3a4b-4c9d-a1e7-6b0f2c5d9e14", "Fix the flaky login tests", "D:\\work\\web-dashboard", 5 * 60 + 12, { model: "grok-code-fast-1" }),
  recent("cursor", "cursor-agent", "Cursor Agent", "c7a9e3b2-1d4f-4a6e-8b05-9f2d7c3e1a60", "Move the charts to the new theme", "D:\\work\\design-system", 26 * 60,
    { can_resume: false, reason: "not installed" }),
] };

// What the session-files scanner returns, for the Session files window. dir is a scratch folder the caller
// creates; the files marked as existing are written there. The keys are those of the sessions above.
function filesScan(dir) {
  const path = require("node:path");
  const file = (p, kind, minutesAgo, exists, size) => ({ path: p, name: path.basename(p), kind, at: agoMin(minutesAgo), exists, size: exists ? size : null, modified: exists ? now - minutesAgo * MIN : null });
  const api = path.join(dir, "api-gateway");
  const orders = path.join(dir, "orders-api");
  return {
    sessions: [
      { key: "claude:demo", tool: "claude", label: "Claude Code", id: "demo", name: "api-gateway", cwd: api, started: agoMin(95), last_active: agoMin(2), files: [
        file(path.join(api, "out", "q3-report.pdf"), "generated", 3, true, 248 * 1024),
        file(path.join(api, "src", "server.js"), "edited", 9, true, 18204),
        file(path.join(api, "docs", "design-notes.md"), "created", 14, true, 5321),
        file(path.join(api, "scripts", "build.bat"), "created", 21, true, 310),
        file(path.join(dir, "shared", "architecture-overview-with-a-very-long-name-for-the-wrapping-check.png"), "edited", 33, true, 1.4 * MB),
        file(path.join(api, "notes", "old-draft.txt"), "created", 52, false),
      ] },
      { key: "codex:019a3c2e-58f1-7d40-b6a2-3e9c4f1d8a05", tool: "codex", label: "Codex", id: "019a3c2e-58f1-7d40-b6a2-3e9c4f1d8a05", name: "Add pagination to the orders API", cwd: orders, started: agoMin(169), last_active: agoMin(74), files: [
        file(path.join(orders, "src", "routes", "orders.ts"), "edited", 80, true, 9120),
        file(path.join(orders, "data", "export.csv"), "generated", 85, true, 64 * 1024),
        file(path.join(orders, "README.md"), "edited", 120, true, 2048),
      ] },
      { key: "grok:demo", tool: "grok", label: "Grok Build", id: "demo", name: "web-dashboard", cwd: path.join(dir, "web-dashboard"), started: agoMin(240), last_active: agoMin(30), files: [
        file(path.join(dir, "web-dashboard", "dist", "bundle.js"), "generated", 35, true, 512 * 1024),
      ] },
    ],
    coverage: { skipped: 0, truncated: false },
  };
}

module.exports = { now, snapshot, batteryPoints, batteryView, netSummary, updateState, sessionsView, filesScan };
