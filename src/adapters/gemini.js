const fs = require("fs");
const {
  geminiOAuth,
  antigravityToken,
  agyBinaryCandidates,
  cliPath,
  cliOnPath,
  fileExists,
} = require("../paths");
const { windowOf, emptyProvider } = require("../models");
const { postJson, postForm } = require("../http");
const { readGenericCredential } = require("../wincred");

const DISPLAY = "Gemini";
const WINCRED_TARGET = "gemini:antigravity";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
// cloudcode-pa still returns the Gemini group (weekly and 5-hour). The daily host's
// summary dropped that group and only has a shared model fraction, so it is the fallback.
const API_HOSTS = [
  "https://cloudcode-pa.googleapis.com",
  "https://daily-cloudcode-pa.googleapis.com",
];
const USER_AGENT = "antigravity/windows/amd64";
// Reading Credential Manager starts PowerShell and compiles a small C# reader, so a result is
// reused instead of paying that on every poll (every 5 s by default) while signed out.
const WINCRED_HIT_MS = 60_000;
const WINCRED_MISS_MS = 2 * 60_000;
const MAX_BINARY_BYTES = 512 * 1024 * 1024;

let memCreds = null;
let oauthClient = null;
const wincred = { at: 0, blob: undefined };
const clientLookup = { key: null };
const poolKinds = new Map();

function probe() {
  return {
    cli_on_path: !!(cliOnPath("agy") || cliOnPath("gemini")),
    creds_present:
      fileExists(antigravityToken()) ||
      fileExists(geminiOAuth()) ||
      process.platform === "win32",
  };
}

function empty(status) {
  return emptyProvider("gemini", DISPLAY, status);
}

function findAgyBinary() {
  const fromPath = cliPath("agy");
  if (fromPath) return fromPath;
  for (const p of agyBinaryCandidates()) {
    if (fileExists(p)) return p;
  }
  return null;
}

// The OAuth client is embedded in the agy binary. The binary is read asynchronously, and a
// lookup that found nothing is not repeated until the binary changes.
async function extractOauthClient(binPath) {
  if (oauthClient) return oauthClient;
  const envId = process.env.AGY_CLIENT_ID || process.env.GEMINI_OAUTH_CLIENT_ID;
  const envSecret = process.env.AGY_CLIENT_SECRET || process.env.GEMINI_OAUTH_CLIENT_SECRET;
  if (envId && envSecret) {
    oauthClient = { clientId: envId, clientSecret: envSecret };
    return oauthClient;
  }
  if (!binPath) return null;
  let stat;
  try {
    stat = await fs.promises.stat(binPath);
  } catch {
    return null;
  }
  const key = `${binPath}|${stat.size}|${stat.mtimeMs}`;
  if (clientLookup.key === key) return null;
  clientLookup.key = key;
  if (!stat.isFile() || stat.size > MAX_BINARY_BYTES) return null;
  let text;
  try {
    text = await fs.promises.readFile(binPath, "latin1");
  } catch {
    return null;
  }
  const ids = [...text.matchAll(/(\d{10,}-[a-z0-9]+\.apps\.googleusercontent\.com)/g)].map(
    (m) => m[1]
  );
  const secrets = [];
  for (const part of text.split("GOCSPX-").slice(1)) {
    const body = (part.match(/^[A-Za-z0-9_]{20,40}/) || [])[0];
    if (body) secrets.push("GOCSPX-" + body);
  }
  if (!ids.length || !secrets.length) return null;
  const clientId = ids.find((id) => id.startsWith("1071")) || ids[0];
  oauthClient = { clientId, clientSecret: secrets[0] };
  return oauthClient;
}

function expiryEpoch(value) {
  if (value == null || value === "") return null;
  if (typeof value === "number") {
    return value > 1e12 ? value / 1000 : value;
  }
  const n = Number(value);
  if (Number.isFinite(n)) return n > 1e12 ? n / 1000 : n;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : t / 1000;
}

function fromTokenBlock(token, source) {
  if (!token || typeof token !== "object") return null;
  const access = token.access_token || token.accessToken;
  const refresh = token.refresh_token || token.refreshToken;
  if (!access && !refresh) return null;
  return {
    access_token: access || null,
    refresh_token: refresh || null,
    expiry_epoch: expiryEpoch(token.expiry || token.expiry_date || token.expires_at),
    source,
  };
}

function fromFile(filePath) {
  try {
    const json = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return fromTokenBlock(json.token || json, "file");
  } catch {
    return null;
  }
}

async function readWinCred() {
  const age = Date.now() - wincred.at;
  if (wincred.blob !== undefined && age < (wincred.blob ? WINCRED_HIT_MS : WINCRED_MISS_MS)) return wincred.blob;
  const blob = await readGenericCredential(WINCRED_TARGET);
  wincred.at = Date.now();
  wincred.blob = blob || null;
  return wincred.blob;
}

async function readStoredCreds() {
  if (process.platform === "win32") {
    const blob = await readWinCred();
    const fromCred = fromTokenBlock(blob && blob.token, "wincred") || fromTokenBlock(blob, "wincred");
    if (fromCred) return fromCred;
  }
  const fileCred = fromFile(antigravityToken()) || fromFile(geminiOAuth());
  if (fileCred) return fileCred;
  const envRefresh = process.env.ANTIGRAVITY_REFRESH_TOKEN;
  const envAccess = process.env.ANTIGRAVITY_ACCESS_TOKEN;
  if (envRefresh || envAccess) {
    return {
      access_token: envAccess || null,
      refresh_token: envRefresh || null,
      expiry_epoch: null,
      source: "env",
    };
  }
  return null;
}

function accessValid(creds) {
  if (!creds || !creds.access_token) return false;
  if (!creds.expiry_epoch) return true;
  return creds.expiry_epoch - Date.now() / 1000 > 60;
}

async function refreshAccess(creds) {
  if (!creds || !creds.refresh_token) return null;
  const client = await extractOauthClient(findAgyBinary());
  if (!client) return null;
  const res = await postForm(
    TOKEN_URL,
    { Accept: "application/json" },
    {
      client_id: client.clientId,
      client_secret: client.clientSecret,
      refresh_token: creds.refresh_token,
      grant_type: "refresh_token",
    }
  );
  if (res.status !== 200 || !res.json || !res.json.access_token) return null;
  const next = {
    ...creds,
    access_token: res.json.access_token,
    refresh_token: res.json.refresh_token || creds.refresh_token,
    expiry_epoch: Date.now() / 1000 + Number(res.json.expires_in || 3600),
  };
  memCreds = next;
  return next;
}

async function getCreds(cfg) {
  const refreshEnabled = cfg?.adapters?.gemini?.refresh_tokens !== false;
  if (accessValid(memCreds)) return memCreds;
  let creds = await readStoredCreds();
  if (!creds) return null;
  if (refreshEnabled && !accessValid(creds) && creds.refresh_token) {
    const next = await refreshAccess(creds);
    if (next) return next;
  }
  memCreds = creds;
  return creds;
}

function authHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    "User-Agent": USER_AGENT,
  };
}

function extractProject(data) {
  const project = data && data.cloudaicompanionProject;
  if (typeof project === "string" && project) return project;
  if (project && typeof project === "object" && project.id) return project.id;
  return null;
}

function tierFields(tier) {
  if (typeof tier === "string" && tier) return { name: tier, id: tier };
  if (tier && typeof tier === "object") {
    return { name: tier.name || tier.id || null, id: tier.id || null };
  }
  return { name: null, id: null };
}

function planLabel(load) {
  const paid = tierFields(load.paidTier);
  if (paid.name) return paid.name;
  const current = tierFields(load.currentTier);
  if (current.name) {
    if (current.id === "free-tier" || /free/i.test(current.name)) return "Free";
    return current.name;
  }
  return null;
}

function classifyBucket(bucket) {
  const label = String(bucket.displayName || bucket.bucketId || "");
  const window = String(bucket.window || "");
  const joined = `${label} ${window}`;
  if (/five.?hour|5h|FIVE_HOUR/i.test(joined)) return { kind: "five_hour", label: "5h" };
  if (/week/i.test(joined)) return { kind: "weekly", label: "Weekly" };
  if (/day|daily|RPD/i.test(joined)) return { kind: "daily", label: "Daily" };
  return { kind: "weekly_scoped", label: label || "Quota" };
}

function usedFromFraction(remaining) {
  if (typeof remaining !== "number" && typeof remaining !== "string") return null;
  if (typeof remaining === "string" && !remaining.trim()) return null;
  const frac = Number(remaining);
  if (!Number.isFinite(frac)) return null;
  return Math.max(0, Math.min(100, (1 - frac) * 100));
}

function fractionOf(row) {
  if (!row || typeof row !== "object") return null;
  if (row.remainingFraction != null) return row.remainingFraction;
  if (row.remaining_fraction != null) return row.remaining_fraction;
  const quota = row.quotaInfo || row.quota_info;
  if (quota && quota !== row) return fractionOf(quota);
  return null;
}

function resetOf(row) {
  if (!row || typeof row !== "object") return null;
  if (row.resetTime || row.reset_time) return row.resetTime || row.reset_time;
  const quota = row.quotaInfo || row.quota_info;
  if (quota && quota !== row) return resetOf(quota);
  return null;
}

function isGeminiGroup(group) {
  const name = String(group.displayName || group.name || group.groupId || "");
  return /gemini/i.test(name);
}

function isGeminiBucket(bucket) {
  return /gemini/i.test(String(bucket.bucketId || bucket.id || ""));
}

// A summary with both Gemini windows outranks a model-pool reading that only looks like 5h.
function quotaRank(windows) {
  const kinds = new Set((windows || []).map((win) => win.kind));
  if (kinds.has("weekly") && kinds.has("five_hour")) return 3;
  if (kinds.has("weekly")) return 2;
  return windows && windows.length ? 1 : 0;
}

function mapSummary(data) {
  const groups = Array.isArray(data.groups) ? data.groups : [];
  const selected = [];
  for (const group of groups) {
    if (!group) continue;
    const named = isGeminiGroup(group);
    const buckets = (Array.isArray(group.buckets) ? group.buckets : []).filter(
      (bucket) => bucket && (named || isGeminiBucket(bucket))
    );
    if (buckets.length) selected.push({ group, buckets });
  }
  const windows = [];
  for (const { group, buckets } of selected) {
    for (const bucket of buckets) {
      const used = usedFromFraction(fractionOf(bucket));
      if (used == null) continue;
      const cls = classifyBucket(bucket);
      windows.push(
        windowOf({
          kind: cls.kind,
          label: selected.length > 1 ? `${group.displayName || group.name || group.groupId} ${cls.label}` : cls.label,
          usedPct: used,
          resetsAt: resetOf(bucket),
        })
      );
    }
  }
  return windows;
}

function shortModel(id) {
  const s = String(id || "");
  if (/3\.?8.*flash|3-flash|3\.8/i.test(s)) return "3 Flash";
  if (/3.*pro/i.test(s)) return "3 Pro";
  if (/flash/i.test(s)) return "Flash";
  if (/pro/i.test(s)) return "Pro";
  return s.replace(/^models\//, "").replace(/^gemini-/, "").slice(0, 14) || "Model";
}

// The quota summary no longer includes the Gemini group. Every Gemini model then
// carries the same remaining fraction, and that shared pool is the 5-hour allowance.
function mapGeminiPools(rows) {
  const pools = new Map();
  for (const row of rows) {
    if (!row || !/gemini/i.test(`${row.name || ""} ${row.id || ""}`)) continue;
    const remaining = fractionOf(row);
    const used = usedFromFraction(remaining);
    if (used == null) continue;
    const reset = resetOf(row);
    const key = `${remaining}|${reset || ""}`;
    const pool = pools.get(key);
    if (pool) pool.count += 1;
    else pools.set(key, { used, reset, count: 1, name: row.name || row.id, tokenType: row.tokenType || "" });
  }
  const list = [...pools.values()];
  if (!list.length) return [];
  if (list.length === 1 && list[0].count > 1 && list[0].reset) {
    const pool = list[0];
    const kind = /REQUESTS/i.test(pool.tokenType) ? "daily"
      : poolKinds.get(pool.reset) || (Date.parse(pool.reset) - Date.now() > 6 * 3600000 ? "weekly" : "five_hour");
    poolKinds.set(pool.reset, kind);
    if (poolKinds.size > 128) poolKinds.delete(poolKinds.keys().next().value);
    return [windowOf({ kind, label: kind === "weekly" ? "Weekly" : kind === "daily" ? "Daily" : "5h", usedPct: pool.used, resetsAt: pool.reset })];
  }
  list.sort((a, b) => b.used - a.used);
  return list.slice(0, 2).map((pool) =>
    windowOf({
      kind: /REQUESTS/i.test(pool.tokenType) ? "daily" : "quota",
      label: shortModel(pool.name),
      usedPct: pool.used,
      resetsAt: pool.reset,
    })
  );
}

function mapQuotaBuckets(data) {
  const buckets = Array.isArray(data.buckets) ? data.buckets : [];
  return mapGeminiPools(buckets.map((bucket) => bucket && {
    id: bucket.modelId || bucket.id || "",
    name: bucket.displayName || bucket.modelId || bucket.id || "",
    remainingFraction: bucket.remainingFraction,
    remaining_fraction: bucket.remaining_fraction,
    resetTime: bucket.resetTime || bucket.reset_time || null,
    tokenType: bucket.tokenType,
  }));
}

function mapModels(data) {
  const raw = data.models;
  const iterable = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object"
      ? Object.entries(raw).map(([id, model]) => ({ ...model, model: model?.model || id }))
      : [];
  return mapGeminiPools(iterable.map((model) => {
    if (!model || typeof model !== "object") return null;
    return {
      id: model.model || model.name || "",
      name: model.displayName || model.label || model.model || model.name || "",
      quotaInfo: model.quotaInfo || model.quota_info,
      tokenType: model.tokenType,
    };
  }));
}

async function assistPost(host, token, method, body) {
  return postJson(`${host}/v1internal:${method}`, authHeaders(token), body || {});
}

function parse429Reset(res) {
  if (!res) return null;
  const retryHeader = res.headers && (res.headers["retry-after"] || res.headers["Retry-After"]);
  if (retryHeader) {
    const sec = Number(retryHeader);
    if (Number.isFinite(sec)) return new Date(Date.now() + sec * 1000).toISOString();
    const parsed = Date.parse(retryHeader);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  const details = res.json?.error?.details;
  if (Array.isArray(details)) {
    for (const d of details) {
      if (d && (d["@type"]?.includes("RetryInfo") || d.retryDelay)) {
        const delayStr = d.retryDelay;
        if (typeof delayStr === "string") {
          const m = /^(\d+(?:\.\d+)?)s?$/i.exec(delayStr.trim());
          if (m) return new Date(Date.now() + Number(m[1]) * 1000).toISOString();
        } else if (delayStr && typeof delayStr === "object" && Number.isFinite(delayStr.seconds)) {
          return new Date(Date.now() + Number(delayStr.seconds) * 1000).toISOString();
        }
      }
    }
  }
  const msg = res.json?.error?.message || res.text || "";
  const rel = /(?:resets?|try again|available again) in ((?:\d+\s*(?:days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)(?:\b|(?=\d))[\s,]*(?:and\s+)?)+)/i.exec(msg);
  if (rel) {
    let ms = 0;
    for (const [, n, unit] of rel[1].matchAll(/(\d+)\s*([a-z]+)/gi)) {
      const u = unit.toLowerCase();
      ms += Number(n) * (u.startsWith("d") ? 86400_000 : u.startsWith("h") ? 3600_000 : u.startsWith("m") ? 60_000 : 1000);
    }
    if (ms > 0) return new Date(Date.now() + ms).toISOString();
  }
  return null;
}

function combineWindows(previous, current) {
  const windows = new Map();
  const prior = current?.some((w) => w.kind === "weekly" && w.used_pct > 0) && previous?.every((w) => w.used_pct === 0)
    ? previous.filter((w) => w.kind !== "five_hour") : previous || [];
  for (const w of [...prior, ...(current || [])]) {
    // The later successful endpoint is authoritative, including a legitimate decrease/reset.
    const key = ["weekly", "five_hour"].includes(w.kind) ? w.kind : `${w.kind}|${w.label}`;
    windows.set(key, w);
  }
  return [...windows.values()].sort((a, b) => (["weekly", "five_hour"].indexOf(a.kind) < 0 ? 2 : ["weekly", "five_hour"].indexOf(a.kind))
    - (["weekly", "five_hour"].indexOf(b.kind) < 0 ? 2 : ["weekly", "five_hour"].indexOf(b.kind)));
}

async function fetchFromHost(host, token, loadBody) {
  const load = await assistPost(host, token, "loadCodeAssist", loadBody);
  if (load.status === 401) return { authFailed: true };
  if (load.status !== 200 || !load.json) return { failed: true, status: load.status };
  const project = extractProject(load.json), plan = planLabel(load.json);
  const body = project ? { project } : {};
  let windows = [], lastStatus;
  for (const [method, map] of [["retrieveUserQuotaSummary", mapSummary], ["retrieveUserQuota", mapQuotaBuckets], ["fetchAvailableModels", mapModels]]) {
    const result = await assistPost(host, token, method, body);
    if (result.status === 401) return { authFailed: true };
    if (result.status === 429) return { failed: true, status: 429, plan };
    if (result.status === 200 && result.json) {
      const mapped = map(result.json);
      windows = combineWindows(windows, mapped);
      if (method !== "retrieveUserQuotaSummary" && mapped.length) return { ok: true, plan, windows };
    } else lastStatus = result.status;
    if (method === "retrieveUserQuota" && windows.length) return { ok: true, plan, windows };
  }
  return windows.length ? { ok: true, plan, windows } : { failed: true, status: lastStatus, plan };
}

function ideType(creds) {
  return creds.source === "file" && fileExists(geminiOAuth()) && !fileExists(antigravityToken())
    ? "IDE_UNSPECIFIED"
    : "ANTIGRAVITY";
}

async function fetchUsage(cfg) {
  const p = probe();
  let creds;
  try {
    creds = await getCreds(cfg);
  } catch {
    creds = null;
  }

  if (!creds && !p.cli_on_path) {
    return empty({
      state: "not_installed",
      hint: "Install Antigravity CLI, then run: agy",
    });
  }
  if (!creds) {
    return empty({
      state: "logged_out",
      hint: "Run: agy  (sign in with Google)",
    });
  }

  const loadBody = {
    metadata: {
      ideType: ideType(creds),
      platform: "PLATFORM_UNSPECIFIED",
      pluginType: "GEMINI",
    },
  };

  const refreshEnabled = cfg?.adapters?.gemini?.refresh_tokens !== false;
  let token = creds.access_token;
  let lastFail = null;
  let best = null;

  for (const host of API_HOSTS) {
    let result;
    try { result = await fetchFromHost(host, token, loadBody); }
    catch { lastFail = { failed: true }; continue; }
    if (result.authFailed && refreshEnabled && creds.refresh_token) {
      const next = await refreshAccess(creds);
      if (next && next.access_token) {
        creds = next;
        token = next.access_token;
        result = await fetchFromHost(host, token, loadBody);
      }
    }
    if (result.authFailed) {
      return empty({
        state: "logged_out",
        hint: "Run: agy  (token expired)",
      });
    }
    if (result.ok) {
      if (!best) {
        best = result;
      } else {
        best = {
          ok: true,
          plan: result.plan || best.plan,
          windows: combineWindows(best.windows, result.windows),
        };
      }
      continue;
    }
    lastFail = result;
    if (result.status === 429) break;
  }

  if (best) {
    return {
      id: "gemini",
      display_name: DISPLAY,
      status: { state: "ok" },
      plan: best.plan,
      windows: best.windows,
      fetched_at: new Date().toISOString(),
      source: "api",
    };
  }

  if (lastFail && lastFail.status === 429) {
    const err = empty({ state: "fetch_failed", message: "rate limited" });
    err._rateLimited = true;
    return err;
  }

  return empty({
    state: "fetch_failed",
    message: lastFail && lastFail.status ? `HTTP ${lastFail.status}` : "quota unavailable",
  });
}

// The current access token for a phone that reads usage directly; the refresh token stays here.
async function linkToken(cfg) {
  let creds;
  try {
    creds = await getCreds(cfg);
  } catch {
    return null;
  }
  if (!accessValid(creds)) return null;
  return {
    access_token: creds.access_token,
    expires_at: creds.expiry_epoch ? Math.round(creds.expiry_epoch * 1000) : null,
    ide_type: ideType(creds),
  };
}

module.exports = { id: "gemini", displayName: DISPLAY, probe, fetchUsage, linkToken };
