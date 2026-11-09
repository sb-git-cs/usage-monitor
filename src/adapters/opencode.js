const fs = require("fs");
const path = require("path");
const paths = require("../paths");
const { readRows } = require("../cursor-local");
const { windowOf, emptyProvider } = require("../models");
const { getJson } = require("../http");

const DISPLAY = "OpenCode";
const USAGE_URL = "https://opencode.ai/zen/go/v1/usage";
const BUDGET_URL = "https://opencode.ai/console/api/policies/current-budgets";
const LOGIN_HINT = "Run: opencode auth login";
const WINDOWS = [
  ["rolling", { kind: "five_hour", label: "5h" }],
  ["weekly", { kind: "weekly", label: "Weekly" }],
  ["monthly", { kind: "monthly", label: "Monthly" }],
];

function installed() {
  return paths.cliOnPath("opencode") || [paths.opencodeDataDir()].some((p) => paths.fileExists(p));
}

// OPENCODE_DB wins; otherwise the main database and any per-channel opencode-<channel>.db beside it.
function dbFiles() {
  if (process.env.OPENCODE_DB) return [process.env.OPENCODE_DB];
  const dir = paths.opencodeDataDir();
  const files = [path.join(dir, "opencode.db")];
  try {
    for (const name of fs.readdirSync(dir).sort()) {
      if (/^opencode-[\w.-]+\.db$/.test(name)) files.push(path.join(dir, name));
    }
  } catch { /* no data directory */ }
  return files.filter((f) => paths.fileExists(f));
}

function parse(text) {
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

function text(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

// The credential's secret and org, or { expired: true } for an oauth login that has run out.
function fromValue(value, now) {
  if (!value) return null;
  if (value.type === "oauth") {
    const token = text(value.access);
    if (!token) return null;
    const exp = Number(value.expires);
    // Expiry is epoch milliseconds, or seconds in older records.
    if (Number.isFinite(exp) && exp > 0 && (exp < 1e12 ? exp * 1000 : exp) <= now) return { expired: true };
    return { token, orgID: text(value.metadata && value.metadata.orgID) };
  }
  if (value.type === "key" || value.type === "api") {
    const token = text(value.key);
    return token ? { token, orgID: text(value.metadata && value.metadata.orgID) } : null;
  }
  return null;
}

function credential(now = Date.now()) {
  let expired = false;
  for (const file of dbFiles()) {
    const rows = readRows(file, "SELECT value FROM credential WHERE integration_id = 'opencode' AND active = 1");
    for (const row of rows) {
      const found = fromValue(parse(row.value), now);
      if (found && found.expired) expired = true;
      else if (found) return found;
    }
  }
  if (expired) return { expired: true };
  // v1 keeps one plain key file; it has no org, so only the sign-in state is known.
  try {
    const auth = parse(fs.readFileSync(path.join(paths.opencodeDataDir(), "auth.json"), "utf8"));
    const found = fromValue(auth && auth["opencode-go"], now);
    if (found) return found;
  } catch { /* no v1 file */ }
  return null;
}

function resetIso(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  const ms = Number.isFinite(n) ? (n < 1e12 ? n * 1000 : n) : Date.parse(value);
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null;
}

function mapUsage(json) {
  const usage = json && json.usage && typeof json.usage === "object" ? json.usage : {};
  const found = WINDOWS.map(([key, spec]) => [spec, usage[key]]).filter(([, w]) => w && typeof w === "object");
  const percents = found.map(([, w]) => Number(w.percent)).filter((n) => Number.isFinite(n));
  // percent is 0-100; if every value sits inside 0-1 and one is fractional it is a ratio, so scale it.
  const ratio = percents.length > 0 && percents.every((n) => n >= 0 && n <= 1) && percents.some((n) => n > 0 && n < 1);
  const windows = [];
  for (const [spec, w] of found) {
    const given = typeof w.percent === "number" || (typeof w.percent === "string" && w.percent.trim()) ? Number(w.percent) : NaN;
    let used = given;
    if (!Number.isFinite(used)) used = w.status === "rate-limited" ? 100 : NaN;
    else if (ratio) used *= 100;
    if (!Number.isFinite(used)) continue;
    windows.push(windowOf({ ...spec, usedPct: used, resetsAt: resetIso(w.resetsAt) }));
  }
  return windows;
}

function mapBudgets(json) {
  const list = Array.isArray(json) ? json : json && Array.isArray(json.budgets) ? json.budgets : [];
  const usable = list.filter((b) => b && Number(b.limitDollars) > 0 && Number.isFinite(Number(b.spentDollars)));
  return usable.map((b) => windowOf({
    kind: "monthly",
    label: usable.length > 1 && text(b.scope) ? `Budget (${text(b.scope).slice(0, 20)})` : "Budget",
    usedPct: (Number(b.spentDollars) / Number(b.limitDollars)) * 100,
    resetsAt: resetIso(b.resetsAt),
  }));
}

function failed(state, extra) {
  return emptyProvider("opencode", DISPLAY, { state, ...extra });
}

async function fetchUsage() {
  const cred = credential();
  if (!cred) {
    return installed() ? failed("logged_out", { hint: LOGIN_HINT }) : failed("not_installed", { hint: "OpenCode not found" });
  }
  if (cred.expired) return failed("logged_out", { hint: LOGIN_HINT });
  if (!cred.orgID) return failed("ok", { hint: "No Go subscription found" });
  const base = { Accept: "application/json", Authorization: `Bearer ${cred.token}`, "User-Agent": "usage-monitor" };
  let res;
  try {
    res = await getJson(USAGE_URL, { ...base, "x-opencode-org-id": cred.orgID });
  } catch (err) {
    return failed("fetch_failed", { message: String(err.message || err) });
  }
  if (res.status === 401) return failed("logged_out", { hint: LOGIN_HINT });
  if (res.status === 403) return failed("ok", { hint: "No Go subscription" });
  if (res.status === 429) {
    const result = failed("fetch_failed", { message: "rate limited" });
    result._rateLimited = true;
    result._retryAfter = res.headers?.["retry-after"];
    return result;
  }
  if (res.status !== 200 || !res.json) return failed("fetch_failed", { message: `HTTP ${res.status}` });
  const windows = mapUsage(res.json);
  try {
    const budgets = await getJson(BUDGET_URL, { ...base, "x-org-id": cred.orgID });
    if (budgets.status === 200) windows.push(...mapBudgets(budgets.json));
  } catch { /* budgets are optional */ }
  return {
    id: "opencode",
    display_name: DISPLAY,
    status: windows.length ? { state: "ok" } : { state: "ok", hint: "No metered limits" },
    plan: "Go",
    windows,
    fetched_at: new Date().toISOString(),
    source: "api",
  };
}

// The signed-in account's email, when the database keeps one.
function accountRef() {
  for (const file of dbFiles()) {
    const row = readRows(file, "SELECT email FROM account WHERE email IS NOT NULL AND email != '' LIMIT 1")[0];
    if (row && text(row.email)) return text(row.email);
  }
  return null;
}

module.exports = { id: "opencode", displayName: DISPLAY, fetchUsage, accountRef, mapUsage, mapBudgets, credential };
