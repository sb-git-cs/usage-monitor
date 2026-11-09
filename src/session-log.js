const fs = require("node:fs");
const path = require("node:path");

// Coding sessions seen running in a terminal or found in the CLIs' own records, kept so a closed
// one can be reopened where it ran. Only metadata is kept: folder, title, times and whether it
// skipped permissions. Nothing is read from disk until the log is first used.

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const DAY_MS = 86400_000;
const NAME_MAX = 80;
// A running session's last_active alone is saved at most this often; other changes within saveGapMs.
const TOUCH_MS = 60_000;
const ADOPT_SLACK_MS = 5000;

// How each CLI reopens a session by id, and its own skip-permissions flag (checked against
// their --help). The id is put on a cmd.exe line unquoted, so only ID_RE ids are accepted.
const RESUME = Object.freeze({
  claude: Object.freeze({ label: "Claude Code", file: "claude", args: (id) => ["--resume", id], godmode: "--dangerously-skip-permissions" }),
  codex: Object.freeze({ label: "Codex", file: "codex", args: (id) => ["resume", id], godmode: "--dangerously-bypass-approvals-and-sandbox" }),
  grok: Object.freeze({ label: "Grok Build", file: "grok", args: (id) => ["--resume", id], godmode: "--always-approve" }),
  agy: Object.freeze({ label: "Antigravity", file: "agy", args: (id) => ["--conversation", id], godmode: "--dangerously-skip-permissions" }),
  gemini: Object.freeze({ label: "Gemini CLI", file: "gemini", args: (id) => ["--resume", id], godmode: "--approval-mode=yolo" }),
  "cursor-agent": Object.freeze({ label: "Cursor Agent", file: "cursor-agent", args: (id) => ["--resume", id], godmode: "--force" }),
  copilot: Object.freeze({ label: "Copilot CLI", file: "copilot", args: (id) => [`--resume=${id}`], godmode: "--allow-all-tools" }),
});

// Every spelling of each CLI's skip-permissions switch; "--name=value" is matched as two tokens.
const GODMODE_FLAGS = Object.freeze({
  claude: [["--dangerously-skip-permissions"], ["--permission-mode", "bypassPermissions"]],
  agy: [["--dangerously-skip-permissions"], ["--permission-mode", "bypassPermissions"]],
  codex: [["--dangerously-bypass-approvals-and-sandbox"], ["--yolo"]],
  grok: [["--always-approve"], ["--permission-mode", "bypassPermissions"]],
  "cursor-agent": [["--force"], ["-f"], ["--yolo"]],
  copilot: [["--allow-all-tools"], ["--allow-all"], ["--yolo"]],
  gemini: [["--yolo"], ["-y"], ["--approval-mode", "yolo"]],
});

function clip(text) {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  return s.length > NAME_MAX ? `${s.slice(0, NAME_MAX - 1)}…` : s;
}

// A model id as shown: text only, no control characters, at most 80 characters.
function cleanModel(model) {
  if (typeof model !== "string") return null;
  const s = model.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").trim().slice(0, 80);
  return s || null;
}

function baseName(p) {
  return String(p || "").split(/[\\/]/).filter(Boolean).pop() || "";
}

// No trailing separator, except on a root: "C:" alone means another folder to Windows.
function folder(p) {
  const s = String(p || "");
  const trimmed = s.replace(/[\\/]+$/, "");
  if (/^[A-Za-z]:$/.test(trimmed)) return `${trimmed}\\`;
  return trimmed || s.slice(0, 1);
}

function sameFolder(a, b, platform) {
  if (!a || !b) return false;
  const norm = (p) => {
    const trimmed = String(p).replace(/[\\/]+$/, "");
    return platform === "win32" ? trimmed.replace(/\//g, "\\").toLowerCase() : trimmed;
  };
  return norm(a) === norm(b);
}

// A process command line without its program, split on whitespace outside quotes, "--name=value"
// split in two. A quoted token is a prompt, never a switch, so it is marked.
function tokens(cmd) {
  const s = String(cmd || "").trim();
  const rest = s.startsWith('"') ? s.slice(s.indexOf('"', 1) + 1) : s.replace(/^\S+/, "");
  const out = [];
  for (const raw of rest.match(/"[^"]*"?|\S+/g) || []) {
    if (raw.startsWith('"')) {
      out.push({ text: raw.replace(/^"|"$/g, ""), quoted: true });
      continue;
    }
    const pair = /^(--[^=]+)=(.*)$/.exec(raw);
    if (pair) out.push({ text: pair[1], quoted: false }, { text: pair[2], quoted: false });
    else out.push({ text: raw, quoted: false });
  }
  return out;
}

function launchFlags(cli, cmd) {
  const args = tokens(cmd);
  const spellings = Object.hasOwn(GODMODE_FLAGS, cli) ? GODMODE_FLAGS[cli] : [];
  const is = (i, part) => !!args[i] && !args[i].quoted && args[i].text === part;
  const godmode = spellings.some((flag) => args.some((_, i) => flag.every((part, j) => is(i + j, part))));
  const opens = (arg) => (cli === "codex" ? arg === "resume"
    : arg === "--resume" || arg === "-r" || (cli === "agy" && arg === "--conversation"));
  let resumed = null;
  for (let i = 0; i < args.length - 1 && resumed == null; i++) {
    if (!args[i].quoted && opens(args[i].text) && ID_RE.test(args[i + 1].text)) resumed = args[i + 1].text;
  }
  return { godmode, resumed };
}

// The window title goes through cmd.exe and Windows Terminal: keep their special characters out.
// A trailing backslash would escape the closing quote in Windows Terminal.
function safeTitle(text) {
  return String(text).replace(/["%^&|<>;!\\\x00-\x1f]/g, " ").replace(/\s+/g, " ").trim();
}

function resumeCommand(entry) {
  const spec = entry && typeof entry.cli === "string" && Object.hasOwn(RESUME, entry.cli) ? RESUME[entry.cli] : null;
  if (!spec || typeof entry.id !== "string" || !ID_RE.test(entry.id)) return null;
  const args = spec.args(entry.id);
  if (entry.godmode === true && spec.godmode) args.push(spec.godmode);
  const name = clip(entry.name) || baseName(entry.cwd) || spec.label;
  return { label: spec.label, title: safeTitle(`${spec.label} · ${name}`), file: spec.file, args };
}

function entryOf(row) {
  if (!row || typeof row !== "object") return null;
  const { tool, cli, id } = row;
  if (![tool, cli, id].every((v) => typeof v === "string" && v) || !Number.isFinite(row.last_active)) return null;
  return {
    key: `${tool}:${id}`, tool, cli,
    label: typeof row.label === "string" && row.label ? row.label : Object.hasOwn(RESUME, cli) ? RESUME[cli].label : cli,
    name: clip(row.name), cwd: folder(row.cwd), id,
    started: Number.isFinite(row.started) ? row.started : null, last_active: row.last_active,
    closed_at: Number.isFinite(row.closed_at) ? row.closed_at : null,
    godmode: row.godmode === true, source: row.source === "seen" ? "seen" : "disk", model: cleanModel(row.model),
  };
}

// An entry as listed: one with no title yet shows its folder.
function shown(e) {
  return { ...e, name: e.name || baseName(e.cwd) || e.label };
}

// Only the last few sessions worked on are kept: enough to pick up where the last shutdown left off.
function createSessionLog({
  file, now = Date.now, maxAgeMs = 7 * DAY_MS, maxPerTool = 5, maxTotal = 8, saveGapMs = 5_000, closeAfterMs = 8_000,
  platform = process.platform,
} = {}) {
  const entries = new Map();
  const misses = new Map(); // running key -> time of the first record() in a row that did not see it
  const adopted = new Map(); // watcher key of a session with no id -> the disk entry it took over
  let loaded = false;
  let dirty = false;
  let savedAt = 0;
  // The CLIs' records still hold what the user cleared: the disk read skips anything not used since.
  let clearedAt = 0;

  function load() {
    if (loaded) return;
    loaded = true;
    let rows = [];
    try {
      const data = JSON.parse(fs.readFileSync(file, "utf8"));
      if (data && Array.isArray(data.entries)) rows = data.entries;
      if (data && Number.isFinite(data.cleared_at)) clearedAt = data.cleared_at;
    } catch {
      /* no log yet, or unreadable: start empty */
    }
    for (const row of rows) {
      const e = entryOf(row);
      if (!e || entries.has(e.key)) continue;
      // Still open when the app last quit: it closed with that shutdown, at its last activity.
      if (e.closed_at == null) e.closed_at = e.last_active;
      entries.set(e.key, e);
    }
    prune(now());
  }

  // Running entries count towards the caps but are never dropped; closed ones go, oldest first.
  function prune(at) {
    const order = [...entries.values()].sort((a, b) => (a.closed_at == null ? 0 : 1) - (b.closed_at == null ? 0 : 1)
      || b.last_active - a.last_active);
    const perTool = new Map();
    let kept = 0;
    for (const e of order) {
      const n = perTool.get(e.tool) || 0;
      if (e.closed_at != null && (at - e.last_active > maxAgeMs || n >= maxPerTool || kept >= maxTotal)) {
        entries.delete(e.key);
        misses.delete(e.key);
        continue;
      }
      perTool.set(e.tool, n + 1);
      kept++;
    }
  }

  function save(force = false) {
    const at = now();
    if (!dirty || (!force && at - savedAt < saveGapMs)) return;
    prune(at);
    dirty = false;
    savedAt = at;
    if (!file) return;
    const tmp = `${file}.tmp`;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const data = { version: 1, entries: [...entries.values()], ...(clearedAt ? { cleared_at: clearedAt } : {}) };
      fs.writeFileSync(tmp, JSON.stringify(data), { encoding: "utf8", mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch (err) {
      dirty = true;
      try { fs.unlinkSync(tmp); } catch { /* never written */ }
      console.error("recent sessions write failed", err.message);
    }
  }

  // A session with no id of its own (Antigravity, Gemini CLI, Copilot) takes over the one record
  // its CLI wrote in that folder since it started; it keeps that entry while it runs.
  function adopt(item, seen) {
    const known = item.key && adopted.get(item.key);
    if (known && entries.has(known)) return known;
    if (!Number.isFinite(item.started) || !item.cwd) return null;
    const taken = new Set(adopted.values());
    const hits = [...entries.values()].filter((e) => e.closed_at != null && e.cli === item.cli && !seen.has(e.key) && !taken.has(e.key)
      && sameFolder(e.cwd, item.cwd, platform) && e.last_active >= item.started - ADOPT_SLACK_MS);
    if (hits.length !== 1) return null;
    if (item.key) adopted.set(item.key, hits[0].key);
    return hits[0].key;
  }

  // Returns whether anything but last_active changed.
  function upsert(key, item, at) {
    const e = entries.get(key);
    if (!e) {
      const fresh = entryOf({ ...item, last_active: at, closed_at: null, source: "seen" });
      if (fresh) entries.set(key, fresh);
      return !!fresh;
    }
    const before = JSON.stringify([e.closed_at, e.source, e.name, e.cwd, e.godmode, e.started, e.model]);
    e.closed_at = null;
    e.source = "seen";
    e.last_active = at;
    if (e.started == null && Number.isFinite(item.started)) e.started = item.started;
    if (clip(item.name)) e.name = clip(item.name);
    if (item.cwd) e.cwd = folder(item.cwd);
    if (typeof item.godmode === "boolean") e.godmode = item.godmode;
    if (cleanModel(item.model)) e.model = cleanModel(item.model);
    return JSON.stringify([e.closed_at, e.source, e.name, e.cwd, e.godmode, e.started, e.model]) !== before;
  }

  function record(running, at = now()) {
    load();
    const seen = new Set();
    const itemKeys = new Set();
    let changed = false;
    for (const item of Array.isArray(running) ? running : []) {
      if (!item || typeof item.tool !== "string" || typeof item.cli !== "string") continue;
      if (item.key) itemKeys.add(item.key);
      const key = typeof item.id === "string" && item.id ? `${item.tool}:${item.id}` : adopt(item, seen);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      if (upsert(key, item, at)) changed = true;
    }
    for (const k of adopted.keys()) if (!itemKeys.has(k)) adopted.delete(k);
    // One scan that misses a session is not enough, and two must be a scan interval apart: a process
    // can be between restarts, and a refresh right after a scan is not a second look.
    for (const e of entries.values()) {
      if (e.closed_at != null || seen.has(e.key)) {
        misses.delete(e.key);
        continue;
      }
      const first = misses.get(e.key);
      if (first == null || at - first < closeAfterMs) {
        if (first == null) misses.set(e.key, at);
        continue;
      }
      e.closed_at = at;
      misses.delete(e.key);
      changed = true;
    }
    if (changed || (seen.size && at - savedAt >= TOUCH_MS)) dirty = true;
    save();
  }

  function seed(rows, at = now()) {
    load();
    let changed = false;
    const added = [];
    for (const row of Array.isArray(rows) ? rows : []) {
      const d = entryOf({ ...row, closed_at: row?.last_active, godmode: false, source: "disk" });
      if (!d) continue;
      const e = entries.get(d.key);
      if (!e) {
        if (at - d.last_active <= maxAgeMs && d.last_active > clearedAt) {
          entries.set(d.key, d);
          added.push(d.key);
        }
        continue;
      }
      const before = JSON.stringify(e);
      if (!e.name && d.name) e.name = d.name;
      if (!e.cwd && d.cwd) e.cwd = d.cwd;
      if (e.started == null && d.started != null) e.started = d.started;
      // Used again while this app was not watching: it closed no earlier than that.
      if (e.closed_at != null && d.last_active > e.last_active) {
        e.last_active = d.last_active;
        e.closed_at = Math.max(e.closed_at, d.last_active);
      }
      if (JSON.stringify(e) !== before) changed = true;
    }
    if (added.length) prune(at);
    if (changed || added.some((k) => entries.has(k))) dirty = true;
    save();
  }

  function list() {
    load();
    return [...entries.values()].sort((a, b) => b.last_active - a.last_active).map(shown);
  }

  return {
    record,
    seed,
    list,
    recent: () => list().filter((e) => e.closed_at != null),
    get(key) {
      load();
      const e = entries.get(key);
      return e ? shown(e) : null;
    },
    remove(key) {
      load();
      if (!entries.delete(key)) return false;
      misses.delete(key);
      dirty = true;
      save();
      return true;
    },
    clear() {
      load();
      entries.clear();
      misses.clear();
      adopted.clear();
      clearedAt = now();
      dirty = true;
      save(true);
    },
    flush() {
      if (loaded) save(true);
    },
    size() {
      load();
      return entries.size;
    },
  };
}

module.exports = { createSessionLog, resumeCommand, launchFlags, ID_RE, RESUME, clip, baseName, cleanModel };
