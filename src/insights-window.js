const { app, BrowserWindow, ipcMain, dialog, nativeTheme } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { displayPrefs } = require("./insights");
let win = null;
let ctx;
function diagnostic() {
  const snapshot = ctx.snapshot();
  const network = ctx.network();
  return { version: app.getVersion(), platform: process.platform, recorded_at: new Date().toISOString(),
    storage: ctx.insights.error ? "write_failed" : "ok",
    providers: (snapshot?.providers || []).map((p) => ({ id: p.id, state: p.status?.state || "unknown", last_success: ctx.insights.data.lastSuccess[p.id] || (["ok", "stale"].includes(p.status?.state) ? p.fetched_at || null : null) })),
    network: { state: network?.state || "unavailable", coverage: process.platform === "linux" ? "TCP only; short connections may be missed" : "Captured per-app TCP/UDP; recording gaps and unobserved traffic are excluded" } };
}
function view(days) {
  return { series: ctx.insights.report(days), events: [...ctx.insights.data.events].reverse(), snooze_until: ctx.insights.data.snoozeUntil,
    budget: ctx.insights.budgetView(), diagnostics: diagnostic(), display: ctx.cfg.display, dark: nativeTheme.shouldUseDarkColors };
}
function init(context) {
  ctx = context;
  const own = (e) => win && !win.isDestroyed() && e.sender === win.webContents;
  ipcMain.handle("insights:get", (e, days) => own(e) ? view(days) : null);
  ipcMain.handle("insights:action", async (e, action, value) => {
    if (!own(e)) return null;
    if (action === "snooze") { if (!ctx.insights.snooze(Number(value))) return { error: "Choose a valid snooze duration." }; }
    else if (action === "budget") { if (!ctx.insights.setBudget(value)) return { error: "Enter a valid budget and billing day." }; ctx.insights.save(true); }
    else if (action === "display") { ctx.cfg.display = displayPrefs(value); if (ctx.save() === false) return { error: "Could not save display settings. Check available space and folder permissions." }; }
    else if (action === "retry") ctx.refresh();
    else if (action === "network") ctx.openNetwork();
    else if (action === "settings") ctx.openSettings();
    else if (action === "login" && diagnostic().providers.some((p) => p.id === value)) return ctx.login(value);
    return ctx.insights.error ? { error: "Could not persist insights. Check available space and folder permissions." } : { ok: true };
  });
  ipcMain.handle("insights:export", async (e, format, days) => {
    if (!own(e) || !["csv", "json", "diagnostics"].includes(format)) return null;
    const ext = format === "csv" ? "csv" : "json";
    const result = await dialog.showSaveDialog(win, { defaultPath: path.join(app.getPath("downloads"), `usage-${format}.${ext}`), filters: [{ name: ext.toUpperCase(), extensions: [ext] }] });
    if (result.canceled || !result.filePath) return { canceled: true };
    try {
      const content = format === "diagnostics" ? JSON.stringify(diagnostic(), null, 2) : ctx.insights.export(days, format);
      fs.writeFileSync(result.filePath, content, "utf8"); return { ok: true };
    } catch { return { error: "Could not save the file. Check available space and folder permissions." }; }
  });
}
function open() {
  if (win && !win.isDestroyed()) { win.show(); win.focus(); return; }
  win = new BrowserWindow({ width: 1040, height: 780, minWidth: 620, minHeight: 480, title: "Usage Monitor · Insights", backgroundColor: "#111827",
    webPreferences: { preload: path.join(__dirname, "insights-preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  win.setMenuBarVisibility(false);
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (e) => e.preventDefault());
  win.loadFile(path.join(__dirname, "ui/insights.html"));
  win.on("closed", () => { win = null; });
}
module.exports = { init, open };
