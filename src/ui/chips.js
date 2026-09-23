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

bindDrag(bar, "button, .pct-icon");

let lastKey = "";

function chipKey(snapshot) {
  const docked = bar.classList.contains("docked") ? "1" : "0";
  const parts = (snapshot.providers || []).map((p) => {
    const hot = (p.windows || []).filter((w) => w.used_pct != null);
    const five = hot.find((w) => w.kind === "five_hour");
    const win = five || hot.reduce((a, b) => (!a || b.used_pct > a.used_pct ? b : a), null);
    const num = win ? formatUsedTotal(win, true) : "—";
    const cls = win ? (alerting(win) ? "red" : "green") : "gray";
    const state = (p.status && p.status.state) || "";
    return `${p.id}:${cls}:${num}:${state}`;
  });
  return docked + "|" + parts.join("|");
}

function render(snapshot) {
  const key = chipKey(snapshot);
  if (key === lastKey) return;
  lastKey = key;
  const parts = [];
  for (const p of snapshot.providers || []) {
    const hot = (p.windows || []).filter((w) => w.used_pct != null);
    const five = hot.find((w) => w.kind === "five_hour");
    const win = five || hot.reduce((a, b) => (!a || b.used_pct > a.used_pct ? b : a), null);
    let cls = "gray";
    let num = "—";
    if (win) {
      num = formatUsedTotal(win, true);
      cls = alerting(win) ? "red" : "green";
    }
    parts.push(`<div class="pct-icon ${cls}" data-id="${p.id}" title="${p.display_name}"><span class="who">${mark(p.id)}</span>${num}</div>`);
  }
  root.innerHTML = parts.join("");
  requestAnimationFrame(() => {
    bar.style.width = "max-content";
    const w = Math.ceil(Math.max(bar.scrollWidth, bar.offsetWidth));
    const h = Math.ceil(Math.max(bar.scrollHeight, bar.offsetHeight, 24));
    window.usage.resizeChips(w + 4, h + 4);
  });
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
setInterval(() => {
  if (!window.__last) return;
  const next = applyLocalResets(window.__last);
  if (next.changed) {
    window.__last = next.snapshot;
    render(window.__last);
  }
}, 1000);
window.usage.onChipsDocked(setDocked);
window.usage.getChipsDocked().then(setDocked);
