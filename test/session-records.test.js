const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createRecordReader, readRecords, fromFileUri } = require("../src/session-records");

const NOW = Date.parse("2026-10-15T12:00:00Z");

function tmpdir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "um-records-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";

function reader(root, extra = {}) {
  const none = path.join(root, "none");
  return createRecordReader({ claudeDir: () => none, codexDir: () => none, grokDir: () => none, cursorDir: () => none,
    geminiDir: () => none, copilotDir: () => none, now: () => NOW, platform: "win32", ...extra });
}

const pick = (rows, cli) => rows.filter((r) => r.cli === cli).sort((a, b) => a.id.localeCompare(b.id));

test("missing stores give an empty list", (t) => {
  assert.deepEqual(reader(tmpdir(t)).read(), []);
  const none = path.join(tmpdir(t), "none");
  assert.deepEqual(readRecords({ claudeDir: () => none, codexDir: () => none, grokDir: () => none, cursorDir: () => none,
    geminiDir: () => none, copilotDir: () => none, now: () => NOW }), []);
});

test("Claude Code sessions come from its history, titled from the head of their transcripts", (t) => {
  const dir = tmpdir(t);
  const cwd = "D:\\work\\api";
  const project = path.join(dir, "projects", "D--work-api");
  write(path.join(dir, "history.jsonl"), jsonl([
    { display: "fix the parser please", timestamp: NOW - 7200_000, project: cwd, sessionId: "s1" },
    { display: "and the tests", timestamp: NOW - 3600_000, project: cwd, sessionId: "s1" },
    { display: "run -p", timestamp: NOW - 3000_000, project: cwd, sessionId: "s2" },
    { display: "x".repeat(300), timestamp: NOW - 2000_000, project: cwd, sessionId: "s3" },
    { display: "named one", timestamp: NOW - 1000_000, project: "D:\\other", sessionId: "s4" },
    { display: "deep", timestamp: NOW - 900_000, project: cwd, sessionId: "s5" },
    { display: "late title", timestamp: NOW - 800_000, project: cwd, sessionId: "s6" },
    { display: "no session id", timestamp: NOW },
  ]));
  write(path.join(project, "s1.jsonl"), jsonl([
    { type: "user", entrypoint: "cli", message: { role: "user", content: "fix" } },
    { type: "ai-title", aiTitle: "First title" },
    { type: "agent-name", agentName: "parser-fix" },
    { type: "ai-title", aiTitle: "Fix the parser" },
  ]));
  write(path.join(project, "s2.jsonl"), jsonl([{ type: "user", entrypoint: "sdk-cli" }, { type: "ai-title", aiTitle: "Probe" }]));
  // Found in another project folder, with only a name.
  write(path.join(dir, "projects", "elsewhere", "s4.jsonl"), jsonl([{ type: "user" }, { type: "agent-name", agentName: "named-agent" }]));
  // A sub-agent transcript deeper down is not the session's own.
  write(path.join(project, "s1", "subagents", "s5.jsonl"), jsonl([{ type: "user", entrypoint: "sdk-cli" }]));
  // A title past the first 512 KB is never read.
  write(path.join(project, "s6.jsonl"), jsonl([{ type: "user", entrypoint: "cli", pad: "y".repeat(600 * 1024) }, { type: "ai-title", aiTitle: "Too far" }]));
  const mtime = (NOW - 60_000) / 1000;
  fs.utimesSync(path.join(project, "s1.jsonl"), mtime, mtime);
  const rows = pick(reader(dir, { claudeDir: () => dir }).read(), "claude");
  assert.deepEqual(rows.map((r) => [r.id, r.name]), [["s1", "Fix the parser"], ["s3", `${"x".repeat(79)}…`], ["s4", "named-agent"], ["s5", "deep"], ["s6", "late title"]]);
  const s1 = rows[0];
  assert.deepEqual(s1, { tool: "claude", cli: "claude", label: "Claude Code", name: "Fix the parser", cwd, id: "s1",
    started: NOW - 7200_000, last_active: NOW - 60_000 }, "the transcript's time is newer than the last prompt");
});

function codexDay(root, at) {
  const d = new Date(at);
  return path.join(root, "sessions", String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0"));
}

test("Codex threads the user started in its terminal are listed with their index names", (t) => {
  const dir = tmpdir(t);
  const id = (n) => `aaaaaaaa-0000-0000-0000-00000000000${n}`;
  const meta = (n, payload) => JSON.stringify({ type: "session_meta", payload: { id: id(n), timestamp: new Date(NOW - 3600_000).toISOString(), cwd: "D:\\work\\api", ...payload } });
  const day = codexDay(dir, NOW - 86400_000);
  const rollout = (n, header) => write(path.join(day, `rollout-2026-10-14T10-00-00-${id(n)}.jsonl`), `${header}\n{"type":"event_msg"}\n`);
  rollout(1, meta(1, { originator: "codex-tui", source: "cli", thread_source: "user" }));
  rollout(2, meta(2, { originator: "codex-tui", source: "vscode", thread_source: "user", cwd: "\\\\?\\D:\\work\\web" }));
  rollout(3, meta(3, { originator: "codex_exec", source: "exec" }));
  rollout(4, meta(4, { originator: "codex_vscode", source: "vscode" }));
  rollout(5, meta(5, { originator: "codex-tui", source: { subagent: { other: "guardian" } }, thread_source: "guardian_review" }));
  // A header longer than the 64 KB read: its fields come before the long instructions.
  rollout(6, meta(6, { originator: "codex-tui", source: "cli", base_instructions: { text: "z".repeat(100_000) } }));
  const old = codexDay(dir, NOW - 40 * 86400_000);
  write(path.join(old, `rollout-x-${id(7)}.jsonl`), `${meta(7, { originator: "codex-tui", source: "cli" })}\n`);
  write(path.join(dir, "session_index.jsonl"), jsonl([
    { id: id(1), thread_name: "Old name", updated_at: "2026-10-15T09:00:00.1234567Z" },
    { id: id(1), thread_name: "Fix the build", updated_at: "2026-10-15T10:00:00.1234567Z" },
    { id: id(3), thread_name: "Exec run", updated_at: "2026-10-15T10:00:00Z" },
  ]));
  const file6 = fs.readdirSync(day).find((n) => n.includes(id(6)));
  const mtime = (NOW - 5000) / 1000;
  fs.utimesSync(path.join(day, file6), mtime, mtime);
  // Named two hours ago and not written since: the index time is the newer of the two.
  const file1 = fs.readdirSync(day).find((n) => n.includes(id(1)));
  fs.utimesSync(path.join(day, file1), (NOW - 3 * 3600_000) / 1000, (NOW - 3 * 3600_000) / 1000);
  const rows = pick(reader(dir, { codexDir: () => dir }).read(), "codex");
  assert.deepEqual(rows.map((r) => [r.id, r.name, r.cwd]), [[id(1), "Fix the build", "D:\\work\\api"], [id(2), "web", "D:\\work\\web"], [id(6), "api", "D:\\work\\api"]]);
  assert.equal(rows[0].last_active, Date.parse("2026-10-15T10:00:00.123Z"));
  assert.equal(rows[0].started, NOW - 3600_000);
  assert.equal(rows[2].last_active, NOW - 5000, "with no index row the file's time is used");
});

test("Grok Build sessions come from their summaries, without sub-agents or headless runs", (t) => {
  const dir = tmpdir(t);
  const summary = (cwd, id, body) => write(path.join(dir, "sessions", encodeURIComponent(cwd), id, "summary.json"), JSON.stringify(body));
  summary("D:\\work\\api", "g1", { info: { id: "g1", cwd: "D:\\work\\api" }, generated_title: "Fix billing", created_at: "2026-10-15T09:00:00Z",
    updated_at: "2026-10-15T10:00:00Z", last_active_at: "2026-10-15T10:30:00Z", agent_name: "grok-build-plan" });
  summary("D:\\work\\web", "g2", { session_summary: "Summary only", updated_at: "2026-10-15T08:00:00Z" });
  summary("D:\\work\\api", "g3", { info: { id: "g3" }, session_kind: "subagent", updated_at: "2026-10-15T10:00:00Z" });
  summary("D:\\work\\api", "g4", { info: { id: "g4" }, session_kind: "headless", updated_at: "2026-10-15T10:00:00Z" });
  summary("D:\\work\\api", "g5", { info: { id: "g5" }, agent_name: "explorer", updated_at: "2026-10-15T10:00:00Z" });
  const rows = pick(reader(dir, { grokDir: () => dir }).read(), "grok");
  assert.deepEqual(rows.map((r) => [r.id, r.name, r.cwd, r.started, r.last_active]), [
    ["g1", "Fix billing", "D:\\work\\api", Date.parse("2026-10-15T09:00:00Z"), Date.parse("2026-10-15T10:30:00Z")],
    ["g2", "Summary only", "D:\\work\\web", null, Date.parse("2026-10-15T08:00:00Z")],
  ]);
  assert.equal(rows[0].tool, "grok");
});

test("Cursor Agent chats with a conversation are listed, and unchanged files are not parsed again", (t) => {
  const dir = tmpdir(t);
  const meta = (id, body) => write(path.join(dir, "chats", "h1", id, "meta.json"), JSON.stringify({ cwd: "D:\\work\\cli", createdAtMs: NOW - 7200_000, updatedAtMs: NOW - 600_000, ...body }));
  meta("c1", { title: "Alpha", hasConversation: true });
  meta("c2", { hasConversation: false });
  meta("c3", {});
  const file = path.join(dir, "chats", "h1", "c1", "meta.json");
  const stamp = (NOW - 60_000) / 1000;
  fs.utimesSync(file, stamp, stamp);
  const r = reader(dir, { cursorDir: () => dir });
  const rows = pick(r.read(), "cursor-agent");
  assert.deepEqual(rows.map((x) => [x.id, x.name, x.tool]), [["c1", "Alpha", "cursor"], ["c3", "cli", "cursor"]]);
  // Same size and time: the cached reading stands.
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("Alpha", "Bravo"));
  fs.utimesSync(file, stamp, stamp);
  assert.equal(pick(r.read(), "cursor-agent")[0].name, "Alpha");
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("Bravo", "Charlie"));
  assert.equal(pick(r.read(), "cursor-agent")[0].name, "Charlie");
});

test("Antigravity conversations need their database and are never internal or cloud ones", (t) => {
  const dir = tmpdir(t);
  const root = path.join(dir, "antigravity-cli");
  const conv = (id, summary, extra = {}) => [id, { summary: { ID: id, UpdatedAt: "2026-10-15T10:00:00Z", Internal: false, Cloud: false, ...summary }, is_internal: false, ...extra }];
  write(path.join(root, "cache", "conversation_metadata.json"), JSON.stringify({ conversations: Object.fromEntries([
    conv("a1", { Title: "Compare the CLIs", WorkspaceURIs: ["file:///D:/work/my%20web"] }),
    conv("a2", { Preview: "a preview of the chat" }, { last_modified_time: "2026-10-15T11:00:00+05:30" }),
    conv("a3", { Title: "Internal", Internal: true }),
    conv("a4", { Title: "Flagged" }, { is_internal: true }),
    conv("a5", { Title: "Cloud", Cloud: true }),
    conv("a6", { Title: "No database" }),
  ]) }));
  for (const id of ["a1", "a2", "a3", "a4", "a5"]) write(path.join(root, "conversations", `${id}.db`), "");
  write(path.join(root, "history.jsonl"), jsonl([
    { display: "hi", timestamp: NOW - 9000_000, workspace: "D:\\old", conversationId: "a2" },
    { display: "again", timestamp: NOW - 8000_000, workspace: "D:\\work\\agy", conversationId: "a2" },
    { display: "first", timestamp: NOW - 5000_000, workspace: "D:\\x", conversationId: "a1" },
  ]));
  const rows = pick(reader(dir, { geminiDir: () => dir }).read(), "agy");
  assert.deepEqual(rows, [
    { tool: "gemini", cli: "agy", label: "Antigravity", name: "Compare the CLIs", cwd: "D:\\work\\my web", id: "a1", started: NOW - 5000_000, last_active: Date.parse("2026-10-15T10:00:00Z") },
    { tool: "gemini", cli: "agy", label: "Antigravity", name: "a preview of the chat", cwd: "D:\\work\\agy", id: "a2", started: NOW - 9000_000, last_active: Date.parse("2026-10-15T10:00:00Z") },
  ]);
});

test("file URIs become folder paths on each platform", () => {
  assert.equal(fromFileUri("file:///D:/x/y", "win32"), "D:\\x\\y");
  assert.equal(fromFileUri("file:///home/u/x%20y", "linux"), "/home/u/x y");
  assert.equal(fromFileUri("https://x", "win32"), "");
  assert.equal(fromFileUri("file:///bad%zz", "linux"), "");
});

test("Gemini CLI and Copilot CLI sessions are read on a best-effort basis", (t) => {
  const dir = tmpdir(t);
  const chats = path.join(dir, "tmp", "hash1", "chats");
  write(path.join(chats, "session-1.json"), JSON.stringify({ sessionId: "gm1", startTime: "2026-10-15T08:00:00Z", lastUpdated: "2026-10-15T09:00:00Z",
    directories: ["D:\\work\\gem"], summary: "Gemini work", messages: [] }, null, 2));
  write(path.join(chats, "session-2.jsonl"), jsonl([{ sessionId: "gm2", startTime: "2026-10-15T07:00:00Z", lastUpdated: "2026-10-15T07:30:00Z" }, { type: "message" }]));
  write(path.join(chats, "sub", "session-3.json"), JSON.stringify({ sessionId: "gm3", lastUpdated: "2026-10-15T09:00:00Z" }));
  const state = path.join(dir, "copilot", "session-state", "cp1");
  write(path.join(state, "workspace.yaml"), 'id: cp1\ncwd: D:\\work\\cp\nsummary: "Port the: parser"\n');
  write(path.join(state, "events.jsonl"), "{}\n");
  const mtime = (NOW - 120_000) / 1000;
  fs.utimesSync(path.join(state, "events.jsonl"), mtime, mtime);
  const rows = reader(dir, { geminiDir: () => dir, copilotDir: () => path.join(dir, "copilot") }).read();
  assert.deepEqual(pick(rows, "gemini").map((r) => [r.id, r.name, r.cwd, r.started, r.last_active]), [
    ["gm1", "Gemini work", "D:\\work\\gem", Date.parse("2026-10-15T08:00:00Z"), Date.parse("2026-10-15T09:00:00Z")],
    ["gm2", "Gemini CLI", "", Date.parse("2026-10-15T07:00:00Z"), Date.parse("2026-10-15T07:30:00Z")],
  ]);
  const cp = pick(rows, "copilot");
  assert.deepEqual(cp.map((r) => [r.tool, r.id, r.name, r.cwd, r.last_active]), [["copilot", "cp1", "Port the: parser", "D:\\work\\cp", NOW - 120_000]]);
});

test("one store that throws does not hide the others, and each CLI is capped at 40", (t) => {
  const dir = tmpdir(t);
  for (let i = 0; i < 45; i++) {
    write(path.join(dir, "chats", "h", `c${i}`, "meta.json"), JSON.stringify({ cwd: "D:\\x", title: `T${i}`, createdAtMs: NOW - i * 1000, updatedAtMs: NOW - i * 1000 }));
  }
  const rows = reader(dir, { claudeDir: () => { throw new Error("broken"); }, cursorDir: () => dir }).read();
  assert.equal(rows.length, 40);
  assert.equal(rows[0].name, "T0");
  assert.ok(!rows.some((r) => r.name === "T44"), "the oldest are left out");
});
