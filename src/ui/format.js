function pad(n) {
  return String(n).padStart(2, "0");
}

function applyLocalResets(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.providers)) return { snapshot, changed: false };
  const now = Date.now();
  let changed = false;
  const providers = snapshot.providers.map((p) => {
    const windows = (p.windows || []).map((w) => {
      if (!w.resets_at) return w;
      const t = Date.parse(w.resets_at);
      if (!t || t > now) return w;
      changed = true;
      let next = t;
      const step =
        w.kind === "weekly" || w.kind === "weekly_scoped"
          ? 7 * 24 * 60 * 60 * 1000
          : w.kind === "daily"
            ? 24 * 60 * 60 * 1000
            : 5 * 60 * 60 * 1000;
      while (next <= now) next += step;
      return {
        ...w,
        used_pct: w.used_pct == null ? null : 0,
        remaining_pct: w.used_pct == null ? null : 100,
        resets_at: new Date(next).toISOString(),
      };
    });
    return { ...p, windows };
  });
  return { snapshot: { ...snapshot, providers }, changed };
}

function formatEta(iso) {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (!t) return "";
  const ms = t - Date.now();
  if (ms <= 0) return "now";
  const mins = Math.round(ms / 60000);
  if (mins < 24 * 60) {
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return h ? `${h}h ${pad(m)}m` : `${m}m`;
  }
  const d = new Date(t);
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  let hours = d.getHours();
  const ampm = hours >= 12 ? "PM" : "AM";
  hours = hours % 12 || 12;
  return `${days[d.getDay()]} ${hours}:${pad(d.getMinutes())} ${ampm}`;
}

function flyoutLabel(win) {
  if (win.kind === "five_hour") return "5h";
  if (win.kind === "weekly") return "Wk";
  if (win.kind === "daily") return "Day";
  if (win.kind === "credits") return "Credits";
  return win.label;
}

function alerting(win) {
  return win.used_pct != null && win.remaining_pct != null && win.remaining_pct < 20;
}

function formatUsedTotal(win, compact) {
  if (win == null || win.used_pct == null) return compact ? "—" : "—/100%";
  const used = Math.round(win.used_pct);
  return compact ? `${used}/100` : `${used}/100%`;
}

function letter(id) {
  if (id === "claude") return "C";
  if (id === "codex") return "X";
  if (id === "gemini") return "M";
  return "G";
}

function bindIntervalSelect(el) {
  if (!el || !window.usage) return;
  window.usage.getInterval().then((secs) => {
    el.value = String(secs || 5);
  });
  window.usage.onInterval((secs) => {
    el.value = String(secs);
  });
  el.addEventListener("change", (e) => {
    e.stopPropagation();
    window.usage.setIntervalSecs(Number(el.value));
  });
}

function statusText(p) {
  const s = p.status || {};
  if (s.state === "logged_out") return s.hint || "Sign in";
  if (s.state === "not_installed") return s.hint || "Not installed";
  if (s.state === "fetch_failed") return s.message || "Error";
  if (s.state === "unknown") return s.message || "n/a";
  return null;
}
