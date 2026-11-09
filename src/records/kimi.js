const fs = require("node:fs");
const path = require("node:path");

const TAIL = 64 * 1024;
// Per file, keyed by path: { stamp: "size:mtime", value }. A re-read of an unchanged file is free.
const cache = new Map();

function cached(file, parse) {
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    cache.delete(file);
    return undefined;
  }
  const stamp = `${st.size}:${st.mtimeMs}`;
  const hit = cache.get(file);
  if (hit && hit.stamp === stamp) return hit.value;
  let value;
  try {
    value = parse(file, st);
  } catch {
    value = undefined;
  }
  cache.set(file, { stamp, value });
  return value;
}

// Milliseconds from an ISO string, or from a number or digit string in seconds or milliseconds.
function ms(value) {
  const digits = typeof value === "string" && /^\d+$/.test(value);
  const n = typeof value === "number" ? value : digits ? Number(value) : typeof value === "string" ? Date.parse(value) : NaN;
  if (!Number.isFinite(n)) return null;
  return (typeof value === "number" || digits) && n < 1e12 ? n * 1000 : n;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

// The model named by the newest record of the file's last 64 KB that names one.
function wireModel(file, st) {
  const fd = fs.openSync(file, "r");
  let text;
  try {
    const len = Math.min(st.size, TAIL);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, st.size - len);
    text = buf.toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
  const lines = text.split("\n");
  // The first line may be cut by the tail.
  if (st.size > TAIL) lines.shift();
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes("model")) continue;
    let rec;
    try {
      rec = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    for (const v of [rec && rec.model, rec && rec.metadata && rec.metadata.model, rec && rec.generation_model]) {
      if (typeof v === "string" && v) return v;
    }
  }
  return null;
}

function indexRows(file) {
  return cached(file, () => {
    const rows = [];
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line);
        if (e && typeof e.sessionId === "string" && typeof e.sessionDir === "string") rows.push(e);
      } catch {
        /* partial or foreign line */
      }
    }
    return rows;
  }) || [];
}

function read({ entry, home }) {
  const base = typeof home === "function" ? home() : home;
  const root = process.env.KIMI_CODE_HOME || path.join(String(base || ""), ".kimi-code");
  const out = [];
  for (const row of indexRows(path.join(root, "session_index.jsonl"))) {
    try {
      const dir = path.isAbsolute(row.sessionDir) ? row.sessionDir : path.join(root, row.sessionDir);
      const stateFile = path.join(dir, "state.json");
      const stat = fs.statSync(stateFile);
      const state = cached(stateFile, readJson) || {};
      const model = cached(path.join(dir, "agents", "main", "wire.jsonl"), wireModel) || null;
      const times = ["updatedAt", "updated_at", "lastActiveAt", "lastActive", "last_active"].map((k) => ms(state[k])).filter((v) => v != null);
      const started = ["createdAt", "created_at", "startedAt", "started"].map((k) => ms(state[k])).find((v) => v != null) ?? null;
      const item = entry("kimi", "kimi", "Kimi Code", {
        id: row.sessionId,
        name: state.title || state.lastPrompt,
        cwd: row.workDir,
        started,
        last_active: Math.max(stat.mtimeMs, ...times),
        model,
      });
      if (item) out.push(item);
    } catch {
      /* a missing or unreadable session folder is skipped */
    }
  }
  return out;
}

module.exports = { read };
