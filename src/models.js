const ALERT_USED_PCT = 80;

const PROVIDERS = [
  { id: "claude", displayName: "Claude Code" },
  { id: "codex", displayName: "Codex" },
  { id: "grok", displayName: "Grok Build" },
];

function remainingPct(used) {
  if (used == null || Number.isNaN(used)) return null;
  return Math.max(0, 100 - used);
}

function windowOf({ kind, label, usedPct, resetsAt }) {
  const used = usedPct == null ? null : Number(usedPct);
  return {
    kind,
    label,
    used_pct: used,
    remaining_pct: remainingPct(used),
    resets_at: resetsAt || null,
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
  const numeric = (provider.windows || []).filter((w) => w.used_pct != null);
  if (!numeric.length) return null;
  const five = numeric.find((w) => w.kind === "five_hour");
  if (five) return five;
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

module.exports = {
  ALERT_USED_PCT,
  PROVIDERS,
  windowOf,
  remainingPct,
  emptyProvider,
  hottestWindow,
  isAlerting,
  statusOk,
};
