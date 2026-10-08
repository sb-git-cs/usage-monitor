const { ghHosts, cliOnPath, fileExists } = require("../paths");
const githubAuth = require("../github-auth");
const accounts = require("../accounts");
const { windowOf, emptyProvider } = require("../models");
const { getJson } = require("../http");

const DISPLAY = "Copilot";
const USER_URL = "https://api.github.com/copilot_internal/user";
const PLANS = {
  free_limited_copilot: "Free",
  copilot_free: "Free",
  free: "Free",
  copilot_pro: "Pro",
  pro: "Pro",
  copilot_pro_plus: "Pro+",
  pro_plus: "Pro+",
  copilot_business: "Business",
  business: "Business",
  copilot_enterprise: "Enterprise",
  enterprise: "Enterprise",
  copilot_max: "Max",
  individual: "Individual",
};

function installed() {
  return cliOnPath("gh") || cliOnPath("copilot") || ghHosts().some((file) => fileExists(file));
}

function headers(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "usage-monitor",
    "X-GitHub-Api-Version": "2022-11-28",
    "Editor-Version": "vscode/1.103.0",
    "Editor-Plugin-Version": "copilot-chat/0.30.0",
  };
}

function planName(json) {
  const sku = String((json && (json.access_type_sku || json.copilot_plan)) || "");
  if (PLANS[sku]) return PLANS[sku];
  if (/free/i.test(sku)) return "Free";
  return null;
}

function loginOf(value) {
  const text = String(value || "").trim();
  return /^[A-Za-z0-9-]{1,39}$/.test(text) ? text : "";
}

function quotaWindow(bucket, label, resets) {
  if (!bucket || typeof bucket !== "object" || bucket.unlimited) return null;
  const finite = (value) => {
    if (typeof value !== "number" && typeof value !== "string") return null;
    if (typeof value === "string" && !value.trim()) return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  };
  const entitlement = finite(bucket.entitlement);
  if (bucket.has_quota === false && !(entitlement > 0)) return null;
  const remaining = finite(bucket.percent_remaining);
  const count = finite(bucket.remaining);
  let used = null;
  if (remaining != null) used = Math.max(0, 100 - remaining);
  else if (entitlement > 0 && count != null) {
    used = ((entitlement - count) / entitlement) * 100;
  }
  if (used == null) return null;
  return windowOf({ kind: "monthly", label, usedPct: used, resetsAt: resets });
}

function provider(json) {
  const login = loginOf(json && json.login);
  if (login) {
    try { accounts.observe("copilot", login, login); } catch { /* the label can catch up on the next refresh */ }
  }
  const resets = (json && (json.quota_reset_date_utc || json.quota_reset_date)) || null;
  const quotas = json && json.quota_snapshots && typeof json.quota_snapshots === "object" ? json.quota_snapshots : {};
  const windows = ["chat", "completions", "premium_interactions"]
    .map((id) => quotaWindow(quotas[id], id === "premium_interactions" ? "Premium" : id === "completions" ? "Completions" : "Chat", resets))
    .filter(Boolean);
  return {
    id: "copilot",
    display_name: DISPLAY,
    status: { state: "ok" },
    plan: planName(json),
    windows,
    fetched_at: new Date().toISOString(),
    source: "api",
  };
}

function failed(state, extra) {
  return emptyProvider("copilot", DISPLAY, { state, ...extra });
}

async function fetchUsage() {
  let token = "";
  try { token = await githubAuth.token(); } catch { token = ""; }
  if (!token) {
    const present = installed();
    return failed(present ? "logged_out" : "not_installed", {
      hint: present ? "Run: gh auth login" : "Sign in to GitHub Copilot",
    });
  }
  let res;
  try {
    res = await getJson(USER_URL, headers(token));
  } catch (err) {
    return failed("fetch_failed", { message: String(err.message || err) });
  }
  if (res.status === 401 || res.status === 403) {
    return failed("logged_out", { hint: "Run: gh auth login" });
  }
  if (res.status === 404) return failed("not_installed", { hint: "GitHub Copilot isn't enabled for this login" });
  if (res.status === 429) {
    const result = failed("fetch_failed", { message: "rate limited" });
    result._rateLimited = true;
    return result;
  }
  if (res.status !== 200 || !res.json) return failed("fetch_failed", { message: `HTTP ${res.status}` });
  return provider(res.json);
}

module.exports = { id: "copilot", displayName: DISPLAY, fetchUsage, planName, quotaWindow };
