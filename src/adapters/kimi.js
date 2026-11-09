const fs = require("fs");
const path = require("path");
const { kimiCodeHome, cliOnPath, fileExists } = require("../paths");
const accounts = require("../accounts");
const { windowOf, emptyProvider } = require("../models");
const { getJson } = require("../http");

const DISPLAY = "Kimi Code";
const GLOBAL_HOST = "https://api.kimi.ai";
const MAINLAND_HOST = "https://api.kimi.com";
const LOGIN_HINT = "Run: kimi login";
// Plan buckets in display order; the new plans only report the 5-hour one.
const BUCKETS = [
  ["limit_5h", "five_hour", "5h"],
  ["limit_7d", "weekly", "Weekly"],
  ["limit_month_total", "monthly", "Monthly"],
  ["limit_month_code", "monthly", "Code"],
];

// The email of the last successful /me answer; never the token.
let lastEmail = null;

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function installed() {
  return cliOnPath("kimi") || fileExists(kimiCodeHome());
}

// kimi-code.json first, then any other sign-in file in the folder.
function readCredentials() {
  const dir = path.join(kimiCodeHome(), "credentials");
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith(".json")); } catch { return null; }
  names.sort((a, b) => (a === "kimi-code.json" ? -1 : b === "kimi-code.json" ? 1 : a.localeCompare(b)));
  for (const name of names) {
    const json = readJson(path.join(dir, name));
    if (json && typeof json.access_token === "string" && json.access_token) {
      return { token: json.access_token, expiresAt: Number(json.expires_at) || null };
    }
  }
  return null;
}

// Only the api_key line of the managed provider's table; no TOML library.
function apiKeyFromConfig() {
  let text;
  try { text = fs.readFileSync(path.join(kimiCodeHome(), "config.toml"), "utf8"); } catch { return ""; }
  let inTable = false;
  for (const line of text.split(/\r?\n/)) {
    const head = /^\s*\[(.+?)\]\s*(#.*)?$/.exec(line);
    if (head) {
      inTable = /^providers\s*\.\s*(?:"managed:kimi-code"|'managed:kimi-code')$/.test(head[1].trim());
      continue;
    }
    const m = inTable && /^\s*api_key\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(line);
    if (m) return m[1] || m[2] || "";
  }
  return "";
}

function baseUrl() {
  const override = String(process.env.KIMI_CODE_BASE_URL || "").trim();
  if (override) return override.replace(/\/+$/, "").replace(/\/coding\/v1$/, "");
  let region = "";
  try { region = fs.readFileSync(path.join(kimiCodeHome(), "region"), "utf8"); } catch { /* global host */ }
  return region.includes("mainland-cn") ? MAINLAND_HOST : GLOBAL_HOST;
}

function headers(token) {
  return { Authorization: `Bearer ${token}`, Accept: "application/json", "User-Agent": "usage-monitor" };
}

function finite(value) {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && !value.trim()) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// An ISO string, unix seconds or unix milliseconds.
function resetsAt(value) {
  const n = finite(value);
  let ms;
  if (n != null) ms = n <= 0 ? NaN : n < 1e12 ? n * 1000 : n;
  else if (typeof value === "string") ms = Date.parse(value);
  else return null;
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function mapWindows(usages) {
  const src = usages && typeof usages === "object" ? usages : {};
  const out = [];
  for (const [key, kind, label] of BUCKETS) {
    const bucket = src[key];
    const ratio = bucket && typeof bucket === "object" ? finite(bucket.used_ratio) : null;
    if (ratio == null) continue;
    out.push(windowOf({ kind, label, usedPct: ratio * 100, resetsAt: resetsAt(bucket.reset_time) }));
  }
  return out;
}

function planName(me) {
  const text = String((me && me.user_level_name) || "").replace(/[\u0000-\u001f]/g, "").trim();
  return text ? text.slice(0, 40) : null;
}

function emailOf(me) {
  const text = String((me && me.email) || "").trim();
  return text.length > 3 && text.length <= 254 && text.includes("@") ? text : "";
}

function provider(usagesJson, me) {
  const windows = mapWindows(usagesJson && usagesJson.usages);
  const email = emailOf(me);
  if (email) {
    lastEmail = email;
    try { accounts.observe("kimi", email, email); } catch { /* the label can catch up on the next refresh */ }
  }
  return {
    id: "kimi",
    display_name: DISPLAY,
    status: windows.length ? { state: "ok" } : { state: "ok", hint: "No metered limits" },
    plan: planName(me),
    windows,
    fetched_at: new Date().toISOString(),
    source: "api",
  };
}

function failed(state, extra) {
  return emptyProvider("kimi", DISPLAY, { state, ...extra });
}

async function fetchUsage() {
  const creds = readCredentials();
  const expired = !!(creds && creds.expiresAt && creds.expiresAt * 1000 <= Date.now());
  const key = apiKeyFromConfig();
  const token = (creds && !expired && creds.token) || key;
  if (!token) {
    if (expired) return failed("logged_out", { hint: LOGIN_HINT });
    return failed(installed() ? "logged_out" : "not_installed", {
      hint: installed() ? LOGIN_HINT : "Kimi Code not found",
    });
  }
  const base = `${baseUrl()}/coding/v1`;
  let usageRes;
  let meRes;
  try {
    [usageRes, meRes] = await Promise.all([
      getJson(`${base}/usages`, headers(token)),
      getJson(`${base}/me`, headers(token)).catch(() => null),
    ]);
  } catch (err) {
    return failed("fetch_failed", { message: String(err.message || err) });
  }
  if (usageRes.status === 401) return failed("logged_out", { hint: LOGIN_HINT });
  if (usageRes.status === 404) return failed("fetch_failed", { message: "usage endpoint unavailable" });
  if (usageRes.status === 429) {
    const result = failed("fetch_failed", { message: "rate limited" });
    result._rateLimited = true;
    result._retryAfter = usageRes.headers?.["retry-after"];
    return result;
  }
  if (usageRes.status !== 200 || !usageRes.json) return failed("fetch_failed", { message: `HTTP ${usageRes.status}` });
  return provider(usageRes.json, meRes && meRes.status === 200 ? meRes.json : null);
}

function accountRef() {
  return lastEmail;
}

module.exports = { id: "kimi", displayName: DISPLAY, fetchUsage, accountRef, mapWindows, resetsAt };
