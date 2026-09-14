function pad(n) {
  return String(n).padStart(2, "0");
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

function overlayLabel(win) {
  if (win.kind === "five_hour") return "5-hour";
  if (win.kind === "weekly") return "Weekly";
  return win.label;
}

function flyoutLabel(win) {
  if (win.kind === "five_hour") return "5h";
  if (win.kind === "weekly") return "Wk";
  if (win.kind === "credits") return "Credits";
  return win.label;
}

function alerting(win) {
  return win.used_pct != null && win.remaining_pct != null && win.remaining_pct < 20;
}

function letter(id) {
  return id === "claude" ? "C" : id === "codex" ? "X" : "G";
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
