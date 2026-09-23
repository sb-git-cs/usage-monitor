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
const API_HOSTS = [
  "https://daily-cloudcode-pa.googleapis.com",
  "https://cloudcode-pa.googleapis.com",
];
const USER_AGENT = "antigravity/windows/amd64";

let memCreds = null;
let oauthClient = null;

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

function extractOauthClient(binPath) {
  if (oauthClient) return oauthClient;
  const envId = process.env.AGY_CLIENT_ID || process.env.GEMINI_OAUTH_CLIENT_ID;
  const envSecret = process.env.AGY_CLIENT_SECRET || process.env.GEMINI_OAUTH_CLIENT_SECRET;
  if (envId && envSecret) {
    oauthClient = { clientId: envId, clientSecret: envSecret };
    return oauthClient;
  }
  if (!binPath || !fileExists(binPath)) return null;
  let text;
  try {
    text = fs.readFileSync(binPath, "latin1");
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

async function readStoredCreds() {
  if (process.platform === "win32") {
    const blob = await readGenericCredential(WINCRED_TARGET);
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
  const client = extractOauthClient(findAgyBinary());
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

function isGeminiGroup(group) {
  const name = String(group.displayName || group.name || group.groupId || "");
  return /gemini/i.test(name);
}

function mapSummary(data) {
  const groups = Array.isArray(data.groups) ? data.groups : [];
  const selected = groups.filter((g) => g && isGeminiGroup(g));
  const windows = [];
  for (const group of selected) {
    for (const bucket of Array.isArray(group.buckets) ? group.buckets : []) {
      if (!bucket || bucket.remainingFraction == null) continue;
      const used = usedFromFraction(bucket.remainingFraction);
      if (used == null) continue;
      const cls = classifyBucket(bucket);
      windows.push(
        windowOf({
          kind: cls.kind,
          label: selected.length > 1 ? `${group.displayName || group.name || group.groupId} ${cls.label}` : cls.label,
          usedPct: used,
          resetsAt: bucket.resetTime || null,
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

function mapQuotaBuckets(data) {
  const buckets = Array.isArray(data.buckets) ? data.buckets : [];
  const scored = [];
  for (const bucket of buckets) {
    if (!bucket || bucket.remainingFraction == null) continue;
    const used = usedFromFraction(bucket.remainingFraction);
    if (used == null) continue;
    scored.push({
      used,
      modelId: bucket.modelId || bucket.id,
      resetTime: bucket.resetTime || null,
    });
  }
  scored.sort((a, b) => b.used - a.used);
  return scored.slice(0, 2).map((b) =>
    windowOf({
      kind: "daily",
      label: shortModel(b.modelId),
      usedPct: b.used,
      resetsAt: b.resetTime,
    })
  );
}

function mapModels(data) {
  const raw = data.models;
  const list = [];
  const iterable = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object"
      ? Object.entries(raw).map(([id, model]) => ({ ...model, model: model?.model || id }))
      : [];
  for (const model of iterable) {
    if (!model || typeof model !== "object") continue;
    const quota = model.quotaInfo || {};
    if (quota.remainingFraction == null) continue;
    const used = usedFromFraction(quota.remainingFraction);
    if (used == null) continue;
    list.push({
      used,
      name: model.displayName || model.label || model.model || model.name,
      id: model.model || model.name || "",
      resetTime: quota.resetTime || null,
    });
  }
  list.sort((a, b) => b.used - a.used);
  const pick = list.filter((m) => /gemini/i.test(`${m.name} ${m.id}`)).slice(0, 2);
  return pick.map((m) =>
    windowOf({
      kind: "quota",
      label: shortModel(m.name),
      usedPct: m.used,
      resetsAt: m.resetTime,
    })
  );
}

async function assistPost(host, token, method, body) {
  return postJson(`${host}/v1internal:${method}`, authHeaders(token), body || {});
}

async function fetchFromHost(host, token, loadBody) {
  const load = await assistPost(host, token, "loadCodeAssist", loadBody);
  if (load.status === 401 || load.status === 403) return { authFailed: true, load };
  if (load.status !== 200 || !load.json) return { failed: true, status: load.status };
  const project = extractProject(load.json);
  const plan = planLabel(load.json);
  const quotaBody = project ? { project } : {};

  const summary = await assistPost(host, token, "retrieveUserQuotaSummary", quotaBody);
  if (summary.status === 429) return { failed: true, status: 429 };
  if (summary.status === 401 || summary.status === 403) return { authFailed: true };
  if (summary.status === 200 && summary.json) {
    const windows = mapSummary(summary.json);
    if (windows.length) return { ok: true, plan, windows };
  }

  const quota = await assistPost(host, token, "retrieveUserQuota", quotaBody);
  if (quota.status === 429) return { failed: true, status: 429 };
  if (quota.status === 401 || quota.status === 403) return { authFailed: true };
  if (quota.status === 200 && quota.json) {
    const windows = mapQuotaBuckets(quota.json);
    if (windows.length) return { ok: true, plan, windows };
  }

  const models = await assistPost(host, token, "fetchAvailableModels", quotaBody);
  if (models.status === 429) return { failed: true, status: 429 };
  if (models.status === 401 || models.status === 403) return { authFailed: true };
  if (models.status === 200 && models.json) {
    const windows = mapModels(models.json);
    if (windows.length) return { ok: true, plan, windows };
  }

  return { failed: true, status: [models, quota, summary].find((r) => r.status !== 200)?.status, plan };
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
      ideType: creds.source === "file" && fileExists(geminiOAuth()) && !fileExists(antigravityToken())
        ? "IDE_UNSPECIFIED"
        : "ANTIGRAVITY",
      platform: "PLATFORM_UNSPECIFIED",
      pluginType: "GEMINI",
    },
  };

  const refreshEnabled = cfg?.adapters?.gemini?.refresh_tokens !== false;
  let token = creds.access_token;
  let lastFail = null;

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
      return {
        id: "gemini",
        display_name: DISPLAY,
        status: { state: "ok" },
        plan: result.plan,
        windows: result.windows,
        fetched_at: new Date().toISOString(),
        source: "api",
      };
    }
    lastFail = result;
    if (result.status === 429) break;
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

module.exports = { id: "gemini", displayName: DISPLAY, probe, fetchUsage };
