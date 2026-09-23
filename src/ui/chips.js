const root = document.getElementById("root");
const bar = document.getElementById("bar");
const grip = document.getElementById("grip");

function setDocked(docked) {
  const next = !!docked;
  if (bar.classList.contains("docked") === next && window.__last) return;
  bar.classList.toggle("docked", next);
  lastKey = "";
  if (window.__last) render(window.__last);
}

function setPopped(popped) {
  const next = !!popped;
  if (bar.classList.contains("popped") === next) return;
  bar.classList.toggle("popped", next);
  lastKey = "";
  if (window.__last) render(window.__last);
}

bindDrag(bar, "button, .pct-icon");

let lastKey = "";

function chipKey(snapshot) {
  const docked = bar.classList.contains("docked") ? "1" : "0";
  const parts = (snapshot.providers || []).map((p) => {
    const win = UsageModels.currentWindow(p);
    const num = win ? formatUsedTotal(win, true) : "—";
    const cls = win ? (alerting(win) ? "red" : "green") : "gray";
    const state = (p.status && p.status.state) || "";
    return `${escapeHtml(p.id)}:${win?.kind || ""}:${win?.label || ""}:${cls}:${num}:${state}`;
  });
  return docked + "|" + parts.join("|");
}

function fitBar() {
  bar.style.width = "max-content";
  const w = Math.ceil(Math.max(bar.scrollWidth, bar.offsetWidth));
  const h = Math.ceil(Math.max(bar.scrollHeight, bar.offsetHeight, 24));
  window.usage.resizeChips(w + 4, h + 4);
}

function showLoading() {
  lastKey = "loading";
  root.innerHTML = `<div class="pct-icon gray loading-chip" title="Loading">loading…</div>`;
  requestAnimationFrame(fitBar);
}

function render(snapshot) {
  if (!snapshot || !(snapshot.providers || []).length) {
    showLoading();
    return;
  }
  const key = chipKey(snapshot);
  if (key === lastKey) return;
  lastKey = key;
  const parts = [];
  for (const p of snapshot.providers || []) {
    const win = UsageModels.currentWindow(p);
    let cls = "gray";
    let num = "—";
    if (win) {
      num = formatUsedTotal(win, true);
      cls = alerting(win) ? "red" : "green";
    }
    const stale = p.status?.state === "stale";
    parts.push(`<div class="pct-icon ${cls}${stale ? " stale" : ""}" data-id="${escapeHtml(p.id)}" title="${escapeHtml(p.display_name)}${win ? ` - ${escapeHtml(win.label)}` : ""}${stale ? " (stale)" : ""}"><span class="who">${mark(p.id)}</span>${num}</div>`);
  }
  root.innerHTML = parts.join("");
  requestAnimationFrame(fitBar);
  root.querySelectorAll(".pct-icon").forEach((el) => {
    el.addEventListener("click", () => window.usage.toggleFlyout());
    el.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      window.usage.openTrayMenu();
    });
  });
}

grip.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  window.usage.openTrayMenu();
});

window.usage.onSnapshot((s) => {
  window.__last = s;
  render(s);
});
window.usage.onLoading(() => showLoading());
requestAnimationFrame(fitBar);
setInterval(() => {
  if (!window.__last) return;
  const next = applyLocalResets(window.__last);
  if (next.changed) {
    window.__last = next.snapshot;
    render(window.__last);
  }
}, 1000);
window.usage.onChipsDocked(setDocked);
window.usage.onChipsPopped(setPopped);
window.usage.getChipsDocked().then(setDocked);
