function pad(n) {
  return String(n).padStart(2, "0");
}

function applyLocalResets(snapshot) {
  return UsageModels.applyLocalResets(snapshot);
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

function formatEta(iso) {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
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
  if (win.label && !["5h", "Weekly", "Daily", "Credits"].includes(win.label)) return win.label;
  if (win.kind === "five_hour") return "5h";
  if (win.kind === "weekly") return "Wk";
  if (win.kind === "daily") return win.label || "Day";
  if (win.kind === "credits") return "Credits";
  return win.label;
}

function alerting(win) {
  return Number.isFinite(win.used_pct) && win.used_pct >= 80;
}

function formatUsedTotal(win, compact) {
  if (win == null || !Number.isFinite(win.used_pct)) return compact ? "—" : "—/100%";
  const used = Math.round(win.used_pct);
  return compact ? `${used}/100` : `${used}/100%`;
}

const MARKS = {
  claude:
    "M17.304 3.541h-3.672l6.696 16.918H24Zm-10.608 0L0 20.459h3.744l1.37-3.553h7.005l1.369 3.553h3.744L10.536 3.541Zm-.371 10.223 2.291-5.946 2.292 5.946Z",
  codex:
    "M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z",
  gemini:
    "M11.04 19.32Q12 21.51 12 24q0-2.49.93-4.68.96-2.19 2.58-3.81t3.81-2.55Q21.51 12 24 12q-2.49 0-4.68-.93a12.3 12.3 0 0 1-3.81-2.58 12.3 12.3 0 0 1-2.58-3.81Q12 2.49 12 0q0 2.49-.96 4.68-.93 2.19-2.55 3.81a12.3 12.3 0 0 1-3.81 2.58Q2.49 12 0 12q2.49 0 4.68.96 2.19.93 3.81 2.55t2.55 3.81",
  grok: "M6.469 8.776 16.512 23h-4.464L2.005 8.776H6.47zm-.004 7.9 2.233 3.164L6.467 23H2l4.465-6.324zM22 2.582V23h-3.659V7.764L22 2.582zM22 1l-9.952 14.095-2.233-3.163L17.533 1H22z",
};

function mark(id) {
  const d = MARKS[id] || MARKS.grok;
  const title =
    id === "claude" ? "Anthropic" : id === "codex" ? "OpenAI" : id === "gemini" ? "Google Gemini" : "xAI";
  return `<svg class="brand-mark" viewBox="0 0 24 24" fill-rule="evenodd" aria-hidden="true" focusable="false"><title>${title}</title><path fill="currentColor" d="${d}"/></svg>`;
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
