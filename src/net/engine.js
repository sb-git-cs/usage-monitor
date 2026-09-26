// Platform-independent core of the network monitor: live rates, per-minute history,
// focus/ignore, data caps and block state. Providers feed it one sample per second.
const { EventEmitter } = require("events");
const { normalizeCap, isEmptyRule } = require("./settings");
const { rangeMinutes } = require("./format");

const FLUSH_EVERY_MS = 10_000;
const PRUNE_EVERY_MS = 60_000;
const SAVE_EVERY_MS = 15_000;
const LIVE_IDLE_MS = 5 * 60_000;
// Rates older than this are shown as zero (for example while the helper reconnects).
const STALE_RATE_MS = 3000;
const DNS_LIMIT = 50_000;
const BUCKETS = [1, 2, 5, 10, 15, 30, 60, 120, 180, 360, 720, 1440, 2880, 10080, 43200];

function minuteOf(ms) {
  return Math.floor(ms / 60000);
}

function amount(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// Start of the cap period containing `now`, in local time; null for a running total.
function periodStart(period, now) {
  const d = new Date(now);
  if (period === "daily") return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  if (period === "monthly") return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
  return null;
}

class Engine extends EventEmitter {
  constructor({ store, settings, capabilities = {}, now = Date.now }) {
    super();
    this.store = store;
    this.settings = settings;
    this.capabilities = { block: false, domains: false, udp: true, ...capabilities };
    this.now = now;
    this.live = new Map();
    this.dns = new Map();
    this.actualBlocked = new Map();
    this.lastSampleAt = 0;
    this.lastFlush = now();
    this.lastPrune = 0;
    this.lastSave = 0;
    this.dirty = false;
    this.refreshLists();
  }

  refreshLists() {
    this.ignored = new Set(this.settings.ignore.map((a) => a.key));
    this.focused = new Set(this.settings.focus.map((a) => a.key));
  }

  tracks(key) {
    if (this.ignored.has(key)) return false;
    return !this.focused.size || this.focused.has(key);
  }

  ingest(sample) {
    const now = this.now();
    const rawTs = sample ? Number(sample.ts) : NaN;
    const ts = Number.isFinite(rawTs) && rawTs > 0 ? rawTs : now;
    const elapsed = this.lastSampleAt ? Math.min(5, Math.max(0.25, (ts - this.lastSampleAt) / 1000)) : 1;
    this.lastSampleAt = ts;
    const minute = minuteOf(ts);
    const seen = new Set();
    for (const app of (sample && sample.apps) || []) {
      const key = app && typeof app.key === "string" && app.key ? app.key : null;
      if (!key || !this.tracks(key)) continue;
      const rx = amount(app.rx);
      const tx = amount(app.tx);
      let live = this.live.get(key);
      if (!live && !rx && !tx) continue;
      if (!live) {
        live = { key, name: key, path: null, pids: 0, rxRate: 0, txRate: 0, lastSeen: ts };
        this.live.set(key, live);
      }
      if (app.name) live.name = String(app.name);
      if (app.path) live.path = String(app.path);
      if (Array.isArray(app.pids)) live.pids = app.pids.length;
      live.rxRate = rx / elapsed;
      live.txRate = tx / elapsed;
      seen.add(key);
      if (!rx && !tx) continue;
      live.lastSeen = ts;
      this.store.addUsage(this.store.appId(key, live.name, live.path), minute, rx, tx);
      this.countCap(key, rx + tx, ts);
    }
    for (const [key, live] of this.live) {
      if (!seen.has(key)) {
        live.rxRate = 0;
        live.txRate = 0;
      }
      if (ts - live.lastSeen > LIVE_IDLE_MS) this.live.delete(key);
    }
    const sec = Math.floor(ts / 1000);
    for (const flow of (sample && sample.flows) || []) {
      const rule = flow && this.settings.rules[flow.key];
      if (!rule || !rule.record_connections || !this.tracks(flow.key)) continue;
      const rx = amount(flow.rx);
      const tx = amount(flow.tx);
      if ((!rx && !tx) || typeof flow.ip !== "string" || !flow.ip) continue;
      const live = this.live.get(flow.key);
      const id = this.store.appId(flow.key, (live && live.name) || rule.name, (live && live.path) || rule.path);
      const domain = this.dns.get(flow.ip) || null;
      const port = Number.isInteger(Number(flow.port)) ? Number(flow.port) : 0;
      this.store.addFlow(id, flow.ip, port, flow.proto === "udp" ? "udp" : "tcp", domain, rx, tx, sec);
      if (!domain) this.emit("unresolved", flow.ip);
    }
  }

  addDns(name, ips) {
    if (typeof name !== "string" || !name || !Array.isArray(ips)) return;
    for (const ip of ips) {
      if (typeof ip !== "string" || !ip) continue;
      this.dns.delete(ip);
      this.dns.set(ip, name);
    }
    while (this.dns.size > DNS_LIMIT) this.dns.delete(this.dns.keys().next().value);
  }

  // ---- caps and blocking -------------------------------------------------

  countCap(key, bytes, now) {
    const rule = this.settings.rules[key];
    if (!rule || !rule.cap) return;
    this.rollCap(key, rule, now);
    rule.cap.used_bytes += bytes;
    this.dirty = true;
    this.checkCap(key, rule);
  }

  checkCap(key, rule) {
    const cap = rule.cap;
    if (!cap || cap.used_bytes < cap.limit_bytes || cap.notified) return;
    cap.notified = true;
    const blocked = this.canBlock(rule);
    if (blocked) {
      cap.enforced = true;
      this.syncBlock(key);
    }
    this.dirty = true;
    this.emit("cap", { key, name: rule.name || key, limit: cap.limit_bytes, period: cap.period, blocked });
  }

  rollCap(key, rule, now) {
    const cap = rule.cap;
    const start = periodStart(cap.period, now);
    if (start == null || cap.period_start >= start) return;
    const wasEnforced = cap.enforced;
    cap.used_bytes = 0;
    cap.period_start = start;
    cap.notified = false;
    cap.enforced = false;
    this.dirty = true;
    if (wasEnforced) this.syncBlock(key);
  }

  canBlock(rule) {
    return !!(this.capabilities.block && rule && rule.path);
  }

  desiredBlocked(rule) {
    return !!(rule && (rule.blocked || (rule.cap && rule.cap.enforced)));
  }

  syncBlock(key) {
    const rule = this.settings.rules[key];
    if (!rule || !this.canBlock(rule)) return;
    this.emit("block", { key, path: rule.path, blocked: this.desiredBlocked(rule) });
  }

  setActualBlocked(paths) {
    this.actualBlocked = new Map();
    for (const p of paths || []) if (typeof p === "string" && p) this.actualBlocked.set(p.toLowerCase(), p);
  }

  // Makes the firewall match the saved rules; called when the helper (re)connects.
  reconcile() {
    if (!this.capabilities.block) return;
    const desired = new Map();
    for (const [key, rule] of Object.entries(this.settings.rules)) {
      if (this.canBlock(rule) && this.desiredBlocked(rule)) desired.set(rule.path.toLowerCase(), { key, path: rule.path });
    }
    for (const [lower, d] of desired) {
      if (!this.actualBlocked.has(lower)) this.emit("block", { key: d.key, path: d.path, blocked: true });
    }
    for (const [lower, original] of this.actualBlocked) {
      if (!desired.has(lower)) this.emit("block", { key: null, path: original, blocked: false });
    }
  }

  flowKeys() {
    return Object.entries(this.settings.rules)
      .filter(([key, rule]) => rule.record_connections && this.tracks(key))
      .map(([key]) => key);
  }

  // ---- periodic work ----------------------------------------------------

  tick() {
    const now = this.now();
    for (const [key, rule] of Object.entries(this.settings.rules)) if (rule.cap) this.rollCap(key, rule, now);
    if (now - this.lastFlush >= FLUSH_EVERY_MS) {
      this.lastFlush = now;
      this.store.flush();
    }
    if (now - this.lastPrune >= PRUNE_EVERY_MS) {
      this.lastPrune = now;
      this.prune(now);
    }
    // Cap counters change every second; persist them at a gentler pace.
    if (this.dirty && now - this.lastSave >= SAVE_EVERY_MS) {
      this.dirty = false;
      this.lastSave = now;
      this.emit("save");
    }
  }

  prune(now = this.now()) {
    const cutoff = minuteOf(now) - this.settings.retention_minutes + 1;
    const keep = Object.entries(this.settings.rules)
      .filter(([, rule]) => rule.keep_forever)
      .map(([key]) => key);
    this.store.prune(cutoff, keep);
  }

  // ---- views for the window ---------------------------------------------

  appInfo(key) {
    const live = this.live.get(key);
    const rule = this.settings.rules[key];
    const stored = this.store.appInfo ? this.store.appInfo(key) : null;
    return {
      name: (live && live.name) || (rule && rule.name) || (stored && stored.name) || key,
      path: (live && live.path) || (rule && rule.path) || (stored && stored.path) || null,
    };
  }

  view(rangeId) {
    const now = this.now();
    const nowMin = minuteOf(now);
    const minutes = rangeMinutes(rangeId);
    const since = minutes ? nowMin - minutes + 1 : 0;
    const earliest = this.store.earliestMinute();
    const covered = earliest == null ? 0 : Math.max(1, nowMin - Math.max(earliest, since) + 1);
    const fresh = now - this.lastSampleAt <= STALE_RATE_MS;
    const rows = new Map();
    const blank = (key, name, path) => ({ key, name, path, rx_rate: 0, tx_rate: 0, pids: 0, rx: 0, tx: 0 });
    for (const t of this.store.totals(since)) {
      if (!this.tracks(t.key)) continue;
      rows.set(t.key, { ...blank(t.key, t.name, t.path), rx: t.rx, tx: t.tx });
    }
    for (const live of this.live.values()) {
      if (!this.tracks(live.key) || now - live.lastSeen > LIVE_IDLE_MS) continue;
      const row = rows.get(live.key) || blank(live.key, live.name, live.path);
      row.name = live.name || row.name;
      row.path = live.path || row.path;
      row.rx_rate = fresh ? live.rxRate : 0;
      row.tx_rate = fresh ? live.txRate : 0;
      row.pids = live.pids;
      rows.set(live.key, row);
    }
    const summary = { rx_rate: 0, tx_rate: 0, rx: 0, tx: 0, active: 0 };
    const out = [];
    for (const row of rows.values()) {
      const rule = this.settings.rules[row.key];
      row.total = row.rx + row.tx;
      row.avg_per_min = covered ? row.total / covered : 0;
      row.can_block = !!(this.capabilities.block && row.path && /\.exe$/i.test(row.path));
      row.blocked = this.desiredBlocked(rule);
      row.block_pending = row.can_block && row.blocked !== this.actualBlocked.has(String(row.path).toLowerCase());
      row.keep_forever = !!(rule && rule.keep_forever);
      row.record_connections = !!(rule && rule.record_connections);
      row.focused = this.focused.has(row.key);
      row.cap = rule && rule.cap ? { ...rule.cap } : null;
      summary.rx_rate += row.rx_rate;
      summary.tx_rate += row.tx_rate;
      summary.rx += row.rx;
      summary.tx += row.tx;
      if (row.rx_rate || row.tx_rate) summary.active++;
      out.push(row);
    }
    return { ts: now, range: String(rangeId), covered_minutes: covered, rows: out, summary };
  }

  // Current total speed and the busiest apps, from memory only (cheap enough to call every second).
  liveSummary(limit = 3) {
    const out = { rx_rate: 0, tx_rate: 0, active: 0, top: [] };
    if (this.now() - this.lastSampleAt > STALE_RATE_MS) return out;
    const active = [];
    for (const live of this.live.values()) {
      if (!this.tracks(live.key) || !(live.rxRate || live.txRate)) continue;
      out.rx_rate += live.rxRate;
      out.tx_rate += live.txRate;
      active.push(live);
    }
    out.active = active.length;
    out.top = active
      .sort((a, b) => b.rxRate + b.txRate - (a.rxRate + a.txRate))
      .slice(0, limit)
      .map((l) => ({ key: l.key, name: l.name, rx_rate: l.rxRate, tx_rate: l.txRate }));
    return out;
  }

  recentTotals(minutes) {
    const since = minuteOf(this.now()) - minutes + 1;
    const out = { rx: 0, tx: 0 };
    for (const t of this.store.totals(since)) {
      if (!this.tracks(t.key)) continue;
      out.rx += t.rx;
      out.tx += t.tx;
    }
    return out;
  }

  series(key, rangeId, maxBars = 60) {
    const now = this.now();
    const nowMin = minuteOf(now);
    const minutes = rangeMinutes(rangeId);
    let start = minutes ? nowMin - minutes + 1 : 0;
    const points = this.store.series(key, start);
    // Long ranges start at the first record so a few minutes of data are not squashed.
    if (!minutes || minutes > 1440) {
      const earliest = this.store.earliestMinute();
      start = Math.max(start, earliest == null ? nowMin : earliest);
    }
    const span = nowMin - start + 1;
    const size = BUCKETS.find((b) => Math.ceil(span / b) <= maxBars) || BUCKETS[BUCKETS.length - 1];
    // Align buckets to local time so hourly and daily bars start on the hour and at midnight.
    const offset = -new Date(now).getTimezoneOffset();
    const bucketOf = (m) => Math.floor((m + offset) / size);
    const first = bucketOf(start);
    const last = bucketOf(nowMin);
    const buckets = [];
    for (let b = first; b <= last; b++) buckets.push({ start_ms: (b * size - offset) * 60000, rx: 0, tx: 0 });
    for (const p of points) {
      const i = bucketOf(p.minute) - first;
      if (i < 0 || i >= buckets.length) continue;
      buckets[i].rx += p.rx;
      buckets[i].tx += p.tx;
    }
    let peak = null;
    let total = 0;
    for (const b of buckets) {
      total += b.rx + b.tx;
      if (!peak || b.rx + b.tx > peak.rx + peak.tx) peak = b;
    }
    return { key, bucket_minutes: size, points: buckets, peak: peak && peak.rx + peak.tx ? peak : null, total, span_minutes: span };
  }

  connections(key) {
    return this.store.connections(key).map((c) => ({ ...c, domain: c.domain || this.dns.get(c.remote) || null }));
  }

  // ---- actions from the window ------------------------------------------

  ruleFor(key, create) {
    let rule = this.settings.rules[key];
    const info = this.appInfo(key);
    if (!rule && create) {
      rule = { name: info.name, path: info.path, blocked: false, keep_forever: false, record_connections: false, cap: null };
      this.settings.rules[key] = rule;
    }
    if (rule) {
      rule.name = info.name || rule.name;
      rule.path = info.path || rule.path;
    }
    return rule;
  }

  cleanupRule(key) {
    const rule = this.settings.rules[key];
    if (rule && isEmptyRule(rule)) delete this.settings.rules[key];
  }

  changed() {
    this.dirty = false;
    this.lastSave = this.now();
    this.emit("save");
  }

  setBlocked(key, blocked) {
    const rule = this.ruleFor(key, true);
    if (!this.canBlock(rule)) {
      this.cleanupRule(key);
      throw new Error(this.capabilities.block ? "This app has no program file to block." : "Blocking is not available on this system.");
    }
    rule.blocked = !!blocked;
    // Unblocking by hand also lifts a cap block for the rest of the period.
    if (!blocked && rule.cap && rule.cap.enforced) rule.cap.enforced = false;
    this.syncBlock(key);
    this.cleanupRule(key);
    this.changed();
  }

  setCap(key, { limit_bytes, period }) {
    const rule = this.ruleFor(key, true);
    const now = this.now();
    const next = normalizeCap({ limit_bytes, period, used_bytes: 0, period_start: periodStart(period, now) || now });
    if (!next) {
      this.cleanupRule(key);
      throw new Error("Enter a data cap larger than zero.");
    }
    const prev = rule.cap;
    if (prev && prev.period === next.period) {
      next.used_bytes = prev.used_bytes;
      next.period_start = prev.period_start;
    }
    rule.cap = next;
    if (prev && prev.enforced && next.used_bytes < next.limit_bytes) this.syncBlock(key);
    else if (prev && prev.enforced) {
      next.enforced = true;
      next.notified = true;
    }
    this.checkCap(key, rule);
    this.changed();
  }

  clearCap(key) {
    const rule = this.settings.rules[key];
    if (!rule || !rule.cap) return;
    const wasEnforced = rule.cap.enforced;
    rule.cap = null;
    if (wasEnforced) this.syncBlock(key);
    this.cleanupRule(key);
    this.changed();
  }

  resetCap(key) {
    const rule = this.settings.rules[key];
    if (!rule || !rule.cap) return;
    const now = this.now();
    const wasEnforced = rule.cap.enforced;
    rule.cap.used_bytes = 0;
    rule.cap.period_start = periodStart(rule.cap.period, now) || now;
    rule.cap.notified = false;
    rule.cap.enforced = false;
    if (wasEnforced) this.syncBlock(key);
    this.changed();
  }

  setKeepForever(key, on) {
    const rule = this.ruleFor(key, true);
    rule.keep_forever = !!on;
    this.cleanupRule(key);
    this.changed();
  }

  setRecordConnections(key, on) {
    const rule = this.ruleFor(key, true);
    rule.record_connections = !!on;
    this.cleanupRule(key);
    this.emit("flows", this.flowKeys());
    this.changed();
  }

  focus(key) {
    if (!this.settings.focus.some((a) => a.key === key)) this.settings.focus.push({ key, name: this.appInfo(key).name });
    this.settings.ignore = this.settings.ignore.filter((a) => a.key !== key);
    this.refreshLists();
    this.emit("flows", this.flowKeys());
    this.changed();
  }

  unfocus(key) {
    this.settings.focus = key == null ? [] : this.settings.focus.filter((a) => a.key !== key);
    this.refreshLists();
    this.emit("flows", this.flowKeys());
    this.changed();
  }

  ignore(key) {
    if (!this.settings.ignore.some((a) => a.key === key)) this.settings.ignore.push({ key, name: this.appInfo(key).name });
    this.settings.focus = this.settings.focus.filter((a) => a.key !== key);
    this.live.delete(key);
    this.refreshLists();
    this.emit("flows", this.flowKeys());
    this.changed();
  }

  unignore(key) {
    this.settings.ignore = this.settings.ignore.filter((a) => a.key !== key);
    this.refreshLists();
    this.emit("flows", this.flowKeys());
    this.changed();
  }

  deleteApp(key) {
    this.store.deleteApp(key);
    this.live.delete(key);
  }

  deleteConnections(key) {
    this.store.deleteConnections(key);
  }

  deleteOlderThan(minutes) {
    this.store.deleteOlderThan(minuteOf(this.now()) - Math.max(0, Number(minutes) || 0) + 1);
  }

  deleteAll() {
    this.store.deleteAll();
    this.live.clear();
  }
}

module.exports = { Engine, periodStart, minuteOf, BUCKETS };
