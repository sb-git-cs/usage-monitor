const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { performance } = require("node:perf_hooks");
const { claudeConfigDir, codexHome, grokHome, cursorCliDir, geminiHome, home } = require("./paths");
const { clip, baseName } = require("./session-log");
const { fromFileUri } = require("./session-records");

// The files each coding CLI session wrote, from the CLI's own records: what the record says it
// created or edited, plus output files that appeared in the session's folder while it was working
// (a guess, shown as "generated"). Transcripts run to gigabytes and this runs in the main process
// beside the widgets, so each record file is read once: its parse state is kept (and saved to
// cacheFile) and a later scan reads only the bytes appended since. Lines are searched as bytes;
// only the few that hold a write are decoded. Cursor Agent and Antigravity keep SQLite databases
// instead: those are opened read-only and only the rows added since are read.

const DAY_MS = 86400_000;
const CHUNK = 4 * 1024 * 1024;
// Longest stretch spent on lines before letting the widgets run.
const SLICE_MS = 12;
// A line longer than this is never parsed whole; the scan reports itself truncated instead.
const PARSE_MAX = 16 * 1024 * 1024;
const TAIL_MAX = 1024 * 1024;
const CACHE_VERSION = 1;
// A resumed Codex thread keeps writing in the folder of the day it began.
const CODEX_EXTRA_DAYS = 30;
const WALK_DEPTH = 6;
const WALK_MAX = 20_000;
const WALK_TTL_MS = 30_000;
const WALK_LIMIT = 4;
const WALK_BATCH = 8;
const GENERATED_MAX = 500;
const PAD_MS = 5000;
const STAT_LIMIT = 32;
const LABELS = { claude: "Claude Code", codex: "Codex", grok: "Grok Build", cursor: "Cursor Agent" };
// A protobuf message with more fields than this is not one of the records read here.
const PB_FIELDS = 4096;
// Antigravity's step states (CortexStepStatus). A step in any other state can still change, so it
// is read again next time, up to REDO_MAX of them.
const AGY_DONE = 3;
const AGY_FINAL = new Set([3, 4, 5, 6, 7, 12]); // done, invalid, cleared, canceled, error, interrupted
const AGY_USER_INPUT = 14;
const AGY_TOOL_CALL = 132;
const REDO_MAX = 64;
const SEEN_MAX = 5000;
// Antigravity's file tools: the argument naming the file, and what a call does to it. A "write"
// creates the file unless the session had already read or written it, as Antigravity's own
// Created / Edited labels on write_file do.
const AGY_WRITERS = {
  write_to_file: ["TargetFile", "write"], write_file: ["Path", "write"], edit_file: ["Path", "edit"],
  replace_file_content: ["TargetFile", "edit"], multi_replace_file_content: ["TargetFile", "edit"],
  str_replace_editor: ["path", "editor"],
};
const AGY_READERS = { view_file: "AbsolutePath", read_file: "Path" };
const AGY_VERBS = { Created: "created", Edited: "edited" };
// Cursor Agent's ToolCall cases (agent.v1) that change files, and AppliedAgentChange.ChangeType.
const CURSOR_DELETE = 3;
const CURSOR_EDIT = 12;
const CURSOR_AGENT_DIFF = 22;
const CURSOR_CHANGE = { 1: "created", 2: "edited", 3: "deleted" };
// A chat with no timed step stands for one turn from its start to its last update, unless it was
// left open so long it would claim everything made in its folder.
const CURSOR_SPAN_MAX = 12 * 3600_000;
// Folders the walk for generated files leaves out: dependencies, and the build, cache, upload and
// scratch folders that fill with files a session's test or build run made, not ones it handed over.
const SKIP_DIRS = new Set(["node_modules", "__pycache__", "venv", "env", "site-packages", "vendor", "build", "target", "obj",
  "tmp", "temp", "cache", "storage", "media", "staticfiles", "coverage", "logs", "log"]);
const OUTPUT_EXT = new Set(["pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods", "odp", "rtf", "csv", "md",
  "txt", "html", "png", "jpg", "jpeg", "gif", "svg", "webp", "mp3", "mp4", "wav", "zip", "epub"]);
const UUID = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

// The body of a JSON string, escapes left in.
const STR = '"((?:[^"\\\\]|\\\\.)*)"';
const CLAUDE_CREATE = new RegExp(`^\\{"type":"(create|update)","filePath":${STR}`);
const CLAUDE_EDIT = new RegExp(`^\\{"filePath":${STR},"oldString":`);
const CODEX_HEAD = /^\{"timestamp":"([^"]{1,40})"(?:,"ordinal":\d+)?,"type":"([a-z_]+)"(?:,"payload":\{"type":"([a-z_]+)")?/;
const GROK_CALL = /"sessionUpdate":"tool_call","toolCallId":"([^"]{1,200})"/;
const GROK_UPDATE = /"sessionUpdate":"tool_call_update","toolCallId":"([^"]{1,200})"[^{}]*?"status":"([a-z_]+)"/;
const GROK_PATH = new RegExp(`"rawInput":\\{"file_path":${STR}`);
const GROK_EVENT = /^\{"ts":"([^"]{1,40})","type":"([a-z_]+)"/;

const bytes = (s) => Buffer.from(s, "latin1");
const TS = bytes('"timestamp":"');
const TOOL_RESULT = bytes('"toolUseResult":');
const CWD = bytes('"cwd":"');
const IS_META = bytes('"isMeta":true');
const TEXT_PART = bytes('{"type":"text"');
const BASH_FILES = bytes('"bashEditDiff":{"files":[{');
const PATH_KEYS = [bytes('"filePath":"'), bytes('"file_path":"'), bytes('"notebook_path":"')];
const XAI_TOOL = bytes('"x.ai/tool":{');
const AGENT_MS = bytes('"agentTimestampMs":');
const OLD_EMPTY = bytes('"old_string":""');
const BEGIN_PATCH = bytes("*** Begin Patch");
const APPEND_TRUE = bytes('"Append":true');
const KEY_NEEDLES = new Map();

const yieldTurn = () => new Promise((resolve) => setImmediate(resolve));

function unquote(raw) {
  try {
    return JSON.parse(`"${raw}"`);
  } catch {
    return null;
  }
}

// Milliseconds from a number or an ISO / numeric string.
function ms(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || !value) return null;
  const n = /^\d+$/.test(value) ? Number(value) : Date.parse(value);
  return Number.isFinite(n) ? n : null;
}

function parseLine(st, line) {
  if (line.length > PARSE_MAX) {
    st.cut = true;
    return null;
  }
  try {
    const j = JSON.parse(line.toString("utf8"));
    return j && typeof j === "object" ? j : null;
  } catch {
    return null;
  }
}

// The JSON string that starts at the closing quote of a needle found at i.
function stringAt(line, i, needle) {
  if (i === -1) return null;
  const from = i + needle.length - 1;
  const m = /^"((?:[^"\\]|\\.)*)"/.exec(line.toString("utf8", from, Math.min(line.length, from + 8192)));
  return m ? unquote(m[1]) : null;
}

function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  return Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker)).then(() => out);
}

async function statOf(file) {
  try {
    return await fs.promises.stat(file);
  } catch {
    return null;
  }
}

async function entries(dir) {
  try {
    return await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

// Working time: each turn runs from its start to the last line before the next one.
function stamp(st, at) {
  if (!Number.isFinite(at)) return;
  if (st.first == null) st.first = at;
  st.last = st.last == null ? at : Math.max(st.last, at);
  if (st.cur) st.cur[1] = Math.max(st.cur[1], at);
}

function closeTurn(st, at) {
  if (!st.cur) return;
  if (Number.isFinite(at)) st.cur[1] = Math.max(st.cur[1], at);
  st.iv.push(st.cur);
  st.cur = null;
}

function openTurn(st, at) {
  closeTurn(st);
  if (Number.isFinite(at)) st.cur = [at, at];
}

function turns(st) {
  return st.cur ? [...st.iv, st.cur] : st.iv;
}

// A path as the OS spells it, or null for one that cannot be placed.
function nativePath(raw, platform, cwd) {
  if (typeof raw !== "string" || !raw || raw.length > 4096) return null;
  const P = platform === "win32" ? path.win32 : path.posix;
  let p = raw.replace(/^\\\\\?\\/, "");
  if (platform === "win32") p = p.replace(/\//g, "\\");
  if (!P.isAbsolute(p)) {
    if (!cwd || !P.isAbsolute(cwd)) return null;
    p = P.join(cwd, p);
  }
  return P.normalize(p);
}

const keyFor = (file, platform) => (platform === "win32" ? file.toLowerCase() : file);

// Once the session created a file it stays created, unless it deleted it again.
function put(w, key, file, kind, at) {
  const prev = w[key];
  const keep = prev && prev[1] === "created" && kind !== "deleted";
  w[key] = [file, keep ? "created" : kind, Math.max(Number.isFinite(at) ? at : 0, prev ? prev[2] : 0)];
}

function addWrite(w, raw, kind, at, ctx, cwd) {
  const file = nativePath(raw, ctx.platform, cwd);
  if (file) put(w, keyFor(file, ctx.platform), file, kind, at);
}

const FRESH = {
  claude: () => ({ n: 0, w: {}, iv: [], cur: null, first: null, last: null, cwd: "", ai: "", ag: "", pr: "" }),
  codex: () => ({ n: 0, w: {}, pw: {}, ev: false, iv: [], cur: null, first: null, last: null, meta: false, cwd: "", started: null }),
  "grok-updates": () => ({ n: 0, w: {}, pend: {}, first: null, last: null }),
  "grok-events": () => ({ n: 0, iv: [], cur: null, first: null, last: null }),
  // offset: the next step idx to read; redo: steps read before they finished; ui: the last user input's idx.
  agy: () => ({ n: 0, w: {}, seen: {}, ns: 0, redo: [], ui: -1, uri: "", iv: [], cur: null, first: null, last: null }),
  // offset: the last blob rowid read, top: that blob's id.
  cursor: () => ({ n: 0, w: {}, top: "", iv: [], cur: null, first: null, last: null }),
};

// Claude Code transcripts. User lines put "type" before the message; assistant and attachment lines
// do not, and metadata lines start with it.
function claudeLine(st, line, ctx) {
  if (line[0] !== 0x7b) return;
  st.n++;
  const head = line.toString("latin1", 0, Math.min(line.length, 512));
  if (head.startsWith('{"type":"')) {
    const field = head.startsWith('{"type":"ai-title"') ? "aiTitle" : head.startsWith('{"type":"agent-name"') ? "agentName" : null;
    if (field) {
      const j = parseLine(st, line);
      const title = j && typeof j[field] === "string" ? clip(j[field]) : "";
      if (title) st[field === "aiTitle" ? "ai" : "ag"] = title;
    }
    const t = /"timestamp":"([^"]{1,40})"/.exec(head);
    if (t) stamp(st, Date.parse(t[1]));
    return;
  }
  const ti = line.indexOf(TS);
  const at = ti === -1 ? NaN : Date.parse(line.toString("latin1", ti + TS.length, Math.min(line.length, ti + TS.length + 40)).split('"')[0]);
  if (!st.cwd) {
    const cwd = stringAt(line, line.lastIndexOf(CWD), CWD);
    if (cwd) st.cwd = cwd.replace(/^\\\\\?\\/, "");
  }
  const typeAt = head.indexOf('"type":"');
  const messageAt = head.indexOf('"message":');
  if (typeAt !== -1 && head.startsWith('"type":"user"', typeAt) && (messageAt === -1 || typeAt < messageAt)) {
    const result = line.indexOf(TOOL_RESULT);
    if (result !== -1) claudeWrite(st, line, result + TOOL_RESULT.length, at, ctx);
    else if (!ctx.sub && claudePrompt(head, messageAt, line)) {
      openTurn(st, at);
      if (!st.pr) st.pr = promptTitle(st, line);
    }
  }
  stamp(st, at);
}

// A prompt the user typed: text, not a tool's result, not injected context, not a sub-agent's.
function claudePrompt(head, messageAt, line) {
  if (messageAt === -1 || head.includes('"isSidechain":true') || line.indexOf(IS_META) !== -1) return false;
  const c = head.indexOf('"content":', messageAt);
  if (c === -1) return false;
  const first = head[c + 10];
  if (first === '"') return true;
  if (first !== "[" || head.startsWith('[{"type":"tool_result"', c + 10) || head.startsWith('[{"tool_use_id"', c + 10)) return false;
  return line.indexOf(TEXT_PART, c) !== -1;
}

function promptTitle(st, line) {
  const j = line.length <= TAIL_MAX ? parseLine(st, line) : null;
  const c = j && j.message ? j.message.content : null;
  const part = Array.isArray(c) ? c.find((p) => p && p.type === "text" && typeof p.text === "string") : null;
  const text = clip(typeof c === "string" ? c : part ? part.text : "");
  // Wrapped slash commands, their output and interruptions say nothing about the session.
  return text && !text.startsWith("<") && !text.startsWith("[Request interrupted") ? text : "";
}

function claudeWrite(st, line, i, at, ctx) {
  const s = line.toString("utf8", i, Math.min(line.length, i + 8192));
  let m = CLAUDE_CREATE.exec(s);
  if (m) return addWrite(st.w, unquote(m[2]), m[1] === "create" ? "created" : "edited", at, ctx);
  m = CLAUDE_EDIT.exec(s);
  if (m) return addWrite(st.w, unquote(m[1]), "edited", at, ctx);
  // A message, or a read whose file sits one level down.
  if (!s.startsWith("{") || s.startsWith('{"type":"')) return;
  if (s.startsWith('{"stdout":')) {
    // Files a shell command changed, as the tool recorded them.
    if (line.indexOf(BASH_FILES, i) === -1) return;
    const diff = parseLine(st, line)?.toolUseResult?.bashEditDiff;
    for (const f of Array.isArray(diff?.files) ? diff.files : []) {
      if (f && typeof f.filePath === "string") addWrite(st.w, f.filePath, f.deleted === true ? "deleted" : f.created === true ? "created" : "edited", at, ctx);
    }
    return;
  }
  if (!PATH_KEYS.some((k) => line.indexOf(k, i) !== -1)) return;
  const r = parseLine(st, line)?.toolUseResult;
  if (!r || typeof r !== "object") return;
  const file = [r.filePath, r.file_path, r.notebook_path].find((v) => typeof v === "string");
  if (!file) return;
  // A plan or other result that only names a file is not a write.
  if (r.type === "create") addWrite(st.w, file, "created", at, ctx);
  else if (r.type === "update" || ["oldString", "newString", "structuredPatch", "new_source", "edits"].some((k) => k in r)) addWrite(st.w, file, "edited", at, ctx);
}

// Codex rollouts.
function codexLine(st, line, ctx) {
  if (line[0] !== 0x7b) return;
  st.n++;
  const head = line.toString("latin1", 0, Math.min(line.length, 1024));
  const h = CODEX_HEAD.exec(head);
  if (!h) return;
  const at = Date.parse(h[1]);
  const [type, sub] = [h[2], h[3]];
  if (type === "session_meta") {
    if (!st.meta) codexMeta(st, line);
  } else if (type === "event_msg") {
    if (sub === "task_started") openTurn(st, at);
    else if (sub === "task_complete" || sub === "turn_aborted") closeTurn(st, at);
    else if (sub === "item_completed" && head.includes('"item":{"type":"FileChange"')) codexChanges(st, line, at, ctx, true);
    else if (sub === "patch_apply_end") codexChanges(st, line, at, ctx, false);
  } else if (type === "response_item" && (sub === "custom_tool_call" || sub === "function_call") && line.indexOf(BEGIN_PATCH) !== -1) {
    codexPatchCall(st, line, at, ctx);
  }
  stamp(st, at);
}

function codexMeta(st, line) {
  const p = parseLine(st, line)?.payload;
  if (!p || typeof p !== "object") return;
  st.meta = true;
  if (typeof p.cwd === "string") st.cwd = p.cwd.replace(/^\\\\\?\\/, "");
  st.started = ms(p.timestamp);
}

function codexChanges(st, line, at, ctx, item) {
  st.ev = true;
  const p = parseLine(st, line)?.payload;
  if (!p) return;
  let changes;
  if (item) {
    // A change that failed or was declined never reached the disk.
    if (!p.item || (p.item.status != null && p.item.status !== "completed")) return;
    changes = p.item.changes;
  } else {
    if (p.success === false) return;
    changes = p.changes;
  }
  const when = Number.isFinite(p.completed_at_ms) ? p.completed_at_ms : at;
  for (const [file, c] of Object.entries(changes && typeof changes === "object" ? changes : {})) {
    if (!c || typeof c !== "object") continue;
    const kind = typeof c.type === "string" ? c.type : ["add", "update", "delete"].find((k) => k in c);
    const move = c.move_path ?? c.update?.move_path;
    if (kind === "add") addWrite(st.w, file, "created", when, ctx, st.cwd);
    else if (kind === "delete") addWrite(st.w, file, "deleted", when, ctx, st.cwd);
    else if (kind === "update" && typeof move === "string" && move) {
      addWrite(st.w, file, "deleted", when, ctx, st.cwd);
      addWrite(st.w, move, "edited", when, ctx, st.cwd);
    } else if (kind === "update") addWrite(st.w, file, "edited", when, ctx, st.cwd);
  }
}

// Only for a rollout with no change events: the files named in its apply_patch calls.
function codexPatchCall(st, line, at, ctx) {
  const p = parseLine(st, line)?.payload;
  if (!p) return;
  let text = typeof p.input === "string" ? p.input : "";
  if (!text && typeof p.arguments === "string") {
    try {
      const a = JSON.parse(p.arguments);
      text = [a.input, a.patch, ...(Array.isArray(a.command) ? a.command : [a.command])].filter((x) => typeof x === "string").join("\n");
    } catch {
      text = p.arguments;
    }
  }
  let updated = null;
  for (const row of text.split("\n")) {
    const m = /^\*\*\* (Add|Update|Delete) File: (.+?)\s*$/.exec(row);
    if (m) {
      updated = m[1] === "Update" ? m[2] : null;
      addWrite(st.pw, m[2], m[1] === "Add" ? "created" : m[1] === "Delete" ? "deleted" : "edited", at, ctx, st.cwd);
      continue;
    }
    const mv = /^\*\*\* Move to: (.+?)\s*$/.exec(row);
    if (mv && updated) {
      addWrite(st.pw, updated, "deleted", at, ctx, st.cwd);
      addWrite(st.pw, mv[1], "edited", at, ctx, st.cwd);
      updated = null;
    }
  }
}

// Grok Build's updates log. A write is logged when it is asked for, and counts once its update
// says it completed.
function grokUpdate(st, line, ctx) {
  if (line[0] !== 0x7b) return;
  st.n++;
  const head = line.toString("utf8", 0, Math.min(line.length, 4096));
  const t = /^\{"timestamp":(\d{9,13})[,}]/.exec(head);
  let at = t ? Number(t[1]) * (t[1].length <= 10 ? 1000 : 1) : NaN;
  const call = GROK_CALL.exec(head);
  if (call) {
    const x = line.lastIndexOf(XAI_TOOL);
    const kind = x === -1 ? null : /"kind":"([a-z_]+)"/.exec(line.toString("latin1", x, Math.min(line.length, x + 400)));
    if (kind && (kind[1] === "write" || kind[1] === "edit")) {
      const a = line.lastIndexOf(AGENT_MS);
      const v = a === -1 ? null : /^\d+/.exec(line.toString("latin1", a + AGENT_MS.length, Math.min(line.length, a + AGENT_MS.length + 20)));
      if (v) at = Number(v[0]);
      const m = GROK_PATH.exec(head);
      const raw = m ? unquote(m[1]) : parseLine(st, line)?.params?.update?.rawInput?.file_path;
      const file = nativePath(raw, ctx.platform);
      // An edit that replaces nothing writes a new file.
      const created = kind[1] === "write" || line.indexOf(OLD_EMPTY) !== -1;
      if (file) st.pend[call[1]] = [file, created ? "created" : "edited", at];
    }
  } else {
    const u = GROK_UPDATE.exec(head);
    const pending = u && Object.hasOwn(st.pend, u[1]) ? st.pend[u[1]] : null;
    if (pending && (u[2] === "completed" || u[2] === "failed")) {
      if (u[2] === "completed") put(st.w, keyFor(pending[0], ctx.platform), ...pending);
      delete st.pend[u[1]];
    }
  }
  stamp(st, at);
}

function grokEvent(st, line) {
  if (line[0] !== 0x7b) return;
  st.n++;
  const m = GROK_EVENT.exec(line.toString("latin1", 0, Math.min(line.length, 160)));
  if (!m) return;
  const at = Date.parse(m[1]);
  if (m[2] === "turn_started") openTurn(st, at);
  else if (m[2] === "turn_ended") closeTurn(st, at);
  stamp(st, at);
}

const LINE = { claude: claudeLine, codex: codexLine, "grok-updates": grokUpdate, "grok-events": grokEvent };

// Protobuf, read defensively: every length is checked against the bytes left, a message stops at
// PB_FIELDS fields, and a field is decoded only when asked for. Fields are [number, wire type,
// value], the value a number for a varint and a view of the bytes for a length-delimited field.
function varint(buf, pos) {
  let v = 0;
  for (let i = 0, mul = 1; i < 10 && pos < buf.length; i++, mul *= 128) {
    const b = buf[pos++];
    v += (b & 0x7f) * mul;
    if (b < 0x80) return [v, pos];
  }
  return null;
}

function pbFields(buf) {
  if (!buf) return null;
  const out = [];
  let pos = 0;
  while (pos < buf.length) {
    const tag = out.length < PB_FIELDS ? varint(buf, pos) : null;
    if (!tag || tag[0] < 8) return null;
    const wt = tag[0] % 8;
    pos = tag[1];
    if (wt === 0) {
      const v = varint(buf, pos);
      if (!v) return null;
      out.push([Math.floor(tag[0] / 8), 0, v[0]]);
      pos = v[1];
    } else if (wt === 2) {
      const n = varint(buf, pos);
      if (!n || n[0] > buf.length - n[1]) return null;
      out.push([Math.floor(tag[0] / 8), 2, buf.subarray(n[1], n[1] + n[0])]);
      pos = n[1] + n[0];
    } else if (wt === 1 || wt === 5) {
      pos += wt === 1 ? 8 : 4;
      if (pos > buf.length) return null;
    } else return null;
  }
  return out;
}

function pbGet(fields, no, wt) {
  for (const f of fields || []) if (f[0] === no && f[1] === wt) return f[2];
  return undefined;
}

const pbBytes = (fields, no) => pbGet(fields, no, 2);
const pbNum = (fields, no) => pbGet(fields, no, 0);

function pbStr(fields, no) {
  const b = pbBytes(fields, no);
  return b && b.length <= 8192 ? b.toString("utf8") : "";
}

// A google.protobuf.Timestamp, in milliseconds.
function pbTime(buf) {
  const f = pbFields(buf);
  const s = pbNum(f, 1);
  return s > 0 ? s * 1000 + Math.floor((pbNum(f, 2) || 0) / 1e6) : null;
}

// A field holding milliseconds since 1970, or null for anything else.
function pbMs(fields, no) {
  const v = pbNum(fields, no);
  return v > 1e12 && v < 1e14 ? v : null;
}

const asBuffer = (v) => (v instanceof Uint8Array ? Buffer.from(v.buffer, v.byteOffset, v.byteLength) : null);

// A top-level string value of a JSON object, found without decoding the rest. A key's quotes are
// bare only outside strings, so a match is never inside a value, and the arguments' keys are
// sorted, so the path comes after any nested object: the last match is the top-level key.
function jsonString(buf, key) {
  let needle = KEY_NEEDLES.get(key);
  if (!needle) KEY_NEEDLES.set(key, (needle = bytes(`"${key}":"`)));
  return stringAt(buf, buf.lastIndexOf(needle), needle);
}

function argPath(st, args, keys) {
  for (const k of keys) {
    const v = jsonString(args, k);
    if (v) return v;
  }
  if (args.length > PARSE_MAX) {
    st.cut = true;
    return null;
  }
  try {
    const j = JSON.parse(args.toString("utf8"));
    return keys.map((k) => j?.[k]).find((v) => typeof v === "string") ?? null;
  } catch {
    return null;
  }
}

// One Antigravity step: { idx, step_type, status, metadata, render_info }. Its metadata holds when
// it was made (field 1), each state it went through with the time (26), and for a tool call the
// call's name and JSON arguments (4). again: the step was read before, while it was unfinished.
function agyStep(st, row, ctx, again) {
  const meta = pbFields(asBuffer(row.metadata));
  if (!meta) return;
  st.n++;
  const made = pbTime(pbBytes(meta, 1));
  let at = made;
  let state = null;
  for (const [no, wt, v] of meta) {
    if (no !== 26 || wt !== 2) continue;
    for (const [n, w, t] of pbFields(v) || []) {
      if (n !== 1 || w !== 2) continue;
      const f = pbFields(t);
      if (pbNum(f, 1) != null) state = pbNum(f, 1);
      const when = pbTime(pbBytes(f, 2));
      if (when) at = Math.max(at || 0, when);
    }
  }
  if (!AGY_FINAL.has(row.status) && !st.redo.includes(row.idx)) {
    st.redo.push(row.idx);
    if (st.redo.length > REDO_MAX) st.redo.shift();
  }
  if (row.step_type === AGY_USER_INPUT && !again) {
    openTurn(st, made ?? at);
    stamp(st, made ?? at);
    st.ui = row.idx;
  }
  // A step that finished after a later prompt does not stretch that turn back.
  if (!again || row.idx > st.ui) stamp(st, at);
  else if (Number.isFinite(at)) st.last = Math.max(st.last ?? at, at);
  // A step the context was compacted past is marked cleared; how it ended is the last state it recorded.
  if (row.step_type !== AGY_TOOL_CALL || (state ?? row.status) !== AGY_DONE) return;
  const call = pbFields(pbBytes(meta, 4));
  const name = pbStr(call, 2);
  const args = pbBytes(call, 3);
  const writer = Object.hasOwn(AGY_WRITERS, name) ? AGY_WRITERS[name] : null;
  const reader = Object.hasOwn(AGY_READERS, name) ? AGY_READERS[name] : null;
  if (!args || (!writer && !reader)) return;
  const file = nativePath(argPath(st, args, writer ? [writer[0], "TargetFile", "Path"] : [reader]), ctx.platform);
  if (!file) return;
  const key = keyFor(file, ctx.platform);
  if (reader) {
    if (st.seen[key] !== 1 && st.ns < SEEN_MAX) {
      st.seen[key] = 1;
      st.ns++;
    }
    return;
  }
  // Antigravity's own label, when the step has one, says which it was.
  const verb = pbStr(pbFields(asBuffer(row.render_info)), 5);
  const kind = Object.hasOwn(AGY_VERBS, verb) ? AGY_VERBS[verb] : agyKind(writer[1], args, st.w[key] || st.seen[key] === 1);
  if (kind) put(st.w, key, file, kind, at);
}

function agyKind(how, args, known) {
  const fresh = known ? "edited" : "created";
  if (how === "edit") return "edited";
  if (how === "editor") {
    const cmd = jsonString(args, "command");
    return cmd === "create" ? fresh : cmd === "str_replace" || cmd === "insert" ? "edited" : null;
  }
  return args.indexOf(APPEND_TRUE) !== -1 ? "edited" : fresh;
}

// One Cursor Agent blob. Its JSON blobs are the chat's messages as sent upstream; the protobuf ones
// are the CLI's own (agent.v1): a user message is dated (field 25), and a step that ran a tool
// (ConversationStep field 2) carries the call's start and end (ToolCall 59, 60) and, once it
// finished, a result saying whether it worked.
function cursorBlob(st, data, ctx, cwd) {
  if (!data || !data.length || data[0] === 0x7b) return;
  if (data.length > PARSE_MAX) {
    st.cut = true;
    return;
  }
  const top = pbFields(data);
  if (!top || !top.length) return;
  st.n++;
  const [no, wt, v] = top[0];
  if (top.length === 1 && wt === 2 && no === 2) return cursorToolCall(st, pbFields(v), ctx, cwd);
  if (top.length === 1 && wt === 2 && (no === 1 || no === 3)) {
    // A reply (AssistantMessage: started 2, completed 3) or a thought (ThinkingMessage: started 3, completed 4).
    const m = pbFields(v);
    const at = no === 1 ? pbMs(m, 3) ?? pbMs(m, 2) : pbMs(m, 4) ?? pbMs(m, 3);
    if (at) stamp(st, at);
    return;
  }
  const sent = pbMs(top, 25);
  const id = pbBytes(top, 2);
  if (sent && id && id.length === 36 && pbBytes(top, 1)) {
    openTurn(st, sent);
    stamp(st, sent);
  }
}

function cursorToolCall(st, call, ctx, cwd) {
  if (!call) return;
  const at = pbMs(call, 60) ?? pbMs(call, 59);
  if (at) stamp(st, at);
  const when = at ?? 0;
  // Each result is a oneof whose first case is success; a call with no result has not finished.
  const result = (c) => pbFields(pbBytes(c, 2));
  const edit = pbFields(pbBytes(call, CURSOR_EDIT));
  if (edit) {
    const ok = pbFields(pbBytes(result(edit), 1));
    if (!ok) return;
    // Nothing before the edit means the edit made the file.
    const made = pbBytes(ok, 6) === undefined && !(pbNum(ok, 4) > 0);
    return addWrite(st.w, pbStr(ok, 1) || pbStr(pbFields(pbBytes(edit, 1)), 1), made ? "created" : "edited", when, ctx, cwd);
  }
  const del = pbFields(pbBytes(call, CURSOR_DELETE));
  if (del) {
    const ok = pbFields(pbBytes(result(del), 1));
    if (ok) addWrite(st.w, pbStr(ok, 1) || pbStr(pbFields(pbBytes(del, 1)), 1), "deleted", when, ctx, cwd);
    return;
  }
  // A sub-agent's changes applied to the workspace; a failed apply still lists the ones it made.
  const diff = result(pbFields(pbBytes(call, CURSOR_AGENT_DIFF)));
  const ok = pbFields(pbBytes(diff, 1));
  const field = ok ? 1 : 2;
  for (const [n, w, c] of ok || pbFields(pbBytes(diff, 2)) || []) {
    const change = n === field && w === 2 ? pbFields(c) : null;
    // A change with an error was not made.
    const kind = change && !pbBytes(change, 5) ? CURSOR_CHANGE[pbNum(change, 2)] : null;
    if (kind) addWrite(st.w, pbStr(change, 1), kind, when, ctx, cwd);
  }
}

// Bytes were read but not one line was a JSON object: not a record this module can use.
const garbage = (e) => e.offset > 0 && e.st.n === 0;

function wholeJson(buf) {
  try {
    JSON.parse(buf.toString("utf8"));
    return true;
  } catch {
    return false;
  }
}

// Overlapping turns (a sub-agent's run inside its parent's) become one stretch.
function merged(intervals) {
  const out = [];
  for (const [s, e] of intervals.filter((iv) => Array.isArray(iv) && Number.isFinite(iv[0]) && Number.isFinite(iv[1])).sort((a, b) => a[0] - b[0])) {
    const last = out[out.length - 1];
    if (last && s <= last[1] + PAD_MS) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

function lowerBound(list, value, field) {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid][field] < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function extOf(name) {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i + 1).toLowerCase() : "";
}

// Read-only, and nothing made beside the database: one in WAL mode whose -wal holds no frames is
// opened immutable, which creates no -wal or -shm; one whose -wal holds frames is opened plainly,
// so the rows still in the -wal are seen.
function openDb(file, wal) {
  const { DatabaseSync } = require("node:sqlite");
  return new DatabaseSync(wal ? file : `${pathToFileURL(file).href}?immutable=1`, { readOnly: true });
}

const walSig = (stat) => (stat && stat.size > 0 ? `${stat.size}:${stat.mtimeMs}` : "");
const activeAt = (stat, wal) => Math.max(stat.mtimeMs, wal && wal.size > 0 ? wal.mtimeMs : 0);

function createSessionFiles({
  claudeDir = claudeConfigDir, codexDir = codexHome, grokDir = grokHome, cursorDir = cursorCliDir,
  geminiDir = geminiHome, cacheFile = null, now = Date.now, platform = process.platform, onRead = null,
} = {}) {
  const ctx = { platform, sub: false };
  const subCtx = { platform, sub: true };
  const files = new Map(); // record file -> { kind, size, mtimeMs, offset, st } (+ wal for a database)
  const walks = new Map(); // folder key -> { at, promise }
  const inflight = new Map();
  let chain = Promise.resolve();
  let loaded = false;
  let dirty = false;
  let index = { sig: "", names: new Map() };
  let agyIndex = { sig: "", meta: new Map(), history: new Map() };

  function load() {
    if (loaded) return;
    loaded = true;
    if (!cacheFile) return;
    try {
      const data = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
      if (!data || data.version !== CACHE_VERSION || !data.files || typeof data.files !== "object") return;
      for (const [file, e] of Object.entries(data.files)) {
        const known = e && (Object.hasOwn(FRESH, e.kind) || e.kind === "grok-summary");
        if (known && [e.size, e.mtimeMs, e.offset].every(Number.isFinite) && e.st && typeof e.st === "object") files.set(file, e);
      }
    } catch {
      /* no cache yet, or unreadable: read the records again */
    }
  }

  function save() {
    if (!dirty || !cacheFile) return;
    const tmp = `${cacheFile}.tmp`;
    try {
      fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify({ version: CACHE_VERSION, files: Object.fromEntries(files) }), { encoding: "utf8", mode: 0o600 });
      if (process.platform !== "win32") fs.chmodSync(tmp, 0o600);
      fs.renameSync(tmp, cacheFile);
      dirty = false;
    } catch (err) {
      try { fs.unlinkSync(tmp); } catch { /* never written */ }
      console.error("session files cache write failed", err.message);
    }
  }

  async function readAppended(file, e, size, lineCtx) {
    const handle = LINE[e.kind];
    const take = (line) => {
      const end = line.length && line[line.length - 1] === 13 ? line.length - 1 : line.length;
      if (!end) return;
      try {
        handle(e.st, end === line.length ? line : line.subarray(0, end), lineCtx);
      } catch {
        /* a line of another shape */
      }
    };
    const fh = await fs.promises.open(file, "r");
    let pos = e.offset;
    let done = e.offset;
    const parts = [];
    let t0 = performance.now();
    try {
      while (pos < size) {
        const buf = Buffer.allocUnsafe(Math.min(CHUNK, size - pos));
        const { bytesRead } = await fh.read(buf, 0, buf.length, pos);
        if (!bytesRead) break;
        if (onRead) onRead(file, pos, bytesRead);
        const chunk = buf.subarray(0, bytesRead);
        let start = 0;
        for (let nl = chunk.indexOf(10); nl !== -1; nl = chunk.indexOf(10, start)) {
          let line = chunk.subarray(start, nl);
          if (parts.length) {
            parts.push(line);
            line = Buffer.concat(parts);
            parts.length = 0;
          }
          take(line);
          start = nl + 1;
          done = pos + start;
          if (performance.now() - t0 > SLICE_MS) {
            await yieldTurn();
            t0 = performance.now();
          }
        }
        if (start < chunk.length) parts.push(chunk.subarray(start));
        pos += bytesRead;
        await yieldTurn();
        t0 = performance.now();
      }
    } finally {
      await fh.close();
    }
    // A last line with no newline yet counts once it is a whole JSON object; a partial one waits.
    if (parts.length) {
      const tail = Buffer.concat(parts);
      if (tail.length <= TAIL_MAX && wholeJson(tail)) {
        take(tail);
        done = pos;
      }
    }
    return done;
  }

  // A record file's parse state, reading only what was appended since the last scan.
  async function record(file, kind, stat, lineCtx, run) {
    run.seen.add(file);
    let e = files.get(file);
    if (e && e.kind === kind && e.size === stat.size && e.mtimeMs === stat.mtimeMs) return e;
    if (!stat.isFile()) throw new Error("not a file");
    if (!e || e.kind !== kind || stat.size < e.size) e = { kind, size: 0, mtimeMs: 0, offset: 0, st: FRESH[kind]() };
    // A read that fails part way starts over next time.
    files.delete(file);
    dirty = true;
    if (stat.size > e.offset) e.offset = await readAppended(file, e, stat.size, lineCtx);
    e.size = stat.size;
    e.mtimeMs = stat.mtimeMs;
    files.set(file, e);
    if (e.st.cut) run.coverage.truncated = true;
    return e;
  }

  // Rows of a query, a slice at a time. A row of another shape is passed over.
  async function eachRow(file, stmt, params, key, fn) {
    let t0 = performance.now();
    for (const row of stmt.iterate(...params)) {
      if (onRead) onRead(file, row[key], 1);
      try {
        fn(row);
      } catch {
        /* a row of another shape */
      }
      if (performance.now() - t0 > SLICE_MS) {
        await yieldTurn();
        t0 = performance.now();
      }
    }
  }

  // A database's parse state, reading only the rows added since the last scan. It is read again
  // only when the database or its -wal changed.
  async function dbRecord(file, kind, stat, walStat, run, read) {
    run.seen.add(file);
    const wal = walSig(walStat);
    let e = files.get(file);
    if (e && e.kind === kind && e.size === stat.size && e.mtimeMs === stat.mtimeMs && e.wal === wal) return e;
    if (!stat.isFile()) throw new Error("not a file");
    if (!e || e.kind !== kind || stat.size < e.size) e = { kind, size: 0, mtimeMs: 0, offset: 0, wal: "", st: FRESH[kind]() };
    // A read that fails part way starts over next time.
    files.delete(file);
    dirty = true;
    const db = openDb(file, wal);
    try {
      await read(db, e);
    } finally {
      try {
        db.close();
      } catch {
        /* the rows are already in hand */
      }
    }
    // Opened immutable, a database that changed under the read may have been read torn.
    if (!wal) {
      const after = await statOf(file);
      if (!after || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) throw new Error("changed while read");
    }
    Object.assign(e, { size: stat.size, mtimeMs: stat.mtimeMs, wal });
    files.set(file, e);
    if (e.st.cut) run.coverage.truncated = true;
    return e;
  }

  // Steps not yet read, and the ones read before they finished. Each query walks idx in order, so
  // no row waits on a sort.
  async function agyRead(db, e, file) {
    const st = e.st;
    try {
      const blob = db.prepare("SELECT data FROM trajectory_metadata_blob WHERE id = 'main'").get();
      st.uri = pbStr(pbFields(pbBytes(pbFields(asBuffer(blob?.data)), 1)), 1) || st.uri;
    } catch {
      /* an older database: the folder comes from elsewhere */
    }
    const cols = "SELECT idx, step_type, status, metadata, render_info FROM steps";
    const again = st.redo;
    st.redo = [];
    if (again.length) {
      const stmt = db.prepare(`${cols} WHERE idx IN (${again.map(() => "?").join(",")}) ORDER BY idx`);
      await eachRow(file, stmt, again, "idx", (row) => agyStep(st, row, ctx, true));
    }
    let next = e.offset;
    await eachRow(file, db.prepare(`${cols} WHERE idx >= ? ORDER BY idx`), [e.offset], "idx", (row) => {
      next = Math.max(next, row.idx + 1);
      agyStep(st, row, ctx, false);
    });
    e.offset = next;
  }

  // Blobs are only added, or replaced by the same bytes, but one can be deleted and its rowid
  // taken by the next: when the last row read is not the blob remembered, the chat is read again.
  async function cursorRead(db, e, file, cwd) {
    if (e.offset > 0 && db.prepare("SELECT id FROM blobs WHERE rowid = ?").get(e.offset)?.id !== e.st.top) {
      e.offset = 0;
      e.st = FRESH.cursor();
    }
    const st = e.st;
    await eachRow(file, db.prepare("SELECT rowid AS r, id, data FROM blobs WHERE rowid > ? ORDER BY rowid"), [e.offset], "r", (row) => {
      e.offset = row.r;
      st.top = String(row.id);
      cursorBlob(st, asBuffer(row.data), ctx, cwd);
    });
  }

  async function claude(run) {
    const root = path.join(claudeDir(), "projects");
    const mains = [];
    for (const slug of await entries(root)) {
      if (!slug.isDirectory()) continue;
      const dir = path.join(root, slug.name);
      for (const ent of await entries(dir)) {
        if (!ent.isFile() || !ent.name.endsWith(".jsonl")) continue;
        const id = ent.name.slice(0, -6);
        if (!run.only || run.only.has(`claude:${id}`)) mains.push({ id, dir, file: path.join(dir, ent.name) });
      }
    }
    const stats = await mapLimit(mains, STAT_LIMIT, (m) => statOf(m.file));
    const groups = new Map();
    mains.forEach((m, i) => {
      if (!stats[i]) return;
      run.seen.add(m.file);
      if (stats[i].mtimeMs < run.since) return;
      const g = groups.get(m.id) || [];
      g.push({ file: m.file, stat: stats[i], sub: false, dir: m.dir });
      groups.set(m.id, g);
    });
    const out = [];
    for (const [id, group] of groups) {
      // Sub-agents keep their own transcripts beside the session's; their writes are the session's.
      for (const dir of [...new Set(group.map((g) => g.dir))]) {
        const subDir = path.join(dir, id, "subagents");
        const found = [];
        for (const ent of await entries(subDir)) {
          if (ent.isFile() && ent.name.endsWith(".jsonl")) found.push(path.join(subDir, ent.name));
          else if (ent.isDirectory() && ent.name === "workflows") {
            for (const wf of await entries(path.join(subDir, ent.name))) {
              if (!wf.isDirectory()) continue;
              const wfDir = path.join(subDir, ent.name, wf.name);
              for (const a of await entries(wfDir)) if (a.isFile() && a.name.endsWith(".jsonl")) found.push(path.join(wfDir, a.name));
            }
          }
        }
        const subStats = await mapLimit(found, STAT_LIMIT, statOf);
        found.forEach((file, i) => { if (subStats[i]) group.push({ file, stat: subStats[i], sub: true }); });
      }
      const parsed = [];
      for (const g of group) {
        try {
          const e = await record(g.file, "claude", g.stat, g.sub ? subCtx : ctx, run);
          if (garbage(e)) run.coverage.skipped++;
          else parsed.push({ st: e.st, sub: g.sub, mtime: g.stat.mtimeMs });
        } catch {
          run.coverage.skipped++;
        }
      }
      const mainSt = parsed.filter((p) => !p.sub).map((p) => p.st);
      if (!mainSt.length) continue;
      const newest = [...mainSt].sort((a, b) => (b.last ?? 0) - (a.last ?? 0));
      const pick = (field) => (newest.find((s) => s[field]) || {})[field] || "";
      const firsts = mainSt.map((s) => s.first).filter(Number.isFinite);
      const lasts = parsed.map((p) => p.st.last ?? p.mtime).filter(Number.isFinite);
      const subCwd = parsed.find((p) => p.st.cwd);
      out.push({
        tool: "claude", id, name: pick("ai") || pick("ag") || pick("pr"), cwd: pick("cwd") || (subCwd ? subCwd.st.cwd : ""),
        started: firsts.length ? Math.min(...firsts) : null, last_active: Math.max(...lasts),
        writes: parsed.map((p) => Object.values(p.st.w)),
        intervals: parsed.flatMap((p) => (p.sub ? [[p.st.first, p.st.last]] : turns(p.st))),
      });
    }
    return out;
  }

  async function codexNames(root) {
    const file = path.join(root, "session_index.jsonl");
    const stat = await statOf(file);
    const sig = stat ? `${stat.size}:${stat.mtimeMs}` : "";
    if (sig === index.sig) return index.names;
    const names = new Map();
    try {
      for (const line of (await fs.promises.readFile(file, "utf8")).split("\n")) {
        try {
          const e = JSON.parse(line);
          if (e && typeof e.id === "string" && typeof e.thread_name === "string") names.set(e.id, e.thread_name);
        } catch {
          /* partial or foreign line */
        }
      }
    } catch {
      /* no index yet */
    }
    index = { sig, names };
    return names;
  }

  async function codex(run) {
    const root = codexDir();
    const dirs = [];
    const day = new Date(run.now);
    day.setHours(0, 0, 0, 0);
    day.setDate(day.getDate() - (run.days + CODEX_EXTRA_DAYS));
    for (; day.getTime() <= run.now; day.setDate(day.getDate() + 1)) {
      dirs.push(path.join(root, "sessions", String(day.getFullYear()), String(day.getMonth() + 1).padStart(2, "0"), String(day.getDate()).padStart(2, "0")));
    }
    const byId = new Map();
    (await mapLimit(dirs, 8, entries)).forEach((list, i) => {
      for (const ent of list) {
        const m = ent.isFile() && ent.name.startsWith("rollout-") ? UUID.exec(ent.name) : null;
        if (m && (!run.only || run.only.has(`codex:${m[1]}`))) byId.set(m[1], path.join(dirs[i], ent.name));
      }
    });
    const found = [...byId].map(([id, file]) => ({ id, file }));
    const names = await codexNames(root);
    const stats = await mapLimit(found, STAT_LIMIT, (f) => statOf(f.file));
    const out = [];
    for (let i = 0; i < found.length; i++) {
      const { id, file } = found[i];
      const stat = stats[i];
      if (!stat) continue;
      run.seen.add(file);
      if (stat.mtimeMs < run.since) continue;
      let e;
      try {
        e = await record(file, "codex", stat, ctx, run);
      } catch {
        run.coverage.skipped++;
        continue;
      }
      if (garbage(e)) {
        run.coverage.skipped++;
        continue;
      }
      const st = e.st;
      out.push({
        tool: "codex", id, name: names.get(id) || "", cwd: st.cwd, started: st.started ?? st.first,
        last_active: st.last ?? stat.mtimeMs, writes: [Object.values(st.ev ? st.w : st.pw)], intervals: turns(st),
      });
    }
    return out;
  }

  // summary.json is rewritten whole; it is small, so it is read again whenever it changes.
  async function grokSummary(file, stat, run) {
    run.seen.add(file);
    const e = files.get(file);
    if (e && e.kind === "grok-summary" && e.size === stat.size && e.mtimeMs === stat.mtimeMs) return e.st;
    if (!stat.isFile() || stat.size > TAIL_MAX) throw new Error("not a summary");
    const s = JSON.parse(await fs.promises.readFile(file, "utf8"));
    if (!s || typeof s !== "object") throw new Error("not a summary");
    const st = {
      title: clip(s.generated_title || s.session_summary), cwd: typeof s.info?.cwd === "string" ? s.info.cwd : "",
      started: ms(s.created_at), last: ms(s.last_active_at) ?? ms(s.updated_at),
    };
    files.set(file, { kind: "grok-summary", size: stat.size, mtimeMs: stat.mtimeMs, offset: stat.size, st });
    dirty = true;
    return st;
  }

  async function grok(run) {
    const root = path.join(grokDir(), "sessions");
    const out = [];
    for (const group of await entries(root)) {
      if (!group.isDirectory()) continue;
      for (const ent of await entries(path.join(root, group.name))) {
        if (!ent.isDirectory() || (run.only && !run.only.has(`grok:${ent.name}`))) continue;
        const dir = path.join(root, group.name, ent.name);
        const names = ["summary.json", "updates.jsonl", "events.jsonl"].map((n) => path.join(dir, n));
        const [sum, upd, evs] = await Promise.all(names.map(statOf));
        names.forEach((f, i) => { if ([sum, upd, evs][i]) run.seen.add(f); });
        const times = [sum, upd, evs].filter(Boolean).map((s) => s.mtimeMs);
        if (!times.length || Math.max(...times) < run.since) continue;
        let summary = {};
        if (sum) {
          try {
            summary = await grokSummary(names[0], sum, run);
          } catch {
            run.coverage.skipped++;
          }
        }
        const read = async (stat, file, kind) => {
          if (!stat) return null;
          try {
            const e = await record(file, kind, stat, ctx, run);
            if (!garbage(e)) return e.st;
          } catch {
            /* counted below */
          }
          run.coverage.skipped++;
          return null;
        };
        const updates = await read(upd, names[1], "grok-updates");
        const events = await read(evs, names[2], "grok-events");
        let cwd = summary.cwd;
        if (!cwd) {
          try {
            cwd = decodeURIComponent(group.name);
          } catch {
            cwd = "";
          }
        }
        const lasts = [summary.last, updates?.last, events?.last].filter(Number.isFinite);
        out.push({
          tool: "grok", id: ent.name, name: summary.title || "", cwd, started: summary.started ?? events?.first ?? updates?.first ?? null,
          last_active: lasts.length ? Math.max(...lasts) : Math.max(...times),
          writes: updates ? [Object.values(updates.w), Object.values(updates.pend)] : [],
          intervals: events ? turns(events) : [],
        });
      }
    }
    return out;
  }

  // Cursor Agent: chats/<hash>/<chat id>/ holds meta.json and the chat's store.db.
  async function cursor(run) {
    const root = path.join(cursorDir(), "chats");
    const found = [];
    for (const group of await entries(root)) {
      if (!group.isDirectory()) continue;
      for (const ent of await entries(path.join(root, group.name))) {
        if (ent.isDirectory() && (!run.only || run.only.has(`cursor:${ent.name}`))) found.push({ id: ent.name, dir: path.join(root, group.name, ent.name) });
      }
    }
    const stats = await mapLimit(found, STAT_LIMIT, (f) => Promise.all([statOf(path.join(f.dir, "store.db")), statOf(path.join(f.dir, "store.db-wal"))]));
    const out = [];
    for (let i = 0; i < found.length; i++) {
      const { id, dir } = found[i];
      const [stat, walStat] = stats[i];
      if (!stat) continue;
      const file = path.join(dir, "store.db");
      run.seen.add(file);
      const active = activeAt(stat, walStat);
      if (active < run.since) continue;
      let meta = null;
      try {
        meta = JSON.parse(await fs.promises.readFile(path.join(dir, "meta.json"), "utf8"));
      } catch {
        /* counted below */
      }
      if (!meta || typeof meta !== "object") {
        run.coverage.skipped++;
        continue;
      }
      if (meta.hasConversation === false) continue;
      const cwd = typeof meta.cwd === "string" ? meta.cwd : "";
      let e;
      try {
        e = await dbRecord(file, "cursor", stat, walStat, run, (db, x) => cursorRead(db, x, file, cwd));
      } catch {
        run.coverage.skipped++;
        continue;
      }
      const st = e.st;
      const started = ms(meta.createdAtMs);
      const updated = ms(meta.updatedAtMs);
      // A write with no time of its own is dated by the file, or else by the chat's last update.
      const writes = Object.values(st.w).map((w) => [...w]);
      const undated = writes.filter((w) => !(w[2] > 0));
      (await mapLimit(undated, STAT_LIMIT, (w) => statOf(w[0]))).forEach((s, j) => { undated[j][2] = s ? s.mtimeMs : updated ?? active; });
      const span = started != null && updated != null && updated >= started && updated - started <= CURSOR_SPAN_MAX ? [[started, updated]] : [];
      const lasts = [updated, st.last].filter(Number.isFinite);
      out.push({
        tool: "cursor", id, name: typeof meta.title === "string" ? meta.title : "", cwd, started: started ?? st.first,
        last_active: lasts.length ? Math.max(...lasts) : active, writes: [writes], intervals: st.first != null ? turns(st) : span,
      });
    }
    return out;
  }

  // Antigravity's titles and folders: its metadata cache, then the prompt history. Both are small
  // and read again only when they change.
  async function agyInfo(root) {
    const metaFile = path.join(root, "cache", "conversation_metadata.json");
    const historyFile = path.join(root, "history.jsonl");
    const [metaStat, historyStat] = await Promise.all([statOf(metaFile), statOf(historyFile)]);
    const sig = [metaStat, historyStat].map((s) => (s ? `${s.size}:${s.mtimeMs}` : "")).join("|");
    if (sig === agyIndex.sig) return agyIndex;
    const meta = new Map();
    let data = null;
    // Rewritten whole: a read that lands mid-write is tried once more.
    for (let i = 0; metaStat && i < 2 && !data; i++) {
      try {
        data = JSON.parse(await fs.promises.readFile(metaFile, "utf8"));
      } catch {
        /* mid-write */
      }
    }
    const conversations = data && data.conversations && typeof data.conversations === "object" ? data.conversations : {};
    for (const [key, c] of Object.entries(conversations)) {
      const s = (c && c.summary) || {};
      const updated = ms(s.UpdatedAt);
      meta.set(typeof s.ID === "string" && s.ID ? s.ID : key, {
        title: s.Title || s.Preview || "", cwd: fromFileUri(Array.isArray(s.WorkspaceURIs) ? s.WorkspaceURIs[0] : null, platform),
        updated: updated > 0 ? updated : null, skip: s.Internal === true || c?.is_internal === true || s.Cloud === true,
      });
    }
    const history = new Map();
    let text = "";
    try {
      text = historyStat ? await fs.promises.readFile(historyFile, "utf8") : "";
    } catch {
      /* no history yet */
    }
    for (const line of text.split("\n")) {
      let h;
      try {
        h = JSON.parse(line);
      } catch {
        continue;
      }
      const at = ms(h?.timestamp);
      if (typeof h?.conversationId !== "string" || at == null) continue;
      const e = history.get(h.conversationId) || { title: "", titleAt: Infinity, cwd: "", cwdAt: -Infinity };
      // The first thing asked names the conversation; a slash command does not.
      if (typeof h.display === "string" && h.display && h.type !== "slash_command" && !h.display.startsWith("/") && at < e.titleAt) {
        e.title = h.display;
        e.titleAt = at;
      }
      if (typeof h.workspace === "string" && h.workspace && at >= e.cwdAt) {
        e.cwd = h.workspace;
        e.cwdAt = at;
      }
      history.set(h.conversationId, e);
    }
    agyIndex = { sig: metaStat && !data ? "" : sig, meta, history };
    return agyIndex;
  }

  // Antigravity: one database per conversation in antigravity-cli/conversations.
  async function antigravity(run) {
    const root = path.join(geminiDir(), "antigravity-cli");
    const dir = path.join(root, "conversations");
    const found = [];
    for (const ent of await entries(dir)) {
      const id = ent.isFile() && ent.name.endsWith(".db") ? ent.name.slice(0, -3) : "";
      if (id && (!run.only || run.only.has(`gemini:${id}`))) found.push({ id, file: path.join(dir, ent.name) });
    }
    if (!found.length) return [];
    const info = await agyInfo(root);
    const stats = await mapLimit(found, STAT_LIMIT, (f) => Promise.all([statOf(f.file), statOf(`${f.file}-wal`)]));
    const out = [];
    for (let i = 0; i < found.length; i++) {
      const { id, file } = found[i];
      const [stat, walStat] = stats[i];
      const c = info.meta.get(id);
      if (!stat) continue;
      run.seen.add(file);
      // Internal and cloud conversations are not the user's.
      if (c?.skip) continue;
      const active = activeAt(stat, walStat);
      if (active < run.since) continue;
      let e;
      try {
        e = await dbRecord(file, "agy", stat, walStat, run, (db, x) => agyRead(db, x, file));
      } catch {
        run.coverage.skipped++;
        continue;
      }
      const st = e.st;
      const h = info.history.get(id);
      out.push({
        tool: "gemini", label: "Antigravity", id, name: c?.title || h?.title || "",
        cwd: c?.cwd || h?.cwd || fromFileUri(st.uri, platform), started: st.first,
        last_active: st.last ?? c?.updated ?? active, writes: [Object.values(st.w)], intervals: turns(st),
      });
    }
    return out;
  }

  // The folder a session ran in, walked once per scan for every session in it, and kept a while.
  function walkFolder(cwd, run) {
    const dir = String(cwd || "").replace(/^\\\\\?\\/, "");
    if (!dir || !path.isAbsolute(dir)) return Promise.resolve(null);
    const norm = path.resolve(dir);
    const key = keyFor(norm, process.platform);
    if (path.parse(norm).root === norm || key === keyFor(path.resolve(home()), process.platform)) return Promise.resolve(null);
    const hit = walks.get(key);
    if (hit && run.now - hit.at < WALK_TTL_MS) return hit.promise;
    const promise = walkDir(norm).catch(() => null);
    walks.set(key, { at: run.now, promise });
    return promise;
  }

  async function walkDir(root) {
    const st = await statOf(root);
    if (!st || !st.isDirectory()) return null;
    const found = [];
    let visited = 0;
    let truncated = false;
    const queue = [[root, 0]];
    // A few folders are listed at once, but taken in order, so the same entries count towards the cap.
    for (let q = 0; q < queue.length && !truncated;) {
      const batch = queue.slice(q, q + WALK_BATCH);
      q += batch.length;
      const lists = await Promise.all(batch.map(([dir]) => entries(dir)));
      const outputs = [];
      for (let i = 0; i < batch.length && !truncated; i++) {
        const [dir, depth] = batch[i];
        for (const ent of lists[i]) {
          if (++visited > WALK_MAX) {
            truncated = true;
            break;
          }
          if (ent.isDirectory()) {
            if (depth < WALK_DEPTH && !ent.name.startsWith(".") && !SKIP_DIRS.has(ent.name.toLowerCase())) queue.push([path.join(dir, ent.name), depth + 1]);
          } else if (ent.isFile() && OUTPUT_EXT.has(extOf(ent.name))) outputs.push(path.join(dir, ent.name));
        }
      }
      const stats = await mapLimit(outputs, STAT_LIMIT, statOf);
      outputs.forEach((file, i) => {
        const s = stats[i];
        if (s) found.push({ path: file, key: keyFor(file, process.platform), m: s.mtimeMs, b: s.birthtimeMs > 0 ? s.birthtimeMs : null });
      });
      await yieldTurn();
    }
    return {
      byM: [...found].sort((a, b) => a.m - b.m),
      byB: found.filter((f) => f.b != null).sort((a, b) => a.b - b.b),
      truncated,
    };
  }

  // Output files whose creation or last change falls inside one of the session's turns.
  function generated(walk, intervals, taken, run) {
    const out = new Map();
    for (const [s, e] of intervals) {
      for (const [list, field] of [[walk.byM, "m"], [walk.byB, "b"]]) {
        for (let i = lowerBound(list, s, field); i < list.length && list[i][field] <= e + PAD_MS; i++) {
          const f = list[i];
          if (taken.has(f.key) || out.has(f.key)) continue;
          if (out.size >= GENERATED_MAX) {
            run.coverage.truncated = true;
            return [...out.values()];
          }
          out.set(f.key, { path: f.path, name: path.basename(f.path), kind: "generated", at: f.m });
        }
      }
    }
    return [...out.values()];
  }

  async function runScan(days, only) {
    load();
    const at = now();
    const run = { days, only, now: at, since: at - days * DAY_MS, seen: new Set(), coverage: { skipped: 0, truncated: false } };
    for (const [key, w] of walks) if (at - w.at >= WALK_TTL_MS) walks.delete(key);
    const found = [];
    for (const store of [claude, codex, grok, cursor, antigravity]) {
      try {
        found.push(...(await store(run)));
      } catch {
        run.coverage.skipped++;
      }
    }
    const P = platform === "win32" ? path.win32 : path.posix;
    const folders = [...new Set(found.map((s) => s.cwd).filter(Boolean))];
    const walked = new Map((await mapLimit(folders, WALK_LIMIT, (f) => walkFolder(f, run))).map((w, i) => [folders[i], w]));
    // A file some session's record says it wrote is that session's: another session working in the
    // same folder at the same time does not list it as generated. Every record read so far counts.
    const written = new Set();
    for (const e of files.values()) {
      for (const field of ["w", "pw", "pend"]) {
        for (const [key, row] of Object.entries(e.st[field] || {})) if (row[1] !== "deleted") written.add(key);
      }
    }
    const sessions = [];
    for (const s of found) {
      try {
        const w = {};
        for (const [file, kind, when] of s.writes.flat().sort((a, b) => a[2] - b[2])) put(w, keyFor(file, platform), file, kind, when);
        const rows = Object.values(w).filter((x) => x[1] !== "deleted").map(([file, kind, when]) => ({ path: file, name: P.basename(file), kind, at: when }));
        const walk = walked.get(s.cwd);
        if (walk) {
          if (walk.truncated) run.coverage.truncated = true;
          rows.push(...generated(walk, merged(s.intervals), written, run));
        }
        if (!rows.length) continue;
        // Antigravity is listed under the tool "gemini", beside the Gemini CLI, with its own label.
        const label = s.label || LABELS[s.tool];
        sessions.push({
          key: `${s.tool}:${s.id}`, tool: s.tool, label, id: s.id,
          name: clip(s.name) || baseName(s.cwd) || label, cwd: s.cwd,
          started: Number.isFinite(s.started) ? s.started : null, last_active: s.last_active, files: rows,
        });
      } catch {
        run.coverage.skipped++;
      }
    }
    // What is on disk now, never from the cache.
    const rows = sessions.flatMap((s) => s.files);
    const stats = await mapLimit(rows, STAT_LIMIT, (r) => statOf(r.path));
    rows.forEach((r, i) => {
      const st = stats[i];
      Object.assign(r, { exists: !!st, size: st ? st.size : null, modified: st ? st.mtimeMs : null });
    });
    for (const s of sessions) s.files.sort((a, b) => b.at - a.at || a.name.localeCompare(b.name));
    sessions.sort((a, b) => b.last_active - a.last_active);
    if (!only) await prune(run);
    save();
    return { sessions, coverage: run.coverage };
  }

  // Parse states of record files that are gone.
  async function prune(run) {
    const stale = [...files.keys()].filter((f) => !run.seen.has(f));
    const gone = await mapLimit(stale, STAT_LIMIT, async (f) => {
      try {
        await fs.promises.stat(f);
        return false;
      } catch (err) {
        return err.code === "ENOENT" || err.code === "ENOTDIR";
      }
    });
    stale.forEach((f, i) => {
      if (!gone[i]) return;
      files.delete(f);
      dirty = true;
    });
  }

  // Scans run one at a time; a scan asked for again while it runs is shared.
  function scan({ days = 7, only = null } = {}) {
    const d = Number.isFinite(Number(days)) && Number(days) > 0 ? Number(days) : 7;
    const set = only instanceof Set ? only : Array.isArray(only) ? new Set(only) : null;
    const key = `${d}|${set ? [...set].sort().join(",") : "*"}`;
    if (inflight.has(key)) return inflight.get(key);
    const run = chain.then(() => runScan(d, set)).catch(() => ({ sessions: [], coverage: { skipped: 1, truncated: false } }));
    chain = run;
    const shared = run.finally(() => inflight.delete(key));
    inflight.set(key, shared);
    return shared;
  }

  return {
    scan,
    flush() {
      save();
    },
  };
}

module.exports = { createSessionFiles };
