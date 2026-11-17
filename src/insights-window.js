const { app, BrowserWindow, ipcMain, dialog, nativeTheme } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { displayPrefs } = require("./insights");
const tokens = require("./tokens");
const { modelExport } = tokens;
// By absolute path, like burn below: some test loaders resolve bare relative paths from their own folder.
const { createOffload } = require(path.join(__dirname, "offload"));
let analyzeBurn = () => [];
let computeHealth = () => ({ score: 100, label: "Good", grade: "A", recommendations: [] });

// Token reports read weeks of transcripts; they run in a utility process that ends a minute after
// the last one, so what they allocate never stays with the main process.
const tokenReports = createOffload(path.join(__dirname, "tokens.js"), { inline: tokens, name: "token report" });

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
  const NAMES = { claude: "Claude Code", codex: "Codex", gemini: "Gemini", grok: "Grok Build", cursor: "Cursor", copilot: "Copilot", windsurf: "Windsurf", kiro: "Kiro", amp: "Amp", opencode: "OpenCode", qwen: "Qwen Code", kimi: "Kimi Code", x_subscription: "X Subscription" };
  const STATUS = { exhausted: "Used up", critical: "Runs out", elevated: "Watch", sustainable: "On pace", cooling: "Falling", idle: "Idle" };
  const gb = (n) => `${((Number(n) || 0) / 1e9).toFixed(2)} GB`;
  // Cost at API list prices; "—" when nothing in the row has a published price.
  const usd = (x) => (x && Number.isFinite(x.cost) && (x.priced || x.cost > 0) ? `$${x.cost < 0.01 && x.cost > 0 ? "<0.01" : x.cost.toFixed(2)}${x.priced === false ? "*" : ""}` : "—");
  const when = (t) => (Number.isFinite(t) ? new Date(t).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "—");
  const lines = [
    "# Usage Monitor report",
    `Generated: ${new Date().toLocaleString()}`,
    `Period: ${v.days || 7} ${v.days === 1 ? "day" : "days"} | Quota health: ${v.health?.label || "Good"} (${v.health?.score ?? 100}/100)`,
    "",
    "## Summary",
    `- **Quota health**: ${v.health?.score ?? 100}/100 (${v.health?.label || "Good"})`,
    `- **Windows recorded**: ${v.series?.length || 0}`,
    `- **Tokens**: ${v.tokens?.summary?.total ? v.tokens.summary.total.toLocaleString() : "0"} (${v.tokens?.summary?.cache_efficiency_pct || 0}% of prompt tokens read from cache)`,
    ...(v.tokens?.summary?.total ? [`- **API-equivalent cost**: ${usd(v.tokens.summary)} over ${(v.tokens.summary.sessions || 0).toLocaleString()} sessions, at list prices`] : []),
    `- **Network this cycle**: ${v.budget?.used ? gb(v.budget.used) : "0 GB"} / ${v.budget?.limit ? gb(v.budget.limit) : "No limit set"}`,
    "",
    "## Recommendations",
  ];
  for (const rec of v.health?.recommendations || []) {
    lines.push(`- **${md(rec.title)}**: ${md(rec.body)}`);
  }
  lines.push("", "## Pace and runway", "| Plan and window | Used | Current pace | Safe pace | Resets in | Status |", "|---|---|---|---|---|---|");
  for (const w of v.burn || []) {
    lines.push(`| ${md(NAMES[w.provider] || w.provider)} (${md(w.label)}) | ${Math.round(w.used)}% | ${w.burn_rate}%/h | ${w.safe_rate != null ? `${w.safe_rate}%/h` : "—"} | ${w.hours_to_reset != null ? `${w.hours_to_reset}h` : "—"} | ${md(STATUS[w.status] || w.status)} |`);
  }
  if (v.tokens?.summary?.total) {
    const sm = v.tokens.summary;
    lines.push(
      "",
      "## Tokens",
      `- **Total**: ${sm.total.toLocaleString()}`,
      `- **Uncached input**: ${sm.input.toLocaleString()}`,
      `- **Read from cache**: ${sm.cache_read.toLocaleString()} (${sm.cache_efficiency_pct}% of prompt tokens)`,
      `- **Written to cache**: ${sm.cache_write.toLocaleString()}`,
      `- **Output**: ${sm.output.toLocaleString()} (reasoning ${sm.reasoning.toLocaleString()})`,
      `- **Model responses**: ${sm.turns.toLocaleString()} (${sm.avg_turn_tokens.toLocaleString()} tokens each on average)`,
      `- **Sessions**: ${(sm.sessions || 0).toLocaleString()}`,
      `- **API-equivalent cost**: ${usd(sm)} at pay-as-you-go list prices (subscription plans are not billed per token)` +
        (sm.unpriced ? `; ${sm.unpriced.toLocaleString()} tokens from models without a published price are not included` : "")
    );
  }
  lines.push(
    "",
    "## Network budget",
    `- **Recorded this cycle**: ${v.budget?.used ? gb(v.budget.used) : "0 GB"}`,
    `- **Cycle**: ${v.budget?.start ? new Date(v.budget.start).toLocaleDateString() : "—"} to ${v.budget?.end ? new Date(v.budget.end).toLocaleDateString() : "—"}`
  );
  lines.push("", "## Model usage", "Observed Claude Code and Codex transcript tokens. Reasoning is included in output; totals count cached input once.",
    "| Provider / model | Total | Uncached input | Cache read | Cache write | Output | Reasoning subset | API cost |", "|---|---:|---:|---:|---:|---:|---:|---:|");
  for (const m of v.tokens?.by_model || []) {
    lines.push(`| ${md(NAMES[m.provider] || m.provider)} / ${md(m.model)} | ${m.total} | ${m.input} | ${m.cache_read} | ${m.cache_write} | ${m.output} | ${m.reasoning} | ${usd(m)} |`);
  }
  for (const m of v.tokens?.by_model || []) lines.push("", `Daily trend for ${md(m.model)}:`, ...(m.daily || []).map((d) => `- ${md(d.date)}: ${d.total} recorded tokens, ${usd(d)}`), "");
  // Cumulative over the period: how many sessions used each model and what they spent on it.
  const models = v.tokens?.by_model || [];
  if (models.length) {
    lines.push("", "## Models across sessions", "| Provider / model | Sessions | Responses | Tokens | Share | API cost | Tokens per session | Cost per session |", "|---|---:|---:|---:|---:|---:|---:|---:|");
    for (const m of models) {
      lines.push(`| ${md(NAMES[m.provider] || m.provider)} / ${md(m.model)} | ${m.sessions ?? "—"} | ${m.turns.toLocaleString()} | ${m.total.toLocaleString()} | ${m.pct}% | ${usd(m)} | ` +
        `${(m.avg_session_tokens ?? 0).toLocaleString()} | ${usd({ cost: m.avg_session_cost, priced: m.priced })} |`);
    }
    const sm = v.tokens.summary;
    lines.push(`| **All models** | **${(sm.sessions || 0).toLocaleString()}** | **${sm.turns.toLocaleString()}** | **${sm.total.toLocaleString()}** | 100% | **${usd(sm)}** | | |`);
  }
  // Each session, newest first, with what each model used in it.
  const sessions = v.tokens?.by_session || [];
  if (sessions.length) {
    const SHOWN = 50;
    lines.push("", "## Sessions by model", `Sessions are named by their folder and the title the tool gave them${sessions.length > SHOWN ? `; the newest ${SHOWN} of ${sessions.length} are listed (the session CSV export has them all)` : ""}.`,
      "| Session | Folder | Active | Model | Responses | Tokens | API cost |", "|---|---|---|---|---:|---:|---:|");
    for (const s of sessions.slice(0, SHOWN)) {
      const name = `${md(NAMES[s.provider] || s.provider)} · ${md(s.title || `session ${String(s.id).slice(0, 8)}`)}${s.agents ? ` (+${s.agents} sub-agent${s.agents === 1 ? "" : "s"})` : ""}`;
      (s.models || []).forEach((m, i) => {
        lines.push(i === 0 ? `| ${name} | ${md(s.folder || "—")} | ${md(when(s.first))} – ${md(when(s.last))} | ${md(m.model)} | ${m.turns.toLocaleString()} | ${m.total.toLocaleString()} | ${usd(m)} |`
          : `| | | | ${md(m.model)} | ${m.turns.toLocaleString()} | ${m.total.toLocaleString()} | ${usd(m)} |`);
      });
      if ((s.models || []).length > 1) lines.push(`| | | | *Session total* | ${s.turns.toLocaleString()} | ${s.total.toLocaleString()} | ${usd(s)} |`);
    }
  }
  if (v.tokens?.pricing) {
    lines.push("", `Costs are what the tokens would cost at the providers' pay-as-you-go API list prices (checked ${md(v.tokens.pricing.checked)}), ` +
      "including cache reads and writes, long-prompt rates and fast mode where the transcripts record them; Codex cache writes are priced at the shortest retention. " +
      "Subscription plans are not billed per token. * marks a row with tokens from a model without a published price.");
  }
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
  const result = tokenReports.call("scanTokens", { days }).catch(() => null);
  tokenScans.set(days, { at: Date.now(), result });
  return result;
}

// Closed sessions the panel offered to reopen, reduced to the fields the page shows.
function recentSessions() {
  try {
    return (ctx.sessions ? ctx.sessions()?.recent || [] : []).map((s) => ({
      key: s.key,
      tool: s.tool,
      cli: s.cli,
      label: s.label,
      name: s.name,
      cwd: s.cwd,
      id: s.id,
      started: s.started,
      last_active: s.last_active,
      closed_at: s.closed_at,
      godmode: s.godmode,
      can_resume: s.can_resume,
      reason: s.reason,
    }));
  } catch {
    return [];
  }
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
    days: [1, 7, 14, 30].includes(days) ? days : 7,
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
    recent_sessions: recentSessions(),
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
    } else if (action === "resume" && typeof value === "string") {
      if (ctx.resume) return ctx.resume(value);
    } else if (action === "login" && diagnostic().providers.some((p) => p.id === value)) {
      if (ctx.login) return ctx.login(value);
    }
    return ctx.insights.error ? { error: "Could not persist insights. Check available space and folder permissions." } : { ok: true };
  });

  ipcMain.handle("insights:export", async (e, format, days, model) => {
    if (!own(e) || !["csv", "json", "diagnostics", "report", "battery-csv", "models-csv", "models-daily-csv", "models-json", "sessions-csv"].includes(format)) return null;
    if (model != null && model !== "all" && !/^[a-f0-9]{16}$/.test(model)) return { error: "Select a valid model." };
    const ext = ["csv", "battery-csv", "models-csv", "models-daily-csv", "sessions-csv"].includes(format) ? "csv" : format === "report" ? "md" : "json";
    const result = await dialog.showSaveDialog(win, {
      defaultPath: path.join(app.getPath("downloads"), `usage-${format}.${ext}`),
      filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
    });
    if (result.canceled || !result.filePath) return { canceled: true };
    try {
      let content;
      if (format === "diagnostics") content = JSON.stringify(diagnostic(), null, 2);
      else if (format.startsWith("models-") || format === "sessions-csv") content = modelExport((await view(days)).tokens, format, model);
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
      spellcheck: false,
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
