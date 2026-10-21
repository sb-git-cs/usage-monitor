const { shownPct } = require("./models");

function slopePerHour(points) {
  if (!points || points.length < 2) return 0;
  const n = points.length;
  const t0 = points[0].t;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  for (const p of points) {
    const x = (p.t - t0) / 3600000;
    sx += x;
    sy += p.used;
    sxx += x * x;
    sxy += x * p.used;
  }
  const d = n * sxx - sx * sx;
  return d > 0 ? (n * sxy - sx * sy) / d : 0;
}

const NAMES = { claude: "Claude Code", codex: "Codex", gemini: "Gemini", grok: "Grok Build", cursor: "Cursor", copilot: "Copilot", x_subscription: "X Subscription" };

function lookbackMs(kind) {
  return kind === "five_hour" || kind === "daily" ? 3600000 : 21600000;
}

function analyzeBurn(seriesList = [], now = Date.now) {
  const nowMs = typeof now === "function" ? now() : now;
  const windows = [];

  for (const s of seriesList) {
    if (!s || !Array.isArray(s.points) || !s.points.length) continue;
    // Points of earlier reset cycles would turn the drop at the reset into a falling pace.
    const cycle = s.points.at(-1).cycle;
    const pts = s.points.filter((p) => p.cycle === cycle);
    const last = pts.at(-1);
    const used = Math.max(0, Math.min(100, last.used));
    const lookback = lookbackMs(s.kind);
    // A window that has reset since, or is no longer being read, says nothing about the current pace.
    if (Date.parse(last.reset) <= nowMs || nowMs - last.t > lookback) continue;
    const recent = pts.filter((p) => p.t >= nowMs - lookback && p.t <= nowMs);
    const sample = recent.length >= 2 ? recent : pts.slice(-5);
    const rawRate = slopePerHour(sample);
    const burnRate = Math.round(rawRate * 10) / 10;

    const resetParsed = Date.parse(last.reset);
    const resetsAt = Number.isFinite(resetParsed) && resetParsed > nowMs ? new Date(resetParsed).toISOString() : null;
    const hoursToReset = resetsAt ? (resetParsed - nowMs) / 3600000 : null;

    const safeRate = hoursToReset && hoursToReset > 0
      ? Math.round(((100 - used) / hoursToReset) * 10) / 10
      : null;

    const runwayHours = burnRate > 0.1
      ? Math.round(((100 - used) / burnRate) * 10) / 10
      : null;

    const willExhaust = runwayHours != null && hoursToReset != null && runwayHours < hoursToReset;

    // Critical means projected to run out before the reset; without a reset time, near the limit and rising.
    let status = "idle";
    if (used >= 100) status = "exhausted";
    else if (willExhaust || (hoursToReset == null && used >= 85 && burnRate > 1)) status = "critical";
    else if (used >= 70 || (safeRate != null ? burnRate > 0.2 && burnRate >= safeRate * 0.8 : burnRate > 5)) status = "elevated";
    else if (burnRate > 0.2) status = "sustainable";
    else if (burnRate < -0.2) status = "cooling";

    // 24h delta
    const dayAgo = nowMs - 86400000;
    const pts24 = pts.filter((p) => p.t >= dayAgo);
    const delta24 = pts24.length >= 2 ? Math.round(last.used - pts24[0].used) : 0;

    // Peak rate in series
    let peakRate = burnRate;
    if (pts.length >= 3) {
      for (let i = 0; i < pts.length - 2; i++) {
        const seg = pts.slice(i, i + 4);
        const r = slopePerHour(seg);
        if (r > peakRate) peakRate = Math.round(r * 10) / 10;
      }
    }

    windows.push({
      id: s.id,
      provider: s.provider,
      label: s.label,
      kind: s.kind,
      account: s.account,
      used,
      burn_rate: burnRate,
      resets_at: resetsAt,
      hours_to_reset: hoursToReset != null ? Math.round(hoursToReset * 10) / 10 : null,
      safe_rate: safeRate,
      runway_hours: runwayHours,
      will_exhaust: willExhaust,
      status,
      delta_24h: delta24,
      peak_rate: Math.max(peakRate, burnRate),
    });
  }

  // Sort by highest risk, then highest utilization
  const order = { exhausted: 0, critical: 1, elevated: 2, sustainable: 3, cooling: 4, idle: 5 };
  windows.sort((a, b) => (order[a.status] - order[b.status]) || (b.used - a.used));

  return windows;
}

function computeHealth(windows = [], events = [], now = Date.now) {
  const nowMs = typeof now === "function" ? now() : now;
  let score = 100;

  for (const w of windows) {
    if (w.status === "exhausted") score -= 30;
    else if (w.status === "critical") score -= 20;
    else if (w.status === "elevated") score -= 10;
    else if (w.used >= 80) score -= 5;
  }

  // Only plan warnings count; resumed sessions, data caps and updates say nothing about quota health.
  const recentAlerts = events.filter((e) => nowMs - e.at <= 86400000 && String(e.title).startsWith("Usage Monitor — "));
  score -= Math.min(15, recentAlerts.length * 5);
  score = Math.max(0, Math.min(100, score));

  let label = "Good";
  let grade = "A";
  if (score < 50) { label = "Critical"; grade = "D"; }
  else if (score < 75) { label = "Needs attention"; grade = "C"; }
  else if (score < 90) { label = "Fair"; grade = "B"; }

  const recommendations = [];

  for (const w of windows) {
    const name = `${NAMES[w.provider] || w.provider} ${w.label}`;
    const resets = w.hours_to_reset != null ? `It resets in ${duration(w.hours_to_reset)}.` : "Its reset time is not reported.";
    const rising = w.burn_rate > 0 ? `rising ${w.burn_rate}%/h` : "not rising";
    if (w.status === "exhausted") {
      recommendations.push({
        type: "danger",
        title: `${name} is used up`,
        body: `${resets} Use another plan or model until then.`,
      });
    } else if (w.status === "critical") {
      recommendations.push({
        type: "warning",
        title: w.will_exhaust ? `${name} runs out before it resets` : `${name} is close to its limit`,
        body: w.will_exhaust
          ? `At ${w.burn_rate}%/h it reaches 100% in about ${duration(w.runway_hours)}. ${resets} A pace of ${w.safe_rate}%/h or less lasts until then.`
          : `${shownPct(w.used)}% used and ${rising}; about ${duration(w.runway_hours)} left at this pace. ${resets}`,
      });
    } else if (w.status === "elevated") {
      recommendations.push({
        type: "info",
        title: w.used >= 70 ? `${name} is filling up` : `${name} is near its safe pace`,
        body: `${shownPct(w.used)}% used and ${rising}.${w.safe_rate != null ? ` A pace of ${w.safe_rate}%/h or less lasts until the reset.` : ""} ${resets}`,
      });
    }
  }

  if (!recommendations.length) {
    recommendations.push(windows.length ? {
      type: "success",
      title: "Every window is on a sustainable pace",
      body: "No current window is projected to reach its limit before it resets.",
    } : {
      type: "info",
      title: "No current readings",
      body: "Recommendations appear once a plan meter reports usage in this period.",
    });
  }

  return { score, label, grade, recommendations };
}

// 0.4 -> "24m", 3.5 -> "3h 30m", 84 -> "3.5 days".
function duration(hours) {
  if (!Number.isFinite(hours)) return "an unknown time";
  if (hours >= 48) return `${Math.round(hours / 2.4) / 10} days`;
  const mins = Math.max(1, Math.round(hours * 60));
  return mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h${mins % 60 ? ` ${mins % 60}m` : ""}`;
}

module.exports = {
  slopePerHour,
  analyzeBurn,
  computeHealth,
};
