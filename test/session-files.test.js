const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { DatabaseSync } = require("node:sqlite");
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
  return createSessionFiles({ claudeDir: () => none, codexDir: () => none, grokDir: () => none, cursorDir: () => none,
    geminiDir: () => none, now: () => NOW, ...extra });
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
    exists: false, size: null, modified: null, output: false });
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
  at(path.join("sub", "deep", "deck.pptx"), T0 + 3_663_000);
  at("late.pdf", T0 + 600_000);
  at("notes.js", T0 + 30_000);
  // Images and data are working files, and Office's lock file beside an open document is not a document.
  at("chart.png", T0 + 30_000);
  at("~$report.docx", T0 + 30_000);
  at(path.join(".hidden", "inside.pdf"), T0 + 30_000);
  at(path.join("node_modules", "pkg", "readme.pdf"), T0 + 30_000);
  at(path.join("Build", "out.pdf"), T0 + 30_000);
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
  assert.deepEqual(byKey(res, "claude:g2").files.map((f) => [f.kind, f.name]), [["created", "other.md"], ["generated", "chart.png"], ["generated", "report.pdf"]]);
  const s = byKey(res, `claude:${sid}`);
  assert.deepEqual(s.files.map((f) => [f.kind, path.relative(proj, f.path)]), [
    ["generated", path.join("sub", "deep", "deck.pptx")],
    ["created", "gone.txt"],
    ["created", "written.md"],
    ["generated", "chart.png"],
    ["generated", "report.pdf"],
  ]);
  // The documents are outputs; the chart made in the turn that ended with the report was a step towards it.
  assert.deepEqual(s.files.filter((f) => f.output).map((f) => f.name), ["deck.pptx", "report.pdf"]);
  const report = s.files.find((f) => f.name === "report.pdf");
  assert.equal(report.at, T0 + 30_000);
  assert.equal(report.exists, true);
  assert.equal(report.size, "pdf bytes".length);
  assert.equal(report.modified, T0 + 30_000);
  assert.deepEqual(s.files.find((f) => f.name === "gone.txt"), { path: path.join(proj, "gone.txt"), name: "gone.txt", kind: "created",
    at: T0 + 50_000, exists: false, size: null, modified: null, output: false });
});

// A zip with stored entries: [name, bytes] pairs. Enough of the format for a document's directory.
function zipOf(entries) {
  const zlib = require("node:zlib");
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, data] of entries) {
    const n = Buffer.from(name);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt32LE(zlib.crc32(data), 14);
    head.writeUInt32LE(data.length, 18);
    head.writeUInt32LE(data.length, 22);
    head.writeUInt16LE(n.length, 26);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt32LE(zlib.crc32(data), 16);
    dir.writeUInt32LE(data.length, 20);
    dir.writeUInt32LE(data.length, 24);
    dir.writeUInt16LE(n.length, 28);
    dir.writeUInt32LE(offset, 42);
    locals.push(head, n, data);
    central.push(dir, n);
    offset += 30 + n.length + data.length;
  }
  const dirBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(dirBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dirBytes, end]);
}

test("outputs: documents, and pages, data and images that are not part of something else", async (t) => {
  const dir = tmpdir(t);
  const proj = path.join(dir, "proj");
  const sid = "o1";
  const at = (file, when, data = "data") => {
    fs.mkdirSync(path.dirname(path.join(proj, file)), { recursive: true });
    fs.writeFileSync(path.join(proj, file), data);
    touch(path.join(proj, file), when);
  };
  const HOUR = 3_600_000;
  const picture = Buffer.from("the bytes of a picture that went into the deck");
  // Turn 1 makes pictures and nothing else; turn 2 builds a deck from one of them; turn 3 makes a
  // chart and then the PDF it is for; turn 4 leaves a page, an export and a picture of their own.
  at("in-deck.png", T0 + 10_000, picture);
  at("logo.png", T0 + 20_000, "a picture nobody put anywhere");
  at("deck.pptx", T0 + HOUR + 10_000, zipOf([["ppt/slides/slide1.xml", Buffer.from("<p/>")], ["ppt/media/image1.png", picture]]));
  at("figure.png", T0 + 2 * HOUR + 10_000);
  at("report.pdf", T0 + 2 * HOUR + 20_000);
  at("prototype.html", T0 + 3 * HOUR + 10_000);
  at("export.csv", T0 + 3 * HOUR + 20_000);
  at("diagram.svg", T0 + 3 * HOUR + 30_000);
  // Parts of a program, and scratch work.
  at(path.join("templates", "page.html"), T0 + 3 * HOUR + 30_000);
  at(path.join("src", "assets", "icon.png"), T0 + 3 * HOUR + 30_000);
  at(path.join("tests", "fixtures", "rows.csv"), T0 + 3 * HOUR + 30_000);
  at(path.join("work", "temp", "draft.pdf"), T0 + 3 * HOUR + 30_000);
  write(claudeFile(dir, "proj", sid), jsonl([
    prompt(sid, proj, T0, "draw the pictures"),
    reply(sid, proj, T0 + 30_000),
    prompt(sid, proj, T0 + HOUR, "now the deck"),
    reply(sid, proj, T0 + HOUR + 30_000),
    prompt(sid, proj, T0 + 2 * HOUR, "and the report"),
    reply(sid, proj, T0 + 2 * HOUR + 30_000),
    prompt(sid, proj, T0 + 3 * HOUR, "a prototype and the data"),
    result(sid, proj, T0 + 3 * HOUR + 5_000, create(path.join(proj, ".work", "notes.pdf"))),
    reply(sid, proj, T0 + 3 * HOUR + 40_000),
    // A page finished later in a turn takes the pictures made before it in that turn as its own.
    prompt(sid, proj, T0 + 4 * HOUR, "one more page"),
    reply(sid, proj, T0 + 4 * HOUR + 30_000),
  ]));
  at("hero.png", T0 + 4 * HOUR + 5_000);
  at("landing.html", T0 + 4 * HOUR + 20_000);
  // Pictures taken to check the work, and a batch of renders: none is a result by itself.
  at(path.join("outputs", "qa", "home.png"), T0 + 20_000);
  for (let i = 1; i <= 6; i++) at(path.join("renders", `page-${i}.png`), T0 + 20_000 + i);
  const s = byKey(await scanner(dir, { claudeDir: () => dir }).scan(), `claude:${sid}`);
  const flags = Object.fromEntries(s.files.map((f) => [path.relative(proj, f.path).split(path.sep).join("/"), f.output]));
  assert.deepEqual(flags, {
    "landing.html": true, "hero.png": false,
    "prototype.html": true, "export.csv": true, "diagram.svg": true,
    "templates/page.html": false, "src/assets/icon.png": false, "tests/fixtures/rows.csv": false, ".work/notes.pdf": false,
    "report.pdf": true, "figure.png": false,
    "deck.pptx": true,
    "logo.png": true, "in-deck.png": false,
    "outputs/qa/home.png": false,
    ...Object.fromEntries([1, 2, 3, 4, 5, 6].map((i) => [`renders/page-${i}.png`, false])),
  });
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

// Protobuf, as the two databases below hold it: a number is a varint, a string or Buffer is bytes.
function varint(n) {
  const out = [];
  for (; n >= 128; n = Math.floor(n / 128)) out.push((n % 128) | 128);
  out.push(n);
  return Buffer.from(out);
}

const msg = (...fields) => Buffer.concat(fields.map(([no, v]) => (typeof v === "number"
  ? Buffer.concat([varint(no * 8), varint(v)])
  : Buffer.concat([varint(no * 8 + 2), varint(Buffer.byteLength(v)), Buffer.from(v)]))));
const stamp = (ms) => msg([1, Math.floor(ms / 1000)], [2, (ms % 1000) * 1e6]);

function sqlite(file, schema, fill) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  try {
    db.exec(schema);
    fill(db);
  } finally {
    db.close();
  }
}

// Antigravity: a step's metadata holds when it was made, each state it went through, and a tool call.
const AGY_SCHEMA = "CREATE TABLE IF NOT EXISTS steps (idx integer, step_type integer NOT NULL DEFAULT 0, status integer NOT NULL DEFAULT 0, "
  + "metadata blob, render_info blob, step_payload blob, PRIMARY KEY (idx)); "
  + "CREATE TABLE IF NOT EXISTS trajectory_metadata_blob (id text DEFAULT 'main', data blob, PRIMARY KEY (id));";
const agyFile = (root, id) => path.join(root, "antigravity-cli", "conversations", `${id}.db`);
const agyMeta = (at, states, call) => msg([1, stamp(at)], [3, 2], ...(call ? [[4, msg([1, "call_1"], [2, call.name], [3, JSON.stringify(call.args)])]] : []),
  [26, msg(...states.map((s) => [1, msg([1, s], [2, stamp(at)])]))]);
const userStep = (idx, at) => ({ idx, type: 14, status: 3, meta: agyMeta(at, [3]) });
const replyStep = (idx, at) => ({ idx, type: 15, status: 3, meta: agyMeta(at, [8, 3]) });
const toolStep = (idx, at, name, args, { states = [1, 2, 3], status = states[states.length - 1], verb = null } = {}) => ({
  idx, type: 132, status, meta: agyMeta(at, states, { name, args }),
  render: verb ? msg([5, verb], [6, "edit"], [9, msg([4, msg([1, "file:///D:/elsewhere.txt"])])]) : null,
});

function agyDb(root, id, steps, workspace = null) {
  const file = agyFile(root, id);
  sqlite(file, AGY_SCHEMA, (db) => {
    const add = db.prepare("INSERT OR REPLACE INTO steps (idx, step_type, status, metadata, render_info, step_payload) VALUES (?, ?, ?, ?, ?, ?)");
    for (const s of steps) add.run(s.idx, s.type, s.status, s.meta, s.render ?? null, Buffer.alloc(64));
    if (workspace) db.prepare("INSERT OR REPLACE INTO trajectory_metadata_blob (id, data) VALUES ('main', ?)").run(msg([1, msg([1, workspace])]));
  });
  return file;
}

function agyConversations(root, conversations) {
  write(path.join(root, "antigravity-cli", "cache", "conversation_metadata.json"), JSON.stringify({ conversations: Object.fromEntries(
    Object.entries(conversations).map(([id, s]) => [id, { summary: { ID: id, Title: "", Preview: "", UpdatedAt: iso(T0 + 9000), WorkspaceURIs: [],
      Internal: false, Cloud: false, ...s }, is_internal: s.is_internal === true }])) }));
}

test("Antigravity: each file tool, created or edited by its own label or by what the session had seen; unfinished steps not counted", async (t) => {
  const dir = tmpdir(t);
  const f = (n) => `D:\\work\\agy\\${n}`;
  const steps = [
    userStep(0, T0),
    toolStep(1, T0 + 100, "view_file", { AbsolutePath: f("seen.py"), toolAction: "Reading" }),
    toolStep(2, T0 + 200, "write_to_file", { CodeContent: "x", Overwrite: true, TargetFile: f("seen.py") }),
    // The contents name another file; only the argument counts.
    toolStep(3, T0 + 300, "write_to_file", { CodeContent: `{"TargetFile":"${f("inside.txt")}"}`, Description: "d", Overwrite: true, TargetFile: f("new.md") }),
    toolStep(4, T0 + 400, "write_to_file", { Append: true, CodeContent: "line", TargetFile: f("log.txt") }),
    toolStep(5, T0 + 500, "write_file", { ArtifactMetadata: { Path: f("nested.txt") }, Content: "a", Path: f("a.txt") }, { verb: "Created" }),
    toolStep(6, T0 + 600, "write_file", { Content: "b", Overwrite: true, Path: f("b.txt") }, { verb: "Edited" }),
    toolStep(7, T0 + 700, "edit_file", { Path: f("c.py"), Replacement: "r", Target: "t" }, { verb: "Edited" }),
    toolStep(8, T0 + 800, "replace_file_content", { AllowMultiple: false, ReplacementContent: "r", TargetContent: "t", TargetFile: f("d.py") }),
    toolStep(9, T0 + 900, "multi_replace_file_content", { ReplacementChunks: [{ ReplacementContent: "r" }], TargetFile: f("e.py") }),
    toolStep(10, T0 + 1000, "str_replace_editor", { command: "create", file_text: "x", path: f("f.py") }),
    toolStep(11, T0 + 1100, "str_replace_editor", { command: "str_replace", new_str: "b", old_str: "a", path: f("g.py") }),
    toolStep(12, T0 + 1200, "write_to_file", { CodeContent: "x", TargetFile: f("failed.md") }, { states: [1, 2, 7] }),
    toolStep(13, T0 + 1300, "edit_file", { Path: f("canceled.py"), Replacement: "r", Target: "t" }, { states: [1, 2, 6], verb: "Editing" }),
    // Cleared from the conversation's context later: it still ran, as its own states say.
    toolStep(14, T0 + 1400, "write_to_file", { CodeContent: "x", TargetFile: f("cleared.md") }, { status: 5 }),
    toolStep(15, T0 + 1500, "write_to_file", { CodeContent: "x", TargetFile: f("cleared-failed.md") }, { states: [1, 2, 7], status: 5 }),
    toolStep(16, T0 + 1600, "run_command", { CommandLine: "echo > shell.txt", Cwd: f("") }),
    replyStep(17, T0 + 2000),
  ];
  agyDb(dir, "c1", steps);
  agyConversations(dir, { c1: { Title: "Agy work", WorkspaceURIs: ["file:///D:/work/agy"] } });
  const res = await scanner(dir, { geminiDir: () => dir, platform: "win32" }).scan();
  const s = byKey(res, "gemini:c1");
  assert.deepEqual({ ...s, files: undefined }, { key: "gemini:c1", tool: "gemini", label: "Antigravity", id: "c1", name: "Agy work",
    cwd: "D:\\work\\agy", started: T0, last_active: T0 + 2000, files: undefined });
  assert.deepEqual(s.files.map((x) => [x.kind, x.name, x.at]), [
    ["created", "cleared.md", T0 + 1400],
    ["edited", "g.py", T0 + 1100],
    ["created", "f.py", T0 + 1000],
    ["edited", "e.py", T0 + 900],
    ["edited", "d.py", T0 + 800],
    ["edited", "c.py", T0 + 700],
    ["edited", "b.txt", T0 + 600],
    ["created", "a.txt", T0 + 500],
    ["edited", "log.txt", T0 + 400],
    ["created", "new.md", T0 + 300],
    ["edited", "seen.py", T0 + 200],
  ]);
});

test("Antigravity: a step read while it ran is read again, and only it and the steps added since are read", async (t) => {
  const dir = tmpdir(t);
  const reads = [];
  const s = scanner(dir, { geminiDir: () => dir, platform: "win32", onRead: (file, idx) => reads.push(idx) });
  const file = agyDb(dir, "c1", [
    userStep(0, T0),
    toolStep(1, T0 + 100, "write_to_file", { CodeContent: "x", TargetFile: "D:\\w\\slow.md" }, { states: [1, 2] }),
    replyStep(2, T0 + 200),
  ]);
  touch(file, T0 + 1);
  assert.deepEqual((await s.scan()).sessions, [], "nothing finished yet");
  assert.deepEqual(reads, [0, 1, 2]);
  agyDb(dir, "c1", [
    toolStep(1, T0 + 100, "write_to_file", { CodeContent: "x", TargetFile: "D:\\w\\slow.md" }),
    toolStep(3, T0 + 300, "edit_file", { Path: "D:\\w\\slow.md", Replacement: "r", Target: "t" }),
  ]);
  touch(file, T0 + 2);
  reads.length = 0;
  assert.deepEqual(rows((await s.scan()).sessions[0]), [["created", "D:\\w\\slow.md"]]);
  assert.deepEqual(reads, [1, 3]);
  reads.length = 0;
  await s.scan();
  assert.deepEqual(reads, [], "an unchanged database is not opened again");
});

test("Antigravity: output files changed in the folder during its turns are generated", async (t) => {
  const dir = tmpdir(t);
  const proj = path.join(dir, "proj");
  const at = (name, when) => {
    write(path.join(proj, name), "data");
    touch(path.join(proj, name), when);
  };
  at("report.pdf", T0 + 30_000);
  at("written.md", T0 + 40_000);
  at("late.pdf", T0 + 600_000);
  at("deck.pptx", T0 + 3_630_000);
  agyDb(dir, "c1", [
    userStep(0, T0),
    toolStep(1, T0 + 40_000, "write_to_file", { CodeContent: "x", TargetFile: path.join(proj, "written.md") }),
    replyStep(2, T0 + 60_000),
    userStep(3, T0 + 3_600_000),
    replyStep(4, T0 + 3_660_000),
  ]);
  agyConversations(dir, { c1: { WorkspaceURIs: [pathToFileURL(proj).href] } });
  const s = byKey(await scanner(dir, { geminiDir: () => dir }).scan(), "gemini:c1");
  assert.equal(s.cwd, proj);
  assert.equal(s.name, "proj");
  assert.deepEqual(s.files.map((x) => [x.kind, x.name]), [["generated", "deck.pptx"], ["created", "written.md"], ["generated", "report.pdf"]]);
});

test("Antigravity names and folders: its metadata, then the prompt history, then the database; internal and cloud ones not opened", async (t) => {
  const dir = tmpdir(t);
  const opened = new Set();
  const one = (id, workspace) => agyDb(dir, id, [userStep(0, T0), toolStep(1, T0 + 100, "write_file", { Content: "x", Path: `D:\\out\\${id}.txt` })], workspace);
  for (const id of ["meta", "preview", "hist", "blob", "internal", "flagged", "cloud"]) one(id, id === "blob" ? "file:///D:/work/from%20blob" : "file:///D:/work/wrong");
  agyConversations(dir, {
    meta: { Title: "From metadata", Preview: "p", WorkspaceURIs: ["file:///D:/work/meta"] },
    preview: { Preview: "Only a preview" },
    internal: { Title: "i", Internal: true }, flagged: { Title: "f", is_internal: true }, cloud: { Title: "c", Cloud: true },
  });
  write(path.join(dir, "antigravity-cli", "history.jsonl"), jsonl([
    { display: "ask about meta", timestamp: T0, workspace: "D:\\work\\other", conversationId: "meta" },
    { display: "/help", timestamp: T0, workspace: "D:\\work\\hist-old", conversationId: "hist", type: "slash_command" },
    { display: "fix the tests", timestamp: T0 + 1, workspace: "D:\\work\\hist-old", conversationId: "hist" },
    { display: "and the docs", timestamp: T0 + 2, workspace: "D:\\work\\hist", conversationId: "hist" },
  ]));
  const res = await scanner(dir, { geminiDir: () => dir, platform: "win32", onRead: (file) => opened.add(path.basename(file)) }).scan();
  assert.deepEqual(res.sessions.map((s) => [s.id, s.name, s.cwd]).sort(), [
    ["blob", "from blob", "D:\\work\\from blob"],
    ["hist", "fix the tests", "D:\\work\\hist"],
    ["meta", "From metadata", "D:\\work\\meta"],
    ["preview", "Only a preview", "D:\\work\\wrong"],
  ]);
  assert.deepEqual([...opened].sort(), ["blob.db", "hist.db", "meta.db", "preview.db"]);
});

// Cursor Agent: content-addressed blobs. The CLI's own records are protobuf (agent.v1): a user
// message, and steps whose ToolCall holds a case (3 delete, 12 edit, 22 apply a sub-agent's diff),
// its id (57), start (59) and end (60), and once finished a result whose first case is success.
const CURSOR_SCHEMA = "CREATE TABLE IF NOT EXISTS blobs (id TEXT PRIMARY KEY, data BLOB); CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);";
const cursorUser = (text, at) => msg([1, text], [2, "00000000-0000-0000-0000-000000000001"], [25, at], [26, at]);
const cursorStep = (no, call, at = null) => msg([2, msg([no, call], [57, `tool_${crypto.randomUUID()}`], ...(at ? [[59, at - 100], [60, at]] : []))]);
const cursorCall = (p, result) => msg([1, msg([1, p])], ...(result ? [[2, result]] : []));
const editDone = (p, extra = []) => msg([1, msg([1, p], ...extra, [7, "after"])]);
const cursorJson = (o) => Buffer.from(JSON.stringify(o));

function cursorChat(root, id, meta, blobs) {
  const dir = path.join(root, "chats", "0123abcd", id);
  write(path.join(dir, "meta.json"), JSON.stringify({ schemaVersion: 1, hasConversation: true, ...meta }));
  sqlite(path.join(dir, "store.db"), CURSOR_SCHEMA, (db) => {
    const add = db.prepare("INSERT OR REPLACE INTO blobs (id, data) VALUES (?, ?)");
    for (const b of blobs) add.run(crypto.createHash("sha256").update(b).digest("hex"), b);
  });
  return path.join(dir, "store.db");
}

test("Cursor Agent: file changes from the CLI's tool-call steps; failed, rejected and unfinished ones not counted", async (t) => {
  const dir = tmpdir(t);
  const f = (n) => `D:\\work\\cur\\${n}`;
  cursorChat(dir, "chat-1", { createdAtMs: T0 - 1000, updatedAtMs: T0 + 9500, title: "Cursor chat", cwd: "D:\\work\\cur" }, [
    cursorJson({ role: "system", content: "system prompt" }),
    cursorUser("make the files", T0),
    // The JSON copy of a call is not what is read.
    cursorJson({ role: "assistant", content: [{ type: "tool-call", toolCallId: "tool_x", toolName: "Write", args: { path: f("json-only.txt") } }] }),
    cursorStep(12, cursorCall(f("a.txt"), editDone(f("a.txt"))), T0 + 1000),
    cursorStep(12, cursorCall(f("b.txt"), editDone(f("b.txt"), [[6, "before"]])), T0 + 2000),
    cursorStep(12, cursorCall(f("c.txt"), editDone(f("c.txt"), [[4, 3]])), T0 + 3000),
    cursorStep(12, cursorCall(f("error.txt"), msg([7, msg([1, f("error.txt")], [2, "no match"])])), T0 + 3500),
    cursorStep(12, cursorCall(f("rejected.txt"), msg([6, msg([1, f("rejected.txt")])])), T0 + 3600),
    cursorStep(12, cursorCall(f("running.txt"))),
    cursorStep(12, cursorCall("src\\rel.js", editDone("")), T0 + 4000),
    cursorStep(12, cursorCall(f("gone.txt"), editDone(f("gone.txt"))), T0 + 5000),
    cursorStep(3, cursorCall(f("gone.txt"), msg([1, msg([1, f("gone.txt")], [2, "x"])])), T0 + 6000),
    cursorStep(3, cursorCall(f("b.txt"), msg([2, msg([1, f("b.txt")])])), T0 + 6500),
    cursorStep(22, msg([1, msg([1, "agent-1"])], [2, msg([1, msg(
      [1, msg([1, f("sub-new.txt")], [2, 1])], [1, msg([1, f("sub-edit.txt")], [2, 2])], [1, msg([1, f("sub-bad.txt")], [2, 1], [5, "conflict"])],
    )])]), T0 + 7000),
    msg([1, msg([1, "done"], [2, T0 + 9000])]),
  ]);
  const res = await scanner(dir, { cursorDir: () => dir, platform: "win32" }).scan();
  const s = byKey(res, "cursor:chat-1");
  assert.deepEqual({ ...s, files: undefined }, { key: "cursor:chat-1", tool: "cursor", label: "Cursor Agent", id: "chat-1", name: "Cursor chat",
    cwd: "D:\\work\\cur", started: T0 - 1000, last_active: T0 + 9500, files: undefined });
  assert.deepEqual(s.files.map((x) => [x.kind, x.path, x.at]), [
    ["edited", f("sub-edit.txt"), T0 + 7000],
    ["created", f("sub-new.txt"), T0 + 7000],
    ["created", f("src\\rel.js"), T0 + 4000],
    ["edited", f("c.txt"), T0 + 3000],
    ["edited", f("b.txt"), T0 + 2000],
    ["created", f("a.txt"), T0 + 1000],
  ]);
});

test("Cursor Agent: a chat with no timed step is one turn from start to last update, if that is at most 12 hours", async (t) => {
  const dir = tmpdir(t);
  const opened = new Set();
  const chat = (id, hours, extra = {}) => {
    const proj = path.join(dir, id);
    write(path.join(proj, "report.pdf"), "pdf");
    touch(path.join(proj, "report.pdf"), T0 + 60_000);
    write(path.join(proj, "written.md"), "w");
    touch(path.join(proj, "written.md"), T0 + 30_000);
    cursorChat(dir, id, { createdAtMs: T0, updatedAtMs: T0 + hours * 3600_000, cwd: proj, ...extra }, [
      cursorStep(12, cursorCall(path.join(proj, "written.md"), editDone(path.join(proj, "written.md")))),
      cursorStep(12, cursorCall(path.join(proj, "missing.md"), editDone(path.join(proj, "missing.md")))),
    ]);
    return proj;
  };
  chat("short", 3);
  chat("long", 13);
  chat("empty", 3, { hasConversation: false });
  const res = await scanner(dir, { cursorDir: () => dir, onRead: (file) => opened.add(path.basename(path.dirname(file))) }).scan();
  assert.deepEqual(byKey(res, "cursor:short").files.map((x) => [x.kind, x.name, x.at]), [
    ["created", "missing.md", T0 + 3 * 3600_000],
    ["generated", "report.pdf", T0 + 60_000],
    ["created", "written.md", T0 + 30_000],
  ], "undated writes take the file's time, or the chat's last update");
  assert.deepEqual(byKey(res, "cursor:long").files.map((x) => [x.kind, x.name]), [["created", "missing.md"], ["created", "written.md"]]);
  assert.equal(byKey(res, "cursor:empty"), undefined);
  assert.deepEqual([...opened].sort(), ["long", "short"]);
});

test("only: other chats' and conversations' databases are not opened", async (t) => {
  const dir = tmpdir(t);
  const opened = [];
  for (const id of ["a1", "a2"]) agyDb(dir, id, [userStep(0, T0), toolStep(1, T0 + 1, "write_file", { Content: "x", Path: `D:\\w\\${id}.txt` })]);
  for (const id of ["c1", "c2"]) cursorChat(dir, id, { createdAtMs: T0, updatedAtMs: T0 + 1, cwd: "D:\\w" }, [cursorStep(12, cursorCall(`D:\\w\\${id}.txt`, editDone(`D:\\w\\${id}.txt`)), T0 + 1)]);
  const s = scanner(dir, { cursorDir: () => dir, geminiDir: () => dir, platform: "win32", onRead: (file) => opened.push(path.basename(path.dirname(file)) + "/" + path.basename(file)) });
  const res = await s.scan({ only: ["gemini:a2", "cursor:c1"] });
  assert.deepEqual(res.sessions.map((x) => x.key).sort(), ["cursor:c1", "gemini:a2"]);
  assert.deepEqual([...new Set(opened)].sort(), ["c1/store.db", "conversations/a2.db"]);
});

test("a database that cannot be read is counted, and the rest still returns", async (t) => {
  const dir = tmpdir(t);
  agyDb(dir, "good", [userStep(0, T0), toolStep(1, T0 + 1, "write_file", { Content: "x", Path: "D:\\w\\good.txt" })]);
  write(agyFile(dir, "text"), "not a database at all\n");
  // A database of another shape.
  sqlite(agyFile(dir, "other"), "CREATE TABLE things (x);", () => {});
  cursorChat(dir, "c1", { createdAtMs: T0, updatedAtMs: T0 + 1, cwd: "D:\\w" }, []);
  write(path.join(dir, "chats", "0123abcd", "c1", "store.db"), Buffer.alloc(4096, 7));
  const res = await scanner(dir, { cursorDir: () => dir, geminiDir: () => dir, platform: "win32" }).scan();
  assert.deepEqual(res.sessions.map((s) => s.key), ["gemini:good"]);
  assert.equal(res.coverage.skipped, 3);
});

test("a WAL database: rows still in its -wal are read, and a read leaves no -wal or -shm beside it", async (t) => {
  const dir = tmpdir(t);
  const file = agyFile(dir, "c1");
  sqlite(file, `PRAGMA journal_mode = WAL; ${AGY_SCHEMA}`, (db) => {
    db.prepare("INSERT INTO steps (idx, step_type, status, metadata) VALUES (?, ?, ?, ?)").run(0, 132, 3,
      agyMeta(T0, [1, 2, 3], { name: "write_file", args: { Content: "x", Path: "D:\\w\\one.txt" } }));
  });
  const s = scanner(dir, { geminiDir: () => dir, platform: "win32" });
  assert.deepEqual(rows((await s.scan()).sessions[0]), [["created", "D:\\w\\one.txt"]]);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ["c1.db"]);
  // A writer still at work: its rows are in the -wal only.
  const writer = new DatabaseSync(file);
  try {
    writer.exec("PRAGMA wal_autocheckpoint = 0;");
    writer.prepare("INSERT INTO steps (idx, step_type, status, metadata) VALUES (?, ?, ?, ?)").run(1, 132, 3,
      agyMeta(T0 + 1000, [1, 2, 3], { name: "write_file", args: { Content: "x", Path: "D:\\w\\two.txt" } }));
    assert.ok(fs.statSync(`${file}-wal`).size > 0);
    assert.deepEqual(rows((await s.scan()).sessions[0]), [["created", "D:\\w\\two.txt"], ["created", "D:\\w\\one.txt"]]);
  } finally {
    writer.close();
  }
});

test("the cache file carries database parse states to a new scanner, which opens nothing unchanged", async (t) => {
  const dir = tmpdir(t);
  const cacheFile = path.join(dir, "cache", "session-files.json");
  agyDb(dir, "a1", [userStep(0, T0), toolStep(1, T0 + 100, "view_file", { AbsolutePath: "D:\\w\\x.txt" }),
    toolStep(2, T0 + 200, "write_to_file", { CodeContent: "x", TargetFile: "D:\\w\\x.txt" }),
    toolStep(3, T0 + 300, "write_to_file", { CodeContent: "x", TargetFile: "D:\\w\\y.txt" }, { states: [1, 2] }),
    toolStep(4, T0 + 350, "read_file", { Path: "D:\\w\\z.txt" })]);
  cursorChat(dir, "c1", { createdAtMs: T0, updatedAtMs: T0 + 1, cwd: "D:\\w" }, [cursorUser("go", T0), cursorStep(12, cursorCall("D:\\w\\c.txt", editDone("D:\\w\\c.txt")), T0 + 1)]);
  const opts = { cursorDir: () => dir, geminiDir: () => dir, platform: "win32", cacheFile };
  const first = await scanner(dir, opts).scan();
  assert.deepEqual(first.sessions.map((s) => [s.key, rows(s)]).sort(), [
    ["cursor:c1", [["created", "D:\\w\\c.txt"]]],
    ["gemini:a1", [["edited", "D:\\w\\x.txt"]]],
  ]);
  const reads = [];
  const again = scanner(dir, { ...opts, onRead: (f, key) => reads.push(key) });
  assert.deepEqual(await again.scan(), first);
  assert.deepEqual(reads, []);
  // The unfinished step and what the session had seen survive the round trip.
  agyDb(dir, "a1", [toolStep(3, T0 + 300, "write_to_file", { CodeContent: "x", TargetFile: "D:\\w\\y.txt" }),
    toolStep(5, T0 + 400, "write_to_file", { CodeContent: "x", TargetFile: "D:\\w\\z.txt" })]);
  touch(agyFile(dir, "a1"), T0 + 5);
  assert.deepEqual(rows(byKey(await again.scan(), "gemini:a1")), [["edited", "D:\\w\\z.txt"], ["created", "D:\\w\\y.txt"], ["edited", "D:\\w\\x.txt"]]);
  assert.deepEqual(reads, [3, 5]);
});

test("Cursor Agent: a later scan reads only the blobs added since, and starts over when a read blob's row was taken by another", async (t) => {
  const dir = tmpdir(t);
  const reads = [];
  const s = scanner(dir, { cursorDir: () => dir, platform: "win32", onRead: (f, rowid) => reads.push(rowid) });
  const edit = (n, at) => cursorStep(12, cursorCall(`D:\\w\\${n}`, editDone(`D:\\w\\${n}`)), at);
  const file = cursorChat(dir, "c1", { createdAtMs: T0, updatedAtMs: T0 + 9, cwd: "D:\\w" }, [edit("a.txt", T0 + 1), edit("b.txt", T0 + 2)]);
  assert.deepEqual(rows((await s.scan()).sessions[0]), [["created", "D:\\w\\b.txt"], ["created", "D:\\w\\a.txt"]]);
  assert.deepEqual(reads, [1, 2]);
  cursorChat(dir, "c1", {}, [edit("c.txt", T0 + 3)]);
  touch(file, T0 + 1);
  reads.length = 0;
  assert.equal((await s.scan()).sessions[0].files.length, 3);
  assert.deepEqual(reads, [3]);
  // The newest blob deleted and another stored in its row: read from the start.
  sqlite(file, "", (db) => db.prepare("DELETE FROM blobs WHERE rowid = 3").run());
  cursorChat(dir, "c1", {}, [edit("d.txt", T0 + 4)]);
  touch(file, T0 + 2);
  reads.length = 0;
  assert.deepEqual(rows((await s.scan()).sessions[0]), [["created", "D:\\w\\d.txt"], ["created", "D:\\w\\b.txt"], ["created", "D:\\w\\a.txt"]]);
  assert.deepEqual(reads, [1, 2, 3]);
});
