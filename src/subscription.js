const { windowOf } = require("./models");

const regime = (value) => value === "combined" ? "combined" : "legacy";
const DASHBOARD = "https://grok.com/?_s=usage";

// A total and an explicitly weekly period are required. Product percentages and
// monthly allowances are never evidence of a shared weekly pool.
function sharedWeekly(cfg) {
  const period = cfg?.currentPeriod;
  const value = cfg?.creditUsagePercent;
  if (!/(?:^|_)WEEKLY$/i.test(period?.type || "")) return null;
  if (!(Array.isArray(cfg.productUsage) ? cfg.productUsage : []).some((p) => /cursor/i.test(p?.product || ""))) return null;
  if (!["number", "string"].includes(typeof value) || String(value).trim() === "") return null;
  const pct = Number(value);
  const end = Date.parse(period.end);
  if (!Number.isFinite(pct) || pct < 0 || !Number.isFinite(end)) return null;
  return windowOf({ kind: "weekly", label: "Weekly", usedPct: pct, resetsAt: period.end });
}

function consolidate(providers, selected) {
  if (regime(selected) !== "combined") return providers;
  if (providers.some((p) => p.id === "x_subscription")) return providers;
  const grok = providers.find((p) => p.id === "grok");
  const cursor = providers.find((p) => p.id === "cursor");
  // Select one authoritative pool reader. Its identity and credits must travel
  // with its total; another account's monthly allowance is never a fallback.
  const verified = (p) => p?.shared_weekly && Number.isFinite(p.shared_weekly.used_pct) && p.shared_weekly.used_pct >= 0 &&
    Date.parse(p.shared_weekly.resets_at) > Date.now() && ["ok", "stale"].includes(p.status?.state);
  const base = [grok, cursor].find((p) => verified(p) && p.status.state === "ok") || [grok, cursor].find(verified) || grok || cursor;
  const weekly = base?.shared_weekly;
  const valid = verified(base);
  const combined = {
    id: "x_subscription", display_name: "X Subscription", plan: "Shared weekly pool",
    subscription_regime: "combined", dashboard_url: base?.id === "cursor" ? "https://cursor.com/dashboard" : DASHBOARD,
    pool_reader: base?.id || "grok",
    account: base?.account, account_id: base?.account_id,
    cache_scope: base?.cache_scope,
    // A sign-out or a failed read says what to do; only a missing pool gets the generic hint.
    status: valid || ["logged_out", "not_installed", "fetch_failed"].includes(base?.status?.state) ? base.status : { state: base?.status?.state === "stale" ? "stale" : "unknown",
      hint: base?.status?.state === "stale" ? "Stale reading · shared weekly usage unavailable. Open the usage dashboard." : "Shared weekly usage unavailable. Open the usage dashboard." },
    windows: [...(valid ? [weekly] : [{ kind: "weekly", label: "Weekly", used_pct: null, remaining_pct: null, resets_at: null }]), ...(base?.windows || []).filter((w) => w.kind === "credits")
      .map((w) => ({ ...w, label: w.label.replace(/^Credits/, "Additional Usage") }))],
    fetched_at: base?.fetched_at || new Date().toISOString(), source: valid || base?.status?.state === "stale" ? base.source : "none",
  };
  const out = providers.filter((p) => !["grok", "cursor", "x_subscription"].includes(p.id));
  out.splice(Math.min(3, out.length), 0, combined);
  return out;
}

module.exports = { regime, sharedWeekly, consolidate };
