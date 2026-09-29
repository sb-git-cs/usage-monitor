// Plan usage history and burn-rate forecast. Each fresh reading of a window is recorded
// (at most once a minute); the recent trend says when the window would reach 100% if usage
// kept its current pace. A window that resets first gets no forecast.
const fs = require("fs");
const path = require("path");
const { cacheDir } = require("./paths");

const FILE = "usage-history.json";
const MIN_GAP_MS = 60_000;
const MAX_POINTS = 360;
const MAX_AGE_MS = 8 * 24 * 60 * 60_000;
const SAVE_GAP_MS = 60_000;
// Short windows look at the last hour; weekly and longer ones at the last six hours.
const SHORT_LOOKBACK_MS = 60 * 60_000;
const LONG_LOOKBACK_MS = 6 * 60 * 60_000;
const MIN_SPAN_MS = 10 * 60_000;
const MIN_POINTS = 3;
// Slower than this is noise from rounding in the providers' percentages.
const MIN_RATE_PER_HOUR = 0.5;

function keyOf(providerId, win) {
  return `${providerId}|${win.kind}|${win.label || ""}`;
}

function lookback(kind) {
  return kind === "five_hour" || kind === "daily" ? SHORT_LOOKBACK_MS : LONG_LOOKBACK_MS;
}

// Least-squares slope of used% over time, in % per hour.
function slopePerHour(points) {
  const n = points.length;
  const t0 = points[0].t;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  for (const p of points) {
    const x = (p.t - t0) / 3_600_000;
    sx += x;
    sy += p.used;
    sxx += x * x;
    sxy += x * p.used;
  }
  const d = n * sxx - sx * sx;
  return d > 0 ? (n * sxy - sx * sy) / d : 0;
}

// { at, rate_per_hour } when the window is on course to reach 100% before it resets, else null.
function forecast(points, win, now = Date.now()) {
  if (!win || !Number.isFinite(win.used_pct) || win.used_pct >= 100) return null;
  const since = now - lookback(win.kind);
  const recent = (points || []).filter((p) => p.t >= since && p.t <= now);
  if (recent.length < MIN_POINTS || recent[recent.length - 1].t - recent[0].t < MIN_SPAN_MS) return null;
  const rate = slopePerHour(recent);
  if (!(rate >= MIN_RATE_PER_HOUR)) return null;
  const at = now + ((100 - win.used_pct) / rate) * 3_600_000;
  const resets = win.resets_at ? Date.parse(win.resets_at) : NaN;
  if (Number.isFinite(resets) && at >= resets) return null;
  return { at: new Date(Math.round(at / 60_000) * 60_000).toISOString(), rate_per_hour: Math.round(rate * 10) / 10 };
}

class History {
  constructor({ file = path.join(cacheDir(), FILE), now = Date.now } = {}) {
    this.file = file;
    this.now = now;
    this.series = new Map();
    this.savedAt = 0;
    this.dirty = false;
    this.load();
  }

  load() {
    try {
      const data = JSON.parse(fs.readFileSync(this.file, "utf8"));
      for (const [key, s] of Object.entries(data.series || {})) {
        if (!s || !Array.isArray(s.points)) continue;
        const points = s.points.filter((p) => p && Number.isFinite(p.t) && Number.isFinite(p.used));
        if (points.length) this.series.set(key, { resets_at: typeof s.resets_at === "string" ? s.resets_at : null, points });
      }
    } catch {
      /* no history yet */
    }
  }

  save() {
    const now = this.now();
    if (!this.dirty || now - this.savedAt < SAVE_GAP_MS) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, series: Object.fromEntries(this.series) }), "utf8");
      fs.renameSync(tmp, this.file);
      this.savedAt = now;
      this.dirty = false;
    } catch (err) {
      console.error("usage history write failed", err.message);
    }
  }

  record(snapshot) {
    const now = this.now();
    for (const provider of (snapshot && snapshot.providers) || []) {
      // Only fresh readings: cached or expired numbers would flatten the trend.
      if (!provider || provider.status?.state !== "ok") continue;
      for (const win of provider.windows || []) {
        if (!Number.isFinite(win.used_pct)) continue;
        const key = keyOf(provider.id, win);
        let s = this.series.get(key);
        // A new reset time means a new window; the old trend no longer applies.
        if (!s || (win.resets_at && s.resets_at && win.resets_at !== s.resets_at) || (s.points.length && win.used_pct < s.points[s.points.length - 1].used - 1)) {
          s = { resets_at: win.resets_at || null, points: [] };
          this.series.set(key, s);
        }
        s.resets_at = win.resets_at || s.resets_at;
        const last = s.points[s.points.length - 1];
        if (last && now - last.t < MIN_GAP_MS) continue;
        s.points.push({ t: now, used: win.used_pct });
        if (s.points.length > MAX_POINTS) s.points.splice(0, s.points.length - MAX_POINTS);
        this.dirty = true;
      }
    }
    for (const [key, s] of this.series) {
      s.points = s.points.filter((p) => now - p.t <= MAX_AGE_MS);
      if (!s.points.length) this.series.delete(key);
    }
    this.save();
  }

  // Copies the snapshot with forecast_at / burn_per_hour on windows that are on course to run out.
  annotate(snapshot) {
    if (!snapshot || !Array.isArray(snapshot.providers)) return snapshot;
    const now = this.now();
    return {
      ...snapshot,
      providers: snapshot.providers.map((p) => ({
        ...p,
        windows: (p.windows || []).map((w) => {
          const f = p.status?.state === "ok" || p.status?.state === "stale" ? forecast(this.series.get(keyOf(p.id, w))?.points, w, now) : null;
          const { forecast_at, burn_per_hour, ...rest } = w;
          return f ? { ...rest, forecast_at: f.at, burn_per_hour: f.rate_per_hour } : rest;
        }),
      })),
    };
  }

  flush() {
    this.savedAt = 0;
    this.save();
  }
}

module.exports = { History, forecast, slopePerHour, keyOf };
