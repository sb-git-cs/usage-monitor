const fs = require("fs");
const { codexAuth, cliOnPath, fileExists } = require("../paths");
const { windowOf, emptyProvider, percentage } = require("../models");
const { getJson } = require("../http");
const { jwtExpMs } = require("../jwt");

const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

function probe() {
  return {
    cli_on_path: cliOnPath("codex"),
    creds_present: fileExists(codexAuth()),
  };
}

function classifyWindow(usedPct, seconds, resetAt, resetAfter, fallbackLabel) {
  let kind = "weekly_scoped";
  let label = fallbackLabel;
  if (seconds >= 14400 && seconds <= 21600) {
    kind = "five_hour";
    label = "5h";
  } else if (seconds >= 518400 && seconds <= 691200) {
    kind = "weekly";
    label = "Weekly";
  } else if (seconds >= 82800 && seconds <= 90000) {
    kind = "daily";
    label = "Daily";
  } else if (seconds > 0 && (!label || label === "5h" || label === "Weekly")) {
    // Another length: the primary and secondary fallbacks would name it wrongly.
    const h = Math.round(seconds / 3600);
    label = h >= 24 ? `${Math.round(h / 24)}d` : `${h}h`;
  }
  if (fallbackLabel && fallbackLabel !== "5h" && fallbackLabel !== "Weekly") label = `${fallbackLabel} ${label === fallbackLabel ? "" : label}`.trim();
  const epoch = resetAt != null ? Number(resetAt) * 1000
    : resetAfter != null ? Date.now() + Number(resetAfter) * 1000 : NaN;
  const date = new Date(epoch);
  const resetsAt = Number.isFinite(date.getTime()) ? date.toISOString() : null;
  return windowOf({ kind, label, usedPct, resetsAt });
}

// A remaining percentage only counts when it is a number; a blank one is not 100% used.
function usedOf(w) {
  if (w.used_percent != null) return w.used_percent;
  const left = percentage(w.remaining_percent);
  return left == null ? null : 100 - left;
}

function mapWham(body) {
  const windows = [];
  const rl = body.rate_limit || {};
  const primary = rl.primary_window;
  const secondary = rl.secondary_window;
  if (primary && (primary.used_percent != null || primary.remaining_percent != null)) {
    const used = usedOf(primary);
    windows.push(
      classifyWindow(
        used,
        primary.limit_window_seconds,
        primary.reset_at,
        primary.reset_after_seconds,
        "5h"
      )
    );
  }
  if (secondary && (secondary.used_percent != null || secondary.remaining_percent != null)) {
    const used = usedOf(secondary);
    windows.push(
      classifyWindow(
        used,
        secondary.limit_window_seconds,
        secondary.reset_at,
        secondary.reset_after_seconds,
        "Weekly"
      )
    );
  }
  for (const extra of Array.isArray(body.additional_rate_limits) ? body.additional_rate_limits : []) {
    if (!extra) continue;
    // Current responses nest a model's windows under rate_limit; earlier ones put them on the entry.
    const limits = extra.rate_limit || extra;
    for (const w of [limits.primary_window, limits.secondary_window]) {
      if (!w || w.used_percent == null) continue;
      windows.push(
        classifyWindow(
          w.used_percent,
          w.limit_window_seconds,
          w.reset_at,
          w.reset_after_seconds,
          extra.limit_name || extra.name || extra.id || "extra"
        )
      );
    }
  }
  const credits = body.rate_limit_reset_credits;
  if (credits && credits.available_count > 0) {
    windows.push({
      kind: "credits",
      label: `Reset credits ×${credits.available_count}`,
      used_pct: null,
      remaining_pct: null,
      resets_at: null,
    });
  }
  const plan = typeof body.plan_type === "string" && body.plan_type
    ? body.plan_type.charAt(0).toUpperCase() + body.plan_type.slice(1)
    : null;
  return {
    id: "codex",
    display_name: "Codex",
    status: { state: "ok" },
    plan,
    windows,
    fetched_at: new Date().toISOString(),
    source: "api",
  };
}

async function fetchUsage() {
  const p = probe();
  if (!p.creds_present && !p.cli_on_path) {
    return emptyProvider("codex", "Codex", {
      state: "not_installed",
      hint: "Install Codex, then run: codex login",
    });
  }
  if (!p.creds_present) {
    return emptyProvider("codex", "Codex", {
      state: "logged_out",
      hint: "Run: codex login",
    });
  }

  let auth;
  try {
    auth = JSON.parse(fs.readFileSync(codexAuth(), "utf8"));
  } catch {
    return emptyProvider("codex", "Codex", {
      state: "logged_out",
      hint: "Run: codex login",
    });
  }

  if ((auth?.api_key || auth?.OPENAI_API_KEY) && !(auth.tokens && auth.tokens.access_token)) {
    return emptyProvider("codex", "Codex", {
      state: "unknown",
      message: "Codex is signed in with an API key — subscription windows are unavailable",
    });
  }
  const tokens = auth?.tokens || {};
  if (!tokens.access_token) {
    return emptyProvider("codex", "Codex", {
      state: "logged_out",
      hint: "Run: codex login",
    });
  }

  const res = await getJson(USAGE_URL, {
    Authorization: `Bearer ${tokens.access_token}`,
    "ChatGPT-Account-Id": tokens.account_id || "",
    "User-Agent": "Mozilla/5.0 usage-monitor/1.0",
  });

  // Only 401 means the login expired. A 403 can come from the site's firewall, so it stays
  // retryable and the last reading is kept.
  if (res.status === 401) {
    return emptyProvider("codex", "Codex", {
      state: "logged_out",
      hint: "Open Codex once to refresh login",
    });
  }
  if (res.status === 429) {
    const err = emptyProvider("codex", "Codex", {
      state: "fetch_failed",
      message: "rate limited",
    });
    err._rateLimited = true;
    err._retryAfter = res.headers && res.headers["retry-after"];
    return err;
  }
  if (res.status !== 200 || !res.json) {
    return emptyProvider("codex", "Codex", {
      state: "fetch_failed",
      message: `HTTP ${res.status}`,
    });
  }
  const mapped = mapWham(res.json);
  if (!mapped.windows.length) {
    // Without rate_limit the body is a changed or error response, and the last good reading is
    // kept. With it but no window, the plan reports no limits.
    if (!res.json || typeof res.json !== "object" || !("rate_limit" in res.json)) {
      return emptyProvider("codex", "Codex", {
        state: "fetch_failed",
        message: "Usage response not recognized",
      });
    }
    mapped.status = { ...mapped.status, hint: "No limits reported" };
  }
  return mapped;
}

// The current access token for a phone that reads usage directly; the refresh token stays here.
function linkToken() {
  let auth;
  try {
    auth = JSON.parse(fs.readFileSync(codexAuth(), "utf8"));
  } catch {
    return null;
  }
  const tokens = (auth && auth.tokens) || {};
  if (!tokens.access_token) return null;
  const exp = jwtExpMs(tokens.access_token);
  if (exp && exp <= Date.now()) return null;
  return { access_token: tokens.access_token, account_id: tokens.account_id || null, expires_at: exp };
}

// The ChatGPT account the saved login belongs to, even while its token is expired.
function accountRef() {
  try {
    return JSON.parse(fs.readFileSync(codexAuth(), "utf8"))?.tokens?.account_id || null;
  } catch {
    return null;
  }
}

module.exports = { id: "codex", displayName: "Codex", probe, fetchUsage, linkToken, accountRef };
