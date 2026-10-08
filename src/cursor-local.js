// Read-only lookups in Cursor's editor database. Values stay in memory; nothing here is logged.
const fs = require("fs");

function readValue(dbPath, key) {
  if (!dbPath || !key) return "";
  try {
    if (!fs.existsSync(dbPath)) return "";
  } catch {
    return "";
  }
  let db = null;
  try {
    const { DatabaseSync } = require("node:sqlite");
    db = new DatabaseSync(dbPath, { readOnly: true });
    const row = db.prepare("SELECT value FROM ItemTable WHERE key = ?").get(key);
    const value = row && row.value;
    if (typeof value === "string") return value;
    if (Buffer.isBuffer(value)) return value.toString("utf8");
    return "";
  } catch {
    return "";
  } finally {
    try {
      if (db) db.close();
    } catch {
      /* the value is already in hand */
    }
  }
}

module.exports = { readValue };
