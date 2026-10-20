(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.BatteryModel = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, () => {
  const GAP = 20 * 60000;
  const states = ["charging", "discharging", "full", "plugged", "unknown"];
  function normalize(raw, t = Date.now()) {
    const present = raw?.hasBattery === false ? false : raw?.hasBattery === true ? true : null;
    const percent = present === true && Number.isFinite(raw.percent) && raw.percent >= 0 && raw.percent <= 100 ? raw.percent : null;
    const state = percent === null ? "unknown" : raw.acConnected === true && percent === 100 ? "full" : raw.isCharging === true ? "charging"
      : raw.acConnected === true ? percent === 100 ? "full" : "plugged"
      : raw.acConnected === false ? "discharging" : "unknown";
    const minutes = raw?.timeRemaining;
    let seconds = state === "discharging" && Number.isFinite(raw?.estimatedSeconds) && raw.estimatedSeconds > 0 && raw.estimatedSeconds <= 604800 ? raw.estimatedSeconds
      : state === "discharging" && Number.isFinite(minutes) && minutes > 0 && minutes < 10080 ? minutes * 60 : null;
    let source = seconds === null ? null : "system";
    const capacity = raw?.currentCapacity, rate = raw?.powerRate;
    if (seconds === null && percent !== null && percent > 0 && Number.isFinite(capacity) && capacity > 0 && capacity < 0xffffffff && Number.isFinite(rate)
      && Math.abs(rate) > 0 && Math.abs(rate) < 1000000 && (state === "charging" ? rate > 0 : state === "discharging" && rate < 0)) {
      const energy = state === "charging" ? capacity * (100 - percent) / percent : capacity;
      const quick = energy / Math.abs(rate) * 3600;
      if (quick > 0 && quick <= 604800) { seconds = Math.round(quick); source = "power"; }
    }
    return { t, present, percent, state, seconds, source };
  }
  function estimate(reading, points) {
    const out = { ...reading };
    if (out.seconds !== null || !["charging", "discharging"].includes(out.state) || out.percent === null) return out;
    const recent = [];
    for (let i = points.length - 1; i >= 0; i--) {
      const p = points[i];
      if (p.t >= out.t) continue;
      const next = recent.at(-1) || out;
      if (p.state !== out.state || next.g || next.t - p.t > GAP || out.t - p.t > 30 * 60000) break;
      recent.push(p);
      if (p.g) break;
    }
    const first = recent.at(-1);
    if (!first || out.t - first.t < 30000) return out;
    const delta = out.percent - first.percent;
    if (Math.abs(delta) < 1 || (out.state === "charging" ? delta <= 0 : delta >= 0)) return out;
    const target = out.state === "charging" ? 100 - out.percent : out.percent;
    out.seconds = Math.round(target / Math.abs(delta) * (out.t - first.t) / 1000);
    out.source = "observed";
    return out;
  }
  function duration(seconds) {
    const mins = Math.max(1, Math.round(seconds / 60));
    return mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h ${mins % 60}m`;
  }
  function label(r) {
    if (!r || r.percent === null || r.present !== true || r.state === "unknown") return "Unavailable";
    if (r.state === "full") return "Full";
    if (r.state === "plugged") return "Plugged in · not charging";
    return Number.isFinite(r.seconds) && r.seconds >= 0 ? `~${duration(r.seconds)} ${r.state === "charging" ? "to full" : "left"}` : "Estimating…";
  }
  function sessions(points) {
    const groups = [];
    for (const p of points) {
      let group = groups.at(-1);
      const last = group?.points.at(-1);
      if (!last || p.g || p.t - last.t > GAP || p.state !== last.state) {
        if (group) group.completeEnd = !p.g && p.t - last.t <= GAP;
        group = { points: [], completeStart: !!last && !p.g && p.t - last.t <= GAP };
        groups.push(group);
      }
      group.points.push(p);
    }
    return groups.filter((g) => ["charging", "discharging"].includes(g.points[0].state)).map((g) => {
      const a = g.points[0], b = g.points.at(-1);
      return { start: a.t, end: b.t, from: a.percent, to: b.percent, state: a.state,
        delta: b.percent - a.percent, partial: !g.completeStart || !g.completeEnd, duration: b.t - a.t };
    }).reverse();
  }
  function valid(p) {
    return p && Number.isFinite(p.t) && p.t > 0 && Number.isFinite(p.percent) && p.percent >= 0 && p.percent <= 100 && states.includes(p.state)
      && (p.seconds == null || Number.isFinite(p.seconds) && p.seconds >= 0) && (p.source == null || ["system", "power", "observed"].includes(p.source));
  }
  return { GAP, normalize, estimate, duration, label, sessions, valid };
});
