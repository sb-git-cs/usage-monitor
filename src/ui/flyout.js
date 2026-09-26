const body = document.getElementById("body");
const root = document.getElementById("root");
const dockBtn = document.getElementById("dock");
document.getElementById("refresh").addEventListener("click", (e) => {
  e.stopPropagation();
  window.usage.refresh();
});
document.getElementById("network").addEventListener("click", (e) => {
  e.stopPropagation();
  window.usage.openNetwork();
});
dockBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  window.usage.toggleFlyoutDock();
});
bindIntervalSelect(document.getElementById("interval"));

function applyFlyoutState(state) {
  if (!state) return;
  // Taskbar snapping only exists on Windows.
  dockBtn.hidden = state.canDock === false;
  dockBtn.classList.toggle("active", !!state.docked);
  root.classList.toggle("docked", !!state.docked);
}

bindDrag(root);
window.usage.onFlyoutState(applyFlyoutState);
window.usage.getFlyoutState().then(applyFlyoutState);

function fitFlyout() {
  root.style.width = "max-content";
  const w = Math.ceil(Math.max(root.scrollWidth, root.offsetWidth, root.getBoundingClientRect().width, 580));
  const h = Math.ceil(Math.max(root.scrollHeight, root.offsetHeight, root.getBoundingClientRect().height));
  // Exact height: no transparent strip under the panel, so it can sit flush on the taskbar.
  window.usage.resizeFlyout(h, w);
}

function render(snapshot) {
  const parts = [];
  for (const p of snapshot.providers || []) {
    const hint = statusText(p);
    parts.push(`<section class="provider accent-${escapeHtml(p.id)}" data-id="${escapeHtml(p.id)}">
      <div class="p-head"><span class="p-name">${mark(p.id)}<span>${escapeHtml(p.display_name)}</span></span><span class="p-plan">${escapeHtml(p.plan || "")}${p.status && p.status.state === "stale" ? '<span class="badge">stale</span>' : ""}</span></div>`);
    if (hint && !(p.windows && p.windows.length)) {
      parts.push(`<div class="hint">${escapeHtml(hint)}</div>`);
    } else {
      const extras = [];
      parts.push(`<div class="metrics">`);
      for (const w of p.windows || []) {
        if (w.kind === "credits" && w.used_pct == null) {
          extras.push(`<div class="credits">${escapeHtml(w.label)}</div>`);
          continue;
        }
        const alert = alerting(w) ? " alert" : "";
        const pct = formatUsedTotal(w);
        const width = w.used_pct == null ? 0 : Math.max(0, Math.min(100, w.used_pct));
        const color = alerting(w) ? "red" : "green";
        parts.push(`<div class="row${alert}">
          <span class="row-label" title="${escapeHtml(flyoutLabel(w))}">${escapeHtml(flyoutLabel(w))}</span>
          <div class="meter"><div class="fill ${color}" data-width="${width}"></div></div>
          <span class="pct">${pct}</span>
          <span class="eta" data-reset="${escapeHtml(w.resets_at || "")}">${formatEta(w.resets_at)}</span>
        </div>`);
      }
      parts.push(`</div>`);
      extras.forEach((html) => parts.push(html));
    }
    parts.push("</section>");
  }
  body.innerHTML = parts.join("");
  body.querySelectorAll(".fill[data-width]").forEach((el) => {
    el.style.width = `${Number(el.dataset.width) || 0}%`;
  });
  body.querySelectorAll(".provider").forEach((el) => {
    el.addEventListener("click", () => window.usage.openUsage(el.dataset.id));
  });
  requestAnimationFrame(fitFlyout);
}

// ---- network card ---------------------------------------------------------------

const netCard = document.getElementById("net");
const NET_IDLE = {
  setup_required: "Setup needed",
  disabled: "Recording off",
  not_running: "Helper not running",
  error: "Not recording",
  starting: "Starting…",
};

function setNetText(id, text) {
  const node = document.getElementById(id);
  if (node.textContent !== text) node.textContent = text;
}

function renderNet(summary) {
  const wasHidden = netCard.hidden;
  if (!summary) {
    if (!wasHidden) {
      netCard.hidden = true;
      requestAnimationFrame(fitFlyout);
    }
    return;
  }
  netCard.hidden = false;
  const running = summary.state === "running";
  setNetText("netRx", running ? NetFormat.formatRate(summary.rx_rate) : "—");
  setNetText("netTx", running ? NetFormat.formatRate(summary.tx_rate) : "—");
  setNetText("netHour", summary.hour ? `↓ ${NetFormat.formatBytes(summary.hour.rx)}\u2003↑ ${NetFormat.formatBytes(summary.hour.tx)}` : "—");
  setNetText("netState", running ? "Open monitor ›" : `${NET_IDLE[summary.state] || "Not recording"} · Open ›`);
  let top;
  if (!running) top = summary.message || "Open the monitor to start recording network usage.";
  else if (!summary.top.length) top = "No app is using the network right now.";
  else top = `Now: ${summary.top.map((a) => `${a.name} ${NetFormat.formatRateShort(a.rx_rate + a.tx_rate)}`).join(" · ")}`;
  setNetText("netTop", top);
  if (wasHidden) requestAnimationFrame(fitFlyout);
}

netCard.addEventListener("click", (e) => {
  e.stopPropagation();
  window.usage.openNetwork();
});
window.usage.onNet(renderNet);

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
