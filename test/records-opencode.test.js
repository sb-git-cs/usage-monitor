const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { load } = require("./helpers");
const { entry } = load("src/session-records.js", {}, ["entry"]);

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "um-opencode-rec-"));
  const saved = process.env.OPENCODE_DB;
  delete process.env.OPENCODE_DB;
  t.after(() => {
    if (saved === undefined) delete process.env.OPENCODE_DB; else process.env.OPENCODE_DB = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const reader = load("src/records/opencode.js", { "../paths": { opencodeDataDir: () => dir } });
  return { dir, read: () => reader.read({ entry, home: () => dir, platform: "win32", now: Date.now() }) };
}

function makeDb(file, rows) {
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE session_v2 (id TEXT, directory TEXT, title TEXT, model TEXT, time_created INTEGER, time_updated INTEGER, time_archived INTEGER, parent_id TEXT)");
  const insert = db.prepare("INSERT INTO session_v2 VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  for (const r of rows) insert.run(r.id, r.directory ?? "D:\\work\\api", r.title ?? null, r.model ?? null, r.created ?? 1000, r.updated, r.archived ?? null, r.parent ?? null);
  db.close();
}

const model = JSON.stringify({ id: "kimi-k2", providerID: "opencode-go" });

test("no database gives an empty list", (t) => {
  assert.deepEqual(setup(t).read(), []);
});

test("top-level, unarchived sessions are listed newest first with their model", (t) => {
  const { dir, read } = setup(t);
  makeDb(path.join(dir, "opencode.db"), [
    { id: "ses_a", title: "Fix tests", model, created: 1_780_000_000_000, updated: 1_780_000_500_000 },
    { id: "ses_b", updated: 1_780_000_900_000, model: "not json" },
    { id: "ses_c", updated: 1_780_000_950_000, archived: 1_780_000_960_000 },
    { id: "ses_d", updated: 1_780_000_970_000, parent: "ses_a" },
  ]);
  const rows = read();
  assert.deepEqual(rows.map((r) => r.id), ["ses_b", "ses_a"]);
  assert.equal(rows[1].name, "Fix tests");
  assert.equal(rows[1].cwd, "D:\\work\\api");
  assert.equal(rows[1].model, "kimi-k2");
  assert.equal(rows[1].started, 1_780_000_000_000);
  assert.equal(rows[1].last_active, 1_780_000_500_000);
  assert.equal(rows[1].tool, "opencode");
  assert.equal(rows[1].cli, "opencode");
  assert.equal(rows[0].name, "api");
  assert.equal("model" in rows[0], false);
});

test("second-sized times are converted and only the newest 40 are kept", (t) => {
  const { dir, read } = setup(t);
  const rows = Array.from({ length: 45 }, (_, i) => ({ id: `ses_${i}`, created: 1_780_000_000, updated: 1_780_000_000 + i }));
  makeDb(path.join(dir, "opencode.db"), rows);
  const out = read();
  assert.equal(out.length, 40);
  assert.equal(out[0].id, "ses_44");
  assert.equal(out[0].last_active, 1_780_000_044_000);
});

test("a database without session_v2 gives an empty list, and changes are re-read", (t) => {
  const { dir, read } = setup(t);
  const file = path.join(dir, "opencode.db");
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE session (id TEXT)");
  db.close();
  assert.deepEqual(read(), []);
  fs.rmSync(file);
  makeDb(file, [{ id: "ses_x", updated: 1_780_000_000_000 }]);
  assert.deepEqual(read().map((r) => r.id), ["ses_x"]);
  assert.equal(read().length, 1, "an unchanged file is served from the cache");
});
