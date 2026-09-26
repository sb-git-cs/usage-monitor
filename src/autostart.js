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

function linuxEntryPath() {
  const base = process.env.XDG_CONFIG_HOME || path.join(require("os").homedir(), ".config");
  return path.join(base, "autostart", "usage-monitor.desktop");
}

// Desktop Entry Exec quoting: wrap in double quotes and escape ", `, $ and \.
function desktopArg(value) {
  return `"${String(value).replace(/(["`$\\])/g, "\\$1")}"`;
}

function writeLinuxEntry() {
  const { app } = require("electron");
  const exec = app.isPackaged
    ? desktopArg(process.env.APPIMAGE || process.execPath)
    : `${desktopArg(process.execPath)} ${desktopArg(appRoot())}`;
  const file = linuxEntryPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    ["[Desktop Entry]", "Type=Application", "Name=Usage Monitor", "Comment=Plan and network usage monitor", `Exec=${exec}`, "Terminal=false", "X-GNOME-Autostart-enabled=true", ""].join("\n"),
    "utf8"
  );
}

function apply(enabled) {
  try {
    if (process.platform === "win32") {
      const { app } = require("electron");
      app.setLoginItemSettings({ openAtLogin: false });
      if (enabled) writeShortcut();
      else removeShortcut();
    } else if (process.platform === "darwin") {
      const { app } = require("electron");
      // An unpackaged checkout would register the bare Electron app, so only packaged builds opt in.
      app.setLoginItemSettings({ openAtLogin: !!enabled && app.isPackaged, openAsHidden: true });
    } else if (process.platform === "linux") {
      if (enabled) writeLinuxEntry();
      else fs.rmSync(linuxEntryPath(), { force: true });
    }
  } catch (err) {
    console.error("login item update failed", err.message);
  }
  return isEnabled();
}

function isEnabled() {
  try {
    if (process.platform === "win32") return fs.existsSync(shortcutPath());
    if (process.platform === "darwin") return require("electron").app.getLoginItemSettings().openAtLogin;
    if (process.platform === "linux") return fs.existsSync(linuxEntryPath());
  } catch {
    /* fall through */
  }
  return false;
}

module.exports = { apply, isEnabled, shortcutPath, appRoot, desktopArg };
