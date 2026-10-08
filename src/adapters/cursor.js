const path = require("path");
const fs = require("fs");
const { cursorAuth, cursorStateDb, cliOnPath, fileExists } = require("../paths");
const { readValue } = require("../cursor-local");
const { windowOf, emptyProvider } = require("../models");
const { postJson } = require("../http");
const { jwtExpMs } = require("../jwt");

const DISPLAY = "Cursor";
const PLAN_URL = "https://api2.cursor.sh/aiserver.v1.DashboardService/GetPlanInfo";
const USAGE_URL = "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage";

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function authFiles() {
  const files = [];
  try { files.push(cursorAuth()); } catch { /* platform path */ }
  try {
    const ide = path.join(path.dirname(path.dirname(path.dirname(cursorStateDb()))), "auth.json");
    if (!files.includes(ide)) files.push(ide);
  } catch { /* platform path */ }
  return files;
}

function tokenFromFiles() {
  for (const file of authFiles()) {
    const json = readJson(file);
    const token = json && (json.accessToken || json.access_token);
    if (typeof token === "string" && token.length > 20) return token;
  }
  return "";
}

function accessToken() {
  return tokenFromFiles() || readValue(safeDb(), "cursorAuth/accessToken");
}

function safeDb() {
  try { return cursorStateDb(); } catch { return ""; }
}

function installed() {
  return authFiles().some((file) => fileExists(file)) || fileExists(safeDb()) || cliOnPath("cursor") || cliOnPath("cursor-agent");
}

function headers(token) {
  return {
    Authorization: `Bearer ${token}`,
    "Connect-Protocol-Version": "1",
    "User-Agent": "usage-monitor",
  };
}

function finite(value) {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && !value.trim()) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function resetsAt(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  const date = new Date(n < 1e12 ? n * 1000 : n);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function planName(json) {
  const name = json && json.planInfo && json.planInfo.planName;
  const text = String(name || "").replace(/[\u0000-\u001f]/g, "").trim();
  return text ? text.slice(0, 40) : null;
}

function provider(plan, usage) {
  const end = resetsAt(usage && usage.billingCycleEnd);
  const spend = usage && usage.planUsage && typeof usage.planUsage === "object" ? usage.planUsage : {};
  const windows = [];
  const add = (label, value) => {
    const used = finite(value);
    if (used == null) return;
    windows.push(windowOf({ kind: "monthly", label, usedPct: used, resetsAt: end }));
  };
  add("Included", spend.totalPercentUsed);
  add("Auto", spend.autoPercentUsed);
  add("API", spend.apiPercentUsed);
  return {
    id: "cursor",
    display_name: DISPLAY,
    status: { state: "ok" },
    plan: planName(plan),
    windows,
    fetched_at: new Date().toISOString(),
    source: "api",
  };
}

function failed(state, extra) {
  const result = emptyProvider("cursor", DISPLAY, { state, ...extra });
  return result;
}

async function fetchUsage() {
  const token = accessToken();
  if (!token) {
    return failed(installed() ? "logged_out" : "not_installed", {
      hint: installed() ? "Sign in to Cursor, or run: cursor-agent login" : "Install Cursor and sign in",
    });
  }
  let planRes;
  let usageRes;
  try {
    [planRes, usageRes] = await Promise.all([
      postJson(PLAN_URL, headers(token), {}),
      postJson(USAGE_URL, headers(token), {}),
    ]);
  } catch (err) {
    return failed("fetch_failed", { message: String(err.message || err) });
  }
  if (usageRes.status === 401 || usageRes.status === 403) {
    return failed("logged_out", { hint: "Sign in to Cursor, or run: cursor-agent login" });
  }
  if (planRes.status === 429 || usageRes.status === 429) {
    const result = failed("fetch_failed", { message: "rate limited" });
    result._rateLimited = true;
    return result;
  }
  if (usageRes.status !== 200 || !usageRes.json) {
    return failed("fetch_failed", { message: `HTTP ${usageRes.status}` });
  }
  return provider(planRes.status === 200 ? planRes.json : null, usageRes.json);
}

// The current access token for a phone that reads usage directly.
function linkToken() {
  const token = accessToken();
  if (!token) return null;
  const exp = jwtExpMs(token);
  if (exp && exp <= Date.now()) return null;
  return { access_token: token, expires_at: exp };
}

module.exports = { id: "cursor", displayName: DISPLAY, fetchUsage, accessToken, linkToken };
