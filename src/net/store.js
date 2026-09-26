// Records database: per-minute byte counts per app plus optional connection logs.
// Uses the SQLite built into Node/Electron, so no native module is compiled per platform.
const fs = require("fs");
const path = require("path");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS apps (
  id INTEGER PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  name TEXT,
  path TEXT
);
CREATE TABLE IF NOT EXISTS usage (
  app_id INTEGER NOT NULL,
  minute INTEGER NOT NULL,
  rx INTEGER NOT NULL DEFAULT 0,
  tx INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (app_id, minute)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS usage_minute ON usage(minute);
CREATE TABLE IF NOT EXISTS connections (
  app_id INTEGER NOT NULL,
  remote TEXT NOT NULL,
  port INTEGER NOT NULL,
  proto TEXT NOT NULL,
  domain TEXT,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  rx INTEGER NOT NULL DEFAULT 0,
  tx INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (app_id, remote, port, proto)
);
CREATE INDEX IF NOT EXISTS connections_seen ON connections(last_seen);
`;

const DB_NAME = "network.db";

function driver() {
  // Loaded lazily: node:sqlite prints an experimental warning on some Node versions.
  return require("node:sqlite");
}

function removeDbFiles(file) {
  for (const f of [file, `${file}-wal`, `${file}-shm`]) {
    try {
      fs.rmSync(f, { force: true });
    } catch {
      /* ignore */
    }
  }
}

class Store {
  constructor(file) {
    this.file = file;
    this.db = null;
    this.recovered = null;
    this.open();
  }

  open() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    try {
      this.connect();
    } catch (err) {
      if (!/malformed|not a database|corrupt/i.test(String(err.message || err))) throw err;
      // A damaged database must not stop monitoring: keep it aside and start fresh.
      try {
        if (this.db) this.db.close();
      } catch {
        /* ignore */
      }
      const aside = `${this.file}.damaged-${Date.now()}`;
      try {
        fs.renameSync(this.file, aside);
      } catch {
        /* ignore */
      }
      removeDbFiles(this.file);
      this.recovered = { error: String(err.message || err), movedTo: aside };
      this.connect();
    }
  }

  connect() {
    const { DatabaseSync } = driver();
    this.db = new DatabaseSync(this.file);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=3000;");
    this.db.exec(SCHEMA);
    this.db.prepare("SELECT COUNT(*) AS n FROM apps").get();
    this.ids = new Map();
    this.apps = new Map();
    for (const row of this.db.prepare("SELECT id, key, name, path FROM apps").all()) {
      this.ids.set(row.key, row.id);
      this.apps.set(row.id, { key: row.key, name: row.name, path: row.path });
    }
    this.pendingUsage = new Map();
    this.pendingFlows = new Map();
    this.q = {
      insertApp: this.db.prepare("INSERT INTO apps (key, name, path) VALUES (?, ?, ?)"),
      renameApp: this.db.prepare("UPDATE apps SET name = ?, path = ? WHERE id = ?"),
      addUsage: this.db.prepare(
        "INSERT INTO usage (app_id, minute, rx, tx) VALUES (?, ?, ?, ?) " +
          "ON CONFLICT (app_id, minute) DO UPDATE SET rx = rx + excluded.rx, tx = tx + excluded.tx"
      ),
      addFlow: this.db.prepare(
        "INSERT INTO connections (app_id, remote, port, proto, domain, first_seen, last_seen, rx, tx) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) " +
          "ON CONFLICT (app_id, remote, port, proto) DO UPDATE SET rx = rx + excluded.rx, tx = tx + excluded.tx, " +
          "last_seen = MAX(last_seen, excluded.last_seen), domain = COALESCE(excluded.domain, domain)"
      ),
    };
  }

  close() {
    if (!this.db) return;
    try {
      this.flush();
    } finally {
      this.db.close();
      this.db = null;
    }
  }

  sizeBytes() {
    let total = 0;
    for (const f of [this.file, `${this.file}-wal`]) {
      try {
        total += fs.statSync(f).size;
      } catch {
        /* missing */
      }
    }
    return total;
  }

  appId(key, name, appPath) {
    let id = this.ids.get(key);
    if (id == null) {
      id = Number(this.q.insertApp.run(key, name || key, appPath || null).lastInsertRowid);
      this.ids.set(key, id);
      this.apps.set(id, { key, name: name || key, path: appPath || null });
      return id;
    }
    const app = this.apps.get(id);
    if (app && ((name && name !== app.name) || (appPath && appPath !== app.path))) {
      app.name = name || app.name;
      app.path = appPath || app.path;
      this.q.renameApp.run(app.name, app.path, id);
    }
    return id;
  }

  appInfo(key) {
    const id = this.ids.get(key);
    return id == null ? null : this.apps.get(id) || null;
  }

  addUsage(id, minute, rx, tx) {
    const k = `${id}:${minute}`;
    const cur = this.pendingUsage.get(k);
    if (cur) {
      cur.rx += rx;
      cur.tx += tx;
    } else this.pendingUsage.set(k, { id, minute, rx, tx });
  }

  addFlow(id, remote, port, proto, domain, rx, tx, sec) {
    const k = `${id}|${remote}|${port}|${proto}`;
    const cur = this.pendingFlows.get(k);
    if (cur) {
      cur.rx += rx;
      cur.tx += tx;
      cur.last = Math.max(cur.last, sec);
      cur.domain = domain || cur.domain;
    } else this.pendingFlows.set(k, { id, remote, port, proto, domain: domain || null, first: sec, last: sec, rx, tx });
  }

  flush() {
    if (!this.pendingUsage.size && !this.pendingFlows.size) return;
    const usage = [...this.pendingUsage.values()];
    const flows = [...this.pendingFlows.values()];
    this.db.exec("BEGIN");
    try {
      for (const u of usage) this.q.addUsage.run(u.id, u.minute, u.rx, u.tx);
      for (const f of flows) this.q.addFlow.run(f.id, f.remote, f.port, f.proto, f.domain, f.first, f.last, f.rx, f.tx);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    this.pendingUsage.clear();
    this.pendingFlows.clear();
  }

  // Per-app totals since a minute (inclusive), including unflushed data.
  totals(sinceMinute) {
    const byId = new Map();
    const rows = this.db
      .prepare("SELECT app_id AS id, SUM(rx) AS rx, SUM(tx) AS tx, MIN(minute) AS first FROM usage WHERE minute >= ? GROUP BY app_id")
      .all(sinceMinute);
    for (const r of rows) byId.set(r.id, { rx: r.rx, tx: r.tx, first: r.first });
    for (const u of this.pendingUsage.values()) {
      if (u.minute < sinceMinute) continue;
      const cur = byId.get(u.id) || { rx: 0, tx: 0, first: u.minute };
      cur.rx += u.rx;
      cur.tx += u.tx;
      cur.first = Math.min(cur.first, u.minute);
      byId.set(u.id, cur);
    }
    const out = [];
    for (const [id, t] of byId) {
      const app = this.apps.get(id);
      if (app) out.push({ key: app.key, name: app.name, path: app.path, rx: t.rx, tx: t.tx, first: t.first });
    }
    return out;
  }

  earliestMinute() {
    const row = this.db.prepare("SELECT MIN(minute) AS m FROM usage").get();
    let m = row && row.m != null ? row.m : null;
    for (const u of this.pendingUsage.values()) m = m == null ? u.minute : Math.min(m, u.minute);
    return m;
  }

  series(key, sinceMinute) {
    const id = this.ids.get(key);
    if (id == null) return [];
    const byMinute = new Map();
    for (const r of this.db.prepare("SELECT minute, rx, tx FROM usage WHERE app_id = ? AND minute >= ?").all(id, sinceMinute)) {
      byMinute.set(r.minute, { minute: r.minute, rx: r.rx, tx: r.tx });
    }
    for (const u of this.pendingUsage.values()) {
      if (u.id !== id || u.minute < sinceMinute) continue;
      const cur = byMinute.get(u.minute) || { minute: u.minute, rx: 0, tx: 0 };
      cur.rx += u.rx;
      cur.tx += u.tx;
      byMinute.set(u.minute, cur);
    }
    return [...byMinute.values()].sort((a, b) => a.minute - b.minute);
  }

  connections(key, limit = 2000) {
    const id = this.ids.get(key);
    if (id == null) return [];
    const byKey = new Map();
    const rows = this.db
      .prepare(
        "SELECT remote, port, proto, domain, first_seen, last_seen, rx, tx FROM connections WHERE app_id = ? ORDER BY rx + tx DESC LIMIT ?"
      )
      .all(id, limit);
    for (const r of rows) byKey.set(`${r.remote}|${r.port}|${r.proto}`, { ...r });
    for (const f of this.pendingFlows.values()) {
      if (f.id !== id) continue;
      const k = `${f.remote}|${f.port}|${f.proto}`;
      const cur = byKey.get(k);
      if (cur) {
        cur.rx += f.rx;
        cur.tx += f.tx;
        cur.last_seen = Math.max(cur.last_seen, f.last);
        cur.domain = cur.domain || f.domain;
      } else {
        byKey.set(k, { remote: f.remote, port: f.port, proto: f.proto, domain: f.domain, first_seen: f.first, last_seen: f.last, rx: f.rx, tx: f.tx });
      }
    }
    return [...byKey.values()].sort((a, b) => b.rx + b.tx - (a.rx + a.tx));
  }

  setDomain(remote, domain) {
    this.db.prepare("UPDATE connections SET domain = ? WHERE remote = ? AND domain IS NULL").run(domain, remote);
    for (const f of this.pendingFlows.values()) if (f.remote === remote && !f.domain) f.domain = domain;
  }

  // Deletes minutes and connections older than the cutoff, except for kept apps.
  prune(cutoffMinute, keepKeys) {
    this.flush();
    const keep = JSON.stringify([...keepKeys]);
    const kept = "SELECT a.id FROM apps a WHERE a.key IN (SELECT value FROM json_each(?))";
    this.db.prepare(`DELETE FROM usage WHERE minute < ? AND app_id NOT IN (${kept})`).run(cutoffMinute, keep);
    this.db.prepare(`DELETE FROM connections WHERE last_seen < ? AND app_id NOT IN (${kept})`).run(cutoffMinute * 60, keep);
  }

  deleteApp(key) {
    const id = this.ids.get(key);
    if (id == null) return;
    for (const [k, u] of this.pendingUsage) if (u.id === id) this.pendingUsage.delete(k);
    for (const [k, f] of this.pendingFlows) if (f.id === id) this.pendingFlows.delete(k);
    this.db.prepare("DELETE FROM usage WHERE app_id = ?").run(id);
    this.db.prepare("DELETE FROM connections WHERE app_id = ?").run(id);
  }

  deleteConnections(key) {
    const id = this.ids.get(key);
    if (id == null) return;
    for (const [k, f] of this.pendingFlows) if (f.id === id) this.pendingFlows.delete(k);
    this.db.prepare("DELETE FROM connections WHERE app_id = ?").run(id);
  }

  deleteOlderThan(cutoffMinute) {
    this.flush();
    this.db.prepare("DELETE FROM usage WHERE minute < ?").run(cutoffMinute);
    this.db.prepare("DELETE FROM connections WHERE last_seen < ?").run(cutoffMinute * 60);
  }

  deleteAll() {
    this.pendingUsage.clear();
    this.pendingFlows.clear();
    this.db.exec("DELETE FROM usage; DELETE FROM connections; DELETE FROM apps;");
    this.ids.clear();
    this.apps.clear();
    this.db.exec("VACUUM");
  }

  // Moves the records to another folder, or switches to a database already there.
  relocate(dir, { useExisting = false } = {}) {
    const target = path.join(dir, DB_NAME);
    if (path.resolve(target) === path.resolve(this.file)) return this.file;
    fs.mkdirSync(dir, { recursive: true });
    this.flush();
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    const exists = fs.existsSync(target);
    if (exists && !useExisting) throw Object.assign(new Error("A records database already exists in that folder."), { code: "EEXIST" });
    const previous = this.file;
    this.db.close();
    this.db = null;
    try {
      if (!exists) {
        fs.copyFileSync(previous, target);
      }
      this.file = target;
      this.open();
    } catch (err) {
      this.file = previous;
      this.open();
      throw err;
    }
    if (!exists) removeDbFiles(previous);
    return this.file;
  }
}

module.exports = { Store, DB_NAME };
