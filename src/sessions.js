const fs = require("node:fs");
const path = require("node:path");
const { claudeConfigDir, codexHome } = require("./paths");
const { createWorker, spawnWorker } = require("./system");

// Coding sessions running in a terminal, and resuming the ones a usage limit stopped.
// Claude Code records each running session in ~/.claude/sessions/<pid>.json; Codex has no such
// record, so a running `codex` process is matched to its rollout by folder and start time.
// A session stopped by a limit gets "continue" typed into its own terminal once the limit has reset.
// Nothing is typed when the terminal has closed, when it no longer shows the limit message, while
// the session is busy, or on macOS/Linux.

const SCAN_MS = 10_000;
const GRACE_MS = 60_000; // after the reported reset, so a slightly fast clock does not hit the limit again
const RETRY_MS = 60_000;
const MAX_ATTEMPTS = 3;
const TAIL_BYTES = 256 * 1024;
const HEAD_MAX_BYTES = 2 * 1024 * 1024;
const ROLLOUT_DAYS = 14;
const RESUME_TEXT = "continue";
// Claude Code: "You've hit your session limit · resets 10:10pm", "5-hour limit reached";
// Codex: "You've hit your usage limit". The terminal must still show one before anything is typed,
// so "continue" only ever goes to the terminal where the limit was hit.
const LIMIT_ON_SCREEN = "hit your [\\w -]*limit|limit reached";
// A terminal not linked to a rollout counts only with the message among its newest lines (Codex
// shows its composer and footer below it), and only within hours of the reset the meters reported.
const ORPHAN_LINES = 10;
const ORPHAN_WINDOW_MS = 6 * 3600_000;
// `codex <subcommand>` forms that are not an interactive terminal session.
const CODEX_NON_TUI = new Set(["app-server", "exec", "e", "mcp", "mcp-server", "login", "logout", "apply", "a", "proto",
  "completion", "sandbox", "debug", "cloud", "features", "help", "-h", "--help", "-V", "--version"]);

// FILETIME (100 ns ticks since 1601, as a decimal string) to milliseconds since 1970.
function filetimeMs(value) {
  try {
    return Number(BigInt(String(value)) / 10000n) - 11644473600000;
  } catch {
    return NaN;
  }
}

function sameFolder(a, b, platform = process.platform) {
  if (!a || !b) return false;
  const norm = (p) => {
    const trimmed = String(p).replace(/[\\/]+$/, "");
    return platform === "win32" ? trimmed.replace(/\//g, "\\").toLowerCase() : trimmed;
  };
  return norm(a) === norm(b);
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

// The last complete lines of a file that can be several megabytes long.
function readTail(file, bytes = TAIL_BYTES) {
  const fd = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    let text = buf.toString("utf8");
    if (start > 0) text = text.slice(text.indexOf("\n") + 1);
    return parseLines(text);
  } finally {
    fs.closeSync(fd);
  }
}

// The first line of a file; Codex's session header carries long instructions.
function readFirstLine(file) {
  const fd = fs.openSync(file, "r");
  try {
    const chunks = [];
    const buf = Buffer.alloc(64 * 1024);
    let pos = 0;
    while (pos < HEAD_MAX_BYTES) {
      const n = fs.readSync(fd, buf, 0, buf.length, pos);
      if (!n) break;
      const nl = buf.subarray(0, n).indexOf(10);
      chunks.push(Buffer.from(buf.subarray(0, nl >= 0 ? nl : n)));
      if (nl >= 0) break;
      pos += n;
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

// Claude Code: the session is stopped by a limit when its last conversation entry is the
// rejected-quota error. Anything the user or Claude wrote after it means it moved on.
function claudeState(entries) {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (!e || (e.type !== "user" && e.type !== "assistant") || e.isSidechain || e.isMeta) continue;
    const q = e.quotaLimits;
    if (e.type === "assistant" && e.error === "rate_limit" && q && q.status === "rejected" && Number.isFinite(q.resetsAt)) {
      return { limited: true, resets_at: q.resetsAt * 1000, limit: q.rateLimitType || null };
    }
    return { limited: false };
  }
  return { limited: false };
}

// "try again at 6:05 PM": the next such clock time after the error.
function clockAfter(text, afterMs) {
  const m = /try again at (\d{1,2}):(\d{2})\s*([AP]M)/i.exec(String(text || ""));
  if (!m || !Number.isFinite(afterMs)) return null;
  const d = new Date(afterMs);
  d.setHours((Number(m[1]) % 12) + (m[3].toUpperCase() === "PM" ? 12 : 0), Number(m[2]), 0, 0);
  if (d.getTime() <= afterMs) d.setDate(d.getDate() + 1);
  return d.getTime();
}

// Codex: a turn that ended with usage_limit_exceeded, with no turn started after it.
function codexState(entries) {
  let resets = null;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    const p = e && e.type === "event_msg" && e.payload;
    if (!p) continue;
    if (p.type === "task_started") return { limited: false, busy: true };
    if (p.type !== "task_complete") continue;
    if (!p.error || p.error.codex_error_info !== "usage_limit_exceeded") return { limited: false, busy: false };
    const at = Date.parse(e.timestamp);
    // The rate limits reported just before the error say which window ran out and when it resets.
    for (let j = i - 1; j >= 0 && resets == null; j--) {
      const limits = entries[j]?.type === "event_msg" && entries[j].payload?.type === "token_count" && entries[j].payload.rate_limits;
      if (!limits) continue;
      const spent = [limits.primary, limits.secondary].filter((w) => w && w.used_percent >= 100 && Number.isFinite(w.resets_at));
      if (spent.length) resets = Math.max(...spent.map((w) => w.resets_at * 1000));
      break;
    }
    if (resets == null) resets = clockAfter(p.error.message, at);
    return { limited: true, busy: false, resets_at: resets, limit: null };
  }
  return { limited: false, busy: false };
}

// True while the meters still read that provider's window as used up; resuming then would only
// hit the limit again.
function stillLimited(snapshot, tool, now) {
  const p = (snapshot?.providers || []).find((item) => item.id === tool);
  if (!p || p.status?.state !== "ok") return false;
  return (p.windows || []).some((w) => Number.isFinite(w.used_pct) && w.used_pct >= 100 && Date.parse(w.resets_at) > now);
}

// What happens next for a session stopped by a limit. `attempt` is what was already tried for this reset.
function resumeStatus(session, attempt, { enabled, platform, now, snapshot }) {
  if (platform !== "win32" || !session.can_type) return "manual";
  if (!enabled) return "off";
  if (attempt?.sent) return "sent";
  if (attempt && attempt.count >= MAX_ATTEMPTS) return "failed";
  if (!Number.isFinite(session.resets_at) || now < session.resets_at + GRACE_MS) return "scheduled";
  if (stillLimited(snapshot, session.tool, now)) return "pending";
  if (attempt && now - attempt.last < RETRY_MS) return "retrying";
  return "due";
}

// Pairs running `codex` processes with their rollouts: an id named on the command line, then a
// thread created as the process started, then the only process left in that folder.
function matchCodex(procs, rollouts, platform = process.platform) {
  const out = new Map();
  const taken = new Set();
  const free = (r) => !taken.has(r.file);
  const take = (proc, r) => { out.set(proc.pid, r); taken.add(r.file); };
  for (const proc of procs) {
    const id = /\bresume\s+([0-9a-f-]{36})\b/i.exec(proc.cmd || "")?.[1];
    const r = id && rollouts.find((item) => free(item) && item.id === id);
    if (r) take(proc, r);
  }
  // A thread created while two processes in that folder were starting could be either one's.
  for (const r of [...rollouts].sort((a, b) => b.mtime - a.mtime)) {
    if (!free(r)) continue;
    const owners = procs.filter((p) => !out.has(p.pid) && sameFolder(r.cwd, p.cwd, platform)
      && r.created >= p.started - 5000 && r.created <= p.started + 120_000);
    if (owners.length === 1) take(owners[0], r);
  }
  for (const proc of procs) {
    if (out.has(proc.pid)) continue;
    const peers = procs.filter((p) => !out.has(p.pid) && sameFolder(p.cwd, proc.cwd, platform));
    if (peers.length !== 1) continue;
    const r = rollouts.filter((item) => free(item) && sameFolder(item.cwd, proc.cwd, platform) && item.mtime >= proc.started)
      .sort((a, b) => b.mtime - a.mtime)[0];
    if (r) take(proc, r);
  }
  return out;
}

function codexArgs(cmd) {
  const s = String(cmd || "").trim();
  const rest = s.startsWith('"') ? s.slice(s.indexOf('"', 1) + 1) : s.replace(/^\S+/, "");
  return rest.trim().split(/\s+/).filter(Boolean);
}

function isCodexTui(proc) {
  const first = codexArgs(proc.cmd).find((arg) => !arg.startsWith("-") || CODEX_NON_TUI.has(arg));
  return !first || !CODEX_NON_TUI.has(first);
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

let worker = null;
function helperRequest(req) {
  if (!worker) worker = createWorker({ start: () => spawnWorker("sessions-windows.ps1"), timeoutMs: 15_000 });
  return worker.sample(JSON.stringify(req));
}

function createWatcher({
  getConfig = () => ({}), snapshot = () => null, onChange = () => {}, onResume = () => {},
  platform = process.platform, now = Date.now, request = helperRequest,
  claudeDir = claudeConfigDir, codexDir = codexHome, text = RESUME_TEXT,
} = {}) {
  const attempts = new Map();
  const transcripts = new Map(); // sessionId -> path
  const tails = new Map(); // path -> { key, state }
  const heads = new Map(); // rollout path -> session header
  let view = { auto_resume: false, can_resume: platform === "win32", sessions: [] };
  let busy = false;
  let codexSpent = null;

  function cachedState(file, read) {
    let st;
    try {
      st = fs.statSync(file);
    } catch {
      return null;
    }
    const key = `${st.size}:${st.mtimeMs}`;
    const hit = tails.get(file);
    if (hit && hit.key === key) return hit.state;
    let state;
    try {
      state = read(readTail(file));
    } catch {
      state = null;
    }
    tails.set(file, { key, state });
    return state;
  }

  function claudeTranscript(record) {
    if (transcripts.has(record.sessionId)) return transcripts.get(record.sessionId);
    const projects = path.join(claudeDir(), "projects");
    const name = `${record.sessionId}.jsonl`;
    let found = path.join(projects, String(record.cwd || "").replace(/[^A-Za-z0-9]/g, "-"), name);
    if (!fs.existsSync(found)) {
      found = null;
      try {
        for (const dir of fs.readdirSync(projects)) {
          const candidate = path.join(projects, dir, name);
          if (fs.existsSync(candidate)) {
            found = candidate;
            break;
          }
        }
      } catch {
        /* no projects folder */
      }
    }
    // A session with transcripts turned off has none; look again later.
    if (found) transcripts.set(record.sessionId, found);
    return found;
  }

  function claudeRecords() {
    const dir = path.join(claudeDir(), "sessions");
    let names = [];
    try {
      names = fs.readdirSync(dir).filter((n) => /^\d+\.json$/.test(n));
    } catch {
      return [];
    }
    const out = [];
    for (const n of names) {
      try {
        const r = JSON.parse(fs.readFileSync(path.join(dir, n), "utf8"));
        if (Number.isInteger(r.pid) && typeof r.sessionId === "string" && r.kind === "interactive") out.push(r);
      } catch {
        /* being rewritten */
      }
    }
    return out;
  }

  function codexRollouts(since, ids) {
    const root = path.join(codexDir(), "sessions");
    const files = new Set();
    const day = new Date(Math.max(since, now() - ROLLOUT_DAYS * 86400_000));
    day.setHours(0, 0, 0, 0);
    for (; day.getTime() <= now(); day.setDate(day.getDate() + 1)) {
      const dir = path.join(root, String(day.getFullYear()), String(day.getMonth() + 1).padStart(2, "0"), String(day.getDate()).padStart(2, "0"));
      try {
        for (const n of fs.readdirSync(dir)) if (n.endsWith(".jsonl")) files.add(path.join(dir, n));
      } catch {
        /* no sessions that day */
      }
    }
    // `codex resume <id>` keeps writing the rollout in the folder of the day it began.
    for (const id of ids) {
      if ([...heads.values()].some((h) => h && h.id === id)) {
        for (const [file, h] of heads) if (h && h.id === id) files.add(file);
        continue;
      }
      try {
        outer: for (const y of fs.readdirSync(root)) for (const m of fs.readdirSync(path.join(root, y))) for (const d of fs.readdirSync(path.join(root, y, m))) {
          const n = fs.readdirSync(path.join(root, y, m, d)).find((f) => f.endsWith(`${id}.jsonl`));
          if (n) {
            files.add(path.join(root, y, m, d, n));
            break outer;
          }
        }
      } catch {
        /* not found */
      }
    }
    const out = [];
    for (const file of files) {
      let st;
      try {
        st = fs.statSync(file);
      } catch {
        continue;
      }
      if (st.mtimeMs < since) continue;
      if (!heads.has(file)) {
        const meta = readFirstLine(file);
        const p = meta && meta.type === "session_meta" && meta.payload;
        // Sub-agent threads (reviewers, helpers) run inside another session.
        heads.set(file, p && !(p.source && typeof p.source === "object") ? { id: p.id, cwd: p.cwd, created: Date.parse(p.timestamp) } : null);
      }
      const h = heads.get(file);
      if (h) out.push({ ...h, file, mtime: st.mtimeMs });
    }
    return out;
  }

  function codexNames() {
    const names = new Map();
    try {
      for (const e of parseLines(fs.readFileSync(path.join(codexDir(), "session_index.jsonl"), "utf8"))) {
        if (e.id && e.thread_name) names.set(e.id, e.thread_name);
      }
    } catch {
      /* no index */
    }
    return names;
  }

  async function collect() {
    const records = claudeRecords();
    let procs = [];
    if (platform === "win32") {
      const reply = await request({ op: "scan", pids: records.map((r) => r.pid), names: ["codex"] });
      procs = (reply && Array.isArray(reply.procs) ? reply.procs : []).filter((p) => p && Number.isInteger(p.pid));
    }
    const byPid = new Map(procs.map((p) => [p.pid, p]));
    const sessions = [];
    for (const r of records) {
      // A record left behind by a crash, or a process id reused by another program, is not a session.
      const proc = byPid.get(r.pid);
      if (platform === "win32" ? !proc || (r.procStart && proc.start !== String(r.procStart)) : !processAlive(r.pid)) continue;
      const file = claudeTranscript(r);
      const state = (file && cachedState(file, claudeState)) || { limited: false };
      sessions.push({
        key: `claude:${r.sessionId}`, tool: "claude", pid: r.pid, start: proc ? proc.start : null,
        name: r.name || path.basename(r.cwd || "") || "Claude Code", cwd: r.cwd || "",
        state: state.limited && r.status !== "busy" ? "limited" : r.status === "busy" ? "working" : "idle",
        resets_at: state.limited ? state.resets_at : null, limit: state.limited ? state.limit : null,
        can_type: r.entrypoint === "cli", started: r.startedAt || null,
      });
    }
    const codexProcs = procs.filter((p) => /^codex$/i.test(p.name || "") && isCodexTui(p))
      .map((p) => ({ ...p, started: filetimeMs(p.start) })).filter((p) => Number.isFinite(p.started));
    if (codexProcs.length) {
      const ids = codexProcs.map((p) => /\bresume\s+([0-9a-f-]{36})\b/i.exec(p.cmd || "")?.[1]).filter(Boolean);
      const rollouts = codexRollouts(Math.min(...codexProcs.map((p) => p.started)) - 60_000, ids);
      const matched = matchCodex(codexProcs, rollouts, platform);
      const claimed = new Set([...matched.values()].map((r) => r.file));
      const names = codexNames();
      for (const p of codexProcs) {
        const r = matched.get(p.pid);
        const cwd = (r && r.cwd) || (p.cwd || "").replace(/[\\/]+$/, "");
        const base = { tool: "codex", pid: p.pid, start: p.start, cwd, limit: null, started: p.started };
        if (r) {
          const state = cachedState(r.file, codexState) || { limited: false, busy: false };
          sessions.push({ ...base, key: `codex:${r.id}`, name: names.get(r.id) || path.basename(cwd) || "Codex",
            state: state.limited ? "limited" : state.busy ? "working" : "idle",
            resets_at: state.limited ? state.resets_at : null, can_type: true });
          continue;
        }
        // Not linked to one rollout (for example two terminals opened together in one folder).
        // While a Codex limit is in effect its own screen decides: the limit message among its
        // newest lines means this terminal hit it.
        const spent = rollouts.filter((x) => !claimed.has(x.file) && sameFolder(x.cwd, p.cwd, platform) && x.mtime >= p.started)
          .map((x) => cachedState(x.file, codexState)).filter((st) => st && st.limited && Number.isFinite(st.resets_at));
        const resets = spent.length ? Math.max(...spent.map((st) => st.resets_at))
          : Number.isFinite(codexSpent) && now() < codexSpent + ORPHAN_WINDOW_MS ? codexSpent : null;
        let shown = false;
        if (resets != null && platform === "win32") {
          try {
            shown = !!(await request({ op: "peek", pid: p.pid, start: p.start, expect: LIMIT_ON_SCREEN, lines: ORPHAN_LINES }))?.shown;
          } catch {
            shown = false;
          }
        }
        sessions.push({ ...base, key: `codex:${p.pid}:${p.start}`, name: path.basename(cwd) || "Codex",
          state: shown ? "limited" : "idle", resets_at: shown ? resets : null, can_type: true, lines: ORPHAN_LINES });
      }
    }
    return sessions;
  }

  async function scan() {
    if (busy) return view;
    busy = true;
    try {
      const cfg = getConfig() || {};
      // The meters' latest used-up Codex window, for terminals not linked to a rollout.
      const meters = (snapshot()?.providers || []).find((p) => p.id === "codex" && p.status?.state === "ok");
      const spentAt = (meters?.windows || []).filter((w) => Number.isFinite(w.used_pct) && w.used_pct >= 100 && Date.parse(w.resets_at) > now())
        .map((w) => Date.parse(w.resets_at));
      if (spentAt.length) codexSpent = Math.max(...spentAt);
      let sessions;
      try {
        sessions = await collect();
      } catch (err) {
        console.error("session scan failed", err.message);
        return view;
      }
      const live = new Set();
      for (const s of sessions) {
        if (s.state !== "limited") continue;
        const id = `${s.key}@${s.resets_at}`;
        live.add(id);
        const ctx = { enabled: cfg.auto_resume === true, platform, now: now(), snapshot: snapshot() };
        s.resume = resumeStatus(s, attempts.get(id), ctx);
        // Only a session this scan saw idle at its limit, in a terminal that is still open, is typed into.
        if (s.resume !== "due" || !s.can_type) continue;
        const prev = attempts.get(id) || { count: 0, last: 0, sent: false };
        let result;
        try {
          result = await request({ op: "type", pid: s.pid, start: s.start, text, expect: LIMIT_ON_SCREEN, ...(s.lines ? { lines: s.lines } : {}) });
        } catch (err) {
          result = { ok: false, error: err.message };
        }
        const next = { count: prev.count + 1, last: now(), sent: !!(result && result.ok), error: result && result.error };
        attempts.set(id, next);
        s.resume = next.sent ? "sent" : next.count >= MAX_ATTEMPTS ? "failed" : "retrying";
        try {
          onResume(s, next);
        } catch {
          /* reporting only */
        }
      }
      for (const id of attempts.keys()) if (!live.has(id)) attempts.delete(id);
      view = {
        auto_resume: cfg.auto_resume === true,
        can_resume: platform === "win32",
        sessions: sessions
          .sort((a, b) => a.tool.localeCompare(b.tool) || (a.started || 0) - (b.started || 0))
          .map((s) => ({
            key: s.key, tool: s.tool, name: s.name, cwd: s.cwd, state: s.state, limit: s.limit,
            resets_at: Number.isFinite(s.resets_at) ? new Date(s.resets_at).toISOString() : null,
            resume_at: Number.isFinite(s.resets_at) ? new Date(s.resets_at + GRACE_MS).toISOString() : null,
            resume: s.resume || null,
          })),
      };
      onChange(view);
      return view;
    } finally {
      busy = false;
    }
  }

  return { scan, view: () => view };
}

function start(opts) {
  const watcher = createWatcher(opts);
  watcher.scan();
  const timer = setInterval(() => watcher.scan(), SCAN_MS);
  return {
    refresh: () => watcher.scan(),
    view: () => watcher.view(),
    stop() {
      clearInterval(timer);
      if (worker) {
        worker.stop();
        worker = null;
      }
    },
  };
}

module.exports = {
  start, createWatcher, claudeState, codexState, resumeStatus, matchCodex, isCodexTui, stillLimited,
  filetimeMs, clockAfter, readTail, GRACE_MS, MAX_ATTEMPTS, RETRY_MS, RESUME_TEXT, LIMIT_ON_SCREEN,
};
