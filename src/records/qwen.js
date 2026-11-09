const fs = require("node:fs");
const path = require("node:path");
const { qwenHome } = require("../paths");

// Qwen Code chats: <home>/projects/<sanitized cwd>/chats/<sessionId>.jsonl. Only the first and
// last 64 KB of the newest files are read, and a file is parsed again only when it changed.

const FILES = 40;
const EDGE = 64 * 1024;
const cache = new Map(); // file -> { sig, value }

function list(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

function lines(text, dropFirst, dropLast) {
  const rows = text.split("\n");
  // A slice cut out of a file starts or ends in the middle of a line.
  if (dropFirst) rows.shift();
  if (dropLast) rows.pop();
  const out = [];
  for (const row of rows) {
    if (!row.trim()) continue;
    try {
      const j = JSON.parse(row);
      if (j && typeof j === "object") out.push(j);
    } catch {
      /* partial or foreign line */
    }
  }
  return out;
}

function readEdges(file, size) {
  const fd = fs.openSync(file, "r");
  try {
    const part = (start, len) => {
      const buf = Buffer.alloc(len);
      const n = fs.readSync(fd, buf, 0, len, start);
      return buf.subarray(0, n).toString("utf8");
    };
    const head = lines(part(0, Math.min(size, EDGE)), false, size > EDGE);
    const tail = size > EDGE ? lines(part(size - EDGE, EDGE), true, false) : head;
    return { head, tail };
  } finally {
    fs.closeSync(fd);
  }
}

function ms(value) {
  const n = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(n) ? n : null;
}

// The message may be a string or a list of parts that carry text.
function textOf(message) {
  if (typeof message === "string") return message;
  if (message && typeof message === "object" && !Array.isArray(message)) return textOf(message.parts || message.content || message.text);
  if (!Array.isArray(message)) return "";
  return message.map((p) => (typeof p === "string" ? p : p && typeof p.text === "string" ? p.text : "")).filter(Boolean).join("\n");
}

function summarize(file, size) {
  const { head, tail } = readEdges(file, size);
  const firstOf = (key) => head.find((r) => typeof r[key] === "string" && r[key])?.[key];
  const user = head.find((r) => r.type === "user" && textOf(r.message).trim());
  let last = null;
  for (const r of tail) {
    const at = ms(r.timestamp);
    if (at != null && (last == null || at > last)) last = at;
  }
  let model = null;
  for (let i = tail.length - 1; i >= 0 && !model; i--) {
    if (tail[i].type === "assistant" && typeof tail[i].model === "string" && tail[i].model) model = tail[i].model;
  }
  return {
    id: firstOf("sessionId"),
    cwd: firstOf("cwd") || "",
    started: head.map((r) => ms(r.timestamp)).find((t) => t != null) ?? null,
    last,
    model,
    name: user ? textOf(user.message).trim().split(/\r?\n/)[0] : "",
  };
}

function read({ entry }) {
  try {
    const root = path.join(qwenHome(), "projects");
    const files = [];
    for (const dir of list(root)) {
      const chats = path.join(root, dir, "chats");
      for (const n of list(chats)) {
        // Sidecars such as .runtime.json sit beside the chats.
        if (!n.endsWith(".jsonl")) continue;
        try {
          const file = path.join(chats, n);
          const st = fs.statSync(file);
          if (st.isFile()) files.push({ file, dir, size: st.size, mtime: st.mtimeMs });
        } catch {
          /* gone since it was listed */
        }
      }
    }
    files.sort((a, b) => b.mtime - a.mtime);
    const seen = new Set();
    const out = [];
    for (const f of files.slice(0, FILES)) {
      seen.add(f.file);
      const sig = `${f.size}:${f.mtime}`;
      let hit = cache.get(f.file);
      if (!hit || hit.sig !== sig) {
        let value = null;
        try {
          value = summarize(f.file, f.size);
        } catch {
          value = null;
        }
        hit = { sig, value };
        cache.set(f.file, hit);
      }
      const s = hit.value;
      if (!s) continue;
      out.push(entry("qwen", "qwen", "Qwen Code", {
        id: s.id || path.basename(f.file, ".jsonl"),
        // Without a prompt or a recorded folder, the project folder's name stands in.
        name: s.name || (s.cwd ? "" : f.dir),
        cwd: s.cwd,
        started: s.started,
        last_active: s.last ?? f.mtime,
        model: s.model,
      }));
    }
    for (const key of cache.keys()) if (!seen.has(key)) cache.delete(key);
    return out.filter(Boolean);
  } catch {
    return [];
  }
}

module.exports = { read };
