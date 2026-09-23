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
  let cwd = appRoot();
  let cmd = `"${exe}" "${cwd}"`;
  try {
    const { app } = require("electron");
    if (app.isPackaged) {
      const launchExe = process.env.PORTABLE_EXECUTABLE_FILE || exe;
      cwd = path.dirname(launchExe);
      cmd = `"${launchExe}"`;
    }
  } catch {
    /* unpackaged */
  }
  fs.mkdirSync(startupDir(), { recursive: true });
  const vbs = [
    'Set sh = CreateObject("Wscript.Shell")',
    `sh.CurrentDirectory = ${vbsStr(cwd)}`,
    `sh.Run ${vbsStr(cmd)}, 0, False`,
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
  return isEnabled();
}

function isEnabled() {
  try {
    return fs.existsSync(shortcutPath());
  } catch {
    return false;
  }
}

module.exports = { apply, isEnabled, shortcutPath, appRoot };
