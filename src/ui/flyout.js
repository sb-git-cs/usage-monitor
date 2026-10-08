const body = document.getElementById("body");
const root = document.getElementById("root");
const dockBtn = document.getElementById("dock");
document.getElementById("settings").addEventListener("click", (e) => {
  e.stopPropagation();
  window.usage.openSettings();
});
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

bindDrag(root, "button, select, a, .icon-btn, .interval, .pct-icon, .tb-item, .provider, .net-card, .pair-card");
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
    if (p.account) parts.push(`<div class="p-account">${escapeHtml(p.account)}</div>`);
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
        if (w.forecast_at && Number.isFinite(w.used_pct)) {
          const pace = Number.isFinite(w.burn_per_hour) ? ` (+${w.burn_per_hour}%/h)` : "";
          extras.push(`<div class="forecast" title="Projected from the recent pace; the window resets ${escapeHtml(formatEta(w.resets_at) || "later")}">${escapeHtml(flyoutLabel(w))} reaches 100% around ${escapeHtml(formatClock(w.forecast_at))} at this pace${escapeHtml(pace)}</div>`);
        }
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

// ---- version and automatic updates -------------------------------------------------

const updateBar = document.getElementById("update");
const updateStatus = document.getElementById("updateStatus");
const updateBtn = document.getElementById("updateAction");

// [text, tone, action button]
function updateLine(u) {
  const v = u.latest || "the update";
  switch (u.status) {
    case "checking": return ["Checking for updates…", "busy", null];
    case "up-to-date": return [u.auto ? "Up to date · updates install automatically" : "Up to date", "good", "Check now"];
    case "downloading": return [`Downloading ${v}… ${Number(u.progress) || 0}%`, "busy", null];
    case "ready": return [`${v} is ready · installs and restarts shortly`, "busy", null];
    case "installing": return [`Installing ${v} · restarting…`, "busy", null];
    case "available": return [`${v} is available · this copy can't update itself`, "warn", "Download"];
    case "skipped": return [u.message || "Not updated", "warn", "Check now"];
    case "error": return ["Couldn't check for updates", "warn", "Retry"];
    case "off": return ["Automatic updates are off", "", "Check now"];
    default: return [u.auto ? "Updates install automatically" : "Automatic updates are off", u.auto ? "good" : "", "Check now"];
  }
}

function renderUpdate(u) {
  if (!u || !u.current) {
    if (!updateBar.hidden) {
      updateBar.hidden = true;
      requestAnimationFrame(fitFlyout);
    }
    return;
  }
  const wasHidden = updateBar.hidden;
  updateBar.hidden = false;
  const [text, tone, action] = updateLine(u);
  setNetText("updateVersion", `v${u.current}${u.build ? ` · ${u.build}` : ""}`);
  if (updateStatus.textContent !== text) updateStatus.textContent = text;
  updateStatus.className = `update-status ${tone}`.trim();
  const checked = u.checked_at ? ` Last checked ${new Date(u.checked_at).toLocaleString()}.` : "";
  updateStatus.title = `${u.message || text}.${checked}`.replace(/\.\./g, ".");
  updateBtn.hidden = !action;
  if (action && updateBtn.textContent !== action) updateBtn.textContent = action;
  if (wasHidden) requestAnimationFrame(fitFlyout);
}

updateBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  window.usage.updateAction();
});
window.usage.onUpdate(renderUpdate);
window.usage.getUpdate().then(renderUpdate, () => {});

document.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  window.usage.openTrayMenu();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") window.usage.hideFlyout();
});

// ---- phone pairing -------------------------------------------------------------------

const pairCard = document.getElementById("pairCard");
const pairBtn = document.getElementById("pair");
let pairTimer = null;

function renderPairing(phone) {
  const pairing = phone && phone.pairing;
  pairBtn.classList.toggle("active", !!pairing);
  if (!pairing) {
    clearInterval(pairTimer);
    const img = document.getElementById("pairQr");
    if (img) img.remove();
    if (!pairCard.hidden) {
      pairCard.hidden = true;
      requestAnimationFrame(fitFlyout);
    }
    return;
  }
  const wasHidden = pairCard.hidden;
  pairCard.hidden = false;
  let img = document.getElementById("pairQr");
  if (!img) {
    img = document.createElement("img");
    img.id = "pairQr";
    img.alt = "Pairing QR code";
    img.width = 188;
    img.height = 188;
    pairCard.insertBefore(img, pairCard.firstChild);
  }
  if (img.dataset.link !== pairing.link) {
    img.src = pairing.qr || "";
    img.dataset.link = pairing.link;
  }
  document.getElementById("pairCode").textContent = pairing.code;
  const where = phone.addresses && phone.addresses.length
    ? phone.addresses.map((a) => `${a}:${phone.port}`).join("   ")
    : "No network address found";
  document.getElementById("pairAddress").textContent = where;
  const state = document.getElementById("pairState");
  state.textContent = phone.error || (phone.listening ? "" : "Starting…");
  state.hidden = !state.textContent;
  const tick = () => {
    const left = Math.max(0, pairing.expires_at - Date.now());
    document.getElementById("pairExpires").textContent = left
      ? `Works for ${Math.ceil(left / 60000)} more minute${left > 60000 ? "s" : ""}, for one phone.`
      : "This code has expired. Click Pair again for a new one.";
  };
  clearInterval(pairTimer);
  tick();
  pairTimer = setInterval(tick, 5000);
  if (wasHidden) requestAnimationFrame(fitFlyout);
}

pairBtn.addEventListener("click", async (e) => {
  e.stopPropagation();
  renderPairing(await window.usage.pairPhone());
});
document.getElementById("pairCancel").addEventListener("click", async (e) => {
  e.stopPropagation();
  renderPairing(await window.usage.cancelPair());
});
window.usage.onPairing(renderPairing);
window.usage.getPairing().then(renderPairing, () => {});
window.usage.onPrefs((prefs) => {
  if (!prefs) return;
  setAlertThreshold(prefs.alert_threshold);
  if (window.__last) render(window.__last);
});
window.usage.getPrefs().then((prefs) => prefs && setAlertThreshold(prefs.alert_threshold), () => {});
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
