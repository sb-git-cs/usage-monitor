const fs = require("node:fs");
const path = require("node:path");
const { ampDataDir } = require("../paths");

// Threads are one JSON file each; only the first 256 KB is read, and a file is parsed again only
// when its size or time changed.
const HEAD = 256 * 1024;
const FILES = 40;
const cache = new Map(); // file -> { sig, value }

// T-*.json in the threads folder and one level of subfolders, newest first.
function threadFiles(dir) {
  const found = [];
  const scan = (folder, deep) => {
    let items = [];
    try { items = fs.readdirSync(folder, { withFileTypes: true }); } catch { return; }
    for (const d of items) {
      const file = path.join(folder, d.name);
      if (d.isDirectory() && deep) scan(file, false);
      else if (d.isFile() && /^T-.*\.json$/i.test(d.name)) {
        try { found.push({ file, st: fs.statSync(file) }); } catch { /* gone */ }
      }
    }
  };
  scan(dir, true);
  return found.sort((a, b) => b.st.mtimeMs - a.st.mtimeMs).slice(0, FILES);
}

function head(file) {
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(Math.min(fs.fstatSync(fd).size, HEAD));
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, n).toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

function ms(value) {
  const n = typeof value === "string" ? (/^\d+$/.test(value) ? Number(value) : Date.parse(value)) : value;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

function firstText(message) {
  const c = message && message.content;
  if (typeof c === "string") return c;
  for (const part of Array.isArray(c) ? c : []) {
    if (part && typeof part.text === "string" && part.text.trim()) return part.text;
  }
  return "";
}

// A thread cut off at the cap cannot be parsed whole; its start time and folder come before the messages.
function fields(text) {
  try {
    return JSON.parse(text);
  } catch { /* cut off */ }
  const created = /"created"\s*:\s*(\d+)/.exec(text);
  const uri = /"uri"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(text);
  if (!created && !uri) return null;
  let folder;
  try { folder = uri && JSON.parse(`"${uri[1]}"`); } catch { folder = undefined; }
  return { created: created ? Number(created[1]) : undefined, env: { initial: { trees: folder ? [{ uri: folder }] : [] } } };
}

function summary(file) {
  const t = fields(head(file));
  if (!t || typeof t !== "object") throw new Error("not a thread");
  const messages = Array.isArray(t.messages) ? t.messages : [];
  let model = null;
  let latest = null;
  for (const m of messages) {
    const usage = m && m.usage;
    if (usage && typeof usage.model === "string" && usage.model) model = usage.model;
    const at = ms(usage && usage.timestamp) ?? ms(m && m.meta && m.meta.sentAt);
    if (at != null && (latest == null || at > latest)) latest = at;
  }
  const user = messages.find((m) => m && m.role === "user" && firstText(m).trim());
  const tree = t.env && t.env.initial && Array.isArray(t.env.initial.trees) ? t.env.initial.trees[0] : null;
  return {
    id: typeof t.id === "string" && t.id ? t.id : path.basename(file, ".json"),
    name: user ? firstText(user).trim().split(/\r?\n/)[0] : "",
    uri: tree && tree.uri,
    started: ms(t.created),
    latest,
    model,
  };
}

function read({ entry, platform }) {
  const { fromFileUri } = require("../session-records"); // loaded late: that module requires this one
  const out = [];
  const seen = new Set();
  for (const { file, st } of threadFiles(path.join(ampDataDir(), "threads"))) {
    seen.add(file);
    const sig = `${st.size}:${st.mtimeMs}`;
    let hit = cache.get(file);
    if (!hit || hit.sig !== sig) {
      let value = null;
      try { value = summary(file); } catch { /* unreadable thread */ }
      hit = { sig, value };
      cache.set(file, hit);
    }
    const v = hit.value;
    if (!v) continue;
    out.push(entry("amp", "amp", "Amp", {
      id: v.id, name: v.name, cwd: fromFileUri(v.uri, platform), started: v.started,
      last_active: v.latest ?? st.mtimeMs, model: v.model,
    }));
  }
  for (const file of cache.keys()) if (!seen.has(file)) cache.delete(file);
  return out;
}

module.exports = { read };
