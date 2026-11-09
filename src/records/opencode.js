// OpenCode (v2) keeps its sessions in SQLite. read({ entry, home, platform, now }) returns rows.
const path = require("path");
const fs = require("fs");
const { opencodeDataDir } = require("../paths");
const { readRows } = require("../cursor-local");

const SQL = "SELECT id, directory, title, model, time_created, time_updated FROM session_v2 " +
  "WHERE parent_id IS NULL AND time_archived IS NULL ORDER BY time_updated DESC LIMIT 40";
const cache = new Map();

function ms(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  // Values this small are seconds.
  return n < 1e11 ? n * 1000 : n;
}

function modelId(value) {
  try {
    const m = typeof value === "string" ? JSON.parse(value) : value;
    return m && typeof m.id === "string" ? m.id : null;
  } catch {
    return null;
  }
}

function read({ entry }) {
  const file = process.env.OPENCODE_DB || path.join(opencodeDataDir(), "opencode.db");
  let key;
  try {
    const st = fs.statSync(file);
    key = `${st.size}:${st.mtimeMs}`;
  } catch {
    cache.delete(file);
    return [];
  }
  const hit = cache.get(file);
  if (hit && hit.key === key) return hit.rows;
  const rows = readRows(file, SQL).map((r) => entry("opencode", "opencode", "OpenCode", {
    id: r.id,
    name: r.title,
    cwd: r.directory,
    started: ms(r.time_created),
    last_active: ms(r.time_updated),
    model: modelId(r.model),
  })).filter(Boolean);
  cache.set(file, { key, rows });
  return rows;
}

module.exports = { read };
