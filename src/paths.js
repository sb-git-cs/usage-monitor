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

// Cursor Agent (the CLI) keeps its chats here; the editor's files are under cursorDir().
function cursorCliDir() {
  return process.env.CURSOR_CONFIG_DIR || path.join(home(), ".cursor");
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

function cursorDir() {
  return path.join(appData(), "Cursor");
}

function cursorAuth() {
  if (process.platform === "win32") return path.join(cursorDir(), "auth.json");
  if (process.platform === "darwin") return path.join(home(), ".cursor", "auth.json");
  const config = process.env.XDG_CONFIG_HOME || path.join(home(), ".config");
  return path.join(config, "cursor", "auth.json");
}

function cursorStateDb() {
  return path.join(cursorDir(), "User", "globalStorage", "state.vscdb");
}

// Devin CLI: settings under the config dir, sign-in and sessions under the data dir.
function devinConfigDir() {
  if (process.platform === "win32") return path.join(appData(), "devin");
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home(), ".config"), "devin");
}

function devinDataDir() {
  if (process.platform === "win32") return path.join(appData(), "devin");
  return path.join(home(), ".local", "share", "devin");
}

// Windsurf was renamed Devin Desktop; the editor keeps its state in whichever folder the install used.
function devinStateDbs() {
  return ["Devin", "Windsurf", "Windsurf - Next"].map((name) =>
    path.join(editorUserData(), name, "User", "globalStorage", "state.vscdb")
  );
}

function editorUserData() {
  if (process.platform === "win32") return process.env.APPDATA || path.join(home(), "AppData", "Roaming");
  if (process.platform === "darwin") return path.join(home(), "Library", "Application Support");
  return process.env.XDG_CONFIG_HOME || path.join(home(), ".config");
}

function kiroHome() {
  return process.env.KIRO_HOME || path.join(home(), ".kiro");
}

// Where the Windows build keeps data.sqlite3 is unconfirmed, so every likely folder is offered.
function kiroDataDirs() {
  if (process.platform === "win32") {
    return [
      path.join(localAppData(), "kiro-cli"),
      path.join(appData(), "kiro-cli"),
      path.join(home(), ".local", "share", "kiro-cli"),
    ];
  }
  if (process.platform === "darwin") return [path.join(home(), "Library", "Application Support", "kiro-cli")];
  return [path.join(process.env.XDG_DATA_HOME || path.join(home(), ".local", "share"), "kiro-cli")];
}

function awsSsoCache() {
  return path.join(home(), ".aws", "sso", "cache");
}

// Amp uses XDG-style folders on every platform, Windows included.
function ampDataDir() {
  if (process.env.AMP_DATA_HOME) return process.env.AMP_DATA_HOME;
  const base = process.env.XDG_DATA_HOME || path.join(home(), ".local", "share");
  return path.join(base, "amp");
}

function ampHome() {
  return process.env.AMP_HOME || path.join(home(), ".amp");
}

function opencodeDataDir() {
  const base = process.env.XDG_DATA_HOME || path.join(home(), ".local", "share");
  return path.join(base, "opencode");
}

function qwenHome() {
  return process.env.QWEN_HOME || path.join(home(), ".qwen");
}

function kimiCodeHome() {
  return process.env.KIMI_CODE_HOME || path.join(home(), ".kimi-code");
}

function ghHosts() {
  const files = [path.join(home(), ".config", "gh", "hosts.yml")];
  if (process.platform === "win32") files.push(path.join(appData(), "GitHub CLI", "hosts.yml"));
  if (process.platform === "darwin") files.push(path.join(home(), "Library", "Application Support", "GitHub CLI", "hosts.yml"));
  return files;
}

function agyBinaryCandidates() {
  const local = localAppData();
  return [
    path.join(local, "agy", "bin", process.platform === "win32" ? "agy.exe" : "agy"),
    path.join(local, "agy", "bin", "agy"),
  ];
}

// Windows keeps its original folders; macOS and Linux use their platform conventions.
function appData() {
  if (process.platform === "win32") return process.env.APPDATA || path.join(home(), "AppData", "Roaming");
  if (process.platform === "darwin") return path.join(home(), "Library", "Application Support");
  return process.env.XDG_CONFIG_HOME || path.join(home(), ".config");
}

function localAppData() {
  if (process.platform === "win32") return process.env.LOCALAPPDATA || path.join(home(), "AppData", "Local");
  if (process.platform === "darwin") return path.join(home(), "Library", "Application Support");
  return process.env.XDG_DATA_HOME || path.join(home(), ".local", "share");
}

function netDataDir() {
  return path.join(localAppData(), "UsageMonitor");
}

function configDir() {
  return path.join(appData(), "UsageMonitor");
}

function cacheDir() {
  return path.join(localAppData(), "UsageMonitor", "cache");
}

function logDir() {
  return path.join(localAppData(), "UsageMonitor", "logs");
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

// Replaces a CLI's credential file after a token refresh. The CLIs keep these owner-only
// (0600); a plain write would leave the new tokens readable by other users on macOS and Linux.
// A leftover .tmp keeps its old mode on write, so the mode is set explicitly as well.
function writeSecretFile(file, text) {
  const tmp = `${file}.tmp`;
  try {
    fs.writeFileSync(tmp, text, { encoding: "utf8", mode: 0o600 });
    if (process.platform !== "win32") fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, file);
  } catch (err) {
    // A failed replace must not leave the new tokens behind in a stray file.
    try { fs.unlinkSync(tmp); } catch { /* never written */ }
    throw err;
  }
}

module.exports = {
  cursorCliDir,
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
  cursorDir,
  cursorAuth,
  cursorStateDb,
  devinConfigDir,
  devinDataDir,
  devinStateDbs,
  kiroHome,
  kiroDataDirs,
  awsSsoCache,
  ampDataDir,
  ampHome,
  opencodeDataDir,
  qwenHome,
  kimiCodeHome,
  ghHosts,
  agyBinaryCandidates,
  localAppData,
  netDataDir,
  configDir,
  cacheDir,
  logDir,
  configPath,
  snapshotCachePath,
  alertStatePath,
  cliPath,
  cliOnPath,
  fileExists,
  writeSecretFile,
};
