const root = document.getElementById("root");

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
  });
}

window.usage.onSnapshot(render);
