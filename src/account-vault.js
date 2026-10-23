// Saved sign-ins per tool, so a different account can be activated without signing in again.
// Each entry is a copy of that tool's credential file(s) for one account. The copies are
// encrypted with the OS keychain (Electron safeStorage) when it is available, and are owner-only
// on disk either way. Tokens never leave this module except to be written back to the tool's
// own files when that account is activated. Grok keeps every login in one file and gh keeps its
// own list, so neither needs copies here.
const fs = require("fs");
const path = require("path");
const { createHash } = require("crypto");
const paths = require("./paths");

const TOOLS = ["claude", "codex", "gemini", "cursor"];
const ACCOUNT_ID = /^[A-Za-z0-9_.:@-]{1,200}$/;
const MAX_PER_TOOL = 8;
const MAX_FILE = 256 * 1024;

let codec = null;
let store = null;

function file() {
  return path.join(paths.configDir(), "accounts.json");
}

// Encryption is optional: without it the copies are as protected as the CLI's own files.
function init(options = {}) {
  const available = typeof options.encrypt === "function" && typeof options.decrypt === "function" && options.available !== false;
  codec = available ? { name: "keychain", encrypt: options.encrypt, decrypt: options.decrypt } : { name: "plain", encrypt: (t) => t, decrypt: (t) => t };
  store = null;
}

function ensureCodec() {
  if (!codec) init();
}

function load() {
  if (store) return store;
  ensureCodec();
  let parsed = null;
  try {
    parsed = JSON.parse(fs.readFileSync(file(), "utf8"));
  } catch {
    parsed = null;
  }
  const tools = parsed && typeof parsed === "object" && parsed.tools && typeof parsed.tools === "object" ? parsed.tools : {};
  store = { codec: codec.name, tools: {} };
  for (const tool of TOOLS) {
    const rows = Array.isArray(tools[tool]) ? tools[tool] : [];
    store.tools[tool] = rows.filter((row) => row && ACCOUNT_ID.test(String(row.id || "")) && typeof row.payload === "string")
      .map((row) => ({
        id: String(row.id),
        label: clean(row.label) || String(row.id),
        detail: clean(row.detail) || null,
        saved_at: Number.isFinite(row.saved_at) ? row.saved_at : 0,
        hash: typeof row.hash === "string" ? row.hash : "",
        // Copies written by a different codec cannot be read: they are dropped on the next save.
        payload: parsed && parsed.codec === codec.name ? row.payload : null,
      }))
      .filter((row) => row.payload !== null)
      .slice(0, MAX_PER_TOOL);
  }
  return store;
}

function save() {
  const data = load();
  const dir = path.dirname(file());
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* exists */
  }
  paths.writeSecretFile(file(), JSON.stringify({ version: 1, codec: data.codec, tools: data.tools }));
}

function clean(value) {
  const text = String(value || "").replace(/[\u0000-\u001f]/g, "").trim();
  return text.length > 80 ? text.slice(0, 80) : text;
}

function readText(target) {
  try {
    const stat = fs.statSync(target);
    if (!stat.isFile() || stat.size > MAX_FILE) return null;
    return fs.readFileSync(target, "utf8");
  } catch {
    return null;
  }
}

// What makes up each tool's sign-in. Claude's global config holds the account beside unrelated
// settings, so only its oauthAccount block is kept and put back.
function sources(tool) {
  switch (tool) {
    case "claude": return [paths.claudeCredentials()];
    case "codex": return [paths.codexAuth()];
    case "gemini": return [paths.antigravityToken(), paths.geminiOAuth()];
    case "cursor": {
      const files = [];
      try { files.push(paths.cursorAuth()); } catch { /* platform path */ }
      try {
        const ide = path.join(path.dirname(path.dirname(path.dirname(paths.cursorStateDb()))), "auth.json");
        if (!files.includes(ide)) files.push(ide);
      } catch { /* platform path */ }
      return files;
    }
    default: return [];
  }
}

function claudeConfig() {
  return path.join(paths.home(), ".claude.json");
}

// The current sign-in of a tool as the files that hold it; null when none is on disk.
function snapshot(tool) {
  const files = [];
  for (const target of sources(tool)) {
    const text = readText(target);
    if (text != null) files.push({ path: target, text });
  }
  if (!files.length) return null;
  const extra = {};
  if (tool === "claude") {
    try {
      const acct = JSON.parse(readText(claudeConfig()) || "{}").oauthAccount;
      if (acct && typeof acct === "object") extra.claude_account = acct;
    } catch {
      /* no account block */
    }
  }
  return { files, ...extra };
}

function hashOf(snap) {
  return createHash("sha256").update(JSON.stringify(snap)).digest("hex").slice(0, 32);
}

function encode(snap) {
  const out = codec.encrypt(JSON.stringify(snap));
  return Buffer.isBuffer(out) ? out.toString("base64") : Buffer.from(String(out), "utf8").toString("base64");
}

function decode(payload) {
  const buf = Buffer.from(payload, "base64");
  const text = codec.name === "keychain" ? codec.decrypt(buf) : buf.toString("utf8");
  return JSON.parse(String(text));
}

// Saves (or refreshes) the tool's current sign-in under the given account. Nothing is written
// when the copy already matches, so an unchanged login never rewrites the vault.
function capture(tool, identity) {
  if (!TOOLS.includes(tool) || !identity || !ACCOUNT_ID.test(String(identity.id || ""))) return false;
  const snap = snapshot(tool);
  if (!snap) return false;
  const data = load();
  const rows = data.tools[tool];
  const hash = hashOf(snap);
  const id = String(identity.id);
  const existing = rows.find((row) => row.id === id);
  if (existing && existing.hash === hash) {
    const label = clean(identity.label) || existing.label;
    const detail = clean(identity.detail) || null;
    if (label === existing.label && detail === existing.detail) return false;
    existing.label = label;
    existing.detail = detail;
    save();
    return true;
  }
  const row = {
    id,
    label: clean(identity.label) || (existing && existing.label) || id,
    detail: clean(identity.detail) || null,
    saved_at: Date.now(),
    hash,
    payload: encode(snap),
  };
  if (existing) rows.splice(rows.indexOf(existing), 1, row);
  else rows.unshift(row);
  if (rows.length > MAX_PER_TOOL) rows.length = MAX_PER_TOOL;
  save();
  return true;
}

function list(tool) {
  if (!TOOLS.includes(tool)) return [];
  return load().tools[tool].map((row) => ({ id: row.id, label: row.label, detail: row.detail, saved_at: row.saved_at }));
}

function has(tool, id) {
  return TOOLS.includes(tool) && ACCOUNT_ID.test(String(id || "")) && load().tools[tool].some((row) => row.id === id);
}

function forget(tool, id) {
  if (!has(tool, id)) return false;
  const rows = load().tools[tool];
  rows.splice(rows.findIndex((row) => row.id === id), 1);
  save();
  return true;
}

// Puts a saved sign-in back as the tool's current one. The sign-in that was current is kept
// (captured by the caller) so the switch can be undone the same way.
function activate(tool, id) {
  if (!has(tool, id)) return { ok: false, error: "That account is not saved on this computer." };
  const row = load().tools[tool].find((item) => item.id === id);
  let snap;
  try {
    snap = decode(row.payload);
  } catch {
    return { ok: false, error: "The saved sign-in could not be read on this computer. Sign in again to save it." };
  }
  if (!snap || !Array.isArray(snap.files) || !snap.files.length) return { ok: false, error: "The saved sign-in is empty." };
  const allowed = new Set(sources(tool));
  try {
    for (const entry of snap.files) {
      if (!allowed.has(entry.path) || typeof entry.text !== "string") continue;
      fs.mkdirSync(path.dirname(entry.path), { recursive: true });
      paths.writeSecretFile(entry.path, entry.text);
    }
    if (tool === "claude" && snap.claude_account && typeof snap.claude_account === "object") {
      const target = claudeConfig();
      let config = {};
      try {
        config = JSON.parse(readText(target) || "{}");
      } catch {
        config = {};
      }
      if (config && typeof config === "object") {
        config.oauthAccount = snap.claude_account;
        const tmp = `${target}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(config, null, 2), "utf8");
        fs.renameSync(tmp, target);
      }
    }
  } catch (err) {
    return { ok: false, error: `Couldn't write the sign-in: ${err && err.message ? err.message : err}` };
  }
  return { ok: true };
}

module.exports = { init, capture, list, has, forget, activate, TOOLS };
