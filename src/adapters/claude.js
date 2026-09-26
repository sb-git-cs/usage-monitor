const fs = require("fs");
const { execFile } = require("child_process");
const { claudeCredentials, cliOnPath, fileExists } = require("../paths");
const { windowOf, emptyProvider } = require("../models");
const { getJson, postJson } = require("../http");

const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const TOKEN_URL_LEGACY = "https://console.anthropic.com/v1/oauth/token";
// On macOS, Claude Code keeps its login in the Keychain instead of .credentials.json.
const KEYCHAIN_SERVICE = "Claude Code-credentials";

function probe() {
  return {
    cli_on_path: cliOnPath("claude"),
    creds_present: fileExists(claudeCredentials()),
  };
}

function readCreds() {
  const p = claudeCredentials();
  const stat = fs.statSync(p);
  const raw = fs.readFileSync(p, "utf8");
  const json = JSON.parse(raw);
  return { path: p, mtimeMs: stat.mtimeMs, json, oauth: json.claudeAiOauth || null };
}

// Read-only: refreshing would rotate the token Claude Code relies on, so a Keychain login is never rewritten.
// macOS may ask the user to allow access, so a read is cached and a refusal is not retried every poll.
const KEYCHAIN_CACHE_MS = 5 * 60_000;
const KEYCHAIN_RETRY_MS = 10 * 60_000;
const keychain = { value: null, at: 0, failedAt: 0 };

function readKeychain() {
  if (process.platform !== "darwin") return Promise.resolve(null);
  const now = Date.now();
  if (keychain.value && now - keychain.at < KEYCHAIN_CACHE_MS) return Promise.resolve(keychain.value);
  if (keychain.failedAt && now - keychain.failedAt < KEYCHAIN_RETRY_MS) return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile("/usr/bin/security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"], { timeout: 60000, encoding: "utf8" }, (err, stdout) => {
      let creds = null;
      try {
        if (!err) {
          const json = JSON.parse(String(stdout).trim());
          creds = { path: null, keychain: true, json, oauth: json.claudeAiOauth || null };
        }
      } catch {
        creds = null;
      }
      keychain.value = creds;
      keychain.at = creds ? Date.now() : 0;
      keychain.failedAt = creds ? 0 : Date.now();
      resolve(creds);
    });
  });
}

function forgetKeychain() {
  keychain.value = null;
  keychain.at = 0;
}

async function loadCreds(filePresent) {
  if (filePresent) return readCreds();
  return readKeychain();
}

function planLabel(oauth) {
  const tier = oauth && oauth.rateLimitTier;
  if (tier === "default_claude_max_20x") return "Max 20x";
  if (tier === "default_claude_max_5x") return "Max 5x";
  if (tier && /max_20/.test(tier)) return "Max 20x";
  if (tier && /max_5/.test(tier)) return "Max 5x";
  const sub = oauth && oauth.subscriptionType;
  if (sub === "max") return "Max";
  if (sub === "pro") return "Pro";
  if (sub === "enterprise") return "Enterprise";
  return sub || null;
}

function usageHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    "anthropic-beta": "oauth-2025-04-20",
    "anthropic-version": "2023-06-01",
    "x-app": "cli",
    "User-Agent": "claude-cli/2.1.201 (external, cli)",
    "anthropic-dangerous-direct-browser-access": "true",
  };
}

async function refresh(oauth) {
  const body = {
    grant_type: "refresh_token",
    refresh_token: oauth.refreshToken,
    client_id: CLIENT_ID,
  };
  let res = await postJson(TOKEN_URL, { "User-Agent": "usage-monitor/1.0" }, body);
  if (res.status === 404 || res.status === 405) {
    res = await postJson(TOKEN_URL_LEGACY, { "User-Agent": "usage-monitor/1.0" }, body);
  }
  return res;
}

function casWriteTokens(creds, tokens) {
  const stat = fs.statSync(creds.path);
  if (stat.mtimeMs !== creds.mtimeMs) return false;
  const next = { ...creds.json, claudeAiOauth: { ...creds.oauth } };
  if (tokens.access_token) next.claudeAiOauth.accessToken = tokens.access_token;
  if (tokens.refresh_token) next.claudeAiOauth.refreshToken = tokens.refresh_token;
  if (tokens.expires_in) {
    next.claudeAiOauth.expiresAt = Date.now() + Number(tokens.expires_in) * 1000;
  }
  const tmp = creds.path + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { encoding: "utf8" });
  fs.renameSync(tmp, creds.path);
  return true;
}

function mapUsage(body, oauth) {
  const windows = [];
  if (body.five_hour && (body.five_hour.utilization != null || body.five_hour.resets_at)) {
    windows.push(
      windowOf({
        kind: "five_hour",
        label: "5h",
        usedPct: body.five_hour.utilization,
        resetsAt: body.five_hour.resets_at,
      })
    );
  }
  if (body.seven_day && (body.seven_day.utilization != null || body.seven_day.resets_at)) {
    windows.push(
      windowOf({
        kind: "weekly",
        label: "Weekly",
        usedPct: body.seven_day.utilization,
        resetsAt: body.seven_day.resets_at,
      })
    );
  }
  for (const lim of Array.isArray(body.limits) ? body.limits : []) {
    if (lim && lim.kind === "weekly_scoped" && lim.scope && lim.scope.model && lim.scope.model.display_name) {
      const name = lim.scope.model.display_name;
      windows.push(
        windowOf({
          kind: "weekly_scoped",
          label: `${name} weekly`,
          usedPct: lim.percent,
          resetsAt: lim.resets_at,
        })
      );
    }
  }
  const spend = body.spend;
  if (spend && spend.enabled && spend.limit && spend.used) {
    const used = spend.used.amount_minor;
    const limit = spend.limit.amount_minor;
    windows.push(
      windowOf({
        kind: "credits",
        label: "Credits",
        usedPct: limit ? (used / limit) * 100 : null,
        resetsAt: null,
      })
    );
  }
  return {
    id: "claude",
    display_name: "Claude Code",
    status: { state: "ok" },
    plan: planLabel(oauth),
    windows,
    fetched_at: new Date().toISOString(),
    source: "api",
  };
}

async function fetchUsage(cfg) {
  const p = probe();
  let creds;
  try {
    creds = await loadCreds(p.creds_present);
  } catch {
    creds = null;
  }
  if (!creds && !p.creds_present && !p.cli_on_path) {
    return emptyProvider("claude", "Claude Code", {
      state: "not_installed",
      hint: "Install Claude Code, then run: claude auth login",
    });
  }
  if (!creds) {
    return emptyProvider("claude", "Claude Code", {
      state: "logged_out",
      hint: "Run: claude auth login",
    });
  }
  if (!creds.oauth || !creds.oauth.accessToken) {
    return emptyProvider("claude", "Claude Code", {
      state: "unknown",
      message: "Claude is not signed in with a subscription (no OAuth token)",
    });
  }

  const refreshEnabled = cfg?.adapters?.claude?.refresh_tokens !== false && !creds.keychain;
  let refreshed = false;
  const exp = Number(creds.oauth.expiresAt || 0);
  if (refreshEnabled && exp && exp - Date.now() < 60_000 && creds.oauth.refreshToken) {
    try {
      const r = await refresh(creds.oauth);
      if (r.status === 200 && r.json?.access_token) {
        refreshed = true;
        casWriteTokens(creds, r.json);
        creds = readCreds();
      } else if (r.status === 400 || r.status === 401) {
        return emptyProvider("claude", "Claude Code", {
          state: "logged_out",
          hint: "Run: claude auth login",
        });
      }
    } catch {
      /* keep going with current token */
    }
  }

  let res = await getJson(USAGE_URL, usageHeaders(creds.oauth.accessToken));
  if (res.status === 401 && refreshEnabled && !refreshed && creds.oauth.refreshToken) {
    try {
      const r = await refresh(creds.oauth);
      if (r.status === 200 && r.json?.access_token) {
        casWriteTokens(creds, r.json);
        creds = readCreds();
        res = await getJson(USAGE_URL, usageHeaders(creds.oauth.accessToken));
      }
    } catch {
      /* fall through */
    }
  }
  if (res.status === 401 || res.status === 403) {
    // Claude Code may have rotated its token; read the Keychain again on the next poll.
    if (creds.keychain) forgetKeychain();
    return emptyProvider("claude", "Claude Code", {
      state: "logged_out",
      hint: creds.keychain ? "Open Claude Code once to refresh its sign-in" : "Run: claude auth login",
    });
  }
  if (res.status === 429) {
    const err = emptyProvider("claude", "Claude Code", {
      state: "fetch_failed",
      message: "rate limited",
    });
    err._rateLimited = true;
    return err;
  }
  if (res.status !== 200 || !res.json) {
    return emptyProvider("claude", "Claude Code", {
      state: "fetch_failed",
      message: `HTTP ${res.status}`,
    });
  }
  return mapUsage(res.json, creds.oauth);
}

module.exports = { id: "claude", displayName: "Claude Code", probe, fetchUsage };
