const fs = require("fs");
const path = require("path");
const { kiroHome } = require("../paths");

// Kiro CLI 3.x keeps one folder per session: sessions/<workspace-hash>/sess_<id>/session.json.
// The 2.x rows in data.sqlite3 are skipped.
const PER_CLI = 40;
const cache = new Map();

function names(dir) {
  try { return fs.readdirSync(dir); } catch { return []; }
}

function ms(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || !value) return null;
  const n = /^\d+$/.test(value) ? Number(value) : Date.parse(value);
  return Number.isFinite(n) ? n : null;
}

function parse(file, stat) {
  const key = `${stat.size}:${stat.mtimeMs}`;
  const hit = cache.get(file);
  if (hit && hit.key === key) return hit.json;
  let json = null;
  try { json = JSON.parse(fs.readFileSync(file, "utf8")); } catch { json = null; }
  cache.set(file, { key, json });
  return json;
}

function read({ entry }) {
  const root = path.join(kiroHome(), "sessions");
  const rows = [];
  const seen = new Set();
  for (const hash of names(root)) {
    for (const dir of names(path.join(root, hash))) {
      const file = path.join(root, hash, dir, "session.json");
      try {
        const stat = fs.statSync(file);
        seen.add(file);
        const s = parse(file, stat);
        if (!s || typeof s !== "object") continue;
        const paths = Array.isArray(s.workspacePaths) ? s.workspacePaths : [];
        const row = entry("kiro", "kiro", "Kiro CLI", {
          id: s.id, name: s.title, cwd: typeof paths[0] === "string" ? paths[0] : "",
          started: ms(s.createdAt), last_active: ms(s.lastModifiedAt), model: s.modelId,
        });
        if (row) rows.push(row);
      } catch {
        /* a folder without a readable session.json is skipped */
      }
    }
  }
  for (const file of cache.keys()) if (!seen.has(file)) cache.delete(file);
  return rows.sort((a, b) => b.last_active - a.last_active).slice(0, PER_CLI);
}

module.exports = { read };
