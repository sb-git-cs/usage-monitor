const ALERT_USED_PCT = 80;

const PROVIDERS = [
  { id: "claude", displayName: "Claude Code" },
  { id: "codex", displayName: "Codex" },
  { id: "gemini", displayName: "Gemini" },
  { id: "grok", displayName: "Grok Build" },
];

function percentage(value) {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && !value.trim()) return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, n) : null;
}

function remainingPct(used) {
  const value = percentage(used);
  return value == null ? null : Math.max(0, 100 - value);
}

function windowOf({ kind, label, usedPct, resetsAt }) {
  const used = percentage(usedPct);
  const reset = Date.parse(resetsAt);
  return {
    kind,
    label,
    used_pct: used,
    remaining_pct: remainingPct(used),
    resets_at: Number.isFinite(reset) ? new Date(reset).toISOString() : null,
  };
}

function emptyProvider(id, displayName, status) {
  return {
    id,
    display_name: displayName,
    status,
    plan: null,
    windows: [],
    fetched_at: new Date().toISOString(),
    source: "none",
  };
}

function hottestWindow(provider) {
  const numeric = (provider.windows || []).filter((w) => Number.isFinite(w.used_pct));
  if (!numeric.length) return null;
  return numeric.reduce((a, b) => (a.used_pct >= b.used_pct ? a : b));
}

function isAlerting(provider) {
  return (provider.windows || []).some(
    (w) => w.used_pct != null && w.used_pct >= ALERT_USED_PCT
  );
}

function statusOk(provider) {
  const s = provider.status && provider.status.state;
  return s === "ok" || s === "stale";
}

function applyLocalResets(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.providers)) {
    return { snapshot, changed: false };
  }
  const now = Date.now();
  let changed = false;
  const providers = snapshot.providers.map((p) => {
    let expired = false;
    const windows = (p.windows || []).map((w) => {
      if (!w.resets_at) return w;
      const t = Date.parse(w.resets_at);
      if (!Number.isFinite(t) || t > now) return w;
      changed = true;
      expired = true;
      return {
        ...w,
        used_pct: null,
        remaining_pct: null,
        resets_at: null,
      };
    });
    return { ...p, windows, ...(expired ? { status: { ...p.status, state: "stale" } } : {}) };
  });
  return { snapshot: { ...snapshot, providers }, changed };
}

const UsageModels = {
  ALERT_USED_PCT,
  PROVIDERS,
  windowOf,
  remainingPct,
  percentage,
  emptyProvider,
  hottestWindow,
  isAlerting,
  statusOk,
  applyLocalResets,
};
if (typeof module !== "undefined") module.exports = UsageModels;
