const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createRecordReader } = require("../src/session-records");

const NOW = Date.parse("2026-10-15T12:00:00Z");
const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

// The reader finds Qwen's folder through QWEN_HOME; only the qwen rows are kept.
function qwenRows(t, build) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "um-qwen-rec-"));
  const none = path.join(dir, "none");
  const saved = process.env.QWEN_HOME;
  process.env.QWEN_HOME = path.join(dir, ".qwen");
  t.after(() => {
    if (saved === undefined) delete process.env.QWEN_HOME; else process.env.QWEN_HOME = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  build(path.join(dir, ".qwen", "projects"));
  const reader = createRecordReader({ claudeDir: () => none, codexDir: () => none, grokDir: () => none, cursorDir: () => none,
    geminiDir: () => none, copilotDir: () => none, now: () => NOW, platform: "win32" });
  return () => reader.read().filter((r) => r.cli === "qwen").sort((a, b) => a.id.localeCompare(b.id));
}

test("Qwen chats list with name, folder, times and model; sidecars and bad lines are skipped", (t) => {
  const read = qwenRows(t, (projects) => {
    const chats = path.join(projects, "d--work-api", "chats");
    write(path.join(chats, "aaa.jsonl"), jsonl([
      { sessionId: "aaa", timestamp: "2026-10-15T10:00:00Z", type: "user", cwd: "D:\\work\\api", message: "fix the parser\nsecond line" },
      { sessionId: "aaa", timestamp: "2026-10-15T10:01:00Z", type: "assistant", cwd: "D:\\work\\api", model: "qwen3-coder-plus", message: "ok" },
    ]) + "{not json\n" + jsonl([
      { sessionId: "aaa", timestamp: "2026-10-15T10:05:00Z", type: "assistant", cwd: "D:\\work\\api", model: "qwen3-max", message: "done" },
    ]));
    write(path.join(chats, "bbb.jsonl"), jsonl([
      { sessionId: "bbb", timestamp: "2026-10-15T09:00:00Z", type: "user", cwd: "D:\\work\\api", message: [{ text: "write tests" }, { text: "for it" }] },
    ]));
    write(path.join(chats, "aaa.runtime.json"), JSON.stringify({ pid: 1 }));
    write(path.join(chats, "notes.txt"), "x");
  });
  const rows = read();
  assert.equal(rows.length, 2);
  const [a, b] = rows;
  assert.equal(a.id, "aaa");
  assert.equal(a.name, "fix the parser");
  assert.equal(a.cwd, "D:\\work\\api");
  assert.equal(a.tool, "qwen");
  assert.equal(a.label, "Qwen Code");
  assert.equal(a.model, "qwen3-max");
  assert.equal(a.started, Date.parse("2026-10-15T10:00:00Z"));
  assert.equal(a.last_active, Date.parse("2026-10-15T10:05:00Z"));
  assert.equal(b.id, "bbb");
  assert.equal(b.name, "write tests");
  assert.equal(b.model, undefined);
});

test("a chat without a prompt is named by its folder, and a missing store is empty", (t) => {
  const read = qwenRows(t, (projects) => {
    write(path.join(projects, "x", "chats", "ccc.jsonl"), jsonl([
      { sessionId: "ccc", timestamp: "2026-10-15T08:00:00Z", type: "system", cwd: "D:\\work\\site" },
    ]));
  });
  assert.equal(read()[0].name, "site");
  assert.deepEqual(qwenRows(t, () => {})(), []);
});

test("only the newest 40 chats are read, and a changed file is read again", (t) => {
  let file;
  const read = qwenRows(t, (projects) => {
    for (let i = 0; i < 45; i++) {
      file = path.join(projects, "p", "chats", `s${String(i).padStart(2, "0")}.jsonl`);
      write(file, jsonl([{ sessionId: `s${i}`, timestamp: "2026-10-15T08:00:00Z", type: "user", cwd: "D:\\p", message: "hi" }]));
      const at = new Date(NOW - (45 - i) * 60_000);
      fs.utimesSync(file, at, at);
    }
  });
  assert.equal(read().length, 40);
  assert.ok(!read().some((r) => r.id === "s0"));
  fs.appendFileSync(file, jsonl([{ sessionId: "s44", timestamp: "2026-10-15T11:00:00Z", type: "assistant", model: "m2" }]));
  assert.equal(read().find((r) => r.id === "s44").model, "m2");
});
