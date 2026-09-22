const root = document.getElementById("root");
const bar = document.getElementById("bar");
const grip = document.getElementById("grip");

function setDocked(docked) {
  bar.classList.toggle("docked", !!docked);
  if (window.__last) render(window.__last);
}

bindDrag(bar, "button, .pct-icon");

function render(snapshot) {
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
