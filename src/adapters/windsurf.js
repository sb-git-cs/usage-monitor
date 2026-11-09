const fs = require("fs");
const path = require("path");
const paths = require("../paths");
const accounts = require("../accounts");
const { readValue } = require("../cursor-local");
const { windowOf, emptyProvider } = require("../models");
const { postJson } = require("../http");

const DISPLAY = "Windsurf";
const HOSTS = ["https://server.self-serve.windsurf.com", "https://server.codeium.com"];
const STATUS_PATH = "/exa.seat_management_pb.SeatManagementService/GetUserStatus";
const VERSION = "1.108.2";
const SIGN_IN_HINT = "Sign in to Devin Desktop, or run: devin auth login";

let knownEmail = null;

function finite(value) {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && !value.trim()) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function cliBinary() {
  return path.join(paths.localAppData(), "devin", "cli", "bin", process.platform === "win32" ? "devin.exe" : "devin");
}

function credentialsFile() {
  return path.join(paths.devinDataDir(), "credentials.toml");
}

function installed() {
  return paths.devinStateDbs().some((db) => paths.fileExists(db)) || paths.cliOnPath("devin") ||
    paths.fileExists(cliBinary()) || paths.fileExists(credentialsFile());
}

// The first editor database that holds a signed-in key; the key stays in memory and is never logged.
function editorKey() {
  for (const db of paths.devinStateDbs()) {
    try {
      const auth = JSON.parse(readValue(db, "windsurfAuthStatus"));
      if (auth && typeof auth.apiKey === "string" && auth.apiKey) return { db, key: auth.apiKey };
    } catch {
      /* this database has no usable sign-in */
    }
  }
  return null;
}

function resetIso(unix) {
  const n = finite(unix);
  return n != null && n > 0 ? new Date(n * 1000).toISOString() : null;
}

function quotaWindow(kind, label, remaining, resetUnix) {
  const left = finite(remaining);
  if (left == null) return null;
  return windowOf({ kind, label, usedPct: 100 - left, resetsAt: resetIso(resetUnix) });
}

function planOf(name) {
  const text = String(name || "").replace(/[\u0000-\u001f]/g, "").trim();
  return text ? text.slice(0, 40) : null;
}

// userStatus from GetUserStatus -> { plan, windows, email }
function mapUserStatus(userStatus) {
  const status = (userStatus && userStatus.planStatus) || {};
  const info = status.planInfo || (userStatus && userStatus.planInfo) || {};
  const windows = [];
  const daily = info.hideDailyQuota ? null : quotaWindow("daily", "Daily", status.dailyQuotaRemainingPercent, status.dailyQuotaResetAtUnix);
  const weekly = quotaWindow("weekly", "Weekly", status.weeklyQuotaRemainingPercent, status.weeklyQuotaResetAtUnix);
  if (daily) windows.push(daily);
  if (weekly) windows.push(weekly);
  // Older plans meter prompt credits instead, in hundredths.
  if (status.dailyQuotaRemainingPercent == null && status.weeklyQuotaRemainingPercent == null) {
    const used = finite(status.usedPromptCredits);
    const available = finite(status.availablePromptCredits);
    if (used != null && available != null && used + available > 0) {
      windows.push(windowOf({ kind: "monthly", label: "Credits", usedPct: (used / (used + available)) * 100, resetsAt: null }));
    }
  }
  const overage = finite(status.overageBalanceMicros);
  if (overage != null && overage > 0) {
    windows.push(windowOf({ kind: "credits", label: `Extra usage $${(overage / 1e6).toFixed(2)}`, usedPct: null, resetsAt: null }));
  }
  const email = userStatus && typeof userStatus.email === "string" ? userStatus.email.trim() : "";
  return { plan: planOf(info.planName), windows, email };
}

// The editor's saved plan info, written at launch.
function mapCachedPlan(raw) {
  let info;
  try {
    info = JSON.parse(raw);
  } catch {
    return null;
  }
  const usage = info && info.quotaUsage;
  if (!usage || typeof usage !== "object") return null;
  const windows = [
    quotaWindow("daily", "Daily", usage.dailyRemainingPercent, usage.dailyResetAtUnix),
    quotaWindow("weekly", "Weekly", usage.weeklyRemainingPercent, usage.weeklyResetAtUnix),
  ].filter(Boolean);
  return windows.length ? { plan: planOf(info.planName), windows } : null;
}

function provider(mapped, extra) {
  return {
    id: "windsurf",
    display_name: DISPLAY,
    status: mapped.windows.length ? { state: "ok" } : { state: "ok", hint: "No metered limits" },
    plan: mapped.plan,
    windows: mapped.windows,
    fetched_at: new Date().toISOString(),
    source: "api",
    ...extra,
  };
}

function failed(state, extra) {
  return emptyProvider("windsurf", DISPLAY, { state, ...extra });
}

function body(key) {
  return {
    metadata: { apiKey: key, ideName: "windsurf", ideVersion: VERSION, extensionName: "windsurf", extensionVersion: VERSION, locale: "en" },
  };
}

// A network failure or a 404 on the first host tries the second; the last answer or error stands.
async function callStatus(key) {
  const headers = { "Connect-Protocol-Version": "1", "User-Agent": "usage-monitor" };
  let last = null;
  for (const host of HOSTS) {
    try {
      last = await postJson(host + STATUS_PATH, headers, body(key));
    } catch (err) {
      last = { error: err };
      continue;
    }
    if (last.status !== 404) return last;
  }
  return last;
}

function cachedReading(db) {
  const mapped = mapCachedPlan(readValue(db, "windsurf.settings.cachedPlanInfo"));
  if (!mapped) return null;
  let age = 0;
  try { age = Math.max(0, Math.round((Date.now() - fs.statSync(db).mtimeMs) / 1000)); } catch { /* unknown age */ }
  return provider(mapped, { status: { state: "stale", age_secs: age }, source: "cache" });
}

async function fetchUsage() {
  const found = editorKey();
  if (!found) {
    knownEmail = null;
    if (paths.fileExists(credentialsFile())) {
      return failed("ok", { hint: "Usage is read from Devin Desktop" });
    }
    return installed()
      ? failed("logged_out", { hint: SIGN_IN_HINT })
      : failed("not_installed", { hint: "Install Devin Desktop or the Devin CLI" });
  }
  const res = await callStatus(found.key);
  if (res && (res.status === 401 || res.status === 403)) {
    knownEmail = null;
    return failed("logged_out", { hint: SIGN_IN_HINT });
  }
  if (res && res.status === 429) {
    const result = failed("fetch_failed", { message: "rate limited" });
    result._rateLimited = true;
    result._retryAfter = res.headers?.["retry-after"];
    return result;
  }
  if (res && res.status === 200 && res.json && res.json.userStatus) {
    const mapped = mapUserStatus(res.json.userStatus);
    if (mapped.email) {
      knownEmail = mapped.email;
      try { accounts.observe("windsurf", mapped.email, mapped.email); } catch { /* the label can catch up on the next refresh */ }
    }
    return provider(mapped);
  }
  return cachedReading(found.db) ||
    failed("fetch_failed", { message: res && res.error ? String(res.error.message || res.error) : `HTTP ${res && res.status}` });
}

// The signed-in email once a reading has shown it; never the key.
function accountRef() {
  return knownEmail;
}

module.exports = { id: "windsurf", displayName: DISPLAY, fetchUsage, accountRef, mapUserStatus, mapCachedPlan, editorKey };
