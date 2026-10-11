const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { cacheDir } = require("./paths");

const DAY = 86400000;
const PROVIDERS = ["claude", "codex", "gemini", "grok", "cursor", "copilot"];
const digest = (value) => crypto.createHash("sha256").update(String(value)).digest("hex").slice(0, 16);
const identity = (p) => p.account_id || p.account || null;
function cycleAt(now, day) {
  const d = new Date(now);
  const start = (year, month) => new Date(year, month, Math.min(day, new Date(year, month + 1, 0).getDate())).getTime();
  const current = start(d.getFullYear(), d.getMonth());
  return current <= now ? { start: current, end: start(d.getFullYear(), d.getMonth() + 1) }
    : { start: start(d.getFullYear(), d.getMonth() - 1), end: current };
}
function displayPrefs(raw = {}) {
  const ids = [...new Set((Array.isArray(raw.order) ? raw.order : []).filter((id) => PROVIDERS.includes(id)))];
  return { theme: ["system", "light", "dark"].includes(raw.theme) ? raw.theme : "system",
    scale: [100, 115, 130].includes(Number(raw.scale)) ? Number(raw.scale) : 100,
    compact: raw.compact === true, order: [...ids, ...PROVIDERS.filter((id) => !ids.includes(id))],
    hidden: (Array.isArray(raw.hidden) ? raw.hidden : []).filter((id) => PROVIDERS.includes(id)) };
}
class Insights {
  constructor({ file = path.join(cacheDir(), "insights.json"), now = Date.now } = {}) {
    this.file = file; this.now = now; this.savedAt = 0; this.dirty = false; this.error = false;
    this.data = { series: {}, events: [], days: {}, lastSuccess: {}, snoozeUntil: 0, observedSince: now(), budget: { limit: 0, day: 1 }, budgetFired: {} };
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8"));
      if (raw.version === 1) {
        this.data.snoozeUntil = Number.isFinite(raw.snoozeUntil) ? raw.snoozeUntil : 0;
        this.data.observedSince = Number.isFinite(raw.observedSince) ? raw.observedSince : now();
        for (const id of PROVIDERS) if (Number.isFinite(Date.parse(raw.lastSuccess?.[id]))) this.data.lastSuccess[id] = raw.lastSuccess[id];
        this.setBudget(raw.budget);
        for (const [key, s] of Object.entries(raw.series || {})) {
          if (!s || !PROVIDERS.includes(s.provider) || !Array.isArray(s.points)) continue;
          this.data.series[key] = { provider: s.provider, account: /^[a-f0-9]{16}$/.test(s.account) ? s.account : "unidentified", kind: String(s.kind).slice(0, 60), label: String(s.label).slice(0, 80),
            points: s.points.filter((p) => Number.isFinite(p.t) && Number.isFinite(p.used) && typeof p.cycle === "string") };
        }
        this.data.events = (Array.isArray(raw.events) ? raw.events : []).filter((e) => Number.isFinite(e.at) && typeof e.title === "string" && typeof e.body === "string").slice(-200);
        for (const [key, value] of Object.entries(raw.days || {})) if (/^\d{4}-\d\d-\d\d$/.test(key) && Number.isFinite(value) && value >= 0) this.data.days[key] = value;
        this.data.budgetFired = raw.budgetFired && typeof raw.budgetFired === "object" ? raw.budgetFired : {};
      }
    } catch (err) { this.error = err.code !== "ENOENT"; }
    this.prune();
  }
  prune() {
    const cutoff = this.now() - 31 * DAY;
    for (const [key, s] of Object.entries(this.data.series)) {
      s.points = s.points.filter((p) => p.t >= cutoff && p.t <= this.now()).slice(-9000);
      if (!s.points.length) delete this.data.series[key];
    }
    for (const key of Object.keys(this.data.days)) if (Date.parse(key) < this.now() - 65 * DAY) delete this.data.days[key];
    this.data.events = this.data.events.filter((e) => e.at >= cutoff).slice(-200);
    for (const key of Object.keys(this.data.budgetFired)) if (Number(key) < this.now() - 65 * DAY) delete this.data.budgetFired[key];
  }
  record(snapshot) {
    const now = this.now();
    for (const p of snapshot?.providers || []) {
      if (p.status?.state !== "ok" || !PROVIDERS.includes(p.id)) continue;
      if (Number.isFinite(Date.parse(p.fetched_at))) { this.data.lastSuccess[p.id] = p.fetched_at; this.dirty = true; }
      const account = identity(p) ? digest(identity(p)) : "unidentified";
      for (const w of p.windows || []) {
        if (!Number.isFinite(w.used_pct)) continue;
        const key = digest(`${p.id}|${account}|${w.kind}|${w.label || ""}`);
        const s = this.data.series[key] ||= { provider: p.id, account, kind: w.kind, label: w.label || w.kind, points: [] };
        const last = s.points.at(-1);
        const reset = Number.isFinite(Date.parse(w.resets_at)) ? w.resets_at : "unknown";
        let cycle = last?.reset === reset ? last.cycle : `${reset}-${now}`;
        if (last && w.used_pct < last.used - 1) cycle = `${reset}-${now}`;
        if (last && now - last.t < 300000 && last.cycle === cycle) continue;
        s.points.push({ t: now, used: w.used_pct, cycle, reset }); this.dirty = true;
      }
    }
    this.prune(); this.save();
  }
  event(title, body, delivery) {
    this.data.events.push({ at: this.now(), title: String(title).slice(0, 160), body: String(body).slice(0, 500), delivery });
    this.prune(); this.dirty = true; this.save(true);
  }
  snooze(minutes) {
    if (![0, 15, 60, 240].includes(minutes)) return false;
    this.data.snoozeUntil = minutes ? this.now() + minutes * 60000 : 0;
    this.dirty = true; this.save(true); return true;
  }
  isSnoozed() { return this.data.snoozeUntil > this.now(); }
  setBudget(raw) {
    if (!raw || !Number.isFinite(Number(raw.limit)) || Number(raw.limit) < 0 || Number(raw.limit) > 1e15 || !Number.isInteger(Number(raw.day)) || raw.day < 1 || raw.day > 31) return false;
    this.data.budget = { limit: Number(raw.limit), day: Number(raw.day) };
    this.dirty = true; return true;
  }
  traffic(sample) {
    let bytes = 0;
    for (const a of sample?.apps || []) for (const value of [a.rx, a.tx]) if (Number.isFinite(value) && value > 0) bytes += value;
    if (!bytes) return;
    const d = new Date(this.now());
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    this.data.days[key] = (this.data.days[key] || 0) + bytes;
    this.dirty = true; this.save();
  }
  budgetView() {
    const now = this.now();
    const cycle = cycleAt(now, this.data.budget.day);
    const used = Object.entries(this.data.days).filter(([key]) => {
      const date = new Date(`${key}T00:00:00`).getTime(); return date >= cycle.start && date < cycle.end;
    }).reduce((sum, [, bytes]) => sum + bytes, 0);
    const covered = Math.max(cycle.start, this.data.observedSince);
    const elapsed = now - covered;
    return { ...this.data.budget, ...cycle, used, observedSince: this.data.observedSince,
      projected: elapsed >= DAY ? used / elapsed * (cycle.end - covered) : null };
  }
  budgetCrossing(threshold) {
    const b = this.budgetView();
    if (!b.limit || b.used < b.limit * threshold / 100 || this.data.budgetFired[b.start]) return null;
    this.data.budgetFired[b.start] = true; this.dirty = true; this.save(true); return b;
  }
  report(days = 7) {
    this.prune();
    const since = this.now() - ([1, 7, 30].includes(days) ? days : 7) * DAY;
    return Object.entries(this.data.series).map(([id, s]) => ({ id, ...s, points: s.points.filter((p) => p.t >= since) })).filter((s) => s.points.length);
  }
  export(days, format) {
    const series = this.report(days);
    if (format === "json") return JSON.stringify({ unit: "quota_percent_used", days, series }, null, 2);
    const cell = (v) => `"${String(v).replace(/"/g, '""').replace(/^[=+@-]/, "'$&")}"`;
    return ["provider,account_ref,window,reset_or_segment,time,used_percent", ...series.flatMap((s) => s.points.map((p) => [s.provider, s.account, s.label, p.cycle, new Date(p.t).toISOString(), p.used].map(cell).join(",")))].join("\n");
  }
  save(force = false) {
    if (!this.dirty || (!force && this.now() - this.savedAt < 60000)) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(`${this.file}.tmp`, JSON.stringify({ version: 1, ...this.data }), { encoding: "utf8", mode: 0o600 });
      fs.renameSync(`${this.file}.tmp`, this.file); this.savedAt = this.now(); this.dirty = false; this.error = false;
    } catch { this.error = true; }
  }
}
module.exports = { Insights, cycleAt, displayPrefs, digest, identity };
