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
  { key: "claude:demo", tool: "claude", label: "Claude Code", name: "api-gateway", cwd: "D:\\work\\api-gateway", state: "working", resets_at: null, resume_at: null, resume: null, model: "claude-opus-5-5" },
  { key: "cursor:demo", tool: "cursor", label: "Cursor Agent", name: "Wire up the exporter", cwd: "D:\\work\\exporter", state: "idle", resets_at: null, resume_at: null, resume: null, model: null },
  { key: "grok:demo", tool: "grok", label: "Grok Build", name: "web-dashboard", cwd: "D:\\work\\web-dashboard", state: "limited",
    resets_at: sessionReset, resume_at: new Date(Date.parse(sessionReset) + 60_000).toISOString(), resume: "scheduled", model: "grok-code-fast-1" },
], recent: [
  recent("claude", "claude", "Claude Code", "4f1c2a9e-7b3d-4e8a-9c21-5d6f0e8b1a37", "Refactor the billing webhooks", "D:\\work\\billing-service", 18, { model: "claude-opus-5-5" }),
  recent("codex", "codex", "Codex", "019a3c2e-58f1-7d40-b6a2-3e9c4f1d8a05", "Add pagination to the orders API", "D:\\work\\orders-api", 74, { godmode: true, model: "gpt-5.5-codex" }),
  recent("grok", "grok", "Grok Build", "8d2e61f0-3a4b-4c9d-a1e7-6b0f2c5d9e14", "Fix the flaky login tests", "D:\\work\\web-dashboard", 5 * 60 + 12, { model: "grok-code-fast-1" }),
  recent("cursor", "cursor-agent", "Cursor Agent", "c7a9e3b2-1d4f-4a6e-8b05-9f2d7c3e1a60", "Move the charts to the new theme", "D:\\work\\design-system", 26 * 60,
    { can_resume: false, reason: "not installed" }),
] };

module.exports = { now, snapshot, batteryPoints, batteryView, netSummary, updateState, sessionsView };
