// Network monitor settings stored under cfg.net. Every field is validated so a
// hand-edited or corrupt config cannot break capture.
const RETENTION_MINUTES = [15, 60, 360, 1440, 10080, 43200, 525600];
const RANGES = ["5", "15", "60", "1440", "10080", "43200", "all"];
const CAP_PERIODS = ["total", "daily", "monthly"];

function bool(value, fallback) {
  return typeof value === "boolean" ? value : fallback;
}

function text(value) {
  return typeof value === "string" && value.trim() ? value : null;
}

function count(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function appList(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const out = [];
  for (const item of value) {
    const key = text(item && item.key);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ key, name: text(item.name) || key });
  }
  return out;
}

function normalizeCap(cap) {
  if (!cap || typeof cap !== "object") return null;
  const limit = Number(cap.limit_bytes);
  if (!Number.isFinite(limit) || limit <= 0) return null;
  const start = Number(cap.period_start);
  return {
    limit_bytes: Math.round(limit),
    period: CAP_PERIODS.includes(cap.period) ? cap.period : "total",
    used_bytes: count(cap.used_bytes),
    period_start: Number.isFinite(start) && start > 0 ? start : Date.now(),
    enforced: bool(cap.enforced, false),
    notified: bool(cap.notified, false),
  };
}

function normalizeRule(rule) {
  if (!rule || typeof rule !== "object" || Array.isArray(rule)) return null;
  const out = {
    name: text(rule.name),
    path: text(rule.path),
    blocked: bool(rule.blocked, false),
    keep_forever: bool(rule.keep_forever, false),
    record_connections: bool(rule.record_connections, false),
    cap: normalizeCap(rule.cap),
  };
  return isEmptyRule(out) ? null : out;
}

function isEmptyRule(rule) {
  return !rule.blocked && !rule.keep_forever && !rule.record_connections && !rule.cap;
}

function normalizeRules(rules) {
  const out = {};
  if (!rules || typeof rules !== "object" || Array.isArray(rules)) return out;
  for (const [key, rule] of Object.entries(rules)) {
    const normalized = key ? normalizeRule(rule) : null;
    if (normalized) out[key] = normalized;
  }
  return out;
}

function normalizeNet(raw) {
  const n = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const ignore = appList(n.ignore);
  const ignored = new Set(ignore.map((a) => a.key));
  return {
    enabled: bool(n.enabled, true),
    retention_minutes: RETENTION_MINUTES.includes(Number(n.retention_minutes)) ? Number(n.retention_minutes) : 60,
    db_dir: text(n.db_dir),
    range: RANGES.includes(String(n.range)) ? String(n.range) : "60",
    auto_sort: bool(n.auto_sort, true),
    reverse_dns: bool(n.reverse_dns, false),
    focus: appList(n.focus).filter((a) => !ignored.has(a.key)),
    ignore,
    rules: normalizeRules(n.rules),
  };
}

module.exports = { RETENTION_MINUTES, RANGES, CAP_PERIODS, normalizeNet, normalizeCap, isEmptyRule };
