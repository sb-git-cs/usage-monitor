const { Notification } = require("electron");
const { ALERT_USED_PCT } = require("./models");
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

function evaluate(snapshot, { onClick, notifyOnLimit } = {}) {
  const state = cache.loadAlertState();
  state.fired = prune(state.fired || {});
  const toasts = [];

  for (const provider of snapshot.providers || []) {
    if (provider.status?.state !== "ok") continue;
    for (const win of provider.windows || []) {
      if (!Number.isFinite(win.used_pct)) continue;
      if (win.resets_at && Date.parse(win.resets_at) <= Date.now()) continue;
      const key = keyFor(provider, win);
      const prev = state.fired[key] || { crossed80: false, crossed100: false };
      if (win.used_pct >= ALERT_USED_PCT && !prev.crossed80 && !(notifyOnLimit && win.used_pct >= 100)) {
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
      if (win.used_pct < ALERT_USED_PCT) {
        prev.crossed80 = false;
        prev.crossed100 = false;
      }
      state.fired[key] = prev;
    }
  }

  try { cache.saveAlertState(state); } catch (err) { console.error("alert cache write failed", err.message); }
  for (const t of toasts) {
    const n = notify(t.title, t.body);
    if (n && onClick) n.on("click", onClick);
  }
}

module.exports = { evaluate };
