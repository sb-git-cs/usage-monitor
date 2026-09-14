const body = document.getElementById("body");
const pinBtn = document.getElementById("pin");
document.getElementById("close").addEventListener("click", () => window.usage.hideOverlay());
pinBtn.addEventListener("click", () => window.usage.togglePin());
bindIntervalSelect(document.getElementById("interval"));

function overlayEta(iso) {
  if (!iso) return "";
  const ms = Date.parse(iso) - Date.now();
  if (ms < 24 * 3600 * 1000) return `resets in ${formatEta(iso)}`;
  return `resets ${formatEta(iso)}`;
}

function render(snapshot) {
  const parts = [];
  for (const p of snapshot.providers || []) {
    const hint = statusText(p);
    parts.push(`<section class="provider accent-${p.id}" data-id="${p.id}">
      <div class="p-head"><span class="p-name">${p.display_name}</span><span class="p-plan">${p.plan || ""}${p.status && p.status.state === "stale" ? '<span class="badge">stale</span>' : ""}</span></div>`);
    if (hint && !(p.windows && p.windows.length)) {
      parts.push(`<div class="hint">${hint}</div>`);
    } else {
      for (const w of p.windows || []) {
        if (w.kind === "credits" && w.used_pct == null) {
          parts.push(`<div class="credits"><span>${w.label}</span><span></span></div>`);
          continue;
        }
        const alert = alerting(w);
        const pct = w.used_pct == null ? "—" : `${Math.round(w.used_pct)}%`;
        const width = w.used_pct == null ? 0 : Math.min(100, w.used_pct);
        parts.push(`<div class="win-block">
          <div class="win-label">${overlayLabel(w)}</div>
          <div class="win-pct${alert ? " alert" : ""}">${pct}</div>
          <div class="meter overlay-meter"><div class="fill ${alert ? "red" : "green"}" style="width:${width}%"></div></div>
          <div class="win-reset">${overlayEta(w.resets_at)}</div>
        </div>`);
      }
      if (p.footnotes && p.footnotes.length) {
        parts.push(`<div class="footnote">${p.footnotes.join(" · ")}</div>`);
      }
      if (p.id === "grok" && !(p.windows || []).some((w) => w.kind === "five_hour")) {
        parts.push(`<div class="footnote">No 5-hour window on Grok</div>`);
      }
    }
    parts.push("</section>");
  }
  body.innerHTML = parts.join("");
  body.querySelectorAll(".provider").forEach((el) => {
    el.addEventListener("click", () => window.usage.openUsage(el.dataset.id));
  });
  requestAnimationFrame(() => {
    const h = document.getElementById("root").scrollHeight;
    window.usage.resizeOverlay(h);
  });
}

window.usage.onPinned((pinned) => {
  pinBtn.classList.toggle("active", !!pinned);
});
window.usage.onSnapshot((s) => {
  window.__last = s;
  render(s);
});
setInterval(() => {
  if (window.__last) render(window.__last);
}, 1000);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !pinBtn.classList.contains("active")) window.usage.hideOverlay();
});
