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

bindDrag(bar, "button, .pct-icon, .net-chip, .session-chip");

let lastKey = "";

function chipValue(win) {
  return formatUsed(win);
}

// The chip shows the current window, but any other window at the warn threshold turns it red.
function blockingWindow(p, win) {
  if (!win) return null;
  if (alerting(win)) return win;
  return (p.windows || []).filter((w) => w.kind !== "credits" && alerting(w))
    .reduce((a, b) => (a && a.used_pct >= b.used_pct ? a : b), null);
}

// A forecast only while the reading is current and the time is still ahead.
function chipForecast(p, win) {
  return win && p.status?.state === "ok" && Date.parse(win.forecast_at) > Date.now() && Number.isFinite(win.used_pct) ? win.forecast_at : "";
}

// What one chip shows: its colour, number and tooltip. Two readings that look the same give
// the same view, so a forecast that moves by a few seconds does not touch the strip.
function chipView(p) {
  const win = UsageModels.currentWindow(p);
  const block = blockingWindow(p, win);
  const stale = p.status?.state === "stale";
  const cls = `pct-icon ${win ? (block ? "red" : "green") : "gray"}${stale ? " stale" : ""}`;
  const other = block && block !== win ? ` - ${block.label} ${chipValue(block)}` : "";
  const forecastAt = chipForecast(p, win);
  const pace = forecastAt ? ` - 100% around ${formatClock(forecastAt)} at this pace` : "";
  const title = `${p.display_name}${win ? ` - ${win.label}` : ""}${other}${stale ? " (stale)" : ""}${pace}`;
  return { id: p.id, cls, num: win ? chipValue(win) : "—", title };
}

function chipKey(snapshot) {
  const docked = bar.classList.contains("docked") ? "1" : "0";
  return docked + "|" + shownProviders(snapshot).map((p) => JSON.stringify(chipView(p))).join("|");
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

// The size last asked of the window. Every sample measures the strip, but the window is only
// resized (and re-docked) when the measurement changed; the values have fixed widths.
let askedSize = "";

function askSize(w, h) {
  const key = `${w}x${h}`;
  if (key === askedSize) return;
  askedSize = key;
  window.usage.resizeChips(w, h);
}

// The window is sized in 8px steps, so a value that grows by a character cannot move the docked
// strip; the spare pixels are transparent.
const WIDTH_STEP = 8;

function fitBar() {
  const w = Math.ceil(Math.max(bar.scrollWidth, bar.offsetWidth));
  const step = (px) => Math.ceil(px / WIDTH_STEP) * WIDTH_STEP;
  if (fillHeight) {
    // No transparent margin below the strip, so it sits flush with the taskbar edges.
    askSize(step(w + 2), fillHeight);
    return;
  }
  const h = Math.ceil(Math.max(bar.scrollHeight, bar.offsetHeight, 24));
  askSize(step(w + 4), h + 4);
}

function showLoading() {
  lastKey = "loading";
  root.innerHTML = `<div class="pct-icon gray loading-chip" title="Loading">loading…</div>`;
  requestAnimationFrame(fitBar);
}

// Settings: which chips to show and the "warn at" percentage.
let prefs = { alert_threshold: 80, chips_show: {}, display: {} };

// The strip follows the display order and hides plans hidden there, as the flyout does.
function shownProviders(snapshot) {
  const hidden = prefs.display.hidden || [];
  const order = prefs.display.order || [];
  const rank = (p) => order.indexOf(p.id === "x_subscription" ? "grok" : p.id);
  return (snapshot.providers || []).filter((p) => p.id === "x_subscription"
    ? ["grok", "cursor"].some((id) => prefs.chips_show[id] !== false && !hidden.includes(id))
    : prefs.chips_show[p.id] !== false && !hidden.includes(p.id))
    .sort((a, b) => rank(a) - rank(b));
}

function applyPrefs(next) {
  if (!next) return;
  prefs = { alert_threshold: next.alert_threshold, chips_show: next.chips_show || {}, display: next.display || {} };
  bar.classList.toggle("light", next.display?.theme === "light" || (next.display?.theme === "system" && !next.dark));
  renderBattery(lastBattery);
  setAlertThreshold(prefs.alert_threshold);
  lastKey = "";
  if (window.__last) render(window.__last);
  renderSystem(lastSystem);
  renderSessions(lastSessions);
}

function render(snapshot) {
  if (!snapshot || !(snapshot.providers || []).length) {
    showLoading();
    return;
  }
  const key = chipKey(snapshot);
  if (key === lastKey) return;
  lastKey = key;
  const views = shownProviders(snapshot).map(chipView);
  // The same plans in the same order: update the chips in place. Replacing them re-created
  // every element on each reading, which showed as a flicker on the strip.
  const existing = [...root.querySelectorAll(".pct-icon[data-id]")];
  const same = existing.length === views.length && existing.every((el, i) => el.dataset.id === views[i].id);
  if (!same) {
    root.innerHTML = views.map((v) => `<div class="pct-icon" data-id="${escapeHtml(v.id)}"><span class="who">${mark(v.id)}</span><span class="num"></span></div>`).join("");
    root.querySelectorAll(".pct-icon").forEach((el) => {
      el.addEventListener("click", () => window.usage.toggleFlyout());
      el.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        window.usage.openTrayMenu();
      });
    });
  }
  root.querySelectorAll(".pct-icon[data-id]").forEach((el, i) => {
    const v = views[i];
    if (el.className !== v.cls) el.className = v.cls;
    if (el.title !== v.title) el.title = v.title;
    const num = el.querySelector(".num");
    if (num.textContent !== v.num) num.textContent = v.num;
  });
  requestAnimationFrame(fitBar);
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

// ---- coding sessions chip ---------------------------------------------------------

const sessionChip = document.getElementById("sessionChip");
const SESSION_TOOLS = { claude: "Claude Code", codex: "Codex", grok: "Grok Build", gemini: "Gemini", cursor: "Cursor Agent", copilot: "Copilot CLI" };
let lastSessions = null;
let sessionSig = "";

function sessionTitle(s) {
  const reset = Date.parse(s.resets_at);
  const resume = {
    scheduled: () => `limit reached, resumes in ${formatEta(s.resume_at)}`,
    retrying: () => "limit reset, resuming",
    pending: () => "limit reset, meters still full",
    sent: () => "resumed",
    failed: () => "limit reset, couldn't type into the terminal",
  }[s.resume];
  const state = s.state === "working" ? "working" : s.state === "running" ? "running" : s.state !== "limited" ? "waiting for you"
    : !Number.isFinite(reset) ? "limit reached"
    : resume ? resume()
    : reset > Date.now() ? `limit reached, resets in ${formatEta(s.resets_at)}` : "limit reset, type continue to resume";
  return `${s.label || SESSION_TOOLS[s.tool] || s.tool} · ${s.name}: ${state}`;
}

// "1h05" / "42m": the strip has room for four characters.
function shortEta(at) {
  const mins = Math.max(0, Math.round((at - Date.now()) / 60000));
  if (mins >= 24 * 60) return `${Math.round(mins / 1440)}d`;
  return mins >= 60 ? `${Math.floor(mins / 60)}h${String(mins % 60).padStart(2, "0")}` : `${mins}m`;
}

function renderSessions(view) {
  lastSessions = view;
  const list = (view && view.sessions) || [];
  if (!list.length || prefs.chips_show.sessions === false) {
    if (!sessionChip.hidden) {
      sessionChip.hidden = true;
      sessionSig = "";
      requestAnimationFrame(fitBar);
    }
    return;
  }
  const stopped = list.filter((s) => s.state === "limited");
  const next = stopped.map((s) => Date.parse(s.resume === "scheduled" ? s.resume_at : s.resets_at)).filter((t) => t > Date.now()).sort((a, b) => a - b)[0];
  const working = list.filter((s) => s.state === "working").length;
  const lower = stopped.length ? `⏸ ${next ? shortEta(next) : stopped.length}` : `▶ ${working}`;
  const sig = `${list.length}|${lower}|${list.map(sessionTitle).join("\n")}`;
  if (sig === sessionSig) return;
  sessionSig = sig;
  sessionChip.hidden = false;
  sessionChip.classList.toggle("limited", stopped.length > 0);
  sessionChip.replaceChildren(netSpan("session-glyph", "›_"), netSpan("session-val", String(list.length)), netSpan("session-glyph", lower.slice(0, 1)), netSpan("session-val", lower.slice(2)));
  sessionChip.title = `${list.length} coding session${list.length === 1 ? "" : "s"}\n${list.map(sessionTitle).join("\n")}`;
  requestAnimationFrame(fitBar);
}

sessionChip.addEventListener("click", () => window.usage.toggleFlyout());
sessionChip.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  window.usage.openTrayMenu();
});
window.usage.onSessions(renderSessions);
window.usage.getSessions().then(renderSessions, () => {});

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
let lastSystem = {};
function renderSystem(data = {}) {
  lastSystem = data;
  const pct = (n) => Number.isFinite(n) && n >= 0 ? `${Math.round(Math.min(100, n))}%` : "—";
  const gb = (n) => `${(n / 1024 ** 3).toFixed(1)} GiB`;
  // "1.5M", "999K": at most four characters, so the disk column stays as narrow as a percentage.
  const compactRate = (value) => {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0.5) return "0";
    let v = n;
    let i = 0;
    while (v >= 999.5 && i < 4) {
      v /= 1024;
      i++;
    }
    return `${i === 0 || v >= 9.95 ? Math.round(v) : v.toFixed(1)}${["B", "K", "M", "G", "T"][i]}`;
  };
  const titles = {
    cpu: "CPU: total processor utilization",
    mem: "MEM: physical memory in use",
    gpu: "GPU: busiest GPU engine; — means the driver does not expose utilization",
    disk: data.diskRate != null ? `DISK: total read + write, ${NetFormat.formatRateShort(data.diskRate)}` : "DISK: busiest HDD/SSD active time",
    space: "SPACE: fullest mounted volume (storage used)",
  };
  // Only what changed is written: rewriting a tooltip on every sample hides and reshows it.
  const set = (el, prop, value) => {
    if (el[prop] !== value) el[prop] = value;
  };
  for (const [key] of systemFields) {
    const el = systemRoot.querySelector(`[data-metric="${key}"]`);
    set(el, "hidden", prefs.chips_show[key] === false || (key === "gpu" && data.gpuPresent !== true));
    set(el.querySelector(".system-value"), "textContent", key === "disk" && data.diskRate != null ? compactRate(data.diskRate) : pct(data[key]));
    el.classList.toggle("busy", Number.isFinite(data[key]) && data[key] >= 80);
    let title = titles[key];
    if (key === "disk") title += (data.disks || []).map((d) => `\n${d.name}: ${pct(d.busy)}`).join("");
    if (key === "space") title += (data.volumes || []).map((v) => `\n${v.name}: ${gb(v.used)} / ${gb(v.size)}`).join("");
    set(el, "title", title);
  }
  // With every metric turned off, the empty group would still take up space on the strip.
  set(systemRoot, "hidden", [...systemRoot.children].every((el) => el.hidden));
  requestAnimationFrame(fitBar);
}
renderSystem();
window.usage.onSystem(renderSystem);
window.usage.onPrefs(applyPrefs);
window.usage.getPrefs().then(applyPrefs, () => {});
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
  // The resume countdown on the sessions chip.
  if (lastSessions) renderSessions(lastSessions);
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

// "▲50m" while charging, "▼2h05" while discharging; Full, Plugged, "…" while estimating.
function shortBattery(r) {
  if (!r || r.percent == null || r.present !== true || r.state === "unknown") return "—";
  if (r.state === "full") return "Full";
  if (r.state === "plugged") return "Plugged";
  if (!Number.isFinite(r.seconds) || r.seconds < 0) return "…";
  const mins = Math.max(0, Math.round(r.seconds / 60));
  const eta = mins >= 24 * 60 ? `${Math.round(mins / 1440)}d` : mins >= 60 ? `${Math.floor(mins / 60)}h${String(mins % 60).padStart(2, "0")}` : `${mins}m`;
  return `${r.state === "charging" ? "▲" : "▼"}${eta}`;
}

// Battery is independent of the faster hardware sampler and remains available when chips hide.
let lastBattery = {};
function renderBattery(view = {}) {
  lastBattery = view;
  const r = view.latest;
  const el = document.getElementById("batteryChip");
  const set = (node, prop, value) => {
    if (node[prop] !== value) node[prop] = value;
  };
  set(el, "hidden", prefs.chips_show.battery === false || r?.present === false);
  // Two short lines: "⚡62%" over "▲50m" (to full) or "▼2h05" (left); the tooltip has the words.
  set(document.getElementById("batteryPct"), "textContent", `${r?.state === "charging" ? "⚡" : "▮"}${r?.percent != null ? Math.round(r.percent) + "%" : "—"}`);
  set(document.getElementById("batteryEta"), "textContent", shortBattery(r));
  set(el, "title", `Battery · ${BatteryModel.label(r)}${r ? " · Updated " + new Date(r.t).toLocaleTimeString() : ""}`);
  const aria = `${el.title}${r?.state === "discharging" && r.percent <= 20 ? " · Low battery" : ""}. Open battery details`;
  if (el.getAttribute("aria-label") !== aria) el.setAttribute("aria-label", aria);
  el.classList.toggle("low", r?.state === "discharging" && r.percent <= 20);
  el.classList.toggle("critical", r?.state === "discharging" && r.percent <= 10);
  requestAnimationFrame(fitBar);
}
document.getElementById("batteryChip").onclick = () => window.usage.openBattery();
window.usage.onBattery(renderBattery);
window.usage.getBattery().then(renderBattery, () => renderBattery());
