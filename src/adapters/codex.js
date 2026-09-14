const fs = require("fs");
const { codexAuth, cliOnPath, fileExists } = require("../paths");
const { windowOf, emptyProvider } = require("../models");
const { getJson } = require("../http");

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
    kind = "weekly_scoped";
    label = "Daily";
  } else if (!label) {
    const h = Math.round(seconds / 3600);
    label = h >= 24 ? `${Math.round(h / 24)}d` : `${h}h`;
  }
  const resetsAt = resetAt
    ? new Date(resetAt * 1000).toISOString()
    : resetAfter != null
      ? new Date(Date.now() + resetAfter * 1000).toISOString()
      : null;
  return windowOf({ kind, label, usedPct, resetsAt });
}

function mapWham(body) {
  const windows = [];
  const rl = body.rate_limit || {};
  const primary = rl.primary_window;
  const secondary = rl.secondary_window;
  if (primary && (primary.used_percent != null || primary.remaining_percent != null)) {
    const used = primary.used_percent != null ? primary.used_percent : 100 - primary.remaining_percent;
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
    const used = secondary.used_percent != null ? secondary.used_percent : 100 - secondary.remaining_percent;
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
  for (const extra of body.additional_rate_limits || []) {
    const w = extra.primary_window;
    if (!w) continue;
    const used = w.used_percent != null ? w.used_percent : null;
    if (used == null) continue;
    windows.push(
      classifyWindow(
        used,
        w.limit_window_seconds,
        w.reset_at,
        w.reset_after_seconds,
        extra.name || extra.id || "extra"
      )
    );
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
  const plan = body.plan_type
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

  if (auth.api_key && !(auth.tokens && auth.tokens.access_token)) {
    return emptyProvider("codex", "Codex", {
      state: "unknown",
      message: "Codex is signed in with an API key — subscription windows are unavailable",
    });
  }
  const tokens = auth.tokens || {};
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

  if (res.status === 401 || res.status === 403) {
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
    return err;
  }
  if (res.status !== 200 || !res.json) {
    return emptyProvider("codex", "Codex", {
      state: "fetch_failed",
      message: `HTTP ${res.status}`,
    });
  }
  return mapWham(res.json);
}

module.exports = { id: "codex", displayName: "Codex", probe, fetchUsage };
