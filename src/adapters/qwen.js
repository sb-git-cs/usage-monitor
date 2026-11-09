const fs = require("fs");
const path = require("path");
const paths = require("../paths");
const accounts = require("../accounts");
const { emptyProvider } = require("../models");
const { getJson } = require("../http");

const DISPLAY = "Qwen Code";
const USERINFO_URL = "https://auth.qwen.ai/api/oauth/userinfo";
const SIGN_IN = "Run: qwen, then /auth";
const NO_QUOTA = "Qwen reports no quota; a session shows its limit when it hits one";

// The account the last reading named, so the poller can tell a changed sign-in without a request.
let knownRef = null;

function installed() {
  if (paths.cliOnPath("qwen") || paths.fileExists(paths.qwenHome())) return true;
  if (process.platform !== "win32") return false;
  const appData = process.env.APPDATA || path.join(paths.home(), "AppData", "Roaming");
  return paths.fileExists(path.join(appData, "npm", "node_modules", "@qwen-code", "qwen-code"));
}

// The subscription sign-in only; oauth_creds.json belongs to the free tier that ended.
function credentials() {
  try {
    const json = JSON.parse(fs.readFileSync(path.join(paths.qwenHome(), "subscription_credentials.json"), "utf8"));
    const tokens = json && json.tokens;
    if (!tokens || typeof tokens.access_token !== "string" || !tokens.access_token) return null;
    const expires = Number(tokens.expiresAt);
    return { token: tokens.access_token, expiresAt: Number.isFinite(expires) && expires > 0 ? expires : null };
  } catch {
    return null;
  }
}

function planName(memberType) {
  const text = String(memberType || "").trim();
  return text ? text[0].toUpperCase() + text.slice(1).toLowerCase() : null;
}

function provider(info) {
  const email = info && typeof info.email === "string" ? info.email.trim() : "";
  if (email) {
    const sub = info.sub == null ? "" : String(info.sub);
    knownRef = sub || email;
    try { accounts.observe("qwen", email, knownRef); } catch { /* the label can catch up on the next refresh */ }
  }
  return {
    id: "qwen",
    display_name: DISPLAY,
    status: { state: "ok", hint: NO_QUOTA },
    plan: planName(info && info.member_type),
    windows: [],
    fetched_at: new Date().toISOString(),
    source: "api",
  };
}

function failed(state, extra) {
  return emptyProvider("qwen", DISPLAY, { state, ...extra });
}

async function fetchUsage() {
  const creds = credentials();
  if (!creds) {
    const present = installed();
    return failed(present ? "logged_out" : "not_installed", { hint: present ? SIGN_IN : "Qwen Code not found" });
  }
  if (creds.expiresAt != null && creds.expiresAt <= Date.now()) return failed("logged_out", { hint: SIGN_IN });
  let res;
  try {
    res = await getJson(USERINFO_URL, {
      Authorization: `Bearer ${creds.token}`,
      Accept: "application/json",
      "User-Agent": "usage-monitor",
    });
  } catch (err) {
    return failed("fetch_failed", { message: String(err.message || err) });
  }
  if (res.status === 401) return failed("logged_out", { hint: SIGN_IN });
  if (res.status === 429) {
    const result = failed("fetch_failed", { message: "rate limited" });
    result._rateLimited = true;
    result._retryAfter = (res.headers || {})["retry-after"] || null;
    return result;
  }
  if (res.status !== 200 || !res.json) return failed("fetch_failed", { message: `HTTP ${res.status}` });
  return provider(res.json);
}

// The user id or email from the last reading; null before one. Never the token.
function accountRef() {
  return knownRef;
}

module.exports = { id: "qwen", displayName: DISPLAY, fetchUsage, accountRef, planName, provider };
