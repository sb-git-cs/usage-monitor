const { Notification } = require("electron");
const { ALERT_USED_PCT, shownPct } = require("./models");

// Forecast warnings start once a window is half used; earlier the pace is too uncertain.
const FORECAST_MIN_USED = 50;

// A time on another day carries its date, so a weekly forecast and its reset stay apart.
function clock(iso) {
  const d = new Date(iso);
  const today = d.toDateString() === new Date().toDateString();
  return d.toLocaleString([], today ? { hour: "numeric", minute: "2-digit" }
    : { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
const cache = require("./cache");
const { digest, identity } = require("./insights");

// offset moves the reset by that many minutes. Given oldRegime, it builds the key earlier versions
// saved, which followed the account label and carried the selected regime for every plan.
function keyFor(provider, win, offset = 0, oldRegime = null) {
  let resets = "0";
  if (win.resets_at) {
    const t = Date.parse(win.resets_at);
    // Rounded to five minutes: providers repeat a window's reset time with up to a second of jitter.
    resets = Number.isNaN(t) ? String(win.resets_at) : String(Math.round(t / 300000) * 5 + offset);
  }
  const label = win.label || "";
  // The reading's own scope: the account label can lag a sign-in switch by a minute, and the
  // shared pool is one window whichever account reads it.
  const account = oldRegime ? provider.account_id || provider.account || identity(provider)
    : provider.id === "x_subscription" ? "" : identity(provider);
  const selected = (oldRegime || provider.subscription_regime) === "combined" ? "combined|" : "";
  return `${selected}${provider.id}|${win.kind}|${label}|${resets}${account ? `|${digest(account)}` : ""}`;
}

// The saved entry for this window, if any. A reset on a bucket edge rounds either way, so the
// neighbouring buckets count too, and an entry under an earlier key is moved to the current one.
function firedFor(fired, provider, win, oldRegime) {
  const key = keyFor(provider, win);
  const keys = [0, -5, 5].flatMap((offset) => [keyFor(provider, win, offset), keyFor(provider, win, offset, oldRegime)]);
  const found = keys.find((k) => fired[k]);
  if (!found || found === key) return { key, prev: fired[key] };
  const prev = fired[found];
  delete fired[found];
  return { key, prev };
}

function prune(fired) {
  const now = Date.now();
  const next = {};
  for (const [k, v] of Object.entries(fired)) {
    // An entry that never warned holds nothing, and kept forever it only grows the file.
    if (!v || typeof v !== "object" || !(v.crossed80 || v.crossed100 || v.forecast)) continue;
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
function evaluate(snapshot, { onClick, onEvent, notifyOnLimit, threshold = ALERT_USED_PCT, quiet = false, forecastAlerts = false } = {}) {
  const warnAt = Number.isFinite(threshold) ? threshold : ALERT_USED_PCT;
  const state = cache.loadAlertState();
  state.fired = prune(state.fired || {});
  const toasts = [];

  for (const provider of snapshot.providers || []) {
    if (provider.status?.state !== "ok") continue;
    for (const win of provider.windows || []) {
      if (!Number.isFinite(win.used_pct)) continue;
      if (win.resets_at && Date.parse(win.resets_at) <= Date.now()) continue;
      const found = firedFor(state.fired, provider, win, snapshot.subscription_regime || provider.subscription_regime || "legacy");
      const key = found.key;
      // crossed80 keeps its old name so saved state still reads; it means "crossed the warn threshold".
      const prev = found.prev || { crossed80: false, crossed100: false };
      if (win.used_pct >= warnAt && !prev.crossed80 && !(notifyOnLimit && win.used_pct >= 100)) {
        toasts.push({
          title: `Usage Monitor — ${provider.display_name}`,
          body: `${win.label} window: ${shownPct(win.used_pct)}% used`,
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
      if (forecastAlerts && Date.parse(win.forecast_at) > Date.now() && Date.parse(win.forecast_at) < Date.parse(win.resets_at) && win.used_pct >= FORECAST_MIN_USED && win.used_pct < 100 && !prev.forecast) {
        toasts.push({
          title: `Usage Monitor — ${provider.display_name}`,
          body: `${win.label} is ${shownPct(win.used_pct)}% used. At this pace it reaches 100% around ${clock(win.forecast_at)}, before it resets at ${clock(win.resets_at)}.`,
        });
        prev.forecast = true;
        prev.until = win.resets_at;
      }
      if (win.used_pct < warnAt) {
        prev.crossed80 = false;
        prev.crossed100 = false;
      }
      if (prev.crossed80 || prev.crossed100 || prev.forecast) state.fired[key] = prev;
      else delete state.fired[key];
    }
  }

  try { cache.saveAlertState(state); } catch (err) { console.error("alert cache write failed", err.message); }
  for (const t of toasts) {
    if (quiet) { if (onEvent) onEvent(t.title, t.body, "suppressed"); continue; }
    const n = notify(t.title, t.body);
    if (onEvent) onEvent(t.title, t.body, n ? "requested" : "unsupported");
    if (n && onClick) n.on("click", onClick);
  }
}

module.exports = { evaluate };
