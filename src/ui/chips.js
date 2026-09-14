const root = document.getElementById("root");
const bar = document.getElementById("bar");
const grip = document.getElementById("grip");

function setDocked(docked) {
  bar.classList.toggle("docked", !!docked);
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
    parts.push(`<div class="pct-icon ${cls}" data-id="${p.id}"><span class="who">${letter(p.id)}</span>${num}</div>`);
  }
  root.innerHTML = parts.join("");
  requestAnimationFrame(() => {
    const r = bar.getBoundingClientRect();
    window.usage.resizeChips(Math.ceil(r.width + 1), Math.ceil(r.height + 1));
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

window.usage.onSnapshot(render);
window.usage.onChipsDocked(setDocked);
window.usage.getChipsDocked().then(setDocked);
