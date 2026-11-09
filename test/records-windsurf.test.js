const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { createRecordReader } = require("../src/session-records");

const NOW = Date.parse("2026-10-15T12:00:00Z");
const entry = (tool, cli, label, o) => (typeof o.id === "string" && o.id && Number.isFinite(o.last_active) ? { tool, cli, label, ...o } : null);

// Points the reader at a fresh sessions.db and returns the database handle to fill.
function fixture(t, sql) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "um-windsurf-records-"));
  const saved = process.env.DEVIN_SESSIONS_DIR;
  process.env.DEVIN_SESSIONS_DIR = dir;
  t.after(() => {
    if (saved === undefined) delete process.env.DEVIN_SESSIONS_DIR;
    else process.env.DEVIN_SESSIONS_DIR = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const db = new DatabaseSync(path.join(dir, "sessions.db"));
  db.exec(sql);
  return db;
}

const SCHEMA = "CREATE TABLE sessions (id TEXT, working_directory TEXT, model TEXT, title TEXT, created_at TEXT, last_activity_at TEXT, hidden INTEGER)";

test("Devin CLI sessions are listed with ISO and numeric times, hidden ones left out", (t) => {
  const db = fixture(t, SCHEMA);
  const insert = db.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?)");
  insert.run("brisk-otter", "C:\\work\\app", "swe-1.6", "Fix the build", "2026-10-15T10:00:00Z", "2026-10-15T11:00:00Z", null);
  insert.run("calm-heron", "C:\\work\\lib", null, "", 1792070000, 1792073600, 0);
  insert.run("quiet-fox", "C:\\work\\old", "swe-1.6", "Hidden", "2026-10-14T10:00:00Z", "2026-10-14T11:00:00Z", 1);
  db.close();
  const rows = require("../src/records/windsurf").read({ entry, home: "", platform: "win32", now: NOW });
  assert.deepEqual(rows.map((r) => r.id), ["calm-heron", "brisk-otter"]);
  const otter = rows.find((r) => r.id === "brisk-otter");
  assert.equal(otter.cli, "windsurf");
  assert.equal(otter.label, "Devin CLI");
  assert.equal(otter.name, "Fix the build");
  assert.equal(otter.cwd, "C:\\work\\app");
  assert.equal(otter.model, "swe-1.6");
  assert.equal(otter.started, Date.parse("2026-10-15T10:00:00Z"));
  assert.equal(otter.last_active, Date.parse("2026-10-15T11:00:00Z"));
  const heron = rows.find((r) => r.id === "calm-heron");
  assert.equal(heron.last_active, 1792073600 * 1000);
  assert.equal(heron.started, 1792070000 * 1000);
});

test("a database without the hidden column still lists its sessions", (t) => {
  const db = fixture(t, "CREATE TABLE sessions (id TEXT, working_directory TEXT, model TEXT, title TEXT, created_at INTEGER, last_activity_at INTEGER)");
  db.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?)").run("a-b", "/w/x", "m", "T", NOW - 5000, NOW);
  db.close();
  const rows = require("../src/records/windsurf").read({ entry });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].last_active, NOW);
});

test("a missing database or an unreadable one gives no rows and never throws", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "um-windsurf-records-"));
  const saved = process.env.DEVIN_SESSIONS_DIR;
  process.env.DEVIN_SESSIONS_DIR = dir;
  t.after(() => {
    if (saved === undefined) delete process.env.DEVIN_SESSIONS_DIR;
    else process.env.DEVIN_SESSIONS_DIR = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const reader = require("../src/records/windsurf");
  assert.deepEqual(reader.read({ entry }), []);
  fs.writeFileSync(path.join(dir, "sessions.db"), "not a database");
  assert.deepEqual(reader.read({ entry }), []);
});

test("the shared record reader includes Devin CLI sessions", (t) => {
  const db = fixture(t, SCHEMA);
  db.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?)").run("swift-lynx", "/w/p", "m", "Task", "2026-10-15T09:00:00Z", "2026-10-15T09:30:00Z", 0);
  db.close();
  const none = path.join(os.tmpdir(), "um-windsurf-none");
  const reader = createRecordReader({ claudeDir: () => none, codexDir: () => none, grokDir: () => none, cursorDir: () => none,
    geminiDir: () => none, copilotDir: () => none, now: () => NOW, platform: "win32" });
  assert.deepEqual(reader.read().filter((r) => r.cli === "windsurf").map((r) => r.id), ["swift-lynx"]);
});
