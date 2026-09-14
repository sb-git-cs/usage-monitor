const body = document.getElementById("body");
document.getElementById("close").addEventListener("click", () => window.usage.hideOverlay());
document.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  window.usage.openTrayMenu();
});
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
        const pct = formatUsedTotal(w);
        const width = w.used_pct == null ? 0 : Math.min(100, w.used_pct);
        parts.push(`<div class="win-block">
          <div class="win-label">${overlayLabel(w)}</div>
          <div class="win-frac">used/total</div>
          <div class="win-pct${alert ? " alert" : ""}">${pct}</div>
          <div class="meter overlay-meter"><div class="fill ${alert ? "red" : "green"}" style="width:${width}%"></div></div>
          <div class="win-reset" data-reset="${w.resets_at || ""}">${overlayEta(w.resets_at)}</div>
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
    const root = document.getElementById("root");
    root.style.width = "max-content";
    const w = Math.ceil(Math.max(root.scrollWidth, root.offsetWidth, 300));
    const h = Math.ceil(Math.max(root.scrollHeight, root.offsetHeight));
    window.usage.resizeOverlay(h + 4, w + 4);
  });
}

bindDrag(document.getElementById("root"));

window.usage.onSnapshot((s) => {
  window.__last = s;
  render(s);
});
setInterval(() => {
  document.querySelectorAll("[data-reset]").forEach((el) => {
    el.textContent = overlayEta(el.dataset.reset);
  });
}, 1000);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") window.usage.hideOverlay();
});
