const fs = require("fs");
const path = require("path");

function appRoot() {
  return path.resolve(__dirname, "..");
}

function electronExe() {
  return process.execPath;
}

function startupDir() {
  return path.join(
    process.env.APPDATA || "",
    "Microsoft",
    "Windows",
    "Start Menu",
    "Programs",
    "Startup"
  );
}

function shortcutPath() {
  return path.join(startupDir(), "Usage Monitor.vbs");
}

function oldShortcutPath() {
  return path.join(startupDir(), "Usage Monitor.lnk");
}

function writeShortcut() {
  const exe = electronExe();
  const root = appRoot();
  fs.mkdirSync(startupDir(), { recursive: true });
  const vbs = [
    'Set sh = CreateObject("Wscript.Shell")',
    `sh.CurrentDirectory = ${vbsStr(root)}`,
    `sh.Run ${vbsStr(`"${exe}" "${root}"`)}, 0, False`,
    "",
  ].join("\r\n");
  fs.writeFileSync(shortcutPath(), vbs, "utf8");
  try {
    if (fs.existsSync(oldShortcutPath())) fs.unlinkSync(oldShortcutPath());
  } catch {
    /* ignore */
  }
}

function vbsStr(value) {
  return '"' + String(value).replace(/"/g, '""') + '"';
}

function removeShortcut() {
  try {
    if (fs.existsSync(shortcutPath())) fs.unlinkSync(shortcutPath());
  } catch {
    /* ignore */
  }
  try {
    if (fs.existsSync(oldShortcutPath())) fs.unlinkSync(oldShortcutPath());
  } catch {
    /* ignore */
  }
}

function apply(enabled) {
  try {
    const { app } = require("electron");
    app.setLoginItemSettings({ openAtLogin: false });
  } catch {
    /* ignore */
  }
  if (process.platform !== "win32") return enabled;
  try {
    if (enabled) writeShortcut();
    else removeShortcut();
  } catch (err) {
    console.error("startup shortcut failed", err.message);
  }
  return !!enabled;
}

function isEnabled() {
  try {
    return fs.existsSync(shortcutPath());
  } catch {
    return false;
  }
}

module.exports = { apply, isEnabled, shortcutPath, appRoot };
