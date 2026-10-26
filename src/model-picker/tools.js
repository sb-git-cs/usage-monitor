const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");

// Ids reach a cmd.exe command line for .cmd tools, so only plain characters are accepted.
const MODEL_ID_RE = /^[A-Za-z0-9._:\-[\]=,/ ]+$/;
const MODEL_LIST_TIMEOUT_MS = 15000;
const TOOL_LINE_MAX = 100;

const TOOLS = [
  {
    id: "claude",
    color: 173,
    label: "Claude Code",
    file: "claude",
    parser: "anthropic",
    stdin: true,
    staticModels: ["fable", "opus", "sonnet", "haiku"],
    extraDirs: (ctx) => [ctx.join(ctx.home, ".local", "bin")],
  },
  {
    id: "codex",
    color: 114,
    label: "Codex",
    file: "codex",
    parser: "codex",
    stdin: true,
    extraDirs: (ctx) => (ctx.local ? [ctx.join(ctx.local, "Programs", "OpenAI", "Codex", "bin")] : []),
  },
  {
    id: "grok",
    color: 252,
    label: "Grok Build",
    file: "grok",
    parser: "anthropic",
    stdin: false,
    promptFile: true,
    extraDirs: (ctx) => [ctx.join(ctx.home, ".grok", "bin")],
  },
  {
    id: "gemini",
    color: 75,
    label: "Gemini",
    file: "agy",
    parser: "agy",
    stdin: false,
    extraDirs: (ctx) => (ctx.local ? [ctx.join(ctx.local, "agy", "bin")] : []),
  },
  {
    id: "cursor",
    color: 141,
    label: "Cursor",
    file: "cursor-agent",
    parser: "cursor",
    stdin: true,
    extraDirs: (ctx) => (ctx.local ? [ctx.join(ctx.local, "cursor-agent")] : []),
  },
];

function toolById(id) {
  return TOOLS.find((t) => t.id === id) || null;
}

function validModelId(id) {
  return typeof id === "string" && id.length <= 200 && MODEL_ID_RE.test(id.trim()) && id.trim() === id;
}

// ---- executables ----

function findExecutable(toolId, opts = {}) {
  const tool = toolById(toolId);
  if (!tool) return null;
  const platform = opts.platform || process.platform;
  const env = opts.env || process.env;
  const exists = opts.exists || ((p) => fs.existsSync(p));
  const p = platform === "win32" ? path.win32 : path.posix;
  const home = opts.home || os.homedir();
  const local = platform === "win32" ? env.LOCALAPPDATA || null : null;
  const exts = platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  const pathDirs = (env.PATH || env.Path || "").split(p.delimiter).filter(Boolean);
  const dirs = [...pathDirs, ...tool.extraDirs({ home, local, join: p.join })];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = p.join(dir, tool.file + ext);
      try {
        if (exists(candidate)) return candidate;
      } catch {
        /* ignore */
      }
    }
  }
  return null;
}

function isCmdScript(file) {
  return /\.(cmd|bat)$/i.test(file);
}

// A .cmd cannot be spawned directly on Windows, so it goes through cmd.exe with one quoted line.
function spawnPlan(exe, args, platform = process.platform) {
  if (platform === "win32" && isCmdScript(exe)) {
    if (args.some((a) => /["%!^&|<>\r\n]/.test(a))) throw new Error("Argument is not safe for cmd.exe");
    const line = [`"${exe}"`, ...args.map((a) => `"${a}"`)].join(" ");
    return {
      command: "cmd.exe",
      args: ["/d", "/s", "/c", `"${line}"`],
      options: { windowsHide: true, windowsVerbatimArguments: true },
    };
  }
  return { command: exe, args, options: { windowsHide: true } };
}

// ---- argv ----

// Returns the argv and what to write to stdin (null when the tool takes the prompt another way).
function buildArgv(toolId, { model = null, sessionId = null, prompt = "", promptFile = null } = {}) {
  switch (toolId) {
    case "claude": {
      const args = ["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--dangerously-skip-permissions"];
      if (model) args.push("--model", model);
      if (sessionId) args.push("--resume", sessionId);
      return { args, stdin: prompt };
    }
    case "codex": {
      const head = sessionId ? ["exec", "resume", sessionId] : ["exec"];
      const args = [...head, "--json", "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox"];
      if (model) args.push("-m", model);
      args.push("-");
      return { args, stdin: prompt };
    }
    case "grok": {
      const args = ["--always-approve", "--output-format", "streaming-messages-json", "--include-partial-messages", "--prompt-file", promptFile];
      if (model) args.push("-m", model);
      if (sessionId) args.push("-r", sessionId);
      return { args, stdin: null };
    }
    case "gemini": {
      const args = ["-p", prompt, "--output-format", "stream-json", "--dangerously-skip-permissions"];
      if (model) args.push("--model", model);
      if (sessionId) args.push("--conversation", sessionId);
      return { args, stdin: null };
    }
    case "cursor": {
      const args = ["-p", "--trust", "--force", "--output-format", "stream-json", "--stream-partial-output"];
      if (model) args.push("--model", model);
      if (sessionId) args.push("--resume", sessionId);
      return { args, stdin: prompt };
    }
    default:
      throw new Error(`Unknown tool: ${toolId}`);
  }
}

// ---- model lists ----

function parseCodexCache(text) {
  try {
    const list = JSON.parse(String(text).replace(/^\uFEFF/, "")).models;
    if (!Array.isArray(list)) return [];
    return list
      .filter((m) => m && m.visibility === "list" && typeof m.slug === "string" && m.slug)
      .map((m) => ({ id: m.slug, label: typeof m.display_name === "string" && m.display_name ? m.display_name : undefined }));
  } catch {
    return [];
  }
}

function parseCodexConfigModel(text) {
  const top = String(text).replace(/^\uFEFF/, "").split(/^\s*\[/m)[0];
  const m = /^\s*model\s*=\s*["']([^"']+)["']/m.exec(top);
  return m ? m[1] : null;
}

function parseGrokModels(out) {
  const models = [];
  for (const line of String(out).split(/\r?\n/)) {
    const m = /^\s*[-*]\s+(\S+)/.exec(line);
    if (m) models.push({ id: m[1] });
  }
  return models;
}

function parseAgyModels(out) {
  const models = [];
  for (const line of String(out).split(/\r?\n/)) {
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    const id = line.slice(0, tab).trim();
    const label = line.slice(tab + 1).trim();
    if (id) models.push({ id, label: label || undefined });
  }
  return models;
}

function parseCursorModels(out) {
  const models = [];
  for (const raw of String(out).split(/\r?\n/)) {
    const line = raw.replace(/\u200B/g, "").trim();
    const i = line.indexOf(" - ");
    if (!line || i < 0) continue;
    const id = line.slice(0, i).trim();
    const label = line.slice(i + 3).trim();
    if (id) models.push({ id, label: label || undefined });
  }
  return models;
}

function readText(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

function codexModels(env, home, readFile) {
  const dir = env.CODEX_HOME || path.join(home, ".codex");
  const models = parseCodexCache(readFile(path.join(dir, "models_cache.json")));
  const configured = parseCodexConfigModel(readFile(path.join(dir, "config.toml")));
  if (configured && !models.some((m) => m.id === configured)) models.push({ id: configured });
  return models;
}

function runCapture(exe, args) {
  return new Promise((resolve) => {
    let plan;
    try {
      plan = spawnPlan(exe, args);
    } catch {
      resolve("");
      return;
    }
    execFile(
      plan.command,
      plan.args,
      { ...plan.options, timeout: MODEL_LIST_TIMEOUT_MS, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => resolve(err ? "" : stdout)
    );
  });
}

// Never throws: a tool whose list cannot be read still gets "tool default" and "Other model" in the menu.
async function loadModels(toolId, { exe, env = process.env, home = os.homedir(), run = runCapture, readFile = readText } = {}) {
  try {
    let models = [];
    if (toolId === "claude") models = toolById("claude").staticModels.map((id) => ({ id }));
    else if (toolId === "codex") models = codexModels(env, home, readFile);
    else if (toolId === "grok") models = parseGrokModels(await run(exe, ["models"]));
    else if (toolId === "gemini") models = parseAgyModels(await run(exe, ["models"]));
    else if (toolId === "cursor") models = parseCursorModels(await run(exe, ["models"]));
    const seen = new Set();
    return models.filter((m) => validModelId(m.id) && !seen.has(m.id) && seen.add(m.id));
  } catch {
    return [];
  }
}

// ---- stream parsing ----

function oneLine(text, max = TOOL_LINE_MAX) {
  const s = String(text).replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

const SUMMARY_KEYS = [
  "command",
  "CommandLine",
  "file_path",
  "path",
  "target_directory",
  "targetDirectory",
  "pattern",
  "globPattern",
  "query",
  "url",
  "description",
];

function summarizeTool(name, input) {
  let detail = "";
  if (input && typeof input === "object") {
    const key = SUMMARY_KEYS.find((k) => input[k] != null && input[k] !== "");
    if (key) detail = typeof input[key] === "string" ? input[key] : JSON.stringify(input[key]);
    else if (Object.keys(input).length) detail = JSON.stringify(input);
  }
  return oneLine(detail ? `${name} ${detail}` : name);
}

function parseJson(line) {
  const text = String(line).replace(/^\uFEFF/, "");
  if (!text.trim()) return { empty: true };
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" ? { value } : { raw: text };
  } catch {
    return { raw: text };
  }
}

// Separate assistant text blocks with a newline so they do not run together. A delta
// continues the block before it, so it is joined as is.
function textEvent(state, text, joined = false) {
  if (typeof text !== "string" || !text) return [];
  const lead = !joined && state.wrote && !state.endsNewline && !text.startsWith("\n") ? "\n" : "";
  state.wrote = true;
  state.endsNewline = text.endsWith("\n");
  return [{ kind: "text", text: lead + text }];
}

function resultText(v) {
  return typeof v.result === "string" ? v.result : "";
}

// One shape for every tool. Cached input counts as input where the tool reports it separately.
function normUsage(u) {
  if (!u || typeof u !== "object") return undefined;
  const n = (k) => (typeof u[k] === "number" ? u[k] : 0);
  const input = n("input_tokens") + n("cache_creation_input_tokens") + n("cache_read_input_tokens") + n("inputTokens") + n("cacheReadTokens") + n("cacheWriteTokens");
  const output = n("output_tokens") + n("outputTokens");
  return input || output ? { input, output } : undefined;
}

function withUsage(event, usage, costUsd) {
  const u = normUsage(usage);
  if (u) event.usage = u;
  if (typeof costUsd === "number") event.costUsd = costUsd;
  return event;
}

// Reports changes only, so a run of thinking deltas is one event.
function activity(state, text) {
  if (state.activity === text) return [];
  state.activity = text;
  return [{ kind: "activity", text }];
}

function streamEvent(state, ev) {
  if (ev.type === "content_block_start" && ev.content_block) {
    if (ev.content_block.type === "text") {
      state.newBlock = true;
      return activity(state, "writing");
    }
    if (ev.content_block.type === "thinking") return activity(state, "thinking");
  } else if (ev.type === "content_block_delta" && ev.delta) {
    if (ev.delta.type === "text_delta") {
      const joined = !state.newBlock;
      state.newBlock = false;
      state.deltas = true;
      return textEvent(state, ev.delta.text, joined);
    }
    if (ev.delta.type === "thinking_delta") return activity(state, "thinking");
  } else if (ev.type === "content_block_stop") state.activity = null;
  return [];
}

function anthropicLike(state, v) {
  const events = [];
  if (v.type === "system" && v.subtype === "init" && v.session_id) events.push({ kind: "session", id: v.session_id });
  else if (v.type === "stream_event" && v.event) events.push(...streamEvent(state, v.event));
  else if (v.type === "assistant") {
    const content = v.message && Array.isArray(v.message.content) ? v.message.content : [];
    for (const block of content) {
      if (!block) continue;
      // Once deltas streamed, the whole-text block only repeats them.
      if (block.type === "text" && !state.deltas) events.push(...textEvent(state, block.text));
      else if (block.type === "tool_use") {
        state.activity = null;
        events.push({ kind: "tool", text: summarizeTool(block.name || "tool", block.input) });
      }
    }
  } else if (v.type === "result") {
    if (v.session_id) events.push({ kind: "session", id: v.session_id });
    const error = v.is_error === true;
    events.push(withUsage({ kind: "result", text: resultText(v) || (error ? String(v.subtype || "error") : ""), error }, v.usage, v.total_cost_usd));
  }
  return events;
}

function cursorEvents(state, v) {
  if (v.type === "tool_call" && v.subtype === "started" && v.tool_call && typeof v.tool_call === "object") {
    const key = Object.keys(v.tool_call).find((k) => k.endsWith("ToolCall"));
    if (!key) return [];
    const call = v.tool_call[key];
    state.activity = null;
    return [{ kind: "tool", text: summarizeTool(key.slice(0, -"ToolCall".length), call && call.args) }];
  }
  if (v.type === "thinking") return v.subtype === "delta" ? activity(state, "thinking") : [];
  if (v.type === "assistant" && v.message && Array.isArray(v.message.content)) {
    // With partial output, events with timestamp_ms are deltas and one later event repeats the whole text.
    if (typeof v.timestamp_ms === "number") {
      const joined = state.cursorRun === true;
      state.cursorRun = true;
      const text = v.message.content.map((b) => (b && b.type === "text" && typeof b.text === "string" ? b.text : "")).join("");
      return [...activity(state, "writing"), ...textEvent(state, text, joined)];
    }
    if (state.cursorRun) {
      state.cursorRun = false;
      state.activity = null;
      return [];
    }
  }
  return anthropicLike(state, v);
}

function codexEvents(state, v) {
  const item = v.item || {};
  switch (v.type) {
    case "thread.started":
      return v.thread_id ? [{ kind: "session", id: v.thread_id }] : [];
    case "item.started":
      if (item.type === "command_execution") return [{ kind: "tool", text: oneLine(`Run ${item.command || ""}`) }];
      if (item.type === "mcp_tool_call") return [{ kind: "tool", text: oneLine(`${item.server || "mcp"}.${item.tool || "tool"}`) }];
      if (item.type === "web_search") return [{ kind: "tool", text: oneLine(`Search ${item.query || ""}`) }];
      return [];
    case "item.completed":
      if (item.type === "agent_message") {
        if (typeof item.text === "string") state.last = item.text;
        return textEvent(state, item.text);
      }
      if (item.type === "file_change") {
        const files = (Array.isArray(item.changes) ? item.changes : []).map((c) => c && c.path).filter(Boolean);
        return [{ kind: "tool", text: oneLine(`Edit ${files.join(", ")}`) }];
      }
      if (item.type === "error") return [{ kind: "note", text: String(item.message || "error") }];
      return [];
    case "turn.completed":
      return [withUsage({ kind: "result", text: state.last || "", error: false }, v.usage)];
    case "turn.failed":
      return [{ kind: "result", text: String((v.error && v.error.message) || "turn failed"), error: true }];
    // Codex also reports a dropped stream it is retrying this way; turn.failed is the end.
    case "error":
      return [{ kind: "note", text: String(v.message || "error") }];
    default:
      return [];
  }
}

function agyEvents(state, v) {
  if (v.event === "init") return v.conversation_id ? [{ kind: "session", id: v.conversation_id }] : [];
  if (v.event === "step_update" && v.step_update) {
    const s = v.step_update;
    const info = s.tool_info || {};
    if (s.state === "ERROR") {
      const message = info.error && info.error.message;
      return message ? [{ kind: "note", text: String(message) }] : [];
    }
    if (s.step_type === "agent_response") {
      const joined = s.step_index !== undefined && s.step_index === state.step;
      state.step = s.step_index;
      return textEvent(state, s.text_delta, joined);
    }
    if (s.step_type === "tool" && s.tool_name) {
      const text = summarizeTool(s.tool_name, info.parameters);
      if (state.tools.has(text)) return [];
      state.tools.add(text);
      return [{ kind: "tool", text }];
    }
    return [];
  }
  if (v.event === "result" && v.result) {
    const r = v.result;
    const events = r.conversation_id ? [{ kind: "session", id: r.conversation_id }] : [];
    const error = r.status !== "SUCCESS";
    events.push(withUsage({ kind: "result", text: typeof r.response === "string" ? r.response : error ? String(r.status || "error") : "", error }, r.usage));
    return events;
  }
  return [];
}

// A fresh parser per turn: text separation and the codex "last message" are per-turn state.
function createParser(toolId) {
  const tool = toolById(toolId);
  if (!tool) throw new Error(`Unknown tool: ${toolId}`);
  const state = { wrote: false, endsNewline: false, last: "", tools: new Set(), deltas: false, newBlock: false, activity: null, cursorRun: false };
  const handler = { anthropic: anthropicLike, cursor: cursorEvents, codex: codexEvents, agy: agyEvents }[tool.parser];
  return (line) => {
    const parsed = parseJson(line);
    if (parsed.empty) return [];
    if (parsed.raw !== undefined) return [{ kind: "raw", text: parsed.raw }];
    return handler(state, parsed.value);
  };
}

module.exports = {
  TOOLS,
  MODEL_ID_RE,
  toolById,
  validModelId,
  findExecutable,
  spawnPlan,
  buildArgv,
  parseCodexCache,
  parseCodexConfigModel,
  parseGrokModels,
  parseAgyModels,
  parseCursorModels,
  loadModels,
  summarizeTool,
  normUsage,
  createParser,
};
