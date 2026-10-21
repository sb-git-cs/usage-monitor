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

function lookbackMs(kind) {
  return kind === "five_hour" || kind === "daily" ? 3600000 : 21600000;
}

function analyzeBurn(seriesList = [], now = Date.now) {
  const nowMs = typeof now === "function" ? now() : now;
  const windows = [];

  for (const s of seriesList) {
    if (!s || !Array.isArray(s.points) || !s.points.length) continue;
    const pts = s.points;
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

    let status = "idle";
    if (used >= 100) status = "exhausted";
    else if (willExhaust || (used >= 85 && burnRate > 1)) status = "critical";
    else if (burnRate > 5 || used >= 70) status = "elevated";
    else if (burnRate > 0.2 && (!safeRate || burnRate <= safeRate)) status = "sustainable";
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

  const recentAlerts = events.filter((e) => nowMs - e.at <= 86400000);
  score -= Math.min(15, recentAlerts.length * 5);
  score = Math.max(0, Math.min(100, score));

  let label = "Optimal";
  let grade = "A";
  if (score < 50) { label = "Critical"; grade = "D"; }
  else if (score < 75) { label = "Attention Required"; grade = "C"; }
  else if (score < 90) { label = "Healthy"; grade = "B"; }

  const recommendations = [];

  for (const w of windows) {
    if (w.status === "exhausted") {
      recommendations.push({
        type: "danger",
        title: `${w.provider} ${w.label} Quota Exhausted`,
        body: `100% of the quota is spent. Resets in ${w.hours_to_reset ? `${w.hours_to_reset}h` : "the next cycle"}. Switch to an alternate provider or model.`,
      });
    } else if (w.status === "critical") {
      recommendations.push({
        type: "warning",
        title: `Rapid Burn on ${w.provider} ${w.label}`,
        body: `Burning at ${w.burn_rate}%/h. Runway is only ~${w.runway_hours}h, exhausting before reset in ${w.hours_to_reset}h. Safe pace is ${w.safe_rate}%/h.`,
      });
    } else if (w.status === "elevated") {
      recommendations.push({
        type: "info",
        title: `Elevated Quota Pace on ${w.provider}`,
        body: `Usage reached ${Math.round(w.used)}% (+${w.burn_rate}%/h). Keep an eye on long agent tasks.`,
      });
    }
  }

  if (!recommendations.length) {
    recommendations.push({
      type: "success",
      title: "Sustainable Consumption Pace",
      body: "All monitored windows are operating safely within scheduled reset allowances.",
    });
  }

  return { score, label, grade, recommendations };
}

module.exports = {
  slopePerHour,
  analyzeBurn,
  computeHealth,
};
