const fs = require("fs");
const { cacheDir, snapshotCachePath, alertStatePath } = require("./paths");

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
  return readJson(snapshotCachePath());
}

function saveSnapshot(snapshot) {
  writeJson(snapshotCachePath(), snapshot);
}

function loadAlertState() {
  return readJson(alertStatePath()) || { fired: {} };
}

function saveAlertState(state) {
  writeJson(alertStatePath(), state);
}

module.exports = { loadSnapshot, saveSnapshot, loadAlertState, saveAlertState };
