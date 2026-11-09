const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { load } = require("./helpers");

const NOW = Date.parse("2026-10-15T12:00:00Z");
// The real entry builder, so the rows have the shape the recent list expects.
const entry = load("src/session-records.js", {}, ["entry"]).entry;

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "um-kimi-rec-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const root = path.join(home, ".kimi-code");
  const write = (file, text) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof text === "string" ? text : JSON.stringify(text));
  };
  return { home, root, write };
}

function read(home) {
  const prev = process.env.KIMI_CODE_HOME;
  delete process.env.KIMI_CODE_HOME;
  try {
    return load("src/records/kimi.js").read({ entry, home: () => home, platform: "win32", now: NOW });
  } finally {
    if (prev !== undefined) process.env.KIMI_CODE_HOME = prev;
  }
}

test("sessions come from the index and each state file, with the model from the wire file", (t) => {
  const { home, root, write } = fixture(t);
  const a = path.join(root, "sessions", "a");
  const b = path.join(root, "sessions", "b");
  const c = path.join(root, "sessions", "c");
  write(path.join(root, "session_index.jsonl"), [
    JSON.stringify({ sessionId: "sa", sessionDir: a, workDir: "D:\\work\\api" }),
    "{not json",
    JSON.stringify({ sessionId: "sb", sessionDir: b, workDir: "D:\\work\\web" }),
    JSON.stringify({ sessionId: "gone", sessionDir: path.join(root, "sessions", "gone"), workDir: "D:\\x" }),
    JSON.stringify({ sessionId: "sc", sessionDir: c, workDir: "D:\\work\\c" }),
    "",
  ].join("\n"));
  write(path.join(a, "state.json"), { title: "Fix parser", lastPrompt: "ignored", createdAt: "2026-10-15T10:00:00Z", updatedAt: "2026-10-15T11:00:00Z" });
  write(path.join(a, "agents", "main", "wire.jsonl"), [
    JSON.stringify({ type: "user" }),
    JSON.stringify({ metadata: { model: "kimi-k2.7" } }),
    JSON.stringify({ type: "other" }),
  ].join("\n"));
  write(path.join(b, "state.json"), { lastPrompt: "add tests", createdAt: NOW - 7200_000, updatedAt: NOW - 3600_000 });
  write(path.join(b, "agents", "main", "wire.jsonl"), JSON.stringify({ generation_model: "old" }) + "\n" + JSON.stringify({ model: "kimi-k3" }) + "\n");
  write(path.join(c, "state.json"), { title: "No wire" });

  const rows = read(home).sort((x, y) => x.id.localeCompare(y.id));
  assert.deepEqual(rows.map((r) => r.id), ["sa", "sb", "sc"]);
  const [ra, rb, rc] = rows;
  assert.equal(ra.name, "Fix parser");
  assert.equal(ra.cwd, "D:\\work\\api");
  assert.equal(ra.tool, "kimi");
  assert.equal(ra.label, "Kimi Code");
  assert.equal(ra.model, "kimi-k2.7");
  assert.equal(ra.started, Date.parse("2026-10-15T10:00:00Z"));
  assert.ok(ra.last_active >= Date.parse("2026-10-15T11:00:00Z"));
  assert.equal(rb.name, "add tests");
  assert.equal(rb.model, "kimi-k3");
  assert.equal(rb.started, NOW - 7200_000);
  assert.equal("model" in rc, false);
});

test("a missing index or an unreadable state gives what there is, never an error", (t) => {
  const { home, root, write } = fixture(t);
  assert.deepEqual(read(home), []);
  const dir = path.join(root, "sessions", "x");
  write(path.join(root, "session_index.jsonl"), JSON.stringify({ sessionId: "sx", sessionDir: dir, workDir: "D:\\w" }) + "\n");
  write(path.join(dir, "state.json"), "{broken");
  const rows = read(home);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, "w");
});

test("the wire file is read only from its last 64 KB", (t) => {
  const { home, root, write } = fixture(t);
  const dir = path.join(root, "sessions", "big");
  write(path.join(root, "session_index.jsonl"), JSON.stringify({ sessionId: "big", sessionDir: dir, workDir: "D:\\w" }) + "\n");
  write(path.join(dir, "state.json"), { title: "Big" });
  const filler = JSON.stringify({ text: "x".repeat(1000) }) + "\n";
  write(path.join(dir, "agents", "main", "wire.jsonl"), JSON.stringify({ model: "too-early" }) + "\n" + filler.repeat(100));
  assert.equal("model" in read(home)[0], false);
});
