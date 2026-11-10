const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createSessionFiles } = require("../src/session-files");

// Record times sit well before any file the test writes, so a real creation time never lands in a turn.
const T0 = Date.parse("2020-03-01T10:00:00Z");
const NOW = T0 + 86400_000;
const iso = (ms) => new Date(ms).toISOString();

function tmpdir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "um-session-files-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function touch(file, at) {
  fs.utimesSync(file, at / 1000, at / 1000);
}

const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";

function scanner(root, extra = {}) {
  const none = path.join(root, "none");
  return createSessionFiles({ claudeDir: () => none, codexDir: () => none, grokDir: () => none, now: () => NOW, ...extra });
}

// Claude Code lines, keys in the order the CLI writes them.
const prompt = (sid, cwd, at, content, extra = {}) => ({ parentUuid: null, isSidechain: false, promptId: "p1", type: "user",
  message: { role: "user", content }, uuid: "u1", timestamp: iso(at), permissionMode: "default", ...extra, userType: "external",
  entrypoint: "cli", cwd, sessionId: sid });
const result = (sid, cwd, at, toolUseResult, extra = {}) => ({ parentUuid: "a1", isSidechain: false, promptId: "p1", ...extra, type: "user",
  message: { role: "user", content: [{ tool_use_id: "t1", type: "tool_result", content: "done" }] }, uuid: "u2", timestamp: iso(at),
  toolUseResult, sourceToolAssistantUUID: "a1", userType: "external", entrypoint: "cli", cwd, sessionId: sid });
const reply = (sid, cwd, at) => ({ parentUuid: "u1", isSidechain: false, message: { id: "m1", type: "message", role: "assistant",
  content: [{ type: "text", text: "ok" }] }, type: "assistant", uuid: "a1", timestamp: iso(at), userType: "external", entrypoint: "cli", cwd, sessionId: sid });
const create = (filePath) => ({ type: "create", filePath, content: "x\n", structuredPatch: [], originalFile: null, userModified: false });
const update = (filePath) => ({ type: "update", filePath, content: "y\n", structuredPatch: [], originalFile: "x\n", userModified: false });
const edit = (filePath) => ({ filePath, oldString: "a", newString: "b", originalFile: "a", structuredPatch: [], userModified: false, replaceAll: false });

function claudeFile(root, slug, sid) {
  return path.join(root, "projects", slug, `${sid}.jsonl`);
}

const rows = (session) => session.files.map((f) => [f.kind, f.path]);
const byKey = (res, key) => res.sessions.find((s) => s.key === key);

test("missing stores give no sessions", async (t) => {
  const res = await scanner(tmpdir(t)).scan();
  assert.deepEqual(res, { sessions: [], coverage: { skipped: 0, truncated: false } });
});

test("Claude Code writes: creates, updates and edits, both slash styles as one file, reads and plans ignored", async (t) => {
  const dir = tmpdir(t);
  const cwd = "D:\\work\\api";
  const sid = "s1";
  write(claudeFile(dir, "D--work-api", sid), jsonl([
    { type: "mode", mode: "default", sessionId: sid },
    prompt(sid, cwd, T0, "fix the parser please"),
    reply(sid, cwd, T0 + 500),
    result(sid, cwd, T0 + 1000, create("D:/work/api/src/new.js")),
    result(sid, cwd, T0 + 2000, edit("D:\\work\\api\\src\\new.js")),
    result(sid, cwd, T0 + 3000, update("D:\\work\\api\\README.md")),
    result(sid, cwd, T0 + 4000, edit("d:/WORK/api/readme.md")),
    result(sid, cwd, T0 + 5000, { type: "text", file: { filePath: "D:\\work\\api\\secret.txt", content: "s" } }),
    result(sid, cwd, T0 + 5500, { plan: "the plan", isAgent: false, filePath: "D:\\work\\api\\plan.md" }),
    result(sid, cwd, T0 + 6000, { new_source: "x", cell_id: "c1", cell_type: "code", language: "python", edit_mode: "replace",
      notebook_path: "D:\\work\\api\\nb.ipynb" }),
    result(sid, cwd, T0 + 6500, edit("D:\\work\\api\\old.py")),
    result(sid, cwd, T0 + 7000, { stdout: "", stderr: "", interrupted: false, isImage: false, noOutputExpected: false,
      bashEditDiff: { files: [{ filePath: "D:\\work\\api\\gen.py", hunks: [], created: true }, { filePath: "D:\\work\\api\\old.py", hunks: [], deleted: true }] } }),
    result(sid, cwd, T0 + 7500, "Error: file not found"),
    { type: "ai-title", aiTitle: "First title", sessionId: sid },
    { type: "ai-title", aiTitle: "Fix the parser", sessionId: sid },
  ]));
  // A sub-agent's transcript, and one run inside a workflow: their writes are the session's.
  write(path.join(dir, "projects", "D--work-api", sid, "subagents", "agent-a1.jsonl"), jsonl([
    prompt(sid, cwd, T0 + 1500, "do the sub task", { isSidechain: true }),
    result(sid, cwd, T0 + 8000, create("D:\\work\\api\\from-agent.txt"), { agentId: "a1" }),
  ]));
  write(path.join(dir, "projects", "D--work-api", sid, "subagents", "workflows", "wf_1", "agent-a2.jsonl"), jsonl([
    result(sid, cwd, T0 + 9000, update("D:\\work\\api\\src\\new.js"), { agentId: "a2" }),
  ]));
  const res = await scanner(dir, { claudeDir: () => dir, platform: "win32" }).scan();
  assert.equal(res.sessions.length, 1);
  const s = res.sessions[0];
  assert.deepEqual({ ...s, files: undefined }, { key: "claude:s1", tool: "claude", label: "Claude Code", id: "s1", name: "Fix the parser",
    cwd, started: T0, last_active: T0 + 9000, files: undefined });
  assert.deepEqual(s.files.map((f) => [f.kind, f.path, f.at]), [
    ["created", "D:\\work\\api\\src\\new.js", T0 + 9000],
    ["created", "D:\\work\\api\\from-agent.txt", T0 + 8000],
    ["created", "D:\\work\\api\\gen.py", T0 + 7000],
    ["edited", "D:\\work\\api\\nb.ipynb", T0 + 6000],
    ["edited", "d:\\WORK\\api\\readme.md", T0 + 4000],
  ], "created then edited stays created; the deleted file is dropped");
  assert.deepEqual(s.files[0], { path: "D:\\work\\api\\src\\new.js", name: "new.js", kind: "created", at: T0 + 9000,
    exists: false, size: null, modified: null });
});

test("Claude Code titles: the generated title, then the session's name, then the first prompt, then the folder", async (t) => {
  const dir = tmpdir(t);
  const cwd = "D:\\work\\api";
  const w = (sid, at) => result(sid, cwd, at, create(`D:\\work\\api\\${sid}.txt`));
  write(claudeFile(dir, "p", "a"), jsonl([prompt("a", cwd, T0, "ask a"), { type: "agent-name", agentName: "named-a", sessionId: "a" },
    { type: "ai-title", aiTitle: "Title a", sessionId: "a" }, w("a", T0 + 1)]));
  write(claudeFile(dir, "p", "b"), jsonl([prompt("b", cwd, T0, "ask b"), { type: "agent-name", agentName: "named-b", sessionId: "b" }, w("b", T0 + 2)]));
  write(claudeFile(dir, "p", "c"), jsonl([
    prompt("c", cwd, T0, "<command-name>/model</command-name>"),
    prompt("c", cwd, T0 + 1, "injected context", { isMeta: true }),
    prompt("c", cwd, T0 + 2, [{ type: "text", text: "the first real ask, which is long enough to be clipped at eighty characters in the list" }]),
    prompt("c", cwd, T0 + 3, "a later ask"), w("c", T0 + 3)]));
  write(claudeFile(dir, "p", "d"), jsonl([w("d", T0 + 4)]));
  // No writes and no folder on disk: not listed.
  write(claudeFile(dir, "p", "e"), jsonl([prompt("e", cwd, T0, "just talk"), reply("e", cwd, T0 + 5)]));
  const res = await scanner(dir, { claudeDir: () => dir, platform: "win32" }).scan();
  assert.deepEqual(res.sessions.map((s) => [s.id, s.name]), [
    ["d", "api"],
    ["c", "the first real ask, which is long enough to be clipped at eighty characters in …"],
    ["b", "named-b"],
    ["a", "Title a"],
  ]);
});

function codexDay(root, at) {
  const d = new Date(at);
  return path.join(root, "sessions", String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0"));
}

const codexEvent = (at, payload) => ({ timestamp: iso(at), ordinal: 1, type: "event_msg", payload });
const fileChange = (at, changes, status = "completed") => codexEvent(at, { type: "item_completed", thread_id: "th", turn_id: "tu",
  item: { type: "FileChange", id: "fc", changes, status, stdout: "", stderr: "" }, started_at_ms: at, completed_at_ms: at });

test("Codex: adds, updates, moves and deletes from its change events, named from the thread index", async (t) => {
  const dir = tmpdir(t);
  const id = "aaaaaaaa-0000-0000-0000-000000000001";
  const cwd = "D:\\work\\web";
  const f = (n) => `D:\\work\\web\\${n}`;
  write(path.join(codexDay(dir, T0), `rollout-2020-03-01T10-00-00-${id}.jsonl`), jsonl([
    { timestamp: iso(T0), type: "session_meta", payload: { id, timestamp: iso(T0), cwd, originator: "codex-tui", instructions: "x".repeat(70_000) } },
    codexEvent(T0 + 100, { type: "task_started", turn_id: "tu" }),
    fileChange(T0 + 1000, { [f("a.js")]: { type: "add", content: "a" }, [f("b.js")]: { type: "update", unified_diff: "", move_path: null } }),
    fileChange(T0 + 2000, { [f("c.js")]: { type: "update", unified_diff: "", move_path: f("d.js") } }),
    fileChange(T0 + 3000, { [f("e.js")]: { type: "add", content: "e" } }),
    fileChange(T0 + 4000, { [f("e.js")]: { type: "delete", content: "e" } }),
    fileChange(T0 + 5000, { [f("f.js")]: { type: "add", content: "f" } }, "failed"),
    fileChange(T0 + 5500, { [f("g.js")]: { type: "add", content: "g" } }, "declined"),
    codexEvent(T0 + 6000, { type: "task_complete", turn_id: "tu", last_agent_message: "done" }),
  ]));
  write(path.join(dir, "session_index.jsonl"), jsonl([{ id, thread_name: "First name", updated_at: iso(T0) }, { id, thread_name: "Web fixes", updated_at: iso(T0 + 1) }]));
  const res = await scanner(dir, { codexDir: () => dir, platform: "win32" }).scan();
  const s = byKey(res, `codex:${id}`);
  assert.equal(s.name, "Web fixes");
  assert.equal(s.cwd, cwd);
  assert.equal(s.started, T0);
  assert.equal(s.label, "Codex");
  assert.deepEqual(s.files.map((x) => [x.kind, x.path, x.at]), [
    ["edited", f("d.js"), T0 + 2000],
    ["created", f("a.js"), T0 + 1000],
    ["edited", f("b.js"), T0 + 1000],
  ]);
});

test("Codex: older patch events, and apply_patch calls only when a rollout has no change events", async (t) => {
  const dir = tmpdir(t);
  const id1 = "bbbbbbbb-0000-0000-0000-000000000001";
  const id2 = "bbbbbbbb-0000-0000-0000-000000000002";
  const day = codexDay(dir, T0);
  const meta = (id) => ({ timestamp: iso(T0), type: "session_meta", payload: { id, timestamp: iso(T0), cwd: "D:\\work\\old" } });
  write(path.join(day, `rollout-2020-03-01T10-00-00-${id1}.jsonl`), jsonl([
    meta(id1),
    codexEvent(T0 + 1000, { type: "patch_apply_end", call_id: "c1", success: true,
      changes: { "D:\\work\\old\\new.txt": { add: { content: "n" } }, "D:\\work\\old\\x.txt": { update: { unified_diff: "", move_path: "D:\\work\\old\\y.txt" } } } }),
    codexEvent(T0 + 2000, { type: "patch_apply_end", call_id: "c2", success: false, changes: { "D:\\work\\old\\bad.txt": { add: { content: "b" } } } }),
    // Ignored here: this rollout has change events.
    { timestamp: iso(T0 + 3000), type: "response_item", payload: { type: "custom_tool_call", name: "apply_patch", input: "*** Begin Patch\n*** Add File: ignored.txt\n+x\n*** End Patch" } },
  ]));
  write(path.join(day, `rollout-2020-03-01T11-00-00-${id2}.jsonl`), jsonl([
    meta(id2),
    { timestamp: iso(T0 + 1000), type: "response_item", payload: { type: "custom_tool_call", name: "apply_patch",
      input: "*** Begin Patch\n*** Add File: docs/guide.md\n+hi\n*** Update File: D:\\work\\old\\main.py\n@@\n-a\n+b\n*** Delete File: gone.txt\n*** End Patch" } },
    { timestamp: iso(T0 + 2000), type: "response_item", payload: { type: "function_call", name: "shell",
      arguments: JSON.stringify({ command: ["apply_patch", "*** Begin Patch\n*** Update File: a.py\n*** Move to: b.py\n@@\n-a\n+b\n*** End Patch"] }) } },
  ]));
  const res = await scanner(dir, { codexDir: () => dir, platform: "win32" }).scan();
  assert.deepEqual(rows(byKey(res, `codex:${id1}`)), [["created", "D:\\work\\old\\new.txt"], ["edited", "D:\\work\\old\\y.txt"]]);
  assert.deepEqual(rows(byKey(res, `codex:${id2}`)), [["edited", "D:\\work\\old\\b.py"], ["created", "D:\\work\\old\\docs\\guide.md"],
    ["edited", "D:\\work\\old\\main.py"]]);
  assert.equal(byKey(res, `codex:${id2}`).name, "old", "no thread name: the folder");
});

test("Grok Build: completed writes and edits from tool calls, never from their updates, failed ones dropped", async (t) => {
  const dir = tmpdir(t);
  const sid = "01a0c959-0000-0000-0000-000000000001";
  const cwd = "D:\\work\\g";
  const sdir = path.join(dir, "sessions", encodeURIComponent(cwd), sid);
  const call = (id, name, kind, rawInput, at) => ({ timestamp: Math.floor(at / 1000), method: "session/update", params: { sessionId: sid,
    update: { sessionUpdate: "tool_call", toolCallId: id, title: name, rawInput, _meta: { "x.ai/tool": { version: 1, name, kind, namespace: "grok_build", read_only: false } } },
    _meta: { totalTokens: 1, eventId: `${sid}-1`, agentTimestampMs: at, updateType: "ToolCall", updateParams: { toolCallId: id, title: name, kind: "Other", status: "Pending" } } } });
  const done = (id, status, at, extra = {}) => ({ timestamp: Math.floor(at / 1000), method: "session/update", params: { sessionId: sid,
    update: { sessionUpdate: "tool_call_update", toolCallId: id, status, ...extra }, _meta: { agentTimestampMs: at } } });
  write(path.join(sdir, "summary.json"), JSON.stringify({ info: { id: sid, cwd }, generated_title: "Grok title", session_summary: "summary",
    created_at: iso(T0), updated_at: iso(T0 + 9000), last_active_at: iso(T0 + 8000) }));
  write(path.join(sdir, "updates.jsonl"), jsonl([
    call("c1", "write", "write", { file_path: "D:\\work\\g\\new.md", content: "x" }, T0 + 1000),
    done("c1", "in_progress", T0 + 1100),
    done("c1", "completed", T0 + 1200),
    done("c1", "completed", T0 + 1300),
    call("c2", "search_replace", "edit", { file_path: "D:/work/g/app.py", old_string: "a", new_string: "b" }, T0 + 2000),
    done("c2", "completed", T0 + 2100),
    call("c3", "search_replace", "edit", { file_path: "D:\\work\\g\\other.py", old_string: "zz", new_string: "b" }, T0 + 3000),
    done("c3", "failed", T0 + 3100),
    call("c4", "read_file", "read", { target_file: "D:\\work\\g\\app.py" }, T0 + 4000),
    // An update that repeats a write's input is not a second write.
    done("c4", "completed", T0 + 4100, { rawInput: { file_path: "D:\\work\\g\\only-in-update.txt" },
      _meta: { "x.ai/tool": { version: 1, name: "write", kind: "write" } } }),
    call("c5", "search_replace", "edit", { file_path: "D:\\work\\g\\fresh.json", old_string: "", new_string: "{}" }, T0 + 5000),
    done("c5", "completed", T0 + 5100),
  ]));
  write(path.join(sdir, "events.jsonl"), jsonl([{ ts: iso(T0), type: "turn_started", session_id: sid }, { ts: iso(T0 + 6000), type: "turn_ended" }]));
  const res = await scanner(dir, { grokDir: () => dir, platform: "win32" }).scan();
  const s = byKey(res, `grok:${sid}`);
  assert.equal(s.name, "Grok title");
  assert.equal(s.label, "Grok Build");
  assert.equal(s.started, T0);
  assert.equal(s.last_active, T0 + 8000);
  assert.deepEqual(s.files.map((x) => [x.kind, x.path, x.at]), [
    ["created", "D:\\work\\g\\fresh.json", T0 + 5000],
    ["edited", "D:\\work\\g\\app.py", T0 + 2000],
    ["created", "D:\\work\\g\\new.md", T0 + 1000],
  ]);
});

test("generated files: output files changed in the session's folder during its turns", async (t) => {
  const dir = tmpdir(t);
  const proj = path.join(dir, "proj");
  const sid = "g1";
  const at = (file, when, text = "data") => {
    write(path.join(proj, file), text);
    touch(path.join(proj, file), when);
  };
  at("report.pdf", T0 + 30_000, "pdf bytes");
  at(path.join("sub", "deep", "chart.png"), T0 + 3_663_000);
  at("late.pdf", T0 + 600_000);
  at("notes.js", T0 + 30_000);
  at(path.join(".hidden", "inside.pdf"), T0 + 30_000);
  at(path.join("node_modules", "pkg", "readme.md"), T0 + 30_000);
  at(path.join("Build", "bundle.zip"), T0 + 30_000);
  at("written.md", T0 + 40_000);
  write(claudeFile(dir, "proj", sid), jsonl([
    prompt(sid, proj, T0, "build the report"),
    result(sid, proj, T0 + 40_000, create(path.join(proj, "written.md"))),
    result(sid, proj, T0 + 50_000, create(path.join(proj, "gone.txt"))),
    reply(sid, proj, T0 + 60_000),
    prompt(sid, proj, T0 + 3_600_000, "and a chart"),
    reply(sid, proj, T0 + 3_660_000),
  ]));
  // A second session at work in the same folder at the same time.
  at("other.md", T0 + 45_000);
  write(claudeFile(dir, "proj", "g2"), jsonl([
    prompt("g2", proj, T0, "tidy up"),
    result("g2", proj, T0 + 45_000, create(path.join(proj, "other.md"))),
    reply("g2", proj, T0 + 60_000),
  ]));
  const res = await scanner(dir, { claudeDir: () => dir }).scan();
  // What one session's record says it wrote is not the other's generated file; the report is anyone's guess.
  assert.deepEqual(byKey(res, "claude:g2").files.map((f) => [f.kind, f.name]), [["created", "other.md"], ["generated", "report.pdf"]]);
  const s = byKey(res, `claude:${sid}`);
  assert.deepEqual(s.files.map((f) => [f.kind, path.relative(proj, f.path)]), [
    ["generated", path.join("sub", "deep", "chart.png")],
    ["created", "gone.txt"],
    ["created", "written.md"],
    ["generated", "report.pdf"],
  ]);
  const report = s.files.find((f) => f.name === "report.pdf");
  assert.equal(report.at, T0 + 30_000);
  assert.equal(report.exists, true);
  assert.equal(report.size, "pdf bytes".length);
  assert.equal(report.modified, T0 + 30_000);
  assert.deepEqual(s.files.find((f) => f.name === "gone.txt"), { path: path.join(proj, "gone.txt"), name: "gone.txt", kind: "created",
    at: T0 + 50_000, exists: false, size: null, modified: null });
});

test("only: other sessions' records are not read", async (t) => {
  const dir = tmpdir(t);
  const cwd = "D:\\work\\api";
  for (const sid of ["s1", "s2"]) write(claudeFile(dir, "p", sid), jsonl([result(sid, cwd, T0, create(`D:\\work\\api\\${sid}.txt`))]));
  // Too old for the period asked for.
  write(claudeFile(dir, "p", "s3"), jsonl([result("s3", cwd, T0, create("D:\\work\\api\\s3.txt"))]));
  touch(claudeFile(dir, "p", "s3"), NOW - 10 * 86400_000);
  const read = [];
  const s = scanner(dir, { claudeDir: () => dir, platform: "win32", onRead: (file) => read.push(path.basename(file)) });
  const res = await s.scan({ only: new Set(["claude:s1", "claude:s3"]) });
  assert.deepEqual(res.sessions.map((x) => x.key), ["claude:s1"]);
  assert.deepEqual(read, ["s1.jsonl"]);
  assert.deepEqual((await s.scan({ days: 30 })).sessions.map((x) => x.id).sort(), ["s1", "s2", "s3"]);
});

test("a later scan reads only the bytes appended since, and starts over when the file shrank", async (t) => {
  const dir = tmpdir(t);
  const cwd = "D:\\work\\api";
  const file = claudeFile(dir, "p", "s1");
  write(file, jsonl([prompt("s1", cwd, T0, "go"), result("s1", cwd, T0 + 1000, create("D:\\work\\api\\aaa.txt"))]));
  const size = fs.statSync(file).size;
  const reads = [];
  const s = scanner(dir, { claudeDir: () => dir, platform: "win32", onRead: (f, pos, n) => reads.push([pos, n]) });
  assert.deepEqual(rows((await s.scan()).sessions[0]), [["created", "D:\\work\\api\\aaa.txt"]]);
  assert.deepEqual(reads, [[0, size]]);
  // The part already read is changed in place: a re-read would show zzz.txt.
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("aaa.txt", "zzz.txt"));
  fs.appendFileSync(file, jsonl([result("s1", cwd, T0 + 2000, create("D:\\work\\api\\bbb.txt"))]));
  reads.length = 0;
  assert.deepEqual(rows((await s.scan()).sessions[0]), [["created", "D:\\work\\api\\bbb.txt"], ["created", "D:\\work\\api\\aaa.txt"]]);
  assert.deepEqual(reads, [[size, fs.statSync(file).size - size]]);
  reads.length = 0;
  await s.scan();
  assert.deepEqual(reads, [], "an unchanged file is not read again");
  // A partial last line waits for the rest of it.
  const before = fs.statSync(file).size;
  const late = JSON.stringify(result("s1", cwd, T0 + 3000, create("D:\\work\\api\\ccc.txt")));
  fs.appendFileSync(file, late.slice(0, 40));
  assert.equal((await s.scan()).sessions[0].files.length, 2);
  fs.appendFileSync(file, `${late.slice(40)}\n`);
  reads.length = 0;
  assert.equal((await s.scan()).sessions[0].files[0].path, "D:\\work\\api\\ccc.txt");
  assert.equal(reads[0][0], before, "the partial line is read again from its start");
  write(file, jsonl([result("s1", cwd, T0, edit("D:\\work\\api\\x.txt"))]));
  assert.deepEqual(rows((await s.scan()).sessions[0]), [["edited", "D:\\work\\api\\x.txt"]]);
});

test("the cache file carries parse states to a new scanner, which reads nothing unchanged", async (t) => {
  const dir = tmpdir(t);
  const cacheFile = path.join(dir, "cache", "session-files.json");
  const cwd = "D:\\work\\api";
  write(claudeFile(dir, "p", "s1"), jsonl([prompt("s1", cwd, T0, "go"), result("s1", cwd, T0 + 1000, create("D:\\work\\api\\a.txt"))]));
  const id = "cccccccc-0000-0000-0000-000000000001";
  write(path.join(codexDay(dir, T0), `rollout-2020-03-01T10-00-00-${id}.jsonl`), jsonl([
    { timestamp: iso(T0), type: "session_meta", payload: { id, timestamp: iso(T0), cwd } },
    fileChange(T0 + 1000, { "D:\\work\\api\\b.txt": { type: "add", content: "b" } }),
  ]));
  const opts = { claudeDir: () => dir, codexDir: () => dir, platform: "win32", cacheFile };
  const first = await scanner(dir, opts).scan();
  assert.equal(first.sessions.length, 2);
  assert.ok(fs.existsSync(cacheFile));
  if (process.platform !== "win32") assert.equal(fs.statSync(cacheFile).mode & 0o777, 0o600);
  assert.ok(!fs.readFileSync(cacheFile, "utf8").includes('"content"'), "no file contents in the cache");
  const savedAt = fs.statSync(cacheFile).mtimeMs;
  const reads = [];
  const again = scanner(dir, { ...opts, onRead: (f) => reads.push(f) });
  assert.deepEqual(await again.scan(), first);
  assert.deepEqual(reads, []);
  again.flush();
  assert.equal(fs.statSync(cacheFile).mtimeMs, savedAt, "nothing changed, nothing written");
  // Another format version is not trusted.
  fs.writeFileSync(cacheFile, JSON.stringify({ version: 0, files: {} }));
  await scanner(dir, { ...opts, onRead: (f) => reads.push(f) }).scan();
  assert.equal(new Set(reads).size, 2);
});

test("an unreadable or foreign record is counted, and the rest still returns", async (t) => {
  const dir = tmpdir(t);
  const cwd = "D:\\work\\api";
  write(claudeFile(dir, "p", "s1"), jsonl([result("s1", cwd, T0, create("D:\\work\\api\\a.txt"))]));
  write(path.join(codexDay(dir, T0), "rollout-2020-03-01T10-00-00-dddddddd-0000-0000-0000-000000000001.jsonl"), "not a record\n\u0000\u0001\n");
  const sdir = path.join(dir, "sessions", "D%3A%5Cwork%5Cg", "g1");
  write(path.join(sdir, "summary.json"), "{ not json");
  // A folder where the log should be.
  fs.mkdirSync(path.join(sdir, "events.jsonl"), { recursive: true });
  write(path.join(sdir, "updates.jsonl"), jsonl([{ timestamp: Math.floor(T0 / 1000), method: "session/update", params: { sessionId: "g1",
    update: { sessionUpdate: "tool_call", toolCallId: "c1", title: "write", rawInput: { file_path: "D:\\work\\g\\n.md" },
      _meta: { "x.ai/tool": { name: "write", kind: "write" } } }, _meta: { agentTimestampMs: T0 } } }]));
  const res = await scanner(dir, { claudeDir: () => dir, codexDir: () => dir, grokDir: () => dir, platform: "win32" }).scan();
  assert.deepEqual(res.sessions.map((s) => [s.key, s.name, s.cwd]), [["claude:s1", "api", cwd], ["grok:g1", "g", "D:\\work\\g"]]);
  assert.deepEqual(rows(byKey(res, "grok:g1")), [["created", "D:\\work\\g\\n.md"]], "a write still waiting for its result counts");
  assert.equal(res.coverage.skipped, 3);
});

test("scans asked for together share one run", async (t) => {
  const dir = tmpdir(t);
  write(claudeFile(dir, "p", "s1"), jsonl([result("s1", "D:\\w", T0, create("D:\\w\\a.txt"))]));
  let reads = 0;
  const s = scanner(dir, { claudeDir: () => dir, platform: "win32", onRead: () => reads++ });
  const a = s.scan({ days: 7 });
  const b = s.scan({ days: 7 });
  assert.equal(a, b);
  const c = s.scan({ days: 30 });
  assert.notEqual(a, c);
  assert.equal((await a).sessions.length, 1);
  assert.equal((await c).sessions.length, 1);
  assert.equal(reads, 1);
});
