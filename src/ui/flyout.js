const body = document.getElementById("body");
document.getElementById("refresh").addEventListener("click", (e) => {
  e.stopPropagation();
  window.usage.refresh();
});
bindIntervalSelect(document.getElementById("interval"));

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
          parts.push(`<div class="credits" style="font-size:11px;color:#9ca3af"><span>${w.label}</span><span></span></div>`);
          continue;
        }
        const alert = alerting(w) ? " alert" : "";
        const pct = w.used_pct == null ? "—" : `${Math.round(w.used_pct)}%`;
        const width = w.used_pct == null ? 0 : Math.min(100, w.used_pct);
        const color = alerting(w) ? "red" : "green";
        parts.push(`<div class="row${alert}">
          <span>${flyoutLabel(w)}</span>
          <div class="meter"><div class="fill ${color}" style="width:${width}%"></div></div>
          <span class="pct">${pct}</span>
          <span class="eta">${formatEta(w.resets_at)}</span>
        </div>`);
      }
    }
    parts.push("</section>");
  }
  body.innerHTML = parts.join("");
  body.querySelectorAll(".provider").forEach((el) => {
    el.addEventListener("click", () => window.usage.openUsage(el.dataset.id));
  });
}

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") window.usage.hideFlyout();
});
window.usage.onSnapshot((s) => {
  window.__last = s;
  render(s);
});
setInterval(() => {
  if (window.__last) render(window.__last);
}, 1000);
