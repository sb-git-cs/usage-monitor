const fs = require("node:fs");
const path = require("node:path");
const si = require("systeminformation");
const { cacheDir } = require("./paths");
const Model = require("./battery-model");
const { createWorker, spawnWorker } = require("./system");
const DAY = 86400000;

class BatteryHistory {
  constructor({ file = path.join(cacheDir(), "battery.json"), now = Date.now } = {}) {
    this.file = file; this.now = now; this.points = []; this.latest = null; this.boundary = true; this.error = false;
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
    this.points.push(reading); this.boundary = false; this.prune(); this.save();
    return reading;
  }
  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(`${this.file}.tmp`, JSON.stringify({ version: 1, points: this.points }));
      fs.renameSync(`${this.file}.tmp`, this.file); this.error = false;
    } catch { this.error = true; }
    return !this.error;
  }
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

function start(history, onUpdate, { read, interval = 10000, timeout = 8000 } = {}) {
  const worker = !read && process.platform === "win32" ? createWorker({ start: () => spawnWorker("battery-windows.ps1") }) : null;
  read ||= worker ? () => worker.sample() : () => si.battery();
  let stopped = false, paused = false, pending = false, generation = 0;
  let deadline;
  async function refresh() {
    if (stopped || paused || pending) return;
    pending = true;
    const current = generation;
    let timedOut = false;
    deadline = setTimeout(() => {
      timedOut = true;
      if (!stopped && !paused && generation === current) onUpdate(history.record(null));
    }, timeout);
    try {
      const raw = await read();
      if (!timedOut && !stopped && !paused && generation === current) onUpdate(history.record(raw));
    } catch {
      if (!timedOut && !stopped && !paused && generation === current) onUpdate(history.record(null));
    } finally { clearTimeout(deadline); pending = false; }
  }
  const timer = setInterval(refresh, interval);
  refresh();
  return { refresh, setPaused(value) { paused = value; generation++; history.boundary = true; if (!paused) refresh(); },
    stop() { stopped = true; clearTimeout(deadline); clearInterval(timer); worker?.stop(); } };
}
module.exports = { BatteryHistory, start };
