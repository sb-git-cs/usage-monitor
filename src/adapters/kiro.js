const fs = require("fs");
const path = require("path");
const paths = require("../paths");
const accounts = require("../accounts");
const { windowOf, emptyProvider } = require("../models");
const { postJson } = require("../http");
const { readRows } = require("../cursor-local");

const DISPLAY = "Kiro";
const DEFAULT_REGION = "us-east-1";
const LOGIN_HINT = "Open Kiro or run: kiro-cli login";
const TOKEN_KEYS = ["kirocli:odic:token", "kirocli:social:token"];

// The email from the last reading; the response is the only place it appears.
let lastEmail = "";

function ideTokenFile() {
  return path.join(paths.awsSsoCache(), "kiro-auth-token.json");
}

function installed() {
  return paths.cliOnPath("kiro-cli") || [paths.kiroHome(), ...paths.kiroDataDirs(), ideTokenFile()].some((p) => paths.fileExists(p));
}

function parseJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

function str(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

// Milliseconds from an ISO string or an epoch in seconds or milliseconds; null when unknown.
function expiryMs(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value < 1e12 ? value * 1000 : value;
  const text = str(value);
  if (!text) return null;
  if (/^\d+$/.test(text)) return expiryMs(Number(text));
  const t = Date.parse(text);
  return Number.isFinite(t) ? t : null;
}

function tokenOf(obj, fallbackArn) {
  if (!obj || typeof obj !== "object") return null;
  const token = str(obj.accessToken || obj.access_token);
  if (!token) return null;
  return {
    token,
    expiresAt: expiryMs(obj.expiresAt ?? obj.expires_at),
    profileArn: str(obj.profileArn) || fallbackArn || "",
  };
}

function ideToken() {
  try {
    return tokenOf(parseJson(fs.readFileSync(ideTokenFile(), "utf8")), "");
  } catch {
    return null;
  }
}

function dbFile() {
  return paths.kiroDataDirs().map((dir) => path.join(dir, "data.sqlite3")).find((f) => paths.fileExists(f)) || "";
}

function profileArnOf(value) {
  const text = str(value);
  if (!text) return "";
  const json = parseJson(text);
  if (json && typeof json === "object") return str(json.arn);
  if (typeof json === "string") return str(json);
  return text;
}

function cliToken() {
  const file = dbFile();
  if (!file) return null;
  const rows = readRows(file, "SELECT key, value FROM auth_kv");
  const arn = profileArnOf((readRows(file, "SELECT value FROM state WHERE key = 'api.codewhisperer.profile'")[0] || {}).value);
  for (const key of TOKEN_KEYS) {
    const row = rows.find((r) => r.key === key);
    const found = row && tokenOf(parseJson(String(row.value)), arn);
    if (found) return found;
  }
  return null;
}

// The first sign-in that has not expired: the IDE file, then the CLI database. When every
// one found has expired, `expired` says so.
function findToken(now = Date.now()) {
  let expired = false;
  for (const read of [ideToken, cliToken]) {
    const found = read();
    if (!found) continue;
    if (found.expiresAt != null && found.expiresAt <= now) expired = true;
    else return { found };
  }
  return { expired };
}

// Field 3 of arn:aws:codewhisperer:<region>:<account>:profile/<id>.
function regionOf(arn) {
  const m = /^arn:[^:]*:[^:]*:([a-z0-9-]+):/.exec(arn || "");
  return m ? m[1] : DEFAULT_REGION;
}

function arnId(arn) {
  const m = /[:/]([A-Za-z0-9]+)$/.exec(arn || "");
  return m ? m[1] : null;
}

function usageUrl(arn) {
  const query = `origin=CLI&resourceType=CREDIT${arn ? `&profileArn=${encodeURIComponent(arn)}` : ""}`;
  return `https://q.${regionOf(arn)}.amazonaws.com/?${query}`;
}

function num(...values) {
  for (const v of values) {
    if (v == null || typeof v === "boolean" || (typeof v === "string" && !v.trim())) continue;
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function creditWindow(label, used, overages, limit, resetEpoch) {
  if (!(limit > 0)) return null;
  const pct = ((used || 0) - (overages || 0)) / limit * 100;
  return windowOf({ kind: "monthly", label, usedPct: pct, resetsAt: resetEpoch == null ? null : new Date(resetEpoch * 1000).toISOString() });
}

function mapUsage(json) {
  const windows = [];
  const list = Array.isArray(json && json.usageBreakdownList) ? json.usageBreakdownList : [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const main = creditWindow(str(item.displayName) || "Credits",
      num(item.currentUsageWithPrecision, item.currentUsage),
      num(item.currentOveragesWithPrecision, item.currentOverages),
      num(item.usageLimitWithPrecision, item.usageLimit),
      num(item.nextDateReset));
    if (main) windows.push(main);
    const trial = item.freeTrialInfo;
    if (trial && typeof trial === "object") {
      const w = creditWindow("Trial", num(trial.currentUsageWithPrecision, trial.currentUsage), 0,
        num(trial.usageLimitWithPrecision, trial.usageLimit), num(trial.freeTrialExpiry));
      if (w) windows.push(w);
    }
  }
  return windows;
}

function provider(json) {
  const email = str(json && json.userInfo && json.userInfo.email);
  if (email) {
    lastEmail = email;
    try { accounts.observe("kiro", email, email); } catch { /* the label can catch up on the next refresh */ }
  }
  const windows = mapUsage(json);
  return {
    id: "kiro",
    display_name: DISPLAY,
    status: windows.length ? { state: "ok" } : { state: "ok", hint: "No metered limits" },
    plan: str(json && json.subscriptionInfo && json.subscriptionInfo.subscriptionTitle) || null,
    windows,
    fetched_at: new Date().toISOString(),
    source: "api",
  };
}

function failed(state, extra) {
  return emptyProvider("kiro", DISPLAY, { state, ...extra });
}

async function fetchUsage() {
  const { found, expired } = findToken();
  if (!found) {
    if (expired) return failed("logged_out", { hint: LOGIN_HINT });
    const present = installed();
    return failed(present ? "logged_out" : "not_installed", { hint: present ? LOGIN_HINT : "Kiro not found" });
  }
  const headers = {
    "x-amz-target": "AmazonCodeWhispererService.GetUsageLimits",
    "Content-Type": "application/x-amz-json-1.0",
    Authorization: `Bearer ${found.token}`,
    "User-Agent": "usage-monitor",
  };
  let res;
  try {
    res = await postJson(usageUrl(found.profileArn), headers, found.profileArn ? { profileArn: found.profileArn } : {});
  } catch (err) {
    return failed("fetch_failed", { message: String(err.message || err) });
  }
  const type = String((res.json && (res.json.__type || res.json.code)) || "");
  if (res.status === 429 || type.includes("ThrottlingException")) {
    const result = failed("fetch_failed", { message: "rate limited" });
    result._rateLimited = true;
    result._retryAfter = (res.headers || {})["retry-after"] || null;
    return result;
  }
  if (res.status === 401 || res.status === 403 || type.includes("AccessDeniedException")) {
    return failed("logged_out", { hint: LOGIN_HINT });
  }
  if (res.status !== 200 || !res.json) return failed("fetch_failed", { message: `HTTP ${res.status}` });
  return provider(res.json);
}

// The signed-in email once a reading has shown it, else the profile's id. Never the token.
function accountRef() {
  if (lastEmail) return lastEmail;
  const found = ideToken() || cliToken();
  return found ? arnId(found.profileArn) : null;
}

module.exports = { id: "kiro", displayName: DISPLAY, fetchUsage, accountRef, mapUsage, provider, findToken, regionOf, usageUrl };
