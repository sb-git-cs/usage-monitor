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

bindDrag(bar, "button, .pct-icon, .net-chip");

let lastKey = "";

function chipValue(win) {
  return Number.isFinite(win?.used_pct) ? `${Math.round(win.used_pct)}%` : "—";
}

function chipKey(snapshot) {
  const docked = bar.classList.contains("docked") ? "1" : "0";
  const parts = (snapshot.providers || []).map((p) => {
    const win = UsageModels.currentWindow(p);
    const num = chipValue(win);
    const cls = win ? (alerting(win) ? "red" : "green") : "gray";
    const state = (p.status && p.status.state) || "";
    return `${escapeHtml(p.id)}:${win?.kind || ""}:${win?.label || ""}:${cls}:${num}:${state}`;
  });
  return docked + "|" + parts.join("|");
}

// Taskbar height when docked on a horizontal taskbar; the strip then fills it exactly.
let fillHeight = 0;

function setFill(height) {
  const next = Number(height) > 0 ? Math.round(Number(height)) : 0;
  if (next === fillHeight) return;
  fillHeight = next;
  bar.classList.toggle("fill", fillHeight > 0);
  bar.classList.toggle("short", fillHeight > 0 && fillHeight < 40);
  if (fillHeight) bar.style.setProperty("--fill-h", `${fillHeight}px`);
  else bar.style.removeProperty("--fill-h");
  requestAnimationFrame(fitBar);
}

function fitBar() {
  bar.style.width = "max-content";
  const w = Math.ceil(Math.max(bar.scrollWidth, bar.offsetWidth));
  if (fillHeight) {
    // No transparent margin below the strip, so it sits flush with the taskbar edges.
    window.usage.resizeChips(w + 2, fillHeight);
    return;
  }
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
      num = chipValue(win);
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

// ---- network speed chip ----------------------------------------------------------

const netChip = document.getElementById("net");
const NET_IDLE = { setup_required: "set up", disabled: "off", not_running: "stopped", error: "stopped", starting: "…" };
let netSig = "";
let netWidth = 0;

function netSpan(className, text) {
  const span = document.createElement("span");
  span.className = className;
  span.textContent = text;
  return span;
}

function renderNet(summary) {
  if (!summary) {
    if (netChip.hidden) return;
    netChip.hidden = true;
    netSig = "";
    requestAnimationFrame(fitBar);
    return;
  }
  const running = summary.state === "running";
  const rx = NetFormat.formatRateShort(summary.rx_rate);
  const tx = NetFormat.formatRateShort(summary.tx_rate);
  const sig = running ? `run|${rx}|${tx}` : `idle|${summary.state}`;
  if (sig === netSig) return;
  const wasHidden = netChip.hidden;
  const wasRunning = netSig.startsWith("run|");
  netSig = sig;
  netChip.hidden = false;
  netChip.classList.toggle("idle", !running);
  if (running) {
    if (!wasRunning) {
      netChip.replaceChildren(netSpan("net-arrow rx", "↓"), netSpan("net-val", ""), netSpan("net-arrow tx", "↑"), netSpan("net-val", ""));
    }
    const [rxEl, txEl] = netChip.querySelectorAll(".net-val");
    rxEl.textContent = rx;
    txEl.textContent = tx;
    netChip.title = `Network: ${rx} down, ${tx} up. Click to open Network usage.`;
  } else {
    const label = NET_IDLE[summary.state] || "—";
    netChip.replaceChildren(netSpan("net-arrow", "⇅"), netSpan("net-idle", label));
    netChip.title = `Network: ${summary.message || label}. Click to open Network usage.`;
  }
  // Values have a fixed width, so the strip only resizes when the chip itself changes shape.
  const width = netChip.offsetWidth;
  if (wasHidden || width !== netWidth) {
    netWidth = width;
    requestAnimationFrame(fitBar);
  }
}

netChip.addEventListener("click", () => window.usage.openNetwork());
netChip.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  window.usage.openTrayMenu();
});
window.usage.onNet(renderNet);

// Fixed-width values prevent the widget from shifting with every hardware sample.
const systemRoot = document.getElementById("system");
const systemFields = [["cpu", "CPU"], ["mem", "MEM"], ["gpu", "GPU"], ["disk", "DISK"], ["space", "SPACE"]];
for (const [key, label] of systemFields) {
  const el = document.createElement("div");
  el.className = "system-chip";
  el.dataset.metric = key;
  el.append(netSpan("system-label", label), netSpan("system-value", "—"));
  systemRoot.append(el);
}
function renderSystem(data = {}) {
  const pct = (n) => Number.isFinite(n) && n >= 0 ? `${Math.round(Math.min(100, n))}%` : "—";
  const gb = (n) => `${(n / 1024 ** 3).toFixed(1)} GiB`;
  const titles = {
    cpu: "CPU: total processor utilization",
    mem: "MEM: physical memory in use",
    gpu: "GPU: busiest GPU engine; — means the driver does not expose utilization",
    disk: data.diskRate != null ? "DISK: total read + write throughput" : "DISK: busiest HDD/SSD active time",
    space: "SPACE: fullest mounted volume (storage used)",
  };
  for (const [key] of systemFields) {
    const el = systemRoot.querySelector(`[data-metric="${key}"]`);
    el.hidden = key === "gpu" && data.gpuPresent !== true;
    el.querySelector(".system-value").textContent = key === "disk" && data.diskRate != null ? NetFormat.formatRateShort(data.diskRate) : pct(data[key]);
    el.classList.toggle("busy", Number.isFinite(data[key]) && data[key] >= 80);
    el.title = titles[key];
    if (key === "disk") el.title += (data.disks || []).map((d) => `\n${d.name}: ${pct(d.busy)}`).join("");
    if (key === "space") el.title += (data.volumes || []).map((v) => `\n${v.name}: ${gb(v.used)} / ${gb(v.size)}`).join("");
  }
  requestAnimationFrame(fitBar);
}
renderSystem();
window.usage.onSystem(renderSystem);
systemRoot.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  window.usage.openTrayMenu();
});

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
window.usage.onChipsFill(setFill);
window.usage.getChipsDocked().then(setDocked);
