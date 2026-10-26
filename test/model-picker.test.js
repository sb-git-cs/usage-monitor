const test = require("node:test");
const assert = require("node:assert/strict");
const tools = require("../src/model-picker/tools");
const { createConversation, menuRows, currentIndex, matchRow, CONTEXT_CAP } = require("../src/model-picker/conversation");
const render = require("../src/model-picker/render");
const { parseCommand, askTerminal } = require("../src/model-picker/cli");
const { PassThrough } = require("node:stream");

const {
  buildArgv,
  spawnPlan,
  validModelId,
  createParser,
  findExecutable,
  loadModels,
  parseCodexCache,
  parseCodexConfigModel,
  parseGrokModels,
  parseAgyModels,
  parseCursorModels,
} = tools;

function parse(toolId, lines) {
  const p = createParser(toolId);
  return lines.flatMap((l) => p(typeof l === "string" ? l : JSON.stringify(l)));
}

test("claude argv resumes a session, omits the model flag for default and keeps the permission flag", () => {
  const fresh = buildArgv("claude", { model: null, prompt: "hi" });
  assert.deepEqual(fresh.args, ["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--dangerously-skip-permissions"]);
  assert.equal(fresh.stdin, "hi");
  const resumed = buildArgv("claude", { model: "opus", sessionId: "s-1", prompt: "hi" });
  assert.deepEqual(resumed.args.slice(-4), ["--model", "opus", "--resume", "s-1"]);
});

test("codex argv differs for new and resumed sessions and reads the prompt from stdin", () => {
  const fresh = buildArgv("codex", { model: "m-1", prompt: "hi" });
  assert.deepEqual(fresh.args, ["exec", "--json", "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox", "-m", "m-1", "-"]);
  assert.equal(fresh.stdin, "hi");
  const resumed = buildArgv("codex", { sessionId: "t-1", prompt: "hi" });
  assert.deepEqual(resumed.args, ["exec", "resume", "t-1", "--json", "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox", "-"]);
});

test("grok takes the prompt from a file and gemini as an argv element", () => {
  const grok = buildArgv("grok", { model: "g-1", sessionId: "s-1", prompt: "hi", promptFile: "/tmp/p.txt" });
  assert.deepEqual(grok.args, ["--always-approve", "--output-format", "streaming-messages-json", "--include-partial-messages", "--prompt-file", "/tmp/p.txt", "-m", "g-1", "-r", "s-1"]);
  assert.equal(grok.stdin, null);
  const gemini = buildArgv("gemini", { model: "x-low", sessionId: "c-1", prompt: "hi there" });
  assert.deepEqual(gemini.args, ["-p", "hi there", "--output-format", "stream-json", "--dangerously-skip-permissions", "--model", "x-low", "--conversation", "c-1"]);
  assert.equal(gemini.stdin, null);
  assert.deepEqual(buildArgv("gemini", { prompt: "p" }).args.includes("--model"), false);
});

test("cursor argv trusts the folder, forces and reads stdin", () => {
  const cursor = buildArgv("cursor", { model: "auto", sessionId: "u-1", prompt: "hi" });
  assert.deepEqual(cursor.args, ["-p", "--trust", "--force", "--output-format", "stream-json", "--stream-partial-output", "--model", "auto", "--resume", "u-1"]);
  assert.equal(cursor.stdin, "hi");
});

test(".cmd tools go through cmd.exe with one quoted line, .exe tools spawn directly", () => {
  const plan = spawnPlan("C:\\Tools\\cursor agent\\cursor-agent.cmd", ["-p", "--model", "a b[x=1,y=2]"], "win32");
  assert.equal(plan.command, "cmd.exe");
  assert.deepEqual(plan.args, ["/d", "/s", "/c", '""C:\\Tools\\cursor agent\\cursor-agent.cmd" "-p" "--model" "a b[x=1,y=2]""']);
  assert.equal(plan.options.windowsVerbatimArguments, true);
  assert.equal(plan.options.windowsHide, true);
  const exe = spawnPlan("C:\\Tools\\codex.exe", ["exec"], "win32");
  assert.equal(exe.command, "C:\\Tools\\codex.exe");
  assert.deepEqual(exe.args, ["exec"]);
  assert.equal(exe.options.windowsVerbatimArguments, undefined);
  assert.throws(() => spawnPlan("C:\\x.cmd", ["a&b"], "win32"));
});

test("model ids that could break out of a command line are rejected", () => {
  assert.equal(validModelId("gpt-5.3-codex"), true);
  assert.equal(validModelId("claude-opus-4-8[context=1m,effort=high]"), true);
  assert.equal(validModelId("vendor/model:tag"), true);
  for (const bad of ['a"b', "x&y", "%PATH%", "a|b", "a^b", "a!b", "a<b", "", " pad"]) assert.equal(validModelId(bad), false, bad);
});

test("anthropic parser maps init, tool use, text, ignored events and the result", () => {
  const events = parse("claude", [
    "\uFEFF" + JSON.stringify({ type: "system", subtype: "init", session_id: "s-1", model: "m" }),
    "",
    { type: "assistant", message: { content: [{ type: "tool_use", name: "Glob", input: { pattern: "*" } }] }, session_id: "s-1" },
    { type: "user", message: { content: [{ type: "tool_result" }] } },
    { type: "rate_limit_event" },
    { type: "mystery" },
    { type: "assistant", message: { content: [{ type: "text", text: "one" }] } },
    { type: "assistant", message: { content: [{ type: "text", text: "two" }] } },
    "not json",
    { type: "result", subtype: "success", is_error: false, result: "done", session_id: "s-1" },
  ]);
  assert.deepEqual(events, [
    { kind: "session", id: "s-1" },
    { kind: "tool", text: "Glob *" },
    { kind: "text", text: "one" },
    { kind: "text", text: "\ntwo" },
    { kind: "raw", text: "not json" },
    { kind: "session", id: "s-1" },
    { kind: "result", text: "done", error: false },
  ]);
  const failed = parse("grok", [{ type: "result", is_error: true, result: "boom" }]);
  assert.deepEqual(failed, [{ kind: "result", text: "boom", error: true }]);
});

test("tool summaries pick the first known key, stay on one line and are truncated", () => {
  assert.equal(tools.summarizeTool("Bash", { command: "ls\n  -la", description: "x" }), "Bash ls -la");
  assert.equal(tools.summarizeTool("Odd", { foo: 1 }), 'Odd {"foo":1}');
  assert.equal(tools.summarizeTool("Odd", {}), "Odd");
  assert.ok(tools.summarizeTool("Bash", { command: "x".repeat(300) }).length <= 100);
});

test("codex parser follows items and reports the last agent message on turn.completed", () => {
  const events = parse("codex", [
    { type: "thread.started", thread_id: "t-1" },
    { type: "item.started", item: { type: "command_execution", command: "powershell.exe -Command 'Get-ChildItem'" } },
    { type: "item.completed", item: { type: "agent_message", text: "first" } },
    { type: "item.completed", item: { type: "file_change", changes: [{ path: "a.txt", kind: "add" }] } },
    { type: "item.started", item: { type: "mcp_tool_call", server: "x", tool: "y" } },
    { type: "item.started", item: { type: "web_search", query: "cats" } },
    { type: "item.completed", item: { type: "error", message: "recorded with model `a` but is resuming with `b`" } },
    { type: "item.completed", item: { type: "agent_message", text: "done" } },
    { type: "turn.completed", usage: {} },
  ]);
  assert.deepEqual(events, [
    { kind: "session", id: "t-1" },
    { kind: "tool", text: "Run powershell.exe -Command 'Get-ChildItem'" },
    { kind: "text", text: "first" },
    { kind: "tool", text: "Edit a.txt" },
    { kind: "tool", text: "x.y" },
    { kind: "tool", text: "Search cats" },
    { kind: "note", text: "recorded with model `a` but is resuming with `b`" },
    { kind: "text", text: "\ndone" },
    { kind: "result", text: "done", error: false },
  ]);
  assert.deepEqual(parse("codex", [{ type: "turn.failed", error: { message: "x" } }]), [{ kind: "result", text: "x", error: true }]);
  // A stream error may be retried, so only turn.failed ends the turn.
  assert.deepEqual(parse("codex", [{ type: "error", message: "y" }]), [{ kind: "note", text: "y" }]);
});

test("each turn gets a fresh codex parser", () => {
  const a = createParser("codex");
  a(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "old" } }));
  const b = createParser("codex");
  assert.deepEqual(b(JSON.stringify({ type: "turn.completed" })), [{ kind: "result", text: "", error: false }]);
});

test("agy parser streams deltas, tool steps, errors and the result", () => {
  const step = (s) => ({ event: "step_update", step_update: s });
  const events = parse("gemini", [
    { event: "init", conversation_id: "c-1", init: { model: "m" } },
    step({ state: "ACTIVE", step_type: "agent_response", text_delta: "man" }),
    step({ state: "DONE", step_type: "agent_response", text_delta: "\n" }),
    step({ state: "ACTIVE", step_type: "tool", tool_name: "run_command", tool_info: { parameters: { CommandLine: "Get-ChildItem" } } }),
    step({ state: "ACTIVE", step_type: "tool", tool_name: "run_command", tool_info: { parameters: { CommandLine: "Get-ChildItem" } } }),
    step({ state: "ERROR", step_type: "tool", tool_info: { error: { message: "permission check failed" } } }),
    { event: "result", result: { conversation_id: "c-1", status: "SUCCESS", response: "mango\n" } },
  ]);
  assert.deepEqual(events, [
    { kind: "session", id: "c-1" },
    { kind: "text", text: "man" },
    { kind: "text", text: "\n" },
    { kind: "tool", text: "run_command Get-ChildItem" },
    { kind: "note", text: "permission check failed" },
    { kind: "session", id: "c-1" },
    { kind: "result", text: "mango\n", error: false },
  ]);
  const bad = parse("gemini", [{ event: "result", result: { status: "FAILED", response: "no" } }]);
  assert.deepEqual(bad, [{ kind: "result", text: "no", error: true }]);
});

test("agy deltas of one step join as is; a later step starts on a new line", () => {
  const step = (s) => ({ event: "step_update", step_update: s });
  const texts = parse("gemini", [
    step({ step_index: 1, state: "ACTIVE", step_type: "agent_response", text_delta: "m" }),
    step({ step_index: 1, state: "ACTIVE", step_type: "agent_response", text_delta: "ango" }),
    step({ step_index: 3, state: "ACTIVE", step_type: "agent_response", text_delta: "Done" }),
  ]).map((event) => event.text);
  assert.deepEqual(texts, ["m", "ango", "\nDone"]);
});

test("cursor parser names tool calls by their key and reports thinking as activity", () => {
  const events = parse("cursor", [
    { type: "system", subtype: "init", session_id: "u-1", model: "Composer 2.5" },
    { type: "thinking", subtype: "delta" },
    { type: "user", message: {} },
    { type: "tool_call", subtype: "started", tool_call: { globToolCall: { args: { globPattern: "*" } }, toolCallId: "x" } },
    { type: "tool_call", subtype: "completed", tool_call: { globToolCall: { args: { globPattern: "*" } } } },
    { type: "assistant", message: { content: [{ type: "text", text: "done" }] } },
    { type: "result", subtype: "success", is_error: false, result: "done", session_id: "u-1" },
  ]);
  assert.deepEqual(events, [
    { kind: "session", id: "u-1" },
    { kind: "activity", text: "thinking" },
    { kind: "tool", text: "glob *" },
    { kind: "text", text: "done" },
    { kind: "session", id: "u-1" },
    { kind: "result", text: "done", error: false },
  ]);
});

test("model list parsers read the CLI outputs", () => {
  const cache = JSON.stringify({
    models: [
      { slug: "m-a", display_name: "Model A", visibility: "list" },
      { slug: "m-hidden", display_name: "Hidden", visibility: "hide" },
    ],
  });
  assert.deepEqual(parseCodexCache(cache), [{ id: "m-a", label: "Model A" }]);
  assert.deepEqual(parseCodexCache("{bad"), []);
  assert.equal(parseCodexConfigModel('model = "m-cfg"\n[profiles.x]\nmodel = "other"\n'), "m-cfg");
  assert.equal(parseCodexConfigModel('[profiles.x]\nmodel = "other"\n'), null);
  assert.deepEqual(parseGrokModels("Models:\n  - grok-a\n  * grok-b-fast (default)\n"), [{ id: "grok-a" }, { id: "grok-b-fast" }]);
  assert.deepEqual(parseAgyModels("Fetching available models...\nflash-low\tFlash (Low)\n"), [{ id: "flash-low", label: "Flash (Low)" }]);
  assert.deepEqual(parseCursorModels("Available models\n\nauto - Auto (current, default)\ncode-x - Code\u200b X\n"), [
    { id: "auto", label: "Auto (current, default)" },
    { id: "code-x", label: "Code X" },
  ]);
});

test("loadModels combines the codex cache with config.toml and never throws", async () => {
  const files = {
    "/home/u/.codex/models_cache.json": JSON.stringify({ models: [{ slug: "m-a", display_name: "A", visibility: "list" }] }),
    "/home/u/.codex/config.toml": 'model = "m-cfg"\n',
  };
  const readFile = (f) => files[f.replace(/\\/g, "/")] || "";
  const codex = await loadModels("codex", { home: "/home/u", env: {}, readFile });
  assert.deepEqual(codex.map((m) => m.id), ["m-a", "m-cfg"]);
  const dup = await loadModels("codex", { home: "/home/u", env: { CODEX_HOME: "/nowhere" }, readFile });
  assert.deepEqual(dup, []);
  assert.deepEqual((await loadModels("claude")).map((m) => m.id), ["fable", "opus", "sonnet", "haiku"]);
  assert.deepEqual(await loadModels("cursor", { exe: "x", run: async () => "a&b - Bad id\nok - Fine\n" }), [{ id: "ok", label: "Fine" }]);
  assert.deepEqual(await loadModels("grok", { exe: "x", run: async () => { throw new Error("boom"); } }), []);
});

test("conversation gives a tool only the turns it missed", () => {
  const c = createConversation();
  assert.equal(c.promptFor("claude", "hello"), "hello");
  c.record({ toolId: "codex", toolLabel: "Codex", model: "m-1", prompt: "q1", reply: "a1", sessionId: "t-1" });
  assert.equal(c.promptFor("codex", "q2"), "q2");
  assert.equal(c.sessionFor("codex"), "t-1");
  assert.equal(c.sessionFor("claude"), null);
  const text = c.promptFor("claude", "q2");
  assert.equal(
    text,
    "Earlier in this conversation, other assistants answered these turns in this same folder. Use them as context.\n\n" +
      "[User]\nq1\n\n[Codex · m-1]\na1\n\nNow the user asks:\nq2"
  );
  c.record({ toolId: "claude", toolLabel: "Claude Code", model: null, prompt: "q2", reply: "a2", sessionId: "s-1" });
  const back = c.promptFor("codex", "q3");
  assert.ok(back.includes("[User]\nq2\n\n[Claude Code · default]\na2"));
  assert.ok(!back.includes("a1"));
  assert.equal(c.promptFor("claude", "q3"), "q3");
});

test("conversation caps the context to the newest turns and cuts an oversized reply from the front", () => {
  const c = createConversation();
  for (let i = 0; i < 5; i++) c.record({ toolId: "codex", toolLabel: "Codex", model: "m", prompt: `p${i}`, reply: "x".repeat(6000), sessionId: "t" });
  const text = c.promptFor("claude", "next");
  assert.ok(text.includes("p4") && text.includes("p3") && text.includes("p2"));
  assert.ok(!text.includes("p0"));
  const context = text.slice(text.indexOf("[User]"), text.indexOf("\n\nNow the user asks:"));
  assert.ok(context.length <= CONTEXT_CAP);

  const big = createConversation();
  big.record({ toolId: "codex", toolLabel: "Codex", model: "m", prompt: "p", reply: "A".repeat(30000) + "END", sessionId: "t" });
  const cut = big.promptFor("claude", "next");
  assert.ok(cut.includes("[Codex · m]\n…AAA"));
  assert.ok(cut.includes("END\n\nNow the user asks:"));
  assert.ok(!cut.includes("A".repeat(CONTEXT_CAP)));
});

test("a failed turn without a session stays in the transcript but creates no session", () => {
  const c = createConversation();
  c.record({ toolId: "grok", toolLabel: "Grok Build", model: null, prompt: "q", reply: "", sessionId: null });
  assert.equal(c.turns[0].reply, "(no reply)");
  assert.equal(c.sessionFor("grok"), null);
  assert.ok(c.promptFor("grok", "again").includes("[Grok Build · default]"));
});

test("menu rows list default, models, recent ids and Other per tool", () => {
  const installed = [
    { id: "codex", label: "Codex", models: [{ id: "m-a" }, { id: "m-b", label: "Model B" }] },
    { id: "claude", label: "Claude Code", models: [] },
  ];
  const rows = menuRows(installed, { codex: ["typed-1", "m-a", "typed-1", "typed-2"] });
  assert.deepEqual(rows.map((r) => r.text), [
    "Codex · default",
    "Codex · m-a",
    "Codex · Model B",
    "Codex · typed-1",
    "Codex · typed-2",
    "Codex · Other model…",
    "Claude Code · default",
    "Claude Code · Other model…",
  ]);
  assert.deepEqual(rows.map((r) => r.kind), ["model", "model", "model", "model", "model", "other", "model", "other"]);
  assert.equal(rows[0].model, null);
  assert.equal(currentIndex(rows, { toolId: "codex", model: "m-b" }), 2);
  assert.equal(currentIndex(rows, { toolId: "claude", model: null }), 6);
  assert.equal(currentIndex(rows, { toolId: "gone", model: "x" }), 0);
  assert.equal(currentIndex(rows, null), 0);
});

test("/model <name> finds a model by id or label, a tool's default by name, and narrows to the current tool", () => {
  const installed = [
    { id: "claude", label: "Claude Code", models: [{ id: "opus", label: "Opus" }, { id: "sonnet", label: "Sonnet" }] },
    { id: "cursor", label: "Cursor", models: [{ id: "sonnet" }, { id: "gpt-5", label: "GPT-5" }] },
  ];
  const rows = menuRows(installed);
  const at = (i) => (i < 0 ? null : `${rows[i].toolId}:${rows[i].model}`);
  assert.equal(at(matchRow(rows, "OPUS")), "claude:opus");
  assert.equal(at(matchRow(rows, " gpt-5 ")), "cursor:gpt-5");
  assert.equal(at(matchRow(rows, "cursor")), "cursor:null");
  assert.equal(at(matchRow(rows, "claude code")), "claude:null");
  // "sonnet" is in both tools: only the current tool settles it.
  assert.equal(matchRow(rows, "sonnet"), -1);
  assert.equal(at(matchRow(rows, "sonnet", { toolId: "cursor", model: "gpt-5" })), "cursor:sonnet");
  assert.equal(at(matchRow(rows, "default", { toolId: "claude", model: "opus" })), "claude:null");
  assert.equal(matchRow(rows, "default"), -1);
  assert.equal(matchRow(rows, "other model…"), -1);
  assert.equal(matchRow(rows, "son"), -1);
  assert.equal(matchRow(rows, ""), -1);
});

test("each terminal question lets go of the input, so a typed key is echoed once", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let shown = "";
  output.on("data", (d) => (shown += d));
  for (const line of ["one", "two", "/model"]) {
    const answer = askTerminal("> ", input, output);
    input.write(`${line}\r`);
    assert.equal(await answer, line);
  }
  assert.equal(input.listenerCount("keypress"), 0);
  const next = askTerminal("> ", input, output);
  shown = "";
  input.write("z");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(shown.split("z").length - 1, 1);
  input.end();
  assert.equal(await next, null);
});

test("only a one-line /model or /exit is a command", () => {
  assert.deepEqual(parseCommand("/model"), { kind: "model", arg: "" });
  assert.deepEqual(parseCommand("  /model   gpt-5  "), { kind: "model", arg: "gpt-5" });
  assert.deepEqual(parseCommand("/exit"), { kind: "exit" });
  assert.deepEqual(parseCommand("/quit"), { kind: "exit" });
  assert.deepEqual(parseCommand("/models"), { kind: "prompt" });
  assert.deepEqual(parseCommand("/model opus\nand explain"), { kind: "prompt" });
  assert.deepEqual(parseCommand("use /model later"), { kind: "prompt" });
});

test("executable lookup searches PATH then the tool's own install folders", () => {
  const env = { PATH: "C:\\bin;C:\\other", LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" };
  const home = "C:\\Users\\u";
  const has = (set) => (p) => set.includes(p);
  assert.equal(findExecutable("codex", { platform: "win32", env, home, exists: has(["C:\\other\\codex.cmd", "C:\\bin\\codex"]) }), "C:\\bin\\codex");
  assert.equal(findExecutable("codex", { platform: "win32", env, home, exists: has(["C:\\other\\codex.cmd", "C:\\other\\codex.exe"]) }), "C:\\other\\codex.exe");
  const extra = {
    claude: "C:\\Users\\u\\.local\\bin\\claude.exe",
    codex: "C:\\Users\\u\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin\\codex.exe",
    grok: "C:\\Users\\u\\.grok\\bin\\grok.exe",
    gemini: "C:\\Users\\u\\AppData\\Local\\agy\\bin\\agy.exe",
    cursor: "C:\\Users\\u\\AppData\\Local\\cursor-agent\\cursor-agent.cmd",
  };
  for (const [id, file] of Object.entries(extra)) assert.equal(findExecutable(id, { platform: "win32", env, home, exists: has([file]) }), file);
  assert.equal(findExecutable("grok", { platform: "win32", env, home, exists: () => false }), null);
  assert.equal(findExecutable("claude", { platform: "linux", env: { PATH: "/usr/bin" }, home: "/home/u", exists: has(["/home/u/.local/bin/claude"]) }), "/home/u/.local/bin/claude");
  assert.equal(findExecutable("codex", { platform: "linux", env: { PATH: "/usr/bin", LOCALAPPDATA: "/x" }, home: "/home/u", exists: has(["/x/Programs/OpenAI/Codex/bin/codex"]) }), null);
});

const stream = (event) => ({ type: "stream_event", event });
const block = (type) => stream({ type: "content_block_start", index: 0, content_block: { type, text: "" } });
const delta = (d) => stream({ type: "content_block_delta", index: 0, delta: d });
const textDelta = (text) => delta({ type: "text_delta", text });

for (const toolId of ["claude", "grok"]) {
  test(`${toolId} deltas stream as text, thinking is activity and the repeated assistant text is skipped`, () => {
    const events = parse(toolId, [
      { type: "system", subtype: "init", session_id: "s-1" },
      stream({ type: "message_start" }),
      block("thinking"),
      delta({ type: "thinking_delta", thinking: "hm" }),
      delta({ type: "thinking_delta", thinking: "mm" }),
      stream({ type: "content_block_stop", index: 0 }),
      block("text"),
      textDelta("Hel"),
      textDelta("lo"),
      { type: "assistant", message: { content: [{ type: "text", text: "Hello" }, { type: "tool_use", name: "Glob", input: { pattern: "*" } }] } },
      stream({ type: "content_block_stop", index: 0 }),
      block("text"),
      textDelta("Bye"),
      stream({ type: "message_stop" }),
      { type: "result", is_error: false, result: "Hello\nBye" },
    ]);
    assert.deepEqual(events, [
      { kind: "session", id: "s-1" },
      { kind: "activity", text: "thinking" },
      { kind: "activity", text: "writing" },
      { kind: "text", text: "Hel" },
      { kind: "text", text: "lo" },
      { kind: "tool", text: "Glob *" },
      { kind: "activity", text: "writing" },
      { kind: "text", text: "\nBye" },
      { kind: "result", text: "Hello\nBye", error: false },
    ]);
  });
}

test("without deltas the assistant text is still emitted", () => {
  const events = parse("claude", [{ type: "assistant", message: { content: [{ type: "text", text: "whole" }] } }]);
  assert.deepEqual(events, [{ kind: "text", text: "whole" }]);
});

test("cursor deltas carry timestamp_ms and the closing full message is skipped", () => {
  const part = (text) => ({ type: "assistant", message: { content: [{ type: "text", text }] }, timestamp_ms: 1 });
  const full = (text) => ({ type: "assistant", message: { content: [{ type: "text", text }] } });
  const events = parse("cursor", [
    { type: "thinking", subtype: "delta" },
    { type: "thinking", subtype: "delta" },
    part("Hel"),
    part("lo"),
    full("Hello"),
    part("Next"),
    full("Next"),
    full("Whole, never streamed"),
  ]);
  assert.deepEqual(events, [
    { kind: "activity", text: "thinking" },
    { kind: "activity", text: "writing" },
    { kind: "text", text: "Hel" },
    { kind: "text", text: "lo" },
    { kind: "activity", text: "writing" },
    { kind: "text", text: "\nNext" },
    { kind: "text", text: "\nWhole, never streamed" },
  ]);
});

test("usage is normalised per tool on the result event", () => {
  const result = (toolId, line) => parse(toolId, [line]).find((e) => e.kind === "result");
  const claude = result("claude", { type: "result", result: "x", usage: { input_tokens: 10, cache_creation_input_tokens: 20, cache_read_input_tokens: 30, output_tokens: 5 }, total_cost_usd: 0.0612 });
  assert.deepEqual(claude.usage, { input: 60, output: 5 });
  assert.equal(claude.costUsd, 0.0612);
  assert.deepEqual(result("grok", { type: "result", result: "x", usage: { input_tokens: 3, output_tokens: 4 } }).usage, { input: 3, output: 4 });
  assert.deepEqual(result("codex", { type: "turn.completed", usage: { input_tokens: 100, cached_input_tokens: 90, output_tokens: 7 } }).usage, { input: 100, output: 7 });
  assert.deepEqual(result("cursor", { type: "result", result: "x", usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 30, cacheWriteTokens: 400 } }).usage, { input: 431, output: 2 });
  assert.deepEqual(result("gemini", { event: "result", result: { status: "SUCCESS", response: "x", usage: { input_tokens: 8, output_tokens: 9 } } }).usage, { input: 8, output: 9 });
  assert.equal("usage" in result("codex", { type: "turn.completed", usage: {} }), false);
});

test("tools carry their menu color", () => {
  assert.deepEqual(tools.TOOLS.map((t) => t.color), [173, 114, 252, 75, 141]);
});

// ---- render.js ----

const plainOpts = { color: false };
const on = { color: true, basic: false };
const strip = (s) => require("node:util").stripVTControlCharacters(s);

function menuFixture() {
  return menuRows(
    [
      { id: "claude", label: "Claude Code", color: 173, models: [{ id: "opus" }, { id: "sonnet" }] },
      { id: "codex", label: "Codex", color: 114, models: [{ id: "gpt-5.6-sol", label: "GPT-5.6-Sol" }, { id: "gpt-5.5" }] },
    ],
    {}
  );
}

test("menu lines group rows under a tool header with the id in a second column", () => {
  const lines = render.menuLines(menuFixture(), { pos: 0, width: 80, height: 30, current: { toolId: "codex", model: "gpt-5.5" }, ...plainOpts });
  assert.equal(lines[0], "Claude Code  2 models");
  assert.match(lines[1], /^ {2}› +default +tool's own default$/);
  assert.equal(lines[2], "      opus");
  assert.equal(lines.indexOf("Codex  2 models"), 5);
  assert.match(lines[7], /^ {6}GPT-5.6-Sol +gpt-5\.6-sol$/);
  assert.match(lines[8], /^ {4}● gpt-5\.5$/);
  assert.equal(lines[9], "      Other model…");
  assert.equal(lines[lines.length - 1], render.HINT);
  assert.ok(lines.every((l) => !l.includes("\x1b")));
});

test("menu filter is case-insensitive over tool, label and id, hides empty groups and shows a filter line", () => {
  const rows = menuFixture();
  const sol = render.menuLines(rows, { filter: "SOL", pos: 0, width: 80, height: 30, ...plainOpts });
  assert.equal(sol[0], "Filter SOL");
  assert.ok(sol.some((l) => l.startsWith("Codex")));
  assert.ok(!sol.some((l) => l.startsWith("Claude Code")));
  assert.ok(sol.some((l) => l.includes("gpt-5.6-sol")));
  assert.ok(render.menuLines(rows, { filter: "5.5", width: 80, height: 30, ...plainOpts }).some((l) => l.includes("gpt-5.5")));
  assert.ok(render.menuLines(rows, { filter: "claude code", width: 80, height: 30, ...plainOpts }).some((l) => l.includes("sonnet")));
  const none = render.menuLines(rows, { filter: "zzz", width: 80, height: 30, ...plainOpts });
  assert.deepEqual(none, ["Filter zzz", "  (no match)", render.HINT]);
  assert.equal(render.menuLines(rows, { width: 80, height: 30, ...plainOpts })[0].startsWith("Filter"), false);
});

test("menu viewport keeps the highlighted row visible within the height", () => {
  const rows = menuFixture();
  const total = render.filterRows(rows, "").length;
  for (const pos of [0, 3, total - 1]) {
    const lines = render.menuLines(rows, { pos, width: 80, height: 6, ...plainOpts });
    assert.ok(lines.length <= 6);
    assert.equal(lines.filter((l) => l.startsWith("  ›")).length, 1);
  }
  const first = render.menuLines(rows, { pos: 5, width: 80, height: 5, ...plainOpts });
  assert.ok(first.includes("Codex  2 models"));
});

test("menu colors the current marker in the tool color and bolds the highlight", () => {
  const lines = render.menuLines(menuFixture(), { pos: 0, width: 80, height: 30, current: { toolId: "claude", model: null }, ...on });
  assert.ok(lines[0].includes("\x1b[38;5;173m"));
  assert.ok(lines[1].includes("\x1b[38;5;173m●"));
  const basic = render.menuLines(menuFixture(), { pos: 0, width: 80, height: 30, color: true, basic: true });
  assert.ok(basic[0].includes("\x1b[33m"));
});

test("tab jumps to the next and previous tool group and wraps", () => {
  const rows = menuFixture();
  const list = render.filterRows(rows, "");
  assert.equal(render.jumpGroup(rows, list, 1, 1), 4);
  assert.equal(render.jumpGroup(rows, list, 5, 1), 0);
  assert.equal(render.jumpGroup(rows, list, 5, -1), 0);
  assert.equal(render.jumpGroup(rows, list, 0, -1), 4);
});

test("markdown lines: headings, emphasis, code, lists, quotes and links", () => {
  const st = { fence: false };
  const r = (line) => render.renderLine(line, st, on);
  assert.equal(strip(r("## Title")), "Title");
  assert.ok(r("## Title").includes("\x1b[1m"));
  assert.equal(r("a **bold** b"), "a \x1b[1mbold\x1b[22m b");
  assert.equal(r("an *it* and _it2_ ok"), "an \x1b[3mit\x1b[23m and \x1b[3mit2\x1b[23m ok");
  assert.equal(strip(r("run `ls -la` now")), "run ls -la now");
  assert.ok(r("run `ls`").includes("\x1b[36mls\x1b[39m"));
  assert.equal(strip(r("  - item")), "  • item");
  assert.equal(strip(r("* item")), "• item");
  assert.equal(r("1. first"), "1. first");
  assert.equal(strip(r("> quoted")), "│ quoted");
  assert.equal(strip(r("see [docs](https://x.io/a_b)")), "see docs (https://x.io/a_b)");
  assert.equal(r("use snake_case_name and a * b * c"), "use snake_case_name and a * b * c");
});

test("markdown fences render a rule with the language, a gutter inside and no inline formatting", () => {
  const st = { fence: false };
  const r = (line) => strip(render.renderLine(line, st, { ...on, width: 20 }));
  assert.equal(r("```js"), "─── js " + "─".repeat(13));
  assert.equal(st.fence, true);
  assert.equal(r("const **a** = `b`;"), "│ const **a** = `b`;");
  assert.equal(r("```"), "─".repeat(20));
  assert.equal(st.fence, false);
  assert.equal(r("**after**"), "after");
});

test("NO_COLOR passes markdown through untouched", () => {
  const st = { fence: false };
  for (const line of ["# H", "**b** `c`", "- x", "```js", "> q"]) assert.equal(render.renderLine(line, st, plainOpts), line);
});

test("stream renderer rewrites a finished line in place and buffers without a column count", () => {
  const out = [];
  const live = render.createStreamRenderer({ write: (s) => out.push(s), columns: 10, overwrite: true, ...on });
  live.push("**ab");
  assert.equal(live.atLineStart(), false);
  live.push("c**\n");
  assert.equal(live.atLineStart(), true);
  assert.deepEqual(out, ["**ab", "\r\x1b[J", "\x1b[1mabc\x1b[22m\n"]);
  out.length = 0;
  live.push("x".repeat(25));
  live.push("\n");
  assert.equal(out[1], "\x1b[2A\r\x1b[J");

  const buffered = [];
  const b = render.createStreamRenderer({ write: (s) => buffered.push(s), columns: 0, overwrite: true, ...on });
  b.push("**x**");
  assert.deepEqual(buffered, []);
  b.endLine();
  assert.deepEqual(buffered, ["\x1b[1mx\x1b[22m\n"]);

  const raw = [];
  const p = render.createStreamRenderer({ write: (s) => raw.push(s), columns: 10, overwrite: true, ...plainOpts });
  p.push("**a");
  p.endLine();
  assert.deepEqual(raw, ["**a", "\n"]);
});

test("status line, rule and footer formatting", () => {
  assert.equal(render.statusLine({ frame: 0, label: "Claude Code · opus", elapsed: 4.23, activity: "thinking", ...plainOpts }), "⠋ Claude Code · opus · thinking… · 4.2s");
  assert.equal(render.statusLine({ frame: 11, label: "L", elapsed: 7.9, activity: "running Glob *", ...plainOpts }), "⠙ L · running Glob * · 7.9s");
  assert.equal(render.formatTokens(740), "740");
  assert.equal(render.formatTokens(30200), "30.2k");
  assert.equal(render.formatCost(0.0612), "≈$0.06");
  assert.equal(render.formatCost(0.001), "<$0.01");
  const rule = render.turnRule({ label: "Claude Code · opus", columns: 200, ...plainOpts });
  assert.ok(rule.startsWith("── Claude Code · opus ─"));
  assert.equal([...rule].length, 80);
  assert.equal(render.turnFooter({ elapsedMs: 12300, usage: { input: 30200, output: 740 }, costUsd: 0.0612, ...plainOpts }), "✓ 12.3 s · 30.2k in · 740 out · ≈$0.06");
  assert.equal(render.turnFooter({ elapsedMs: 1000, ...plainOpts }), "✓ 1.0 s");
  assert.equal(render.turnFooter({ elapsedMs: 1000, failed: "boom", ...plainOpts }), "✗ boom · 1.0 s");
  assert.equal(render.turnFooter({ elapsedMs: 1000, stopped: true, ...plainOpts }), "■ Stopped · 1.0 s");
  assert.ok(render.turnFooter({ elapsedMs: 1, failed: "x", ...on }).includes("\x1b[31m"));
});
