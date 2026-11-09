const fs = require("node:fs");
const path = require("node:path");
const { devinDataDir } = require("../paths");
const { readRows } = require("../cursor-local");

// Devin CLI sessions from its own database; read again only when the file's size or time changed.
const COLUMNS = "id, working_directory, model, title, created_at, last_activity_at";
const cache = new Map();

function dbFile() {
  const dir = process.env.DEVIN_SESSIONS_DIR;
  return dir ? path.join(dir, "sessions.db") : path.join(devinDataDir(), "cli", "sessions.db");
}

// ISO text, milliseconds or seconds -> milliseconds.
function toMs(value) {
  if (typeof value === "string" && value && !/^\d+(\.\d+)?$/.test(value)) {
    const t = Date.parse(value);
    return Number.isFinite(t) ? t : null;
  }
  const n = Number(value);
  if (value == null || value === "" || !Number.isFinite(n) || n <= 0) return null;
  return n < 1e11 ? n * 1000 : n;
}

function rowsOf(file) {
  // A database without the hidden column has nothing to filter on.
  const hasHidden = readRows(file, "SELECT 1 FROM pragma_table_info('sessions') WHERE name = 'hidden'").length > 0;
  const where = hasHidden ? "WHERE hidden IS NULL OR hidden = 0 " : "";
  return readRows(file, `SELECT ${COLUMNS}${hasHidden ? ", hidden" : ""} FROM sessions ${where}ORDER BY last_activity_at DESC LIMIT 40`);
}

function read({ entry }) {
  try {
    const file = dbFile();
    let stat;
    try { stat = fs.statSync(file); } catch { return []; }
    const sig = `${stat.size}:${stat.mtimeMs}`;
    const hit = cache.get(file);
    if (hit && hit.sig === sig) return hit.rows;
    const rows = rowsOf(file).map((r) => entry("windsurf", "windsurf", "Devin CLI", {
      id: r.id == null ? null : String(r.id),
      name: r.title,
      cwd: r.working_directory,
      started: toMs(r.created_at),
      last_active: toMs(r.last_activity_at),
      model: r.model,
    })).filter(Boolean).sort((a, b) => b.last_active - a.last_active);
    cache.set(file, { sig, rows });
    return rows;
  } catch {
    return [];
  }
}

module.exports = { read };
