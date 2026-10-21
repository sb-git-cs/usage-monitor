const { app, BrowserWindow, ipcMain, dialog, nativeTheme } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { displayPrefs } = require("./insights");
const { modelExport } = require("./tokens");
let scanTokens = () => null;
let analyzeBurn = () => [];
let computeHealth = () => ({ score: 100, label: "Optimal", grade: "A", recommendations: [] });

try {
  const tokensModule = require(path.join(__dirname, "tokens"));
  scanTokens = tokensModule.scanTokens || scanTokens;
} catch {
  try {
    const tokensModule = require("./tokens");
    scanTokens = tokensModule.scanTokens || scanTokens;
  } catch {}
}

try {
  const burnModule = require(path.join(__dirname, "burn"));
  analyzeBurn = burnModule.analyzeBurn || analyzeBurn;
  computeHealth = burnModule.computeHealth || computeHealth;
} catch {
  try {
    const burnModule = require("./burn");
    analyzeBurn = burnModule.analyzeBurn || analyzeBurn;
    computeHealth = burnModule.computeHealth || computeHealth;
  } catch {}
}

let win = null;
let ctx;

function diagnostic() {
  const snapshot = ctx.snapshot ? ctx.snapshot() : null;
  const network = ctx.network ? ctx.network() : null;
  return {
    version: app.getVersion(),
    platform: process.platform,
    recorded_at: new Date().toISOString(),
    storage: ctx.insights.error ? "write_failed" : "ok",
    providers: (snapshot?.providers || []).map((p) => ({
      id: p.id,
      state: p.status?.state || "unknown",
      last_success: ctx.insights.data.lastSuccess[p.id] || (["ok", "stale"].includes(p.status?.state) ? p.fetched_at || null : null),
    })),
    network: {
      state: network?.state || "unavailable",
      coverage: process.platform === "linux" ? "TCP only; short connections may be missed" : "Captured per-app TCP/UDP; recording gaps and unobserved traffic are excluded",
    },
  };
}

function generateReport(v) {
  const md = (value) => String(value ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]))
    .replace(/[\\`*_{}\[\]()|]/g, "\\$&").replace(/[\r\n]/g, " ");
  const lines = [
    "# Usage Monitor · Executive Insights & Intelligence Report",
    `Generated: ${new Date().toLocaleString()}`,
    `Reporting Window: ${v.tokens?.days || 7} days | System Health: ${v.health?.label || "Optimal"} (${v.health?.score ?? 100}/100 Grade ${v.health?.grade || "A"})`,
    "",
    "## 1. Executive Summary",
    `- **Health Score**: ${v.health?.score ?? 100}/100 (${v.health?.label || "Optimal"})`,
    `- **Active Series Observed**: ${v.series?.length || 0}`,
    `- **Total Tokens Processed**: ${v.tokens?.summary?.total ? v.tokens.summary.total.toLocaleString() : "0"} (${v.tokens?.summary?.cache_efficiency_pct || 0}% cache efficiency)`,
    `- **Network Captured**: ${(v.budget?.used ? (v.budget.used / 1e9).toFixed(2) : "0")} GB / ${(v.budget?.limit ? (v.budget.limit / 1e9).toFixed(2) : "No limit set")} GB`,
    "",
    "## 2. Key Insights & Actionable Recommendations",
  ];
  for (const rec of v.health?.recommendations || []) {
    lines.push(`- **[${md(rec.type.toUpperCase())}] ${md(rec.title)}**: ${md(rec.body)}`);
  }
  lines.push("", "## 3. Quota & Burn Rate Analysis", "| Provider / Window | Current Used | Burn Rate | Safe Pace | Hours to Reset | Status |", "|---|---|---|---|---|---|");
  for (const w of v.burn || []) {
    lines.push(`| ${md(w.provider)} (${md(w.label)}) | ${Math.round(w.used)}% | ${w.burn_rate}%/h | ${w.safe_rate != null ? `${w.safe_rate}%/h` : "—"} | ${w.hours_to_reset != null ? `${w.hours_to_reset}h` : "—"} | ${md(w.status)} |`);
  }
  if (v.tokens?.summary?.total) {
    lines.push(
      "",
      "## 4. Token Consumption & Efficiency",
      `- **Total Tokens**: ${v.tokens.summary.total.toLocaleString()}`,
      `- **Input / Prompt Tokens**: ${v.tokens.summary.input.toLocaleString()}`,
      `- **Output / Completion Tokens**: ${v.tokens.summary.output.toLocaleString()}`,
      `- **Cache Read Tokens**: ${v.tokens.summary.cache_read.toLocaleString()}`,
      `- **Reasoning / Thinking Tokens**: ${v.tokens.summary.reasoning.toLocaleString()}`,
      `- **Cache Efficiency**: ${v.tokens.summary.cache_efficiency_pct}%`,
      `- **Total Turns**: ${v.tokens.summary.turns.toLocaleString()}`,
      `- **Average Tokens / Turn**: ${v.tokens.summary.avg_turn_tokens.toLocaleString()}`
    );
  }
  lines.push(
    "",
    "## 5. Network Traffic & Budget",
    `- **Captured Cycle Traffic**: ${(v.budget?.used ? (v.budget.used / 1e9).toFixed(2) : "0")} GB`,
    `- **Cycle Start**: ${v.budget?.start ? new Date(v.budget.start).toLocaleDateString() : "—"}`,
    `- **Cycle End**: ${v.budget?.end ? new Date(v.budget.end).toLocaleDateString() : "—"}`
  );
  lines.push("", "## Model usage", "Observed Claude Code and Codex transcript tokens. Reasoning is included in output; totals count cached input once.",
    "| Provider / model | Total | Uncached input | Cache read | Cache write | Output | Reasoning subset |", "|---|---:|---:|---:|---:|---:|---:|");
  for (const m of v.tokens?.by_model || []) {
    lines.push(`| ${md(m.provider)} / ${md(m.model)} | ${m.total} | ${m.input} | ${m.cache_read} | ${m.cache_write} | ${m.output} | ${m.reasoning} |`);
  }
  for (const m of v.tokens?.by_model || []) lines.push("", `Daily trend for ${md(m.model)}:`, ...(m.daily || []).map((d) => `- ${md(d.date)}: ${d.total} recorded tokens`), "");
  if (v.battery) {
    const r = v.battery.latest;
    lines.push("", "## Battery", `- Current: ${r?.percent ?? "Unknown"}% · ${require("./battery-model").label(r)}`,
      `- Observed sessions: ${v.battery.sessions.length} (interrupted sessions are partial)`);
  }
  return lines.join("\n");
}

// The window refreshes every 10 seconds; transcripts are rescanned at most every 30 seconds per
// period, and a scan already running is shared instead of started again.
const TOKENS_TTL_MS = 30_000;
const tokenScans = new Map();
function tokensFor(days) {
  const cached = tokenScans.get(days);
  if (cached && Date.now() - cached.at < TOKENS_TTL_MS) return cached.result;
  const result = Promise.resolve().then(() => scanTokens({ days })).catch(() => null);
  tokenScans.set(days, { at: Date.now(), result });
  return result;
}

async function view(days) {
  const series = ctx.insights.report(days);
  const burn = analyzeBurn(series);
  const events = [...ctx.insights.data.events].reverse();
  const health = computeHealth(burn, events);
  const tokens = await tokensFor(days);

  // Sanitize sessions if available
  let activeSessions = [];
  try {
    const rawSessions = ctx.sessions ? ctx.sessions() : null;
    activeSessions = (rawSessions?.sessions || []).map((s) => ({
      key: s.key,
      tool: s.tool,
      label: s.label,
      name: s.name,
      state: s.state,
      resets_at: s.resets_at,
      started: s.started,
    }));
  } catch {
    activeSessions = [];
  }

  return {
    series,
    battery: ctx.battery?.view(days) || null,
    events,
    snooze_until: ctx.insights.data.snoozeUntil,
    budget: ctx.insights.budgetView(),
    diagnostics: diagnostic(),
    display: ctx.cfg.display,
    alert_threshold: ctx.cfg.alert_threshold,
    dark: nativeTheme.shouldUseDarkColors,
    burn,
    health,
    tokens,
    active_sessions: activeSessions,
  };
}

function init(context) {
  ctx = context;
  const own = (e) => win && !win.isDestroyed() && e.sender === win.webContents;
  ipcMain.handle("insights:get", (e, days) => own(e) ? view(days) : null);
  ipcMain.handle("insights:action", async (e, action, value) => {
    if (!own(e)) return null;
    if (action === "clear-battery") {
      return ctx.battery?.clear() ? { ok: true } : { error: "Could not clear battery history." };
    } else if (action === "snooze") {
      if (!ctx.insights.snooze(Number(value))) return { error: "Choose a valid snooze duration." };
    } else if (action === "budget") {
      if (!ctx.insights.setBudget(value)) return { error: "Enter a valid budget and billing day." };
      ctx.insights.save(true);
    } else if (action === "display") {
      ctx.cfg.display = displayPrefs(value);
      if (ctx.save() === false) return { error: "Could not save display settings. Check available space and folder permissions." };
    } else if (action === "retry") {
      if (ctx.refresh) ctx.refresh();
    } else if (action === "network") {
      if (ctx.openNetwork) ctx.openNetwork();
    } else if (action === "settings") {
      if (ctx.openSettings) ctx.openSettings();
    } else if (action === "login" && diagnostic().providers.some((p) => p.id === value)) {
      if (ctx.login) return ctx.login(value);
    }
    return ctx.insights.error ? { error: "Could not persist insights. Check available space and folder permissions." } : { ok: true };
  });

  ipcMain.handle("insights:export", async (e, format, days, model) => {
    if (!own(e) || !["csv", "json", "diagnostics", "report", "battery-csv", "models-csv", "models-daily-csv", "models-json"].includes(format)) return null;
    if (model != null && model !== "all" && !/^[a-f0-9]{16}$/.test(model)) return { error: "Select a valid model." };
    const ext = ["csv", "battery-csv", "models-csv", "models-daily-csv"].includes(format) ? "csv" : format === "report" ? "md" : "json";
    const result = await dialog.showSaveDialog(win, {
      defaultPath: path.join(app.getPath("downloads"), `usage-${format}.${ext}`),
      filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
    });
    if (result.canceled || !result.filePath) return { canceled: true };
    try {
      let content;
      if (format === "diagnostics") content = JSON.stringify(diagnostic(), null, 2);
      else if (format.startsWith("models-")) content = modelExport((await view(days)).tokens, format, model);
      else if (format === "report") content = generateReport(await view(days));
      else if (format === "battery-csv") content = ctx.battery.csv(days);
      else if (format === "json") content = JSON.stringify({ ...JSON.parse(ctx.insights.export(days, format)), battery: ctx.battery?.view(days) }, null, 2);
      else content = ctx.insights.export(days, format);
      fs.writeFileSync(result.filePath, content, "utf8");
      return { ok: true };
    } catch {
      return { error: "Could not save the file. Check available space and folder permissions." };
    }
  });
}

function open(tab) {
  if (win && !win.isDestroyed()) {
    if (tab === "battery") win.webContents.send("insights:tab", tab);
    win.show();
    win.focus();
    return;
  }
  win = new BrowserWindow({
    width: 1100,
    height: 820,
    minWidth: 680,
    minHeight: 520,
    title: "Usage Monitor · Insights",
    backgroundColor: "#0b0f19",
    webPreferences: {
      preload: path.join(__dirname, "insights-preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.setMenuBarVisibility(false);
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (e) => e.preventDefault());
  win.loadFile(path.join(__dirname, "ui/insights.html"), { query: tab === "battery" ? { tab } : {} });
  win.on("closed", () => {
    win = null;
  });
}

module.exports = { init, open, generateReport };
