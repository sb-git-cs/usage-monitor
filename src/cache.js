const fs = require("fs");
const { cacheDir, snapshotCachePath, alertStatePath } = require("./paths");
const { PROVIDERS, windowOf } = require("./models");

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

// Polls run every few seconds; a file is rewritten only when its content changed, and the
// snapshot (whose timestamps change on every poll) at most once a minute while the readings
// themselves stay the same.
const SNAPSHOT_MIN_GAP_MS = 60_000;
const written = new Map();

function writeJson(file, data, { sig = null, minGapMs = 0 } = {}) {
  const text = JSON.stringify(data, null, 2);
  const prev = written.get(file);
  const now = Date.now();
  if (prev && (prev.text === text || (sig != null && prev.sig === sig && now - prev.at < minGapMs))) return false;
  fs.mkdirSync(cacheDir(), { recursive: true });
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, text, { encoding: "utf8" });
  fs.renameSync(tmp, file);
  written.set(file, { text, sig, at: now });
  return true;
}

function snapshotSig(snapshot) {
  return JSON.stringify((snapshot.providers || []).map((p) => [p.id, p.status && p.status.state, p.plan, p.windows]));
}

function loadSnapshot() {
  const data = readJson(snapshotCachePath());
  if (!data || !Array.isArray(data.providers)) return null;
  const providers = data.providers.filter((p) => p && PROVIDERS.some((known) => known.id === p.id) &&
    Array.isArray(p.windows) && p.status && typeof p.status.state === "string" &&
    Number.isFinite(Date.parse(p.fetched_at))).map((p) => ({ ...p, windows: p.windows
      .filter((w) => w && typeof w.kind === "string" && typeof w.label === "string")
      .map((w) => windowOf({ kind: w.kind, label: w.label, usedPct: w.used_pct, resetsAt: w.resets_at })) }));
  return providers.length ? { ...data, providers } : null;
}

function saveSnapshot(snapshot) {
  return writeJson(snapshotCachePath(), snapshot, { sig: snapshotSig(snapshot), minGapMs: SNAPSHOT_MIN_GAP_MS });
}

function loadAlertState() {
  const state = readJson(alertStatePath());
  return state && state.fired && typeof state.fired === "object" && !Array.isArray(state.fired)
    ? state : { fired: {} };
}

function saveAlertState(state) {
  return writeJson(alertStatePath(), state);
}

module.exports = { loadSnapshot, saveSnapshot, loadAlertState, saveAlertState };
