const os = require("os");
const path = require("path");
const fs = require("fs");

function home() {
  return process.env.USERPROFILE || os.homedir();
}

function claudeConfigDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(home(), ".claude");
}

function claudeCredentials() {
  return path.join(claudeConfigDir(), ".credentials.json");
}

function codexHome() {
  return process.env.CODEX_HOME || path.join(home(), ".codex");
}

function codexAuth() {
  return path.join(codexHome(), "auth.json");
}

function grokHome() {
  return process.env.GROK_HOME || path.join(home(), ".grok");
}

function grokAuth() {
  return path.join(grokHome(), "auth.json");
}

function geminiHome() {
  return process.env.GEMINI_HOME || path.join(home(), ".gemini");
}

function geminiOAuth() {
  return path.join(geminiHome(), "oauth_creds.json");
}

function antigravityToken() {
  return path.join(geminiHome(), "antigravity-cli", "antigravity-oauth-token");
}

function agyBinaryCandidates() {
  const local = localAppData();
  return [
    path.join(local, "agy", "bin", process.platform === "win32" ? "agy.exe" : "agy"),
    path.join(local, "agy", "bin", "agy"),
  ];
}

function appData() {
  return process.env.APPDATA || path.join(home(), "AppData", "Roaming");
}

function localAppData() {
  return process.env.LOCALAPPDATA || path.join(home(), "AppData", "Local");
}

function configDir() {
  return path.join(appData(), "UsageMonitor");
}

function cacheDir() {
  return path.join(localAppData(), "UsageMonitor", "cache");
}

function configPath() {
  return path.join(configDir(), "config.json");
}

function snapshotCachePath() {
  return path.join(cacheDir(), "snapshot.json");
}

function alertStatePath() {
  return path.join(cacheDir(), "alert-state.json");
}

function cliPath(name) {
  const exts = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  const dirs = (process.env.PATH || "").split(path.delimiter);
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      try {
        if (fs.existsSync(candidate)) return candidate;
      } catch {
        /* ignore */
      }
    }
  }
  return null;
}

function cliOnPath(name) {
  return !!cliPath(name);
}

function fileExists(p) {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

module.exports = {
  home,
  claudeConfigDir,
  claudeCredentials,
  codexHome,
  codexAuth,
  grokHome,
  grokAuth,
  geminiHome,
  geminiOAuth,
  antigravityToken,
  agyBinaryCandidates,
  localAppData,
  configDir,
  cacheDir,
  configPath,
  snapshotCachePath,
  alertStatePath,
  cliPath,
  cliOnPath,
  fileExists,
};
