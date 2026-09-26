const fs = require("fs");
const { grokAuth, cliOnPath, fileExists } = require("../paths");
const { windowOf, emptyProvider } = require("../models");
const { getJson, postForm, request } = require("../http");

const BILLING_URL = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";
const GRPC_CREDITS_URL = "https://grok.com/grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig";
const GRPC_TIMEOUT_MS = 4000;
// GetGrokCreditsConfigRequest { bool exclude_legacy_monthly_usage = 1; } as a grpc-web frame.
const GRPC_REQUEST = Buffer.from([0, 0, 0, 0, 2, 0x08, 0x00]);

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

function cliHeaders(token, entry) {
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    "X-XAI-Token-Auth": "xai-grok-cli",
    "User-Agent": "grok-cli/1.0",
  };
  if (entry && entry.user_id) headers["x-userid"] = String(entry.user_id);
  return headers;
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
    if (!current || current.key !== entry.key) return res.json.access_token;
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

function finiteNumber(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function productPercents(cfg) {
  return (Array.isArray(cfg.productUsage) ? cfg.productUsage : [])
    .map((p) => (p && typeof p.product === "string" ? finiteNumber(p.usagePercent) : null))
    .filter((n) => n != null);
}

function weeklyPct(cfg) {
  const explicit = finiteNumber(cfg.creditUsagePercent);
  if (explicit != null) return explicit;
  const products = productPercents(cfg);
  if (products.length) return products.reduce((a, b) => a + b, 0);
  const used = cfg.used && cfg.used.val;
  const limit = cfg.monthlyLimit && cfg.monthlyLimit.val;
  if (used != null && Number(limit) > 0) return (Number(used) / Number(limit)) * 100;
  return null;
}

function periodEnd(cfg) {
  return (cfg.currentPeriod && cfg.currentPeriod.end) || cfg.billingPeriodEnd || null;
}

function hasActivePeriod(cfg) {
  const start = (cfg.currentPeriod && cfg.currentPeriod.start) || cfg.billingPeriodStart;
  const end = periodEnd(cfg);
  if (!start && !end) return false;
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  const now = Date.now();
  if (Number.isFinite(startMs) && Number.isFinite(endMs)) return startMs <= now && now < endMs;
  if (Number.isFinite(endMs)) return now < endMs;
  return Number.isFinite(startMs) && startMs <= now;
}

function periodMeta(cfg, fromCreditsPercent) {
  const type = String((cfg.currentPeriod && cfg.currentPeriod.type) || "");
  if (/WEEKLY/i.test(type)) return { kind: "weekly", label: "Weekly" };
  if (/MONTHLY/i.test(type)) return { kind: "monthly", label: "Monthly" };
  if (fromCreditsPercent) return { kind: "weekly", label: "Weekly" };
  if (cfg.monthlyLimit && Number(cfg.monthlyLimit.val) > 0) return { kind: "monthly", label: "Monthly" };
  return { kind: "weekly", label: "Weekly" };
}

function mapBilling(body) {
  const cfg = (body && (body.config || body)) || {};
  const windows = [];
  let pct = weeklyPct(cfg);
  const fromCredits = cfg.creditUsagePercent != null || productPercents(cfg).length > 0;
  // proto3 JSON omits a 0.0 creditUsagePercent. Grok's /usage still draws a 0% bar when the period is live.
  if (pct == null && hasActivePeriod(cfg)) pct = 0;
  if (pct != null) {
    const { kind, label } = periodMeta(cfg, fromCredits);
    windows.push(windowOf({ kind, label, usedPct: pct, resetsAt: periodEnd(cfg) }));
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
  const footnotes = (Array.isArray(cfg.productUsage) ? cfg.productUsage : [])
    .filter((p) => p && typeof p.product === "string" && p.usagePercent != null)
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

function readVarint(buf, offset) {
  let result = 0;
  let shift = 0;
  let next = offset;
  while (next < buf.length && shift <= 35) {
    const byte = buf[next++];
    result |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value: result >>> 0, next };
    shift += 7;
  }
  return null;
}

function firstGrpcWebDataMessage(bytes) {
  let offset = 0;
  while (offset + 5 <= bytes.length) {
    const compressed = bytes[offset];
    const length = bytes.readUInt32BE(offset + 1);
    offset += 5;
    if (length < 0 || offset + length > bytes.length) return null;
    const frame = bytes.subarray(offset, offset + length);
    offset += length;
    if (compressed === 0x80) continue;
    if (compressed !== 0) continue;
    if (frame.length >= 11 && frame.subarray(0, 11).toString("ascii") === "grpc-status") continue;
    return Buffer.from(frame);
  }
  return null;
}

function walkProto(buf, onField) {
  let offset = 0;
  while (offset < buf.length) {
    const tag = readVarint(buf, offset);
    if (!tag) break;
    const field = tag.value >>> 3;
    const wire = tag.value & 7;
    offset = tag.next;
    if (wire === 2) {
      const len = readVarint(buf, offset);
      if (!len) break;
      const end = len.next + len.value;
      if (end > buf.length) break;
      onField(field, wire, buf.subarray(len.next, end));
      offset = end;
    } else if (wire === 5) {
      if (offset + 4 > buf.length) break;
      onField(field, wire, buf.subarray(offset, offset + 4));
      offset += 4;
    } else if (wire === 1) {
      if (offset + 8 > buf.length) break;
      onField(field, wire, buf.subarray(offset, offset + 8));
      offset += 8;
    } else if (wire === 0) {
      const v = readVarint(buf, offset);
      if (!v) break;
      onField(field, wire, v.value);
      offset = v.next;
    } else {
      break;
    }
  }
}

function parseCreditsGrpcWeb(buffer) {
  if (!buffer || !buffer.length) return null;
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const message = firstGrpcWebDataMessage(bytes);
  if (!message) return null;
  let config = null;
  walkProto(message, (field, wire, value) => {
    if (field === 1 && wire === 2) config = Buffer.from(value);
  });
  if (!config) config = message;
  let percent = null;
  walkProto(config, (field, wire, value) => {
    if (field !== 1) return;
    if (wire === 5 && value.length === 4) percent = Buffer.from(value).readFloatLE(0);
    else if (wire === 1 && value.length === 8) percent = Buffer.from(value).readDoubleLE(0);
  });
  if (percent == null || !Number.isFinite(percent)) return { creditUsagePercent: null };
  return { creditUsagePercent: percent };
}

async function fetchCreditsGrpc(token) {
  const res = await request("POST", GRPC_CREDITS_URL, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/grpc-web+proto",
      "x-grpc-web": "1",
      "X-XAI-Token-Auth": "xai-grok-cli",
      Accept: "application/grpc-web+proto",
      Origin: "https://grok.com",
      Referer: "https://grok.com/?_s=usage",
      "User-Agent": "grok-cli/1.0",
    },
    body: GRPC_REQUEST,
    raw: true,
    timeout: GRPC_TIMEOUT_MS,
  });
  if (res.status !== 200 || !res.buffer) return null;
  const grpcStatus = res.headers && res.headers["grpc-status"];
  if (grpcStatus && String(grpcStatus) !== "0") return null;
  return parseCreditsGrpcWeb(res.buffer);
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
  const entry = pickEntry(json);
  const topKey = Object.keys(json || {}).find((k) => json[k] === entry);
  if (!entry) {
    return emptyProvider("grok", "Grok Build", {
      state: "unknown",
      message: "Grok is on an API key — SuperGrok weekly % is a subscription meter",
    });
  }

  let token = entry.key;
  let refreshed = false;
  const refreshEnabled = cfg?.adapters?.grok?.refresh_tokens !== false;
  const expMs = Date.parse(entry.expires_at || "") || jwtExpMs(token);
  if (refreshEnabled && expMs && expMs - Date.now() < 60_000) {
    try {
      const next = await refreshGrok(entry, grokAuth(), mtimeMs, topKey);
      if (next) { token = next; refreshed = true; }
    } catch {
      /* continue */
    }
  }

  const headers = cliHeaders(token, entry);
  let res = await getJson(BILLING_URL, headers);
  if ((res.status === 401 || res.status === 403) && refreshEnabled && !refreshed) {
    try {
      const next = await refreshGrok(entry, grokAuth(), mtimeMs, topKey);
      if (next) {
        token = next;
        res = await getJson(BILLING_URL, cliHeaders(token, entry));
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
  const body = res.json;
  const billing = body.config || body;
  if (weeklyPct(billing) == null) {
    try {
      const grpc = await fetchCreditsGrpc(token);
      if (grpc && grpc.creditUsagePercent != null) billing.creditUsagePercent = grpc.creditUsagePercent;
    } catch {
      /* REST period still maps */
    }
  }
  return mapBilling(body);
}

module.exports = { id: "grok", displayName: "Grok Build", probe, fetchUsage };
