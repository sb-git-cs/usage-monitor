const fs = require("fs");
const path = require("path");
const paths = require("../paths");
const accounts = require("../accounts");
const { windowOf, emptyProvider } = require("../models");
const { postJson } = require("../http");

const DISPLAY = "Amp";
const URL = "https://ampcode.com/api/internal?userDisplayBalanceInfo";
const SERVER_KEY = "apiKey@https://ampcode.com/";
const SIGN_IN = "Run: amp login";
const DAY = 86400000;
const NUM = "([\\d,]+(?:\\.\\d+)?)";

let lastEmail = null;

function installed() {
  if (paths.cliOnPath("amp")) return true;
  const bin = path.join(paths.ampHome(), "bin");
  const dirs = [path.join(paths.home(), ".config", "amp"), paths.ampDataDir()];
  return ["amp.exe", "amp"].some((f) => paths.fileExists(path.join(bin, f))) || dirs.some((p) => paths.fileExists(p));
}

// The saved sign-in is a flat object keyed by server. A newer multi-account layout that does not
// match (nested values, no apiKey@ keys) counts as no key rather than guessing which account.
function keyFromSecrets(json) {
  if (!json || typeof json !== "object") return "";
  const own = json[SERVER_KEY];
  if (typeof own === "string" && own.trim()) return own.trim();
  for (const [name, value] of Object.entries(json)) {
    if (name.startsWith("apiKey@") && typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function apiKey() {
  const env = String(process.env.AMP_API_KEY || "").trim();
  if (env) return env;
  try {
    return keyFromSecrets(JSON.parse(fs.readFileSync(path.join(paths.ampDataDir(), "secrets.json"), "utf8")));
  } catch {
    return "";
  }
}

// Milliseconds the New York wall clock is ahead of UTC at an instant (negative in the US).
function nyOffset(ms) {
  const parts = {};
  for (const p of new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", hourCycle: "h23",
    year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric",
  }).formatToParts(new Date(ms))) parts[p.type] = Number(p.value);
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - Math.floor(ms / 1000) * 1000;
}

// The next 20:00 in New York, which Amp Free is said to reset at; null when the clock cannot be read.
function nextNewYorkEight(now) {
  try {
    const local = new Date(now + nyOffset(now));
    for (let add = 0; add < 3; add++) {
      const wall = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + add, 20);
      const at = wall - nyOffset(wall);
      if (at > now) return new Date(at).toISOString();
    }
  } catch { /* no time zone data */ }
  return null;
}

function money(text) {
  const n = Number(String(text).replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

function spentPct(left, total) {
  const a = money(left);
  const b = money(total);
  return a != null && b > 0 ? ((b - a) / b) * 100 : null;
}

// End of a period's last day when the text gives a plain date.
function periodEnd(text) {
  const t = String(text || "").trim();
  const at = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(t) ? `${t}T23:59:59Z` : t);
  return Number.isFinite(at) ? new Date(at).toISOString() : null;
}

function inDays(now, days) {
  return days == null ? null : new Date(now + Number(days) * DAY).toISOString();
}

// The text `amp usage` prints. A line of a shape not known here is skipped.
function parseDisplayText(text, now = Date.now()) {
  const out = { email: null, plan: null, windows: [] };
  const credits = (amount) => out.windows.push({
    kind: "credits", label: `$${amount} credits`, used_pct: null, remaining_pct: null, resets_at: null,
  });
  for (const raw of String(text || "").replace(/\*\*/g, "").split(/\r?\n/)) {
    const line = raw.replace(/^[\s\-*•]+/, "").trim();
    const days = (/renewal in\s+(\d+)\s+days?/i.exec(line) || [])[1];
    let m;
    if ((m = /^Signed in as\s+(\S+@\S+?)(?:\s+\(.*\))?$/i.exec(line))) {
      out.email = m[1];
    } else if ((m = /^Amp Free:\s*(\d+(?:\.\d+)?)%\s*remaining/i.exec(line))) {
      out.plan = "Free";
      out.windows.push(windowOf({ kind: "daily", label: "Daily", usedPct: 100 - Number(m[1]), resetsAt: nextNewYorkEight(now) }));
    } else if ((m = new RegExp(`^Amp Free:\\s*\\$${NUM}\\s*/\\s*\\$${NUM}\\s*remaining`, "i").exec(line))) {
      out.plan = "Free";
      out.windows.push(windowOf({ kind: "daily", label: "Daily", usedPct: spentPct(m[1], m[2]), resetsAt: null }));
    } else if ((m = new RegExp(`^Amp\\s+(.+?)\\s+Tier:\\s*agent usage\\s*\\$${NUM}\\s*of\\s*\\$${NUM}\\s*remaining`, "i").exec(line))) {
      const period = /period\s+(.+?)\s+to\s+(.+?)(?:\s+·|$)/i.exec(line);
      out.plan = m[1];
      out.windows.push(windowOf({ kind: "monthly", label: "Usage", usedPct: spentPct(m[2], m[3]),
        resetsAt: (period && periodEnd(period[2])) || inDays(now, days) }));
    } else if ((m = new RegExp(`^(?:Amp\\s+(.+?)\\s+Subscription|Subscription\\s+(.+?)):\\s*${NUM}%\\s*other usage and\\s*${NUM}%\\s*orb usage remaining`, "i").exec(line))) {
      const resetsAt = inDays(now, days);
      out.plan = m[1] || m[2];
      out.windows.push(windowOf({ kind: "monthly", label: "Usage", usedPct: 100 - money(m[3]), resetsAt }));
      out.windows.push(windowOf({ kind: "monthly", label: "Orbs", usedPct: 100 - money(m[4]), resetsAt }));
    } else if ((m = new RegExp(`^Individual credits:\\s*\\$${NUM}\\s*remaining`, "i").exec(line))) {
      credits(m[1]);
    } else if ((m = new RegExp(`^Workspace\\s+.+?:\\s*\\$${NUM}\\s*remaining`, "i").exec(line))) {
      credits(m[1]);
    }
  }
  return out;
}

function provider(text) {
  const parsed = parseDisplayText(text);
  if (parsed.email) {
    lastEmail = parsed.email;
    try { accounts.observe("amp", parsed.email, parsed.email); } catch { /* the label can catch up on the next refresh */ }
  }
  return {
    id: "amp",
    display_name: DISPLAY,
    status: parsed.windows.length ? { state: "ok" } : { state: "ok", hint: "No metered limits" },
    plan: parsed.plan ? String(parsed.plan).slice(0, 40) : null,
    windows: parsed.windows,
    fetched_at: new Date().toISOString(),
    source: "api",
  };
}

function failed(state, extra) {
  return emptyProvider("amp", DISPLAY, { state, ...extra });
}

async function fetchUsage() {
  const key = apiKey();
  if (!key) {
    const present = installed();
    return failed(present ? "logged_out" : "not_installed", { hint: present ? SIGN_IN : "Amp not found" });
  }
  let res;
  try {
    res = await postJson(URL, {
      Authorization: `Bearer ${key}`,
      Accept: "application/json",
      "User-Agent": "usage-monitor",
    }, { method: "userDisplayBalanceInfo", params: {} });
  } catch (err) {
    return failed("fetch_failed", { message: String(err.message || err) });
  }
  const error = res.json && res.json.error;
  if (res.status === 401 || res.status === 403 || (error && error.code === "auth-required")) {
    return failed("logged_out", { hint: SIGN_IN });
  }
  if (res.status === 429) {
    const result = failed("fetch_failed", { message: "rate limited" });
    result._rateLimited = true;
    result._retryAfter = res.headers?.["retry-after"];
    return result;
  }
  if (res.status !== 200 || !res.json) return failed("fetch_failed", { message: `HTTP ${res.status}` });
  if (res.json.ok === false) {
    return failed("fetch_failed", { message: String((error && error.message) || "Amp returned an error").slice(0, 200) });
  }
  const text = res.json.result && res.json.result.displayText;
  if (typeof text !== "string") return failed("fetch_failed", { message: "No balance text" });
  return provider(text);
}

// The signed-in email from the last reading; the key alone does not name the account.
function accountRef() {
  return lastEmail;
}

module.exports = { id: "amp", displayName: DISPLAY, fetchUsage, accountRef, parseDisplayText };
