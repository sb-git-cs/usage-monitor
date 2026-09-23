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

function writeJson(file, data) {
  fs.mkdirSync(cacheDir(), { recursive: true });
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: "utf8" });
  fs.renameSync(tmp, file);
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
  writeJson(snapshotCachePath(), snapshot);
}

function loadAlertState() {
  const state = readJson(alertStatePath());
  return state && state.fired && typeof state.fired === "object" && !Array.isArray(state.fired)
    ? state : { fired: {} };
}

function saveAlertState(state) {
  writeJson(alertStatePath(), state);
}

module.exports = { loadSnapshot, saveSnapshot, loadAlertState, saveAlertState };
