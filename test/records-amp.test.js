const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createRecordReader } = require("../src/session-records");

const NOW = Date.parse("2026-10-15T12:00:00Z");

function write(file, text, mtime) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  if (mtime) fs.utimesSync(file, mtime / 1000, mtime / 1000);
}

test("Amp threads, including one in a subfolder and one cut off, become session rows", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "um-amp-rec-"));
  const saved = process.env.AMP_DATA_HOME;
  process.env.AMP_DATA_HOME = dir;
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    if (saved === undefined) delete process.env.AMP_DATA_HOME; else process.env.AMP_DATA_HOME = saved;
  });
  const threads = path.join(dir, "threads");
  write(path.join(threads, "T-one.json"), JSON.stringify({
    id: "T-one", created: NOW - 5_000_000,
    env: { initial: { trees: [{ uri: "file:///D:/work/my%20app" }] } },
    messages: [
      { role: "user", content: [{ type: "text", text: "Fix the parser\nmore detail" }] },
      { role: "assistant", usage: { model: "claude-opus-5-5", timestamp: "2026-10-15T10:00:00Z" } },
      { role: "user", content: [{ type: "text", text: "thanks" }], meta: { sentAt: NOW - 600_000 } },
    ],
  }), NOW - 100_000);
  write(path.join(threads, "sub", "T-two.json"), JSON.stringify({
    id: "T-two", created: NOW - 9_000_000, env: { initial: { trees: [] } },
    messages: [{ role: "user", content: "plain string prompt" }],
  }), NOW - 200_000);
  const filler = "x".repeat(300 * 1024);
  write(path.join(threads, "T-cut.json"),
    `{"id":"T-cut","created":${NOW - 7_000_000},"env":{"initial":{"trees":[{"uri":"file:///D:/work/cut"}]}},"messages":[{"role":"user","content":"${filler}"}]}`, NOW - 300_000);
  write(path.join(threads, "notes.json"), "{}");
  write(path.join(threads, "T-bad.json"), "not json at all");

  const none = path.join(dir, "none");
  const reader = createRecordReader({ claudeDir: () => none, codexDir: () => none, grokDir: () => none, cursorDir: () => none,
    geminiDir: () => none, copilotDir: () => none, now: () => NOW, platform: "win32" });
  const rows = reader.read().filter((r) => r.cli === "amp");
  const by = Object.fromEntries(rows.map((r) => [r.id, r]));
  assert.deepEqual(Object.keys(by).sort(), ["T-cut", "T-one", "T-two"]);

  assert.deepEqual(by["T-one"], { tool: "amp", cli: "amp", label: "Amp", name: "Fix the parser", cwd: "D:\\work\\my app", id: "T-one",
    started: NOW - 5_000_000, last_active: NOW - 600_000, model: "claude-opus-5-5" });
  assert.equal(by["T-two"].name, "plain string prompt");
  assert.equal(by["T-two"].last_active, NOW - 200_000, "falls back to the file time");
  assert.equal(by["T-two"].model, undefined);
  assert.equal(by["T-cut"].cwd, "D:\\work\\cut");
  assert.equal(by["T-cut"].started, NOW - 7_000_000);
  assert.equal(by["T-cut"].name, "cut", "no readable message: the folder names it");

  // A second read serves the same rows from the cache.
  assert.deepEqual(reader.read().filter((r) => r.cli === "amp"), rows);
});

test("Amp rows are empty, not an error, when there is no threads folder", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "um-amp-rec-"));
  const saved = process.env.AMP_DATA_HOME;
  process.env.AMP_DATA_HOME = path.join(dir, "missing");
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    if (saved === undefined) delete process.env.AMP_DATA_HOME; else process.env.AMP_DATA_HOME = saved;
  });
  assert.deepEqual(require("../src/records/amp").read({ entry: () => assert.fail("no rows"), platform: "win32" }), []);
});
