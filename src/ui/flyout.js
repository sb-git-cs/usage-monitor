const body = document.getElementById("body");
const root = document.getElementById("root");
const pinBtn = document.getElementById("pin");
const dockBtn = document.getElementById("dock");
document.getElementById("refresh").addEventListener("click", (e) => {
  e.stopPropagation();
  window.usage.refresh();
});
pinBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  window.usage.toggleFlyoutPin();
});
dockBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  window.usage.toggleFlyoutDock();
});
bindIntervalSelect(document.getElementById("interval"));

let docked = false;

function applyFlyoutState(state) {
  if (!state) return;
  docked = !!state.docked;
  pinBtn.classList.toggle("active", !!state.pinned);
  dockBtn.classList.toggle("active", !!state.docked);
  root.classList.toggle("docked", docked);
  if (window.__last) render(window.__last);
}

document.addEventListener("mouseover", () => window.usage.setFlyoutHit(true));
document.addEventListener("mouseleave", () => {
  if (document.activeElement && document.activeElement.tagName === "SELECT") return;
  window.usage.setFlyoutHit(false);
});
window.usage.onFlyoutState(applyFlyoutState);
window.usage.getFlyoutState().then(applyFlyoutState);

function renderDocked(snapshot) {
  const parts = [`<div class="chip-grip" title="Drag to undock"></div>`];
  for (const p of snapshot.providers || []) {
    const hot = (p.windows || []).filter((w) => w.used_pct != null);
    const five = hot.find((w) => w.kind === "five_hour");
    const win = five || hot.reduce((a, b) => (!a || b.used_pct > a.used_pct ? b : a), null);
    let cls = "gray";
    let num = "—";
    if (win) {
      num = formatUsedTotal(win, true);
      cls = alerting(win) ? "alert" : "ok";
    }
    parts.push(
      `<div class="tb-item ${cls}" data-id="${p.id}" title="${p.display_name}"><span class="who">${letter(p.id)}</span>${num}</div>`
    );
  }
  body.innerHTML = parts.join("");
  body.querySelectorAll(".tb-item").forEach((el) => {
    el.addEventListener("click", () => window.usage.openUsage(el.dataset.id));
    el.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      window.usage.openTrayMenu();
    });
  });
  requestAnimationFrame(() => window.usage.resizeFlyout(32, 252));
}

function render(snapshot) {
  if (docked) {
    renderDocked(snapshot);
    return;
  }
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
        const pct = formatUsedTotal(w);
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
  requestAnimationFrame(() => {
    window.usage.resizeFlyout(root.scrollHeight);
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
