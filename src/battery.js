const fs = require("node:fs");
const path = require("node:path");
const si = require("systeminformation");
const { cacheDir } = require("./paths");
const Model = require("./battery-model");
const { createWorker, spawnWorker } = require("./system");
const DAY = 86400000;

class BatteryHistory {
  constructor({ file = path.join(cacheDir(), "battery.json"), now = Date.now } = {}) {
    this.file = file; this.now = now; this.points = []; this.latest = null; this.boundary = true; this.error = false; this.dirty = false; this.savedAt = 0;
    try {
      const data = JSON.parse(fs.readFileSync(file, "utf8"));
      if (data.version === 1 && Array.isArray(data.points)) this.points = data.points.filter(Model.valid).sort((a, b) => a.t - b.t);
    } catch (e) { this.error = e.code !== "ENOENT"; }
    this.prune();
  }
  prune() { this.points = this.points.filter((p) => p.t >= this.now() - 30 * DAY && p.t <= this.now()).slice(-45000); }
  record(raw) {
    let reading = Model.normalize(raw, this.now());
    const last = this.points.at(-1);
    if (last && reading.t <= last.t && !this.boundary) return this.latest || reading;
    reading.g = this.boundary || !last || reading.t - last.t > Model.GAP || reading.t <= last.t;
    reading = Model.estimate(reading, this.points);
    this.latest = reading;
    if (!Model.valid(reading)) { this.boundary = true; return reading; }
    if (last && !reading.g && last.state === reading.state && reading.t - last.t < 60000) return reading;
    const changed = !last || reading.g || last.state !== reading.state;
    this.points.push(reading); this.boundary = false; this.prune(); this.dirty = true;
    // Steady charge/discharge adds a point a minute; rewrite the file only on a state change or
    // gap, and otherwise at most every ten minutes, to spare the disk. flush() saves the rest on quit.
    if (changed || this.now() - this.savedAt >= 600000) this.save();
    return reading;
  }
  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(`${this.file}.tmp`, JSON.stringify({ version: 1, points: this.points }));
      fs.renameSync(`${this.file}.tmp`, this.file); this.error = false; this.savedAt = this.now(); this.dirty = false;
    } catch { this.error = true; }
    return !this.error;
  }
  // Persists any points held back by the save throttle; call before the app quits.
  flush() { return this.dirty ? this.save() : !this.error; }
  clear() { this.points = []; this.boundary = true; return this.save(); }
  view(days = 7) {
    this.prune();
    const points = this.points.filter((p) => p.t >= this.now() - days * DAY);
    return { latest: this.latest, points, sessions: Model.sessions(points), error: this.error };
  }
  csv(days) {
    return "timestamp,percent,state,estimated_seconds,estimate_source,gap_before\n" + this.view(days).points.map((p) =>
      [new Date(p.t).toISOString(), p.percent, p.state, p.seconds ?? "", p.source ?? "", !!p.g].join(",")).join("\n");
  }
}

function start(history, onUpdate, { read, interval = 10000, timeout = 8000, slowInterval = 600000 } = {}) {
  const worker = !read && process.platform === "win32" ? createWorker({ start: () => spawnWorker("battery-windows.ps1") }) : null;
  read ||= worker ? () => worker.sample() : () => si.battery();
  let stopped = false, paused = false, pending = false, generation = 0;
  let deadline, timer;
  let slow = false, misses = 0;
  function schedule(ms) { clearInterval(timer); timer = setInterval(refresh, ms); }
  // A machine with no battery is read every ten minutes instead of every ten seconds once a few
  // readings confirm it; a battery appearing (or a power event calling refresh) restores the fast cadence.
  function cadence(reading) {
    if (reading && reading.present === false) {
      if (++misses >= 3 && !slow) { slow = true; schedule(slowInterval); }
    } else if (reading && reading.present === true) {
      misses = 0;
      if (slow) { slow = false; schedule(interval); }
    }
  }
  function emit(reading) { cadence(reading); onUpdate(reading); }
  async function refresh() {
    if (stopped || paused || pending) return;
    pending = true;
    const current = generation;
    let timedOut = false;
    deadline = setTimeout(() => {
      timedOut = true;
      if (!stopped && !paused && generation === current) emit(history.record(null));
    }, timeout);
    try {
      const raw = await read();
      if (!timedOut && !stopped && !paused && generation === current) emit(history.record(raw));
    } catch {
      if (!timedOut && !stopped && !paused && generation === current) emit(history.record(null));
    } finally { clearTimeout(deadline); pending = false; }
  }
  timer = setInterval(refresh, interval);
  refresh();
  return { refresh, setPaused(value) { paused = value; generation++; history.boundary = true; if (!paused) refresh(); },
    stop() { stopped = true; clearTimeout(deadline); clearInterval(timer); worker?.stop(); } };
}
module.exports = { BatteryHistory, start };
