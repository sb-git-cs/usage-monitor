const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createRecordReader } = require("../src/session-records");

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "um-kiro-rec-"));
  const saved = process.env.KIRO_HOME;
  process.env.KIRO_HOME = home;
  t.after(() => {
    if (saved === undefined) delete process.env.KIRO_HOME; else process.env.KIRO_HOME = saved;
    fs.rmSync(home, { recursive: true, force: true });
  });
  const put = (hash, id, text) => {
    const dir = path.join(home, "sessions", hash, id);
    fs.mkdirSync(dir, { recursive: true });
    if (text != null) fs.writeFileSync(path.join(dir, "session.json"), text);
  };
  const none = () => path.join(home, "none");
  const reader = createRecordReader({ claudeDir: none, codexDir: none, grokDir: none, cursorDir: none, geminiDir: none, copilotDir: none, platform: "win32" });
  return { put, read: () => reader.read().filter((r) => r.cli === "kiro") };
}

test("V3 sessions become records, newest first; malformed and empty folders are skipped", (t) => {
  const { put, read } = fixture(t);
  put("h1", "sess_a", JSON.stringify({
    id: "sess_a", title: "Fix the parser", createdAt: "2026-11-01T10:00:00Z", lastModifiedAt: "2026-11-01T11:00:00Z",
    workspacePaths: ["D:\\work\\api", "D:\\other"], modelId: "claude-sonnet-4.5",
  }));
  put("h2", "sess_b", JSON.stringify({ id: "sess_b", createdAt: 1793600000000, lastModifiedAt: 1793600600000, workspacePaths: ["D:\\work\\web"] }));
  put("h2", "sess_bad", "{ not json");
  put("h2", "sess_none", null);
  const rows = read();
  assert.deepEqual(rows.map((r) => r.id), ["sess_b", "sess_a"]);
  const a = rows[1];
  assert.equal(a.tool, "kiro");
  assert.equal(a.cli, "kiro");
  assert.equal(a.label, "Kiro CLI");
  assert.equal(a.name, "Fix the parser");
  assert.equal(a.cwd, "D:\\work\\api");
  assert.equal(a.started, Date.parse("2026-11-01T10:00:00Z"));
  assert.equal(a.last_active, Date.parse("2026-11-01T11:00:00Z"));
  assert.equal(a.model, "claude-sonnet-4.5");
  assert.equal(rows[0].name, "web");
  assert.equal(rows[0].model, undefined);
});

test("a missing sessions folder gives no rows, and only the newest 40 are kept", (t) => {
  const { put, read } = fixture(t);
  assert.deepEqual(read(), []);
  for (let i = 0; i < 45; i++) put("h", `sess_${i}`, JSON.stringify({ id: `sess_${i}`, lastModifiedAt: 1793000000000 + i }));
  const rows = read();
  assert.equal(rows.length, 40);
  assert.equal(rows[0].id, "sess_44");
});

test("an edited session file is read again", (t) => {
  const { put, read } = fixture(t);
  put("h", "sess_x", JSON.stringify({ id: "sess_x", title: "one", lastModifiedAt: 1793000000000 }));
  assert.equal(read()[0].name, "one");
  put("h", "sess_x", JSON.stringify({ id: "sess_x", title: "two renamed", lastModifiedAt: 1793000000000 }));
  assert.equal(read()[0].name, "two renamed");
});
