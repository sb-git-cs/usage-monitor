const fs = require("node:fs");
const path = require("node:path");
const { claudeConfigDir, codexHome, grokHome, cursorCliDir, geminiHome, home } = require("./paths");
const { clip, baseName } = require("./session-log");

// Past sessions from each coding CLI's own records, for the recent list. A file is parsed again
// only when its size or time changed, and the large ones (whole transcripts, chat databases) are
// never read past a small head. One store that cannot be read never hides the others.

const PER_CLI = 40;
const CLAUDE_HEAD = 512 * 1024;
const SMALL_HEAD = 64 * 1024;
const CODEX_DAYS = 30;
const UUID = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

function copilotHome() {
  return process.env.COPILOT_HOME || path.join(home(), ".copilot");
}

function statOf(file) {
  try {
    return fs.statSync(file);
  } catch {
    return null;
  }
}

function list(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

// Milliseconds from a number or an ISO / numeric string.
function ms(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || !value) return null;
  const n = /^\d+$/.test(value) ? Number(value) : Date.parse(value);
  return Number.isFinite(n) ? n : null;
}

// The first bytes of a file, without a line cut off at the cap.
function readHead(file, bytes) {
  const fd = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const buf = Buffer.alloc(Math.min(size, bytes));
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    const text = buf.subarray(0, n).toString("utf8");
    return size > bytes ? text.slice(0, text.lastIndexOf("\n") + 1) || text : text;
  } finally {
    fs.closeSync(fd);
  }
}

function parseLines(text) {
  const out = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* partial or foreign line */
    }
  }
  return out;
}

// A string field of a JSON text too long to parse whole.
function jsonField(text, name) {
  const m = new RegExp(`"${name}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(text);
  if (!m) return undefined;
  try {
    return JSON.parse(`"${m[1]}"`);
  } catch {
    return undefined;
  }
}

// file:///D:/x is D:\x on Windows; file:///home/x is /home/x.
function fromFileUri(uri, platform) {
  const m = /^file:\/\/[^/]*(\/.*)$/i.exec(String(uri || ""));
  if (!m) return "";
  let p;
  try {
    p = decodeURIComponent(m[1]);
  } catch {
    return "";
  }
  if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1);
  return platform === "win32" ? p.replace(/\//g, "\\") : p;
}

function entry(tool, cli, label, { id, name, cwd, started, last_active }) {
  if (typeof id !== "string" || !id || !Number.isFinite(last_active)) return null;
  const folder = String(cwd || "").replace(/^\\\\\?\\/, "");
  return { tool, cli, label, name: clip(name) || baseName(folder) || label, cwd: folder, id,
    started: Number.isFinite(started) ? started : null, last_active };
}

function newest(items) {
  return items.filter(Boolean).sort((a, b) => b.last_active - a.last_active).slice(0, PER_CLI);
}

// Claude Code: the title it generated, the session's name, and whether it ran in a terminal,
// from the start of the transcript.
function claudeHead(file) {
  let title = null;
  let agent = null;
  let entrypoint;
  for (const line of readHead(file, CLAUDE_HEAD).split("\n")) {
    const wanted = line.includes('"ai-title"') || line.includes('"agent-name"') || (entrypoint === undefined && line.includes('"user"'));
    if (!wanted) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e.type === "ai-title" && typeof e.aiTitle === "string") title = e.aiTitle;
    else if (e.type === "agent-name" && typeof e.agentName === "string") agent = e.agentName;
    else if (e.type === "user" && entrypoint === undefined) entrypoint = typeof e.entrypoint === "string" ? e.entrypoint : null;
  }
  return { title, agent, entrypoint: entrypoint ?? null };
}

function claudeHistory(file) {
  const sessions = new Map();
  for (const e of parseLines(fs.readFileSync(file, "utf8"))) {
    const at = ms(e.timestamp);
    if (typeof e.sessionId !== "string" || at == null) continue;
    const s = sessions.get(e.sessionId) || { id: e.sessionId, cwd: "", display: "", started: at, last: at };
    if (!s.cwd && typeof e.project === "string") s.cwd = e.project;
    if (!s.display && typeof e.display === "string") s.display = e.display;
    s.started = Math.min(s.started, at);
    s.last = Math.max(s.last, at);
    sessions.set(e.sessionId, s);
  }
  return sessions;
}

// Codex's session header. The first line can carry long instructions; past the cap, the fields
// needed come before them.
function codexHeader(file) {
  const cut = readHead(file, SMALL_HEAD).split("\n")[0];
  try {
    const meta = JSON.parse(cut);
    return meta && meta.type === "session_meta" && meta.payload ? meta.payload : null;
  } catch {
    /* longer than the cap */
  }
  if (!/"type"\s*:\s*"session_meta"/.test(cut)) return null;
  const source = /"source"\s*:\s*(\{|")/.exec(cut);
  return {
    id: jsonField(cut, "id"), timestamp: jsonField(cut, "timestamp"), cwd: jsonField(cut, "cwd"),
    originator: jsonField(cut, "originator"), thread_source: jsonField(cut, "thread_source"),
    source: source && source[1] === "{" ? {} : jsonField(cut, "source"),
  };
}

// Only threads the user started in Codex's own terminal: not `codex exec`, the editor extension or
// a sub-agent. Codex's terminal itself labels many of its threads "vscode"; the originator tells
// those apart from the editor's.
function codexUserThread(h) {
  if (h.thread_source != null && h.thread_source !== "user") return false;
  if (h.source && typeof h.source === "object") return false;
  if (h.source === "exec" || h.originator === "codex_exec" || h.originator === "codex_vscode") return false;
  return !(h.source === "vscode" && h.originator !== "codex-tui");
}

function geminiHead(file, size) {
  const text = readHead(file, SMALL_HEAD);
  for (const candidate of [size <= SMALL_HEAD ? text : null, text.split("\n")[0]]) {
    try {
      const j = JSON.parse(candidate);
      if (j && typeof j === "object") return j;
    } catch {
      /* a .jsonl file, or longer than the cap */
    }
  }
  const dir = /"directories"\s*:\s*\[\s*"((?:[^"\\]|\\.)*)"/.exec(text);
  let directories = [];
  try {
    if (dir) directories = [JSON.parse(`"${dir[1]}"`)];
  } catch {
    /* not a string */
  }
  return { sessionId: jsonField(text, "sessionId"), startTime: jsonField(text, "startTime"),
    lastUpdated: jsonField(text, "lastUpdated"), summary: jsonField(text, "summary"), directories };
}

function yamlValue(text, key) {
  const m = new RegExp(`^${key}:[ \\t]*(.+?)[ \\t]*$`, "m").exec(text);
  if (!m) return "";
  const v = m[1];
  if (v.startsWith('"')) {
    try {
      return JSON.parse(v);
    } catch {
      return v.slice(1, -1);
    }
  }
  return v.startsWith("'") ? v.slice(1, -1).replace(/''/g, "'") : v;
}

function createRecordReader({
  claudeDir = claudeConfigDir, codexDir = codexHome, grokDir = grokHome, cursorDir = cursorCliDir,
  geminiDir = geminiHome, copilotDir = copilotHome, now = Date.now, platform = process.platform,
} = {}) {
  const cache = new Map(); // key -> { sig, value }
  let used = new Set();

  function cached(key, sig, parse) {
    used.add(key);
    const hit = cache.get(key);
    if (hit && hit.sig === sig) return hit.value;
    let value;
    try {
      value = parse();
    } catch {
      value = null;
    }
    cache.set(key, { sig, value });
    return value;
  }

  // A file parsed again only when its size or time changed.
  function parsed(file, parse) {
    const st = statOf(file);
    return st ? { st, value: cached(file, `${st.size}:${st.mtimeMs}`, () => parse(st)) } : { st: null, value: null };
  }

  function claude() {
    const root = claudeDir();
    const sessions = parsed(path.join(root, "history.jsonl"), () => claudeHistory(path.join(root, "history.jsonl"))).value;
    if (!sessions) return [];
    // Transcripts sit one level down; sub-agent transcripts deeper are not sessions.
    const projects = path.join(root, "projects");
    const transcripts = new Map();
    for (const dir of list(projects)) {
      for (const n of list(path.join(projects, dir))) {
        if (n.endsWith(".jsonl")) transcripts.set(`${dir}/${n}`, path.join(projects, dir, n));
      }
    }
    const byName = new Map();
    for (const [key, file] of transcripts) {
      const n = key.slice(key.indexOf("/") + 1);
      if (!byName.has(n)) byName.set(n, file);
    }
    const out = [];
    for (const s of [...sessions.values()].sort((a, b) => b.last - a.last)) {
      if (out.length >= PER_CLI) break;
      const name = `${s.id}.jsonl`;
      const file = transcripts.get(`${s.cwd.replace(/[^A-Za-z0-9]/g, "-")}/${name}`) || byName.get(name);
      const { st, value: head } = file ? parsed(file, () => claudeHead(file)) : { st: null, value: null };
      // Runs started with -p or by another program are not terminal sessions.
      if (head && head.entrypoint && head.entrypoint !== "cli") continue;
      // A slash command is not a title for the session.
      const prompt = s.display.startsWith("/") ? "" : s.display;
      out.push(entry("claude", "claude", "Claude Code", {
        id: s.id, cwd: s.cwd, name: head?.title || head?.agent || prompt, started: s.started,
        last_active: Math.max(s.last, st ? st.mtimeMs : 0),
      }));
    }
    return out;
  }

  function codex() {
    const root = codexDir();
    const index = parsed(path.join(root, "session_index.jsonl"), () => {
      const rows = new Map();
      for (const e of parseLines(fs.readFileSync(path.join(root, "session_index.jsonl"), "utf8"))) {
        if (typeof e.id === "string") rows.set(e.id, { name: e.thread_name, updated: ms(e.updated_at) });
      }
      return rows;
    }).value || new Map();
    // Only the day folders of the last month are listed.
    const files = new Map();
    const day = new Date(now());
    day.setHours(0, 0, 0, 0);
    day.setDate(day.getDate() - CODEX_DAYS);
    for (; day.getTime() <= now(); day.setDate(day.getDate() + 1)) {
      const dir = path.join(root, "sessions", String(day.getFullYear()), String(day.getMonth() + 1).padStart(2, "0"), String(day.getDate()).padStart(2, "0"));
      for (const n of list(dir)) {
        const m = UUID.exec(n);
        if (m) files.set(m[1], path.join(dir, n));
      }
    }
    const out = [];
    for (const [id, file] of files) {
      const st = statOf(file);
      // The header never changes once written; it is read once. A file caught before its header was
      // written is read again once it has grown.
      const h = st && cached(`head:${file}`, cache.get(`head:${file}`)?.value ? "head" : `head:${st.size}`, () => codexHeader(file));
      if (!h || !codexUserThread(h)) continue;
      const row = index.get(id);
      // The index's time is when the thread was named; the file changes with every turn.
      out.push(entry("codex", "codex", "Codex", {
        id: typeof h.id === "string" && h.id ? h.id : id, name: row?.name, cwd: h.cwd, started: ms(h.timestamp),
        last_active: Math.max(row?.updated ?? 0, st.mtimeMs),
      }));
    }
    return out;
  }

  function grok() {
    const root = path.join(grokDir(), "sessions");
    const out = [];
    for (const group of list(root)) {
      for (const dir of list(path.join(root, group))) {
        const file = path.join(root, group, dir, "summary.json");
        const { st, value: s } = parsed(file, () => JSON.parse(fs.readFileSync(file, "utf8")));
        if (!s || typeof s !== "object") continue;
        if (s.session_kind === "subagent" || s.session_kind === "headless" || (s.agent_name && s.agent_name !== "grok-build-plan")) continue;
        let cwd = s.info?.cwd;
        if (!cwd) {
          try {
            cwd = decodeURIComponent(group);
          } catch {
            cwd = "";
          }
        }
        out.push(entry("grok", "grok", "Grok Build", {
          id: s.info?.id || dir, cwd, name: s.generated_title || s.session_summary, started: ms(s.created_at),
          last_active: ms(s.last_active_at) ?? ms(s.updated_at) ?? st.mtimeMs,
        }));
      }
    }
    return out;
  }

  function cursor() {
    const root = path.join(cursorDir(), "chats");
    const out = [];
    for (const group of list(root)) {
      for (const id of list(path.join(root, group))) {
        const file = path.join(root, group, id, "meta.json");
        const { st, value: meta } = parsed(file, () => JSON.parse(fs.readFileSync(file, "utf8")));
        if (!meta || typeof meta !== "object" || meta.hasConversation === false) continue;
        out.push(entry("cursor", "cursor-agent", "Cursor Agent", {
          id, cwd: meta.cwd, name: meta.title, started: ms(meta.createdAtMs),
          last_active: ms(meta.updatedAtMs) ?? ms(meta.createdAtMs) ?? st.mtimeMs,
        }));
      }
    }
    return out;
  }

  function antigravity() {
    const root = path.join(geminiDir(), "antigravity-cli");
    const metaFile = path.join(root, "cache", "conversation_metadata.json");
    // Rewritten whole: a read that lands mid-write is tried once more.
    const read = () => JSON.parse(fs.readFileSync(metaFile, "utf8"));
    const meta = parsed(metaFile, () => {
      try {
        return read();
      } catch {
        return read();
      }
    }).value;
    const conversations = meta && meta.conversations && typeof meta.conversations === "object" ? meta.conversations : {};
    const dbs = new Set(list(path.join(root, "conversations")).filter((n) => n.endsWith(".db")).map((n) => n.slice(0, -3)));
    const historyFile = path.join(root, "history.jsonl");
    const history = parsed(historyFile, () => {
      const byId = new Map();
      for (const e of parseLines(fs.readFileSync(historyFile, "utf8"))) {
        const at = ms(e.timestamp);
        if (typeof e.conversationId !== "string" || at == null) continue;
        const h = byId.get(e.conversationId) || { started: at, last: -Infinity, workspace: "" };
        h.started = Math.min(h.started, at);
        if (at >= h.last && typeof e.workspace === "string") {
          h.last = at;
          h.workspace = e.workspace;
        }
        byId.set(e.conversationId, h);
      }
      return byId;
    }).value || new Map();
    const out = [];
    for (const [key, c] of Object.entries(conversations)) {
      const s = (c && c.summary) || {};
      const id = typeof s.ID === "string" && s.ID ? s.ID : key;
      // Without its database the conversation cannot be opened again; internal and cloud ones are not the user's.
      if (!dbs.has(id) || s.Internal === true || c.is_internal === true || s.Cloud === true) continue;
      const h = history.get(id);
      const uri = Array.isArray(s.WorkspaceURIs) ? s.WorkspaceURIs[0] : null;
      out.push(entry("gemini", "agy", "Antigravity", {
        id, cwd: fromFileUri(uri, platform) || h?.workspace || "", name: s.Title || s.Preview,
        started: h ? h.started : null, last_active: ms(s.UpdatedAt) ?? ms(c.last_modified_time),
      }));
    }
    return out;
  }

  // Gemini CLI: one file per session; files nested a level deeper are its sub-agents.
  function gemini() {
    const root = path.join(geminiDir(), "tmp");
    const out = [];
    for (const hash of list(root)) {
      const chats = path.join(root, hash, "chats");
      for (const n of list(chats)) {
        if (!/^session-.*\.jsonl?$/.test(n)) continue;
        const file = path.join(chats, n);
        const { st, value: h } = parsed(file, (stat) => (stat.isFile() ? geminiHead(file, stat.size) : null));
        if (!h) continue;
        const cwd = Array.isArray(h.directories) && typeof h.directories[0] === "string" ? h.directories[0] : "";
        out.push(entry("gemini", "gemini", "Gemini CLI", {
          id: h.sessionId, cwd, name: h.summary, started: ms(h.startTime), last_active: ms(h.lastUpdated) ?? st.mtimeMs,
        }));
      }
    }
    return out;
  }

  function copilot() {
    const root = path.join(copilotDir(), "session-state");
    const out = [];
    for (const id of list(root)) {
      const dir = path.join(root, id);
      const file = path.join(dir, "workspace.yaml");
      const ws = parsed(file, () => {
        const text = readHead(file, SMALL_HEAD);
        return { cwd: yamlValue(text, "cwd"), name: yamlValue(text, "summary") || yamlValue(text, "title") || yamlValue(text, "name") };
      }).value;
      if (!ws) continue;
      const folder = statOf(dir);
      const events = statOf(path.join(dir, "events.jsonl"));
      out.push(entry("copilot", "copilot", "Copilot CLI", {
        id, cwd: ws.cwd, name: ws.name, started: folder && folder.birthtimeMs > 0 ? folder.birthtimeMs : null,
        last_active: events ? events.mtimeMs : folder ? folder.mtimeMs : null,
      }));
    }
    return out;
  }

  function read() {
    used = new Set();
    const out = [];
    for (const store of [claude, codex, grok, cursor, antigravity, gemini, copilot]) {
      try {
        out.push(...newest(store()));
      } catch {
        /* one unreadable store never hides the others */
      }
    }
    for (const key of cache.keys()) if (!used.has(key)) cache.delete(key);
    return out;
  }

  return { read };
}

function readRecords(opts) {
  return createRecordReader(opts).read();
}

module.exports = { createRecordReader, readRecords, fromFileUri };
