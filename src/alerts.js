const { Notification } = require("electron");
const { ALERT_USED_PCT } = require("./models");

// Forecast warnings start once a window is half used; earlier the pace is too uncertain.
const FORECAST_MIN_USED = 50;

function clock(iso) {
  return new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}
const cache = require("./cache");

function keyFor(provider, win) {
  let resets = "0";
  if (win.resets_at) {
    const t = Date.parse(win.resets_at);
    resets = Number.isNaN(t) ? String(win.resets_at) : String(Math.floor(t / 60000));
  }
  const label = win.label || "";
  return `${provider.id}|${win.kind}|${label}|${resets}`;
}

function prune(fired) {
  const now = Date.now();
  const next = {};
  for (const [k, v] of Object.entries(fired)) {
    if (!v || typeof v !== "object") continue;
    if (v.until && Date.parse(v.until) > now) next[k] = v;
    else if (!v.until) next[k] = v;
  }
  return next;
}

function notify(title, body) {
  if (!Notification.isSupported()) return;
  const n = new Notification({
    title,
    body,
    silent: true,
    urgency: "critical",
  });
  n.show();
  return n;
}

// threshold: the "warn at" percentage from Settings. quiet: inside quiet hours the crossing is
// recorded but no notification is shown, so it does not pop up later either.
// forecastAlerts: warn once per window when it is on course to reach 100% before it resets.
function evaluate(snapshot, { onClick, notifyOnLimit, threshold = ALERT_USED_PCT, quiet = false, forecastAlerts = false } = {}) {
  const warnAt = Number.isFinite(threshold) ? threshold : ALERT_USED_PCT;
  const state = cache.loadAlertState();
  state.fired = prune(state.fired || {});
  const toasts = [];

  for (const provider of snapshot.providers || []) {
    if (provider.status?.state !== "ok") continue;
    for (const win of provider.windows || []) {
      if (!Number.isFinite(win.used_pct)) continue;
      if (win.resets_at && Date.parse(win.resets_at) <= Date.now()) continue;
      const key = keyFor(provider, win);
      // crossed80 keeps its old name so saved state still reads; it means "crossed the warn threshold".
      const prev = state.fired[key] || { crossed80: false, crossed100: false };
      if (win.used_pct >= warnAt && !prev.crossed80 && !(notifyOnLimit && win.used_pct >= 100)) {
        toasts.push({
          title: `Usage Monitor — ${provider.display_name}`,
          body: `${win.label} ${Math.round(win.used_pct)}/100% used`,
        });
        prev.crossed80 = true;
        prev.until = win.resets_at;
      }
      if (notifyOnLimit && win.used_pct >= 100 && !prev.crossed100) {
        toasts.push({
          title: `Usage Monitor — ${provider.display_name}`,
          body: `${win.label} limit reached`,
        });
        prev.crossed100 = true;
        prev.crossed80 = true;
        prev.until = win.resets_at;
      }
      if (forecastAlerts && win.forecast_at && win.resets_at && win.used_pct >= FORECAST_MIN_USED && win.used_pct < 100 && !prev.forecast) {
        toasts.push({
          title: `Usage Monitor — ${provider.display_name}`,
          body: `${win.label} is ${Math.round(win.used_pct)}% used. At this pace it reaches 100% around ${clock(win.forecast_at)}, before it resets at ${clock(win.resets_at)}.`,
        });
        prev.forecast = true;
        prev.until = win.resets_at;
      }
      if (win.used_pct < warnAt) {
        prev.crossed80 = false;
        prev.crossed100 = false;
      }
      state.fired[key] = prev;
    }
  }

  try { cache.saveAlertState(state); } catch (err) { console.error("alert cache write failed", err.message); }
  if (quiet) return;
  for (const t of toasts) {
    const n = notify(t.title, t.body);
    if (n && onClick) n.on("click", onClick);
  }
}

module.exports = { evaluate };
