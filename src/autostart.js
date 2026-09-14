const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { app } = require("electron");

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
  return path.join(startupDir(), "Usage Monitor.lnk");
}

function psQuote(value) {
  return "'" + String(value).replace(/'/g, "''") + "'";
}

function writeShortcut() {
  const lnk = shortcutPath();
  const exe = electronExe();
  const root = appRoot();
  fs.mkdirSync(startupDir(), { recursive: true });
  const script = path.join(app.getPath("temp"), "usage-monitor-autostart.ps1");
  const body = [
    "$ws = New-Object -ComObject WScript.Shell",
    `$s = $ws.CreateShortcut(${psQuote(lnk)})`,
    `$s.TargetPath = ${psQuote(exe)}`,
    `$s.Arguments = ${psQuote(`"${root}"`)}`,
    `$s.WorkingDirectory = ${psQuote(root)}`,
    "$s.WindowStyle = 1",
    `$s.Description = ${psQuote("Usage Monitor")}`,
    "$s.Save()",
  ].join("\r\n");
  fs.writeFileSync(script, body, "utf8");
  execFileSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script], {
    windowsHide: true,
    timeout: 10000,
  });
}

function removeShortcut() {
  try {
    if (fs.existsSync(shortcutPath())) fs.unlinkSync(shortcutPath());
  } catch {
    /* ignore */
  }
}

function apply(enabled) {
  const root = appRoot();
  const exe = electronExe();
  try {
    app.setLoginItemSettings({
      openAtLogin: !!enabled,
      openAsHidden: false,
      path: exe,
      args: [root],
    });
  } catch (err) {
    console.error("login item failed", err.message);
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
    const st = app.getLoginItemSettings({ path: electronExe(), args: [appRoot()] });
    if (st && st.openAtLogin) return true;
  } catch {
    /* ignore */
  }
  try {
    return fs.existsSync(shortcutPath());
  } catch {
    return false;
  }
}

module.exports = { apply, isEnabled, shortcutPath, appRoot };
