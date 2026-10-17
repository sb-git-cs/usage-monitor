const api = window.insightsApi;
const $ = (id) => document.getElementById(id);

const names = {
  claude: "Claude Code",
  codex: "Codex",
  gemini: "Gemini",
  grok: "Grok Build",
  cursor: "Cursor",
  copilot: "Copilot",
  x_subscription: "X Subscription",
};

let state = null;
let order = [];
let picked = "auto";
let showEvents = false;
let activeTab = "overview";
let hoverPoint = null;

function node(tag, text, className) {
  const el = document.createElement(tag);
  if (text != null) el.textContent = text;
  if (className) el.className = className;
  return el;
}

function value(id, next) {
  const el = $(id);
  if (el && document.activeElement !== el) el.value = next;
}

function message(result) {
  const el = $("message");
  if (!el) return;
  el.textContent = result?.error || (result?.ok ? "Saved successfully." : "");
  if (result?.error) {
    el.className = "msg-error";
  } else if (result?.ok) {
    el.className = "msg-success";
    setTimeout(() => { if (el.textContent === "Saved successfully.") el.textContent = ""; }, 4000);
  }
}

function formatTokens(n) {
  const num = Number(n) || 0;
  if (num >= 1e9) return `${(num / 1e9).toFixed(2)}B`;
  if (num >= 1e6) return `${(num / 1e6).toFixed(1)}M`;
  if (num >= 1e3) return `${(num / 1e3).toFixed(1)}K`;
  return num.toLocaleString();
}

const bytes = (n) => `${((Number(n) || 0) / 1e9).toFixed(2)} GB`;

function formatBurn(burn) {
  const b = Number(burn) || 0;
  const rounded = Math.abs(b) >= 10 ? Math.round(b) : Math.round(b * 10) / 10;
  return `${b > 0 ? "+" : ""}${rounded}%/h`;
}

function formatHours(h) {
  if (h == null || !Number.isFinite(h)) return "—";
  if (h < 1) return `< 1h (${Math.round(h * 60)}m)`;
  if (h < 24) return `~${(Math.round(h * 10) / 10)}h`;
  return `~${(Math.round((h / 24) * 10) / 10)} days`;
}

function seriesName(series, all = []) {
  const base = `${names[series.provider] || series.provider} · ${series.label}`;
  const shared = all.filter((other) => other.provider === series.provider && other.label === series.label).length > 1;
  return shared ? `${base} · ${String(series.account || "").slice(0, 4)}` : base;
}

function dayKey(t) {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function dayLabel(key) {
  return new Date(`${key}T12:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function byDay(points) {
  const map = new Map();
  for (const p of points) map.set(dayKey(p.t), p);
  return [...map.values()];
}

function heat(used) {
  return used >= 80 ? "hot" : used >= 50 ? "warm" : "cool";
}

function latestUsed(series) {
  return series.points?.at(-1)?.used ?? -1;
}

function plotted(series) {
  return $("viewMode")?.value === "daily" ? byDay(series.points) : series.points;
}

function resetAt(point) {
  const t = Date.parse(point?.reset);
  return Number.isFinite(t) && t > Date.now() ? t : null;
}

function resetLabel(t) {
  if (!t) return "None scheduled";
  const d = new Date(t);
  const opts = { hour: "numeric", minute: "2-digit" };
  if (d.toDateString() !== new Date().toDateString()) Object.assign(opts, { month: "short", day: "numeric" });
  return d.toLocaleString(undefined, opts);
}

function countdownLabel(t) {
  if (!t) return "";
  const diffMs = t - Date.now();
  if (diffMs <= 0) return "resets now";
  const diffMins = Math.round(diffMs / 60000);
  if (diffMins < 60) return `in ${diffMins}m`;
  const hours = Math.floor(diffMins / 60);
  const mins = diffMins % 60;
  if (hours < 24) return `in ${hours}h ${mins}m`;
  const days = Math.round((hours / 24) * 10) / 10;
  return `in ${days} days`;
}

function paceOf(series) {
  const pts = series.points;
  if (!pts || pts.length < 2) return null;
  const hours = (pts.at(-1).t - pts[0].t) / 3600000;
  if (hours < 0.25) return null;
  return (pts.at(-1).used - pts[0].used) / hours;
}

function deltaText(points) {
  if (!points || points.length < 2) return "";
  const delta = points.at(-1).used - points[0].used;
  const hours = (points.at(-1).t - points[0].t) / 3600000;
  if (hours >= 0.25 && delta < -0.5) return `down ${Math.abs(Math.round(delta))} pts`;
  if (Math.round(delta) === 0) return "flat";
  return `${delta > 0 ? "+" : ""}${Math.round(delta)} pts`;
}

function untilFull(points) {
  if (!points || points.length < 2) return "";
  const last = points.at(-1);
  const hours = (last.t - points[0].t) / 3600000;
  if (hours < 0.25 || last.used >= 100) return "";
  const burn = (last.used - points[0].used) / hours;
  if (burn <= 0.5) return "";
  const left = (100 - last.used) / burn;
  return left < 1 ? "<1h to limit" : `~${Math.round(left)}h to limit`;
}

function fact(label, text, subtext = "") {
  const card = node("div", null, "kpi-card");
  card.append(node("span", label, "kpi-label"), node("strong", text, "kpi-value"));
  if (subtext) card.append(node("p", subtext, "kpi-sub"));
  return card;
}

// ---------------- CHART RENDERING ----------------
function chart(canvas, points) {
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const displayWidth = Math.max(320, Math.round(rect.width || canvas.clientWidth || 600));
  const displayHeight = 220;

  canvas.width = displayWidth * dpr;
  canvas.height = displayHeight * dpr;

  const c = canvas.getContext("2d");
  c.scale(dpr, dpr);

  const style = getComputedStyle(document.body);
  const muted = style.getPropertyValue("--muted").trim() || "#94a3b8";
  const accent = style.getPropertyValue("--accent").trim() || "#38bdf8";
  const border = style.getPropertyValue("--border").trim() || "#334155";

  const left = 48;
  const right = displayWidth - 16;
  const top = 16;
  const bottom = displayHeight - 28;

  const yOf = (used) => bottom - (Math.min(100, Math.max(0, used)) / 100) * (bottom - top);

  c.clearRect(0, 0, displayWidth, displayHeight);

  // Background Grid Lines
  c.font = "11px 'Segoe UI', system-ui, sans-serif";
  c.textBaseline = "middle";
  c.lineWidth = 1;

  for (const pct of [0, 50, 100]) {
    const y = yOf(pct);
    c.strokeStyle = border;
    c.globalAlpha = 0.5;
    c.beginPath();
    c.moveTo(left, y);
    c.lineTo(right, y);
    c.stroke();

    c.globalAlpha = 1;
    c.fillStyle = muted;
    c.textAlign = "right";
    c.fillText(`${pct}%`, left - 8, y);
  }

  // 80% Alert Threshold Line
  c.strokeStyle = "#ef4444";
  c.fillStyle = "#ef4444";
  c.globalAlpha = 0.7;
  c.setLineDash([4, 4]);
  c.beginPath();
  c.moveTo(left, yOf(80));
  c.lineTo(right, yOf(80));
  c.stroke();
  c.setLineDash([]);
  c.fillText("80%", left - 8, yOf(80));
  c.globalAlpha = 1;

  if (!points.length) {
    c.fillStyle = muted;
    c.textAlign = "center";
    c.font = "13px 'Segoe UI', system-ui, sans-serif";
    c.fillText("No usage readings in this period.", displayWidth / 2, displayHeight / 2);
    return;
  }

  const from = points[0].t;
  const span = Math.max(1, points.at(-1).t - from);
  const xOf = (t) => (span ? left + ((t - from) / span) * (right - left) : (left + right) / 2);

  // Gradient area under curve
  const grad = c.createLinearGradient(0, top, 0, bottom);
  grad.addColorStop(0, "rgba(56, 189, 248, 0.35)");
  grad.addColorStop(1, "rgba(56, 189, 248, 0.02)");

  c.beginPath();
  points.forEach((p, i) => {
    const x = xOf(p.t);
    const y = yOf(p.used);
    if (i === 0) c.moveTo(x, y);
    else c.lineTo(x, y);
  });
  c.lineTo(xOf(points.at(-1).t), bottom);
  c.lineTo(xOf(points[0].t), bottom);
  c.closePath();
  c.fillStyle = grad;
  c.fill();

  // Primary curve line
  c.beginPath();
  points.forEach((p, i) => {
    const x = xOf(p.t);
    const y = yOf(p.used);
    if (i === 0) c.moveTo(x, y);
    else c.lineTo(x, y);
  });
  c.strokeStyle = accent;
  c.lineWidth = 2.5;
  c.stroke();

  // Draw points if reasonable count
  if (points.length <= 60) {
    for (const p of points) {
      c.fillStyle = accent;
      c.beginPath();
      c.arc(xOf(p.t), yOf(p.used), 3.5, 0, Math.PI * 2);
      c.fill();
    }
  }

  // Hover crosshair and point
  if (hoverPoint) {
    const hx = xOf(hoverPoint.t);
    const hy = yOf(hoverPoint.used);

    c.strokeStyle = muted;
    c.lineWidth = 1;
    c.setLineDash([3, 3]);
    c.beginPath();
    c.moveTo(hx, top);
    c.lineTo(hx, bottom);
    c.stroke();
    c.setLineDash([]);

    c.fillStyle = "#ffffff";
    c.beginPath();
    c.arc(hx, hy, 5, 0, Math.PI * 2);
    c.fill();
    c.strokeStyle = accent;
    c.lineWidth = 2.5;
    c.stroke();
  }

  // Time Axis Ticks
  c.fillStyle = muted;
  c.font = "10px 'Segoe UI', system-ui, sans-serif";
  c.textAlign = "center";
  c.textBaseline = "alphabetic";

  const ticks = [points[0], points[Math.floor((points.length - 1) / 2)], points.at(-1)];
  const seenLabels = new Set();
  for (const p of ticks) {
    const label = new Date(p.t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
    if (seenLabels.has(label)) continue;
    seenLabels.add(label);
    const tx = Math.min(right - 24, Math.max(left + 24, xOf(p.t)));
    c.fillText(label, tx, displayHeight - 8);
  }
}

// ---------------- TAB SWITCHING ----------------
function setupTabs() {
  const tabs = document.querySelectorAll(".nav-tab");
  tabs.forEach((tab) => {
    tab.onclick = () => {
      const target = tab.dataset.tab;
      activeTab = target;
      tabs.forEach((t) => {
        const isMatch = t.dataset.tab === target;
        t.classList.toggle("active", isMatch);
        t.setAttribute("aria-selected", isMatch ? "true" : "false");
      });
      document.querySelectorAll(".tab-panel").forEach((panel) => {
        panel.classList.toggle("active", panel.id === `tab-${target}`);
      });
      if (state && target === "usage") {
        setTimeout(() => renderHistory(state), 20);
      }
    };
  });
}

// ---------------- RENDERERS ----------------
function renderHealthHero(health) {
  const score = health?.score ?? 100;
  const grade = health?.grade || "A";
  const label = health?.label || "Optimal";

  const badge = $("globalHealthBadge");
  if (badge) {
    badge.className = `health-pill grade-${grade.toLowerCase()}`;
    $("healthScoreText").textContent = `${label} · ${score}/100`;
  }

  if ($("heroHealthGrade")) {
    $("heroHealthGrade").textContent = `Grade ${grade}`;
    $("heroHealthGrade").className = `grade-badge grade-${grade.toLowerCase()}`;
  }
  if ($("heroHealthScore")) $("heroHealthScore").textContent = String(score);
  if ($("heroHealthDesc")) {
    const desc = score >= 90
      ? "All monitored quota windows are operating comfortably within scheduled reset allowances."
      : score >= 75
      ? "Most windows are sustainable, but one or more are experiencing elevated usage."
      : score >= 50
      ? "Attention required: rapid consumption or quota nearing exhaustion on active models."
      : "Critical: active quotas exhausted or overburning ahead of reset window.";
    $("heroHealthDesc").textContent = desc;
  }

  const recsContainer = $("recommendationsList");
  if (recsContainer) {
    recsContainer.replaceChildren();
    for (const rec of health?.recommendations || []) {
      const item = node("div", null, `rec-item ${rec.type}`);
      const icon = rec.type === "danger" ? "🚨" : rec.type === "warning" ? "⚠️" : rec.type === "info" ? "💡" : "✅";
      item.append(node("span", icon, "rec-icon"), node("strong", rec.title, "rec-title"), node("p", rec.body, "rec-body"));
      recsContainer.append(item);
    }
  }
}

function renderSummary(s) {
  const ranked = [...(s.series || [])].sort((a, b) => latestUsed(b) - latestUsed(a));
  const top = ranked[0];
  const burns = ranked.map((series) => ({ series, burn: paceOf(series) })).filter((r) => r.burn != null).sort((a, b) => b.burn - a.burn);
  const resets = ranked.map((series) => resetAt(series.points?.at(-1))).filter(Boolean).sort((a, b) => a - b);

  let paceText = "Steady pace";
  let paceSub = "Consumption within limits";
  if (burns[0]?.burn > 0.5) {
    const who = seriesName(burns[0].series, ranked);
    paceText = `${who} · ${formatBurn(burns[0].burn)}`;
    paceSub = "Fastest rising window";
  } else if (burns.at(-1)?.burn < -0.5) {
    const row = burns.at(-1);
    paceText = `${seriesName(row.series, ranked)} · ${formatBurn(row.burn)}`;
    paceSub = "Cooling down";
  }

  const tokenSummary = s.tokens?.summary;
  const tokenFormatted = tokenSummary?.total ? formatTokens(tokenSummary.total) : "No data";
  const tokenSub = tokenSummary?.cache_efficiency_pct ? `${tokenSummary.cache_efficiency_pct}% cache hit rate` : "Token readings";

  const nextResetText = resets.length ? resetLabel(resets[0]) : "None scheduled";
  const nextResetSub = resets.length ? countdownLabel(resets[0]) : "Safe runway";

  const summaryEl = $("summary");
  if (summaryEl) {
    summaryEl.replaceChildren(
      fact("Fullest Window", top ? `${Math.round(latestUsed(top))}%` : "No readings", top ? seriesName(top, ranked) : "All idle"),
      fact("Burn Pace", paceText, paceSub),
      fact("Next Reset", nextResetText, nextResetSub),
      fact("Token Volume", tokenFormatted, tokenSub),
      fact("Network Traffic", bytes(s.budget?.used || 0), s.budget?.limit ? `Limit: ${bytes(s.budget.limit)}` : "No limit set"),
      fact("Audit Events", s.events?.length ? `${s.events.length} logged` : "None", s.snooze_until > Date.now() ? "Alerts snoozed" : "Alerts active")
    );
  }
}

function renderQuotaMatrix(s) {
  const matrix = $("quotaMatrix");
  if (!matrix) return;
  matrix.replaceChildren();

  const burnMap = new Map((s.burn || []).map((w) => [w.id, w]));
  const list = [...(s.series || [])].sort((a, b) => latestUsed(b) - latestUsed(a));

  if (!list.length) {
    matrix.append(node("p", "No active quota series recorded yet. Start using a CLI tool to see live readings.", "empty-state"));
    return;
  }

  for (const series of list) {
    const w = burnMap.get(series.id);
    const last = series.points?.at(-1);
    const used = last ? Math.round(last.used) : 0;
    const card = node("div", null, `quota-card ${heat(used)}`);

    const header = node("div", null, "quota-card-head");
    header.append(
      node("strong", seriesName(series, list), "quota-name"),
      node("span", `${used}%`, `heat-badge ${heat(used)}`)
    );

    const meter = node("div", null, "meter-bar");
    const fill = node("div", null, `meter-fill ${heat(used)}`);
    fill.style.width = `${Math.min(100, Math.max(0, used))}%`;
    meter.append(fill);

    const footer = node("div", null, "quota-card-foot");
    const burnLabel = w ? `${formatBurn(w.burn_rate)}` : deltaText(series.points);
    const resetInfo = resetAt(last) ? countdownLabel(resetAt(last)) : "No reset scheduled";
    footer.append(
      node("span", `Burn: ${burnLabel}`, "quota-foot-item"),
      node("span", resetInfo, "quota-foot-item")
    );

    card.append(header, meter, footer);
    matrix.append(card);
  }
}

function renderHistory(s) {
  const ranked = [...(s.series || [])].sort((a, b) => latestUsed(b) - latestUsed(a) || seriesName(a, s.series).localeCompare(seriesName(b, s.series)));
  if (picked !== "auto" && !ranked.some((series) => series.id === picked)) picked = "auto";

  const model = $("model");
  if (model) {
    const current = model.value;
    const focused = document.activeElement === model;
    model.replaceChildren(new Option("Fullest window", "auto"));
    for (const series of ranked) model.append(new Option(seriesName(series, ranked), series.id));
    const prefer = focused ? current : picked;
    model.value = [...model.options].some((o) => o.value === prefer) ? prefer : "auto";
  }

  const focus = (picked === "auto" ? ranked[0] : ranked.find((series) => series.id === picked)) || null;
  const points = focus ? plotted(focus) : [];
  const daily = $("viewMode")?.value === "daily";

  if ($("trendTitle")) $("trendTitle").textContent = focus ? seriesName(focus, ranked) : "Usage Trajectory";
  const meta = [
    daily ? "Daily Maximums" : "Sample Readings",
    points.length ? `${Math.round(points.at(-1).used)}% current` : "",
    deltaText(points),
    untilFull(points),
    resetAt(points.at(-1)) ? `resets ${resetLabel(resetAt(points.at(-1)))}` : "",
  ].filter(Boolean);
  if ($("trendMeta")) $("trendMeta").textContent = meta.join(" · ");

  const canvas = $("trend");
  if (canvas) {
    canvas.setAttribute("aria-label", points.length ? `${$("trendTitle")?.textContent}: ${Math.round(points[0].used)}% to ${Math.round(points.at(-1).used)}%` : "No usage history in this period");
    chart(canvas, points);
  }

  const history = $("history");
  if (history) {
    history.replaceChildren();
    if (!ranked.length) {
      history.append(node("p", "No observations in this period yet.", "empty-state"));
      if ($("historyNote")) $("historyNote").textContent = "";
      return;
    }

    for (const series of ranked) {
      const isSelected = series.id === focus?.id;
      const row = node("button", null, isSelected ? "usage-row selected" : "usage-row");
      row.type = "button";
      row.onclick = () => {
        picked = series.id;
        renderHistory(state);
      };

      const last = series.points?.at(-1);
      const usedPct = last ? Math.round(last.used) : 0;
      const who = node("span", seriesName(series, ranked), "who");
      const pill = node("span", `${usedPct}%`, `heat ${heat(usedPct)}`);
      const info = [deltaText(series.points), resetAt(last) ? `resets ${resetLabel(resetAt(last))}` : ""].filter(Boolean).join(" · ");
      const metaEl = node("span", info, "row-meta");

      const strip = node("span", null, "strip");
      for (const p of byDay(series.points).slice(-7)) {
        const cell = node("i", "", heat(p.used));
        cell.title = `${dayLabel(dayKey(p.t))}: ${Math.round(p.used)}%`;
        strip.append(cell);
      }

      row.append(who, pill, metaEl, strip);
      history.append(row);
    }
    if ($("historyNote")) $("historyNote").textContent = "Each bar in the strip is the last reading that day. Select a row to chart its trajectory.";
  }

  // Peak Hours Chart
  renderPeakHours(s);
}

function renderPeakHours(s) {
  const container = $("peakHoursChart");
  if (!container) return;
  container.replaceChildren();

  const hourly = s.tokens?.hourly || Array.from({ length: 24 }, (_, i) => ({ hour: i, tokens: 0, turns: 0 }));
  const maxTokens = Math.max(1, ...hourly.map((h) => h.tokens || h.turns || 0));

  for (const h of hourly) {
    const val = h.tokens || h.turns || 0;
    const pct = Math.round((val / maxTokens) * 100);
    const col = node("div", null, "hourly-col");
    const barWrapper = node("div", null, "hourly-bar-wrap");
    const bar = node("div", null, "hourly-bar");
    bar.style.height = `${Math.max(4, pct)}%`;
    if (pct >= 75) bar.classList.add("peak");

    barWrapper.append(bar);
    const label = node("span", `${h.hour}`, "hourly-label");
    col.title = `${h.hour}:00 - ${h.tokens ? formatTokens(h.tokens) : `${h.turns} turns`}`;
    col.append(barWrapper, label);
    container.append(col);
  }
}

function renderBurnAnalysis(s) {
  const burnList = s.burn || [];
  const paceCards = $("burnPaceCards");
  if (paceCards) {
    paceCards.replaceChildren();
    const highestBurn = [...burnList].sort((a, b) => b.burn_rate - a.burn_rate)[0];
    const atRiskCount = burnList.filter((w) => w.status === "critical" || w.status === "exhausted").length;

    paceCards.append(
      fact("Fastest Burn Rate", highestBurn ? `${formatBurn(highestBurn.burn_rate)}` : "0%/h", highestBurn ? `${names[highestBurn.provider] || highestBurn.provider} · ${highestBurn.label}` : "All idle"),
      fact("At-Risk Quotas", String(atRiskCount), atRiskCount ? "Projected to exhaust before reset" : "All quotas sustainable"),
      fact("Safe Burn Target", highestBurn?.safe_rate != null ? `${highestBurn.safe_rate}%/h` : "Unlimited", "Pace to survive until next reset"),
      fact("Longest Runway", burnList.length ? `${formatHours(burnList[0]?.runway_hours)}` : "—", "Estimated time until 100% capacity")
    );
  }

  const tbody = $("burnTableBody");
  if (tbody) {
    tbody.replaceChildren();
    if (!burnList.length) {
      const tr = node("tr");
      const td = node("td", "No active quota windows found to analyze burn rate.", "empty-cell");
      td.colSpan = 7;
      tr.append(td);
      tbody.append(tr);
      return;
    }

    for (const w of burnList) {
      const tr = node("tr");
      const prov = node("td");
      prov.append(node("strong", `${names[w.provider] || w.provider}`), node("span", ` (${w.label})`, "fine"));

      const usedTd = node("td");
      usedTd.append(node("span", `${Math.round(w.used)}%`, `heat-badge ${heat(w.used)}`));

      const burnTd = node("td", formatBurn(w.burn_rate));
      if (w.burn_rate > 5) burnTd.classList.add("text-danger");

      const safeTd = node("td", w.safe_rate != null ? `${w.safe_rate}%/h` : "—");
      const runwayTd = node("td", w.runway_hours != null ? formatHours(w.runway_hours) : "Sustainable");
      if (w.will_exhaust) runwayTd.classList.add("text-danger");

      const resetTd = node("td", w.resets_at ? `${countdownLabel(Date.parse(w.resets_at))}` : "None");
      if (w.resets_at) resetTd.title = new Date(w.resets_at).toLocaleString();

      const statusBadge = node("span", w.status.toUpperCase(), `badge badge-${w.status}`);
      const statusTd = node("td");
      statusTd.append(statusBadge);

      tr.append(prov, usedTd, burnTd, safeTd, runwayTd, resetTd, statusTd);
      tbody.append(tr);
    }
  }
}

function renderTokenIntelligence(tokens) {
  const kpiGrid = $("tokenKpiGrid");
  if (kpiGrid) {
    kpiGrid.replaceChildren();
    const sm = tokens?.summary || { total: 0, input: 0, output: 0, cache_read: 0, cache_write: 0, reasoning: 0, turns: 0, cache_efficiency_pct: 0, avg_turn_tokens: 0 };
    kpiGrid.append(
      fact("Total Tokens", formatTokens(sm.total), `${sm.turns.toLocaleString()} interactive turns`),
      fact("Cache Hit Efficiency", `${sm.cache_efficiency_pct}%`, `${formatTokens(sm.cache_read)} tokens served from cache`),
      fact("Prompt vs Completion", `${formatTokens(sm.input)} / ${formatTokens(sm.output)}`, `Input / Output ratio: ${(sm.output ? (sm.input / sm.output).toFixed(1) : 0)}:1`),
      fact("Reasoning Tokens", formatTokens(sm.reasoning), "Deep thinking / chain-of-thought"),
      fact("Avg Tokens / Turn", sm.avg_turn_tokens.toLocaleString(), "Average payload density"),
      fact("Cache Write Tokens", formatTokens(sm.cache_write), "Context checkpoint writes")
    );
  }

  // Model Distribution
  const modelList = $("modelDistributionList");
  if (modelList) {
    modelList.replaceChildren();
    const models = tokens?.by_model || [];
    if (!models.length) {
      modelList.append(node("p", "No token data recorded for models in this period.", "empty-state"));
    } else {
      for (const m of models.slice(0, 6)) {
        const row = node("div", null, "model-row");
        const head = node("div", null, "model-row-head");
        head.append(node("strong", m.model), node("span", `${formatTokens(m.total)} (${m.pct}%)`));
        const barWrap = node("div", null, "model-bar-wrap");
        const barFill = node("div", null, "model-bar-fill");
        barFill.style.width = `${Math.min(100, m.pct)}%`;
        barWrap.append(barFill);
        row.append(head, barWrap);
        modelList.append(row);
      }
    }
  }

  // Token Composition
  const comp = $("tokenComposition");
  if (comp) {
    comp.replaceChildren();
    const sm = tokens?.summary;
    if (!sm || !sm.total) {
      comp.append(node("p", "No token composition data available.", "empty-state"));
    } else {
      const items = [
        { label: "Cache Read", count: sm.cache_read, color: "var(--accent)" },
        { label: "Prompt Input", count: sm.input, color: "#10b981" },
        { label: "Output Completion", count: sm.output, color: "#f59e0b" },
        { label: "Reasoning", count: sm.reasoning, color: "#8b5cf6" },
      ];
      for (const it of items) {
        const pct = sm.total > 0 ? ((it.count / sm.total) * 100).toFixed(1) : 0;
        const row = node("div", null, "comp-row");
        const dot = node("span", "", "comp-dot");
        dot.style.background = it.color;
        const label = node("span", `${it.label}: `, "comp-label");
        const val = node("strong", `${formatTokens(it.count)} (${pct}%)`);
        row.append(dot, label, val);
        comp.append(row);
      }
    }
  }

  // Daily Token Trend
  const dailyBars = $("dailyTokenBars");
  if (dailyBars) {
    dailyBars.replaceChildren();
    const days = tokens?.daily || [];
    if (!days.length) {
      dailyBars.append(node("p", "No daily token records available.", "empty-state"));
    } else {
      const maxTokens = Math.max(1, ...days.map((d) => d.total));
      for (const d of days.slice(-14)) {
        const pct = Math.round((d.total / maxTokens) * 100);
        const col = node("div", null, "daily-col");
        const barWrap = node("div", null, "daily-bar-wrap");
        const bar = node("div", null, "daily-bar");
        bar.style.height = `${Math.max(4, pct)}%`;
        barWrap.append(bar);
        const label = node("span", d.label, "daily-label");
        col.title = `${d.date}: ${formatTokens(d.total)} tokens (${d.turns} turns)`;
        col.append(barWrap, label);
        dailyBars.append(col);
      }
    }
  }
}

function renderEvents(events = []) {
  const container = $("events");
  if (!container) return;
  container.replaceChildren();

  if (!events.length) {
    container.append(node("p", "No quota warnings or audit events logged.", "empty-state"));
    return;
  }

  const list = showEvents ? events : events.slice(-6);
  const hidden = events.length - list.length;

  if (hidden > 0) {
    const more = node("button", `Show ${hidden} earlier events`, "btn btn-secondary btn-sm mb-md");
    more.type = "button";
    more.onclick = () => {
      showEvents = true;
      renderEvents(state.events);
    };
    container.append(more);
  } else if (showEvents && events.length > 6) {
    const less = node("button", "Show recent events only", "btn btn-secondary btn-sm mb-md");
    less.type = "button";
    less.onclick = () => {
      showEvents = false;
      renderEvents(state.events);
    };
    container.append(less);
  }

  for (const e of list) {
    const row = node("div", null, "event-card");
    const head = node("div", null, "event-head");
    head.append(
      node("strong", e.title, "event-title"),
      node("span", `${new Date(e.at).toLocaleString()} · ${e.delivery === "requested" ? "Delivered" : e.delivery}`, "meta")
    );
    row.append(head, node("p", e.body, "event-body"));
    container.append(row);
  }
}

function renderNetworkBudget(s) {
  value("limit", s.budget.limit ? s.budget.limit / 1e9 : "");
  value("day", s.budget.day || 1);

  const stats = $("budgetStats");
  if (stats) {
    stats.replaceChildren();
    for (const [label, amount] of [
      ["Captured this cycle", bytes(s.budget.used)],
      ["Configured allowance", s.budget.limit ? bytes(s.budget.limit) : "No limit set"],
      ["Projected cycle pace", s.budget.projected == null ? "Needs 24h of traffic" : bytes(s.budget.projected)],
    ]) {
      const item = fact(label, amount);
      stats.append(item);
    }
  }

  const progressWrap = $("budgetProgressWrapper");
  if (progressWrap && s.budget.limit > 0) {
    progressWrap.replaceChildren();
    const pct = Math.min(100, Math.round((s.budget.used / s.budget.limit) * 100));
    const labelRow = node("div", null, "progress-label-row");
    labelRow.append(
      node("span", `Cycle Progress: ${pct}% used`),
      node("span", `${bytes(s.budget.used)} of ${bytes(s.budget.limit)}`)
    );
    const bar = node("div", null, "meter-bar");
    const fill = node("div", null, `meter-fill ${pct >= 85 ? "hot" : pct >= 65 ? "warm" : "cool"}`);
    fill.style.width = `${pct}%`;
    bar.append(fill);
    progressWrap.append(labelRow, bar);
  } else if (progressWrap) {
    progressWrap.replaceChildren();
  }

  if ($("budgetNote")) {
    $("budgetNote").textContent = `Billing cycle: ${new Date(s.budget.start).toLocaleDateString()} – ${new Date(s.budget.end).toLocaleDateString()}. Monitoring began ${new Date(s.budget.observedSince).toLocaleDateString()}.`;
  }
}

function renderDiagnostics(s) {
  const diagContainer = $("diagnostics");
  if (!diagContainer) return;
  diagContainer.replaceChildren();

  const diag = s.diagnostics;
  const sysInfo = node("p", `Storage Engine: ${diag.storage} · Network Monitor: ${diag.network.state} (${diag.network.coverage})`, "fine mb-md");
  diagContainer.append(sysInfo);

  for (const p of diag.providers) {
    const row = node("div", null, "diagnostic-row");
    const info = node("div", null, "diag-info");
    info.append(
      node("strong", names[p.id] || p.id),
      node("span", ` · State: ${p.state} · Last Success: ${p.last_success ? new Date(p.last_success).toLocaleString() : "None"}`, "fine")
    );
    const login = node("button", "Sign-in / Reconnect", "btn btn-secondary btn-sm");
    login.type = "button";
    login.onclick = async () => {
      const r = await api.action("login", p.id);
      message(r);
    };
    row.append(info, login);
    diagContainer.append(row);
  }
}

function renderProviders(hidden = []) {
  const container = $("providers");
  if (!container) return;
  container.replaceChildren();

  order.forEach((id, index) => {
    const row = node("div", null, "provider-row");
    const label = node("label", null, "provider-label");
    const check = node("input");
    check.type = "checkbox";
    check.dataset.id = id;
    check.checked = !hidden.includes(id);

    label.append(check, node("span", names[id] || id));

    const up = node("button", "Move up", "btn btn-ghost btn-sm");
    up.type = "button";
    up.disabled = !index;
    up.onclick = () => {
      if ($("displayForm")) $("displayForm").dataset.dirty = "true";
      const hiddenNow = [...container.querySelectorAll("input")].filter((e) => !e.checked).map((e) => e.dataset.id);
      [order[index - 1], order[index]] = [order[index], order[index - 1]];
      renderProviders(hiddenNow);
    };

    row.append(label, up);
    container.append(row);
  });
}

function render(s) {
  state = s;
  const light = s.display.theme === "light" || (s.display.theme === "system" && !s.dark);
  document.body.classList.toggle("light", light);
  document.body.style.fontSize = `${14 * (s.display.scale || 100) / 100}px`;

  renderHealthHero(s.health);
  renderSummary(s);
  renderQuotaMatrix(s);
  renderHistory(s);
  renderBurnAnalysis(s);
  renderTokenIntelligence(s.tokens);
  renderNetworkBudget(s);
  renderEvents(s.events);
  renderDiagnostics(s);

  if ($("snoozeState")) {
    $("snoozeState").textContent = s.snooze_until > Date.now()
      ? `Alert notifications snoozed until ${new Date(s.snooze_until).toLocaleTimeString()}. Metrics are still actively recorded.`
      : "Alert notifications active.";
  }

  const dispForm = $("displayForm");
  if (dispForm && !dispForm.contains(document.activeElement) && !dispForm.dataset.dirty) {
    value("theme", s.display.theme);
    value("scale", s.display.scale);
    if ($("compact")) $("compact").checked = !!s.display.compact;
    order = [...(s.display.order || [])];
    renderProviders(s.display.hidden);
  }
}

// ---------------- CANVAS INTERACTION ----------------
function setupCanvasInteractions() {
  const canvas = $("trend");
  const tooltip = $("chartTooltip");
  if (!canvas || !tooltip) return;

  canvas.onmousemove = (e) => {
    if (!state) return;
    const ranked = [...(state.series || [])].sort((a, b) => latestUsed(b) - latestUsed(a));
    const focus = (picked === "auto" ? ranked[0] : ranked.find((series) => series.id === picked)) || null;
    const points = focus ? plotted(focus) : [];
    if (!points.length) return;

    const rect = canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const left = 48;
    const right = rect.width - 16;
    const span = Math.max(1, points.at(-1).t - points[0].t);

    const from = points[0].t;
    let closest = points[0];
    let minDist = Infinity;

    for (const p of points) {
      const px = left + ((p.t - from) / span) * (right - left);
      const dist = Math.abs(px - mouseX);
      if (dist < minDist) {
        minDist = dist;
        closest = p;
      }
    }

    hoverPoint = closest;
    chart(canvas, points);

    tooltip.hidden = false;
    tooltip.style.left = `${Math.min(rect.width - 140, Math.max(10, mouseX - 60))}px`;
    tooltip.style.top = `${Math.max(10, e.clientY - rect.top - 50)}px`;
    tooltip.innerHTML = `<strong>${Math.round(closest.used)}%</strong> · ${new Date(closest.t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}<br><span class="fine">${new Date(closest.t).toLocaleDateString([], { month: "short", day: "numeric" })}</span>`;
  };

  canvas.onmouseleave = () => {
    hoverPoint = null;
    tooltip.hidden = true;
    if (state) {
      const ranked = [...(state.series || [])].sort((a, b) => latestUsed(b) - latestUsed(a));
      const focus = (picked === "auto" ? ranked[0] : ranked.find((series) => series.id === picked)) || null;
      chart(canvas, focus ? plotted(focus) : []);
    }
  };
}

// ---------------- LOAD & EVENT BINDINGS ----------------
async function load() {
  try {
    const s = await api.get(Number($("period")?.value || 7));
    if (s) render(s);
  } catch {
    message({ error: "Could not refresh insights. Please try again." });
  }
}

setupTabs();
setupCanvasInteractions();

if ($("period")) $("period").onchange = load;
if ($("model")) $("model").onchange = () => { picked = $("model").value; if (state) renderHistory(state); };
if ($("viewMode")) $("viewMode").onchange = () => { if (state) renderHistory(state); };
if ($("displayForm")) $("displayForm").onchange = () => { $("displayForm").dataset.dirty = "true"; };

if ($("snooze")) {
  $("snooze").onchange = async () => {
    message(await api.action("snooze", Number($("snooze").value)));
    await load();
  };
}

if ($("budgetForm")) {
  $("budgetForm").onsubmit = async (e) => {
    e.preventDefault();
    message(await api.action("budget", {
      limit: Number($("limit").value) * 1e9,
      day: Number($("day").value),
    }));
    await load();
  };
}

if ($("displayForm")) {
  $("displayForm").onsubmit = async (e) => {
    e.preventDefault();
    const hidden = [...$("providers").querySelectorAll("input")].filter((el) => !el.checked).map((el) => el.dataset.id);
    const result = await api.action("display", {
      theme: $("theme").value,
      scale: Number($("scale").value),
      compact: $("compact").checked,
      order,
      hidden,
    });
    message(result);
    if (result?.ok && $("displayForm")) delete $("displayForm").dataset.dirty;
    await load();
  };
}

if ($("refresh")) $("refresh").onclick = () => api.action("retry");
if ($("network")) $("network").onclick = () => api.action("network");

if ($("csv")) $("csv").onclick = async () => message(await api.export("csv", Number($("period")?.value || 7)));
if ($("json")) $("json").onclick = async () => message(await api.export("json", Number($("period")?.value || 7)));
if ($("reportExport")) $("reportExport").onclick = async () => message(await api.export("report", Number($("period")?.value || 7)));
if ($("support")) $("support").onclick = async () => message(await api.export("diagnostics", Number($("period")?.value || 7)));

load();
setInterval(() => {
  if (!document.querySelector("form:focus-within")) load();
}, 10000);
