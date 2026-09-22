const body = document.getElementById("body");
const root = document.getElementById("root");
const dockBtn = document.getElementById("dock");
document.getElementById("refresh").addEventListener("click", (e) => {
  e.stopPropagation();
  window.usage.refresh();
});
dockBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  window.usage.toggleFlyoutDock();
});
bindIntervalSelect(document.getElementById("interval"));

function applyFlyoutState(state) {
  if (!state) return;
  dockBtn.classList.toggle("active", !!state.docked);
  root.classList.toggle("docked", !!state.docked);
}

bindDrag(root);
window.usage.onFlyoutState(applyFlyoutState);
window.usage.getFlyoutState().then(applyFlyoutState);

function fitFlyout() {
  root.style.width = "max-content";
  const w = Math.ceil(Math.max(root.scrollWidth, root.offsetWidth, 580));
  const h = Math.ceil(Math.max(root.scrollHeight, root.offsetHeight));
  window.usage.resizeFlyout(h + 4, w + 4);
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
      const extras = [];
      parts.push(`<div class="metrics">`);
      for (const w of p.windows || []) {
        if (w.kind === "credits" && w.used_pct == null) {
          extras.push(`<div class="credits">${w.label}</div>`);
          continue;
        }
        const alert = alerting(w) ? " alert" : "";
        const pct = formatUsedTotal(w);
        const width = w.used_pct == null ? 0 : Math.min(100, w.used_pct);
        const color = alerting(w) ? "red" : "green";
        parts.push(`<div class="row${alert}">
          <span class="row-label">${flyoutLabel(w)}</span>
          <div class="meter"><div class="fill ${color}" style="width:${width}%"></div></div>
          <span class="pct">${pct}</span>
          <span class="eta" data-reset="${w.resets_at || ""}">${formatEta(w.resets_at)}</span>
        </div>`);
      }
      parts.push(`</div>`);
      extras.forEach((html) => parts.push(html));
    }
    parts.push("</section>");
  }
  body.innerHTML = parts.join("");
  body.querySelectorAll(".provider").forEach((el) => {
    el.addEventListener("click", () => window.usage.openUsage(el.dataset.id));
  });
  requestAnimationFrame(fitFlyout);
}

document.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  window.usage.openTrayMenu();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") window.usage.hideFlyout();
});
window.usage.onSnapshot((s) => {
  window.__last = s;
  render(s);
});
setInterval(() => {
  if (!window.__last) return;
  const next = applyLocalResets(window.__last);
  if (next.changed) {
    window.__last = next.snapshot;
    render(window.__last);
    return;
  }
  document.querySelectorAll("[data-reset]").forEach((el) => {
    el.textContent = formatEta(el.dataset.reset);
  });
}, 1000);
