const fs = require("fs");
const { grokAuth, cliOnPath, fileExists } = require("../paths");
const { windowOf, emptyProvider } = require("../models");
const { getJson, postForm } = require("../http");

const BILLING_URL = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";

function probe() {
  return {
    cli_on_path: cliOnPath("grok"),
    creds_present: fileExists(grokAuth()),
  };
}

function pickEntry(json) {
  const values = Object.values(json || {});
  const withKey = values.filter((v) => v && v.key);
  if (!withKey.length) return null;
  withKey.sort((a, b) => String(b.create_time || "").localeCompare(String(a.create_time || "")));
  return withKey[0];
}

function jwtExpMs(token) {
  try {
    const parts = String(token).split(".");
    if (parts.length < 2) return null;
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return payload.exp ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

async function refreshGrok(entry, credsPath, mtimeMs, topKey) {
  const issuer = (entry.oidc_issuer || "https://auth.x.ai").replace(/\/$/, "");
  const clientId = entry.oidc_client_id;
  const refreshToken = entry.refresh_token;
  if (!clientId || !refreshToken) return null;
  let tokenUrl = issuer + "/oauth/token";
  try {
    const disc = await getJson(issuer + "/.well-known/openid-configuration", {
      Accept: "application/json",
    });
    if (disc.status === 200 && disc.json && disc.json.token_endpoint) {
      tokenUrl = disc.json.token_endpoint;
    }
  } catch {
    /* use default */
  }
  const res = await postForm(tokenUrl, { Accept: "application/json" }, {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId,
  });
  if (res.status !== 200 || !res.json || !res.json.access_token) return null;

  try {
    const stat = fs.statSync(credsPath);
    if (stat.mtimeMs !== mtimeMs) return res.json.access_token;
    const json = JSON.parse(fs.readFileSync(credsPath, "utf8"));
    const current = json[topKey];
    if (!current) return res.json.access_token;
    current.key = res.json.access_token;
    if (res.json.refresh_token) current.refresh_token = res.json.refresh_token;
    if (res.json.expires_in) {
      current.expires_at = new Date(Date.now() + res.json.expires_in * 1000).toISOString();
    }
    const tmp = credsPath + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(json, null, 2), { encoding: "utf8" });
    fs.renameSync(tmp, credsPath);
  } catch {
    /* in-memory token still usable */
  }
  return res.json.access_token;
}

function weeklyPct(cfg) {
  if (cfg.creditUsagePercent != null) return Number(cfg.creditUsagePercent);
  const used = cfg.used && cfg.used.val;
  const limit = cfg.monthlyLimit && cfg.monthlyLimit.val;
  if (used != null && limit) return (Number(used) / Number(limit)) * 100;
  return null;
}

function mapBilling(body) {
  const cfg = body.config || body;
  const windows = [];
  const pct = weeklyPct(cfg);
  const end = (cfg.currentPeriod && cfg.currentPeriod.end) || cfg.billingPeriodEnd || null;
  if (pct != null) {
    windows.push(windowOf({ kind: "weekly", label: "Weekly", usedPct: pct, resetsAt: end }));
  }
  const prepaid = cfg.prepaidBalance && cfg.prepaidBalance.val;
  const cap = cfg.onDemandCap && cfg.onDemandCap.val;
  const used = cfg.onDemandUsed && cfg.onDemandUsed.val;
  if (cap > 0) {
    windows.push(
      windowOf({
        kind: "credits",
        label: "Credits",
        usedPct: (Number(used || 0) / Number(cap)) * 100,
        resetsAt: null,
      })
    );
  } else if (prepaid > 0) {
    windows.push({
      kind: "credits",
      label: `Credits $${Number(prepaid).toFixed(2)}`,
      used_pct: null,
      remaining_pct: null,
      resets_at: null,
    });
  }
  const footnotes = (cfg.productUsage || [])
    .filter((p) => p.usagePercent != null)
    .map((p) => `${p.product.replace(/^Grok/, "")} ${p.usagePercent}% of pool`);
  return {
    id: "grok",
    display_name: "Grok Build",
    status: { state: "ok" },
    plan: "SuperGrok",
    windows,
    footnotes,
    fetched_at: new Date().toISOString(),
    source: "api",
  };
}

async function fetchUsage(cfg) {
  const p = probe();
  if (!p.creds_present && !p.cli_on_path) {
    return emptyProvider("grok", "Grok Build", {
      state: "not_installed",
      hint: "Install Grok Build, then run: grok login",
    });
  }
  if (!p.creds_present) {
    return emptyProvider("grok", "Grok Build", {
      state: "logged_out",
      hint: "Run: grok login",
    });
  }

  let json;
  let mtimeMs;
  try {
    const stat = fs.statSync(grokAuth());
    mtimeMs = stat.mtimeMs;
    json = JSON.parse(fs.readFileSync(grokAuth(), "utf8"));
  } catch {
    return emptyProvider("grok", "Grok Build", {
      state: "logged_out",
      hint: "Run: grok login",
    });
  }
  const topKey = Object.keys(json).find((k) => json[k] && json[k].key);
  const entry = pickEntry(json);
  if (!entry) {
    return emptyProvider("grok", "Grok Build", {
      state: "unknown",
      message: "Grok is on an API key — SuperGrok weekly % is a subscription meter",
    });
  }

  let token = entry.key;
  const refreshEnabled = cfg?.adapters?.grok?.refresh_tokens !== false;
  const expMs = Date.parse(entry.expires_at || "") || jwtExpMs(token);
  if (refreshEnabled && expMs && expMs - Date.now() < 60_000) {
    try {
      const next = await refreshGrok(entry, grokAuth(), mtimeMs, topKey);
      if (next) token = next;
    } catch {
      /* continue */
    }
  }

  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    "X-XAI-Token-Auth": "xai-grok-cli",
    "User-Agent": "grok-cli/1.0",
  };
  let res = await getJson(BILLING_URL, headers);
  if ((res.status === 401 || res.status === 403) && refreshEnabled) {
    try {
      const next = await refreshGrok(entry, grokAuth(), mtimeMs, topKey);
      if (next) {
        token = next;
        res = await getJson(BILLING_URL, { ...headers, Authorization: `Bearer ${token}` });
      }
    } catch {
      /* fall through */
    }
  }
  if (res.status === 401 || res.status === 403) {
    return emptyProvider("grok", "Grok Build", {
      state: "logged_out",
      hint: "Run grok login (token expired)",
    });
  }
  if (res.status === 429) {
    const err = emptyProvider("grok", "Grok Build", {
      state: "fetch_failed",
      message: "rate limited",
    });
    err._rateLimited = true;
    return err;
  }
  if (res.status !== 200 || !res.json) {
    return emptyProvider("grok", "Grok Build", {
      state: "fetch_failed",
      message: `HTTP ${res.status}`,
    });
  }
  return mapBilling(res.json);
}

module.exports = { id: "grok", displayName: "Grok Build", probe, fetchUsage };
