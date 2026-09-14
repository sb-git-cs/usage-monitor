const root = document.getElementById("root");
const bar = document.getElementById("bar");
const grip = document.getElementById("grip");

function setDocked(docked) {
  bar.classList.toggle("docked", !!docked);
  grip.style.webkitAppRegion = "drag";
}

function hitFromEvent(e) {
  return !!(e.target && e.target.closest && e.target.closest(".pct-icon, .chip-grip"));
}

document.addEventListener("mouseover", (e) => {
  window.usage.setChipsHit(hitFromEvent(e));
});
document.addEventListener("mouseout", (e) => {
  const next = e.relatedTarget;
  if (next && next.closest && next.closest(".pct-icon, .chip-grip")) return;
  window.usage.setChipsHit(false);
});
document.addEventListener("mouseleave", () => window.usage.setChipsHit(false));

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
  root.querySelectorAll(".pct-icon").forEach((el) => {
    el.addEventListener("click", () => window.usage.toggleFlyout());
    el.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      window.usage.openTrayMenu();
    });
    el.addEventListener("mouseenter", () => window.usage.setChipsHit(true));
    el.addEventListener("mouseleave", () => window.usage.setChipsHit(false));
  });
}

grip.addEventListener("mouseenter", () => window.usage.setChipsHit(true));
grip.addEventListener("mouseleave", () => window.usage.setChipsHit(false));
grip.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  window.usage.openTrayMenu();
});

window.usage.onSnapshot(render);
window.usage.onChipsDocked(setDocked);
window.usage.getChipsDocked().then(setDocked);
