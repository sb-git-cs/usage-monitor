// Right-click the empty space in a folder. Windows 11 shows that item on the main
// menu only for a packaged Explorer command, so install writes the command list and
// lets helpers/windows/godmode-menu/register.ps1 put that package in place. The classic
// registry verb is removed after the package is installed, because Windows 11 files it
// under Show more options. Registration runs in the background and is skipped while the
// installed package matches the bundled DLL, so it never holds up the app.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const childProcess = require("node:child_process");
const godmode = require("./godmode-launch");

const MENU_KEY = "HKCU\\Software\\Classes\\Directory\\Background\\shell\\UsageMonitor.Godmode";
const STORE = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\CommandStore\\shell";
const SCRIPT = path.join(__dirname, "..", "helpers", "windows", "godmode-menu", "register.ps1");

function scriptPath() {
  const packaged = process.resourcesPath && path.join(process.resourcesPath, "godmode-menu", "register.ps1");
  if (packaged && fs.existsSync(packaged)) return packaged;
  return SCRIPT;
}

function verb(id) {
  return `UsageMonitor.Godmode.${id}`;
}

function commands() {
  return godmode.CLIS.map((cli) => ({
    id: cli.id,
    verb: verb(cli.id),
    label: cli.label,
    tail: `${cli.file} ${cli.args.join(" ")}`,
  }));
}

function commandFileText() {
  return commands().map((item) => `${item.label}\t${item.tail}`).join("\r\n") + "\r\n";
}

function shellDir() {
  const base = process.env.LOCALAPPDATA || path.join(require("node:os").homedir(), "AppData", "Local");
  return path.join(base, "UsageMonitor", "shell");
}

function run(file, args, options) {
  return new Promise((resolve, reject) => {
    childProcess.execFile(file, args, options, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stdout, stderr }));
      else resolve(stdout);
    });
  });
}

function reg(exec, args) {
  return exec("reg.exe", args, { windowsHide: true });
}

async function removeClassic(exec) {
  try {
    await reg(exec, ["delete", MENU_KEY, "/f"]);
  } catch {
    /* the classic menu is not registered */
  }
  for (const item of commands()) {
    try {
      await reg(exec, ["delete", `${STORE}\\${item.verb}`, "/f"]);
    } catch {
      /* this CLI is not registered */
    }
  }
}

// register.ps1 writes "<package version>|<DLL hash>" after a successful install.
function packageCurrent(folder, script) {
  try {
    const stamp = fs.readFileSync(path.win32.join(folder, "package-stamp.txt"), "utf8").trim();
    const dll = fs.readFileSync(path.join(path.dirname(script), "GodmodeMenu.dll"));
    const hash = crypto.createHash("sha256").update(dll).digest("hex");
    return stamp.split("|")[1].toLowerCase() === hash;
  } catch {
    return false;
  }
}

async function install({
  icon,
  platform = process.platform,
  shellDir: dir,
  script = scriptPath(),
  execFile = run,
  writeFile,
  rename,
} = {}) {
  if (platform !== "win32") return { ok: false, error: "Windows only" };
  // Windows only (install returns above elsewhere), so the paths are Windows paths on any host.
  const folder = dir || shellDir();
  const file = path.win32.join(folder, "godmode-commands.txt");
  const text = commandFileText();
  const write = writeFile || ((target, body) => {
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(target, body, "utf8");
  });
  const move = rename || ((from, to) => fs.renameSync(from, to));
  write(`${file}.tmp`, text);
  move(`${file}.tmp`, file);
  if (icon && !String(icon).includes(",") && !writeFile) {
    try {
      fs.copyFileSync(icon, path.win32.join(folder, "icon.ico"));
    } catch {
      /* the menu still works without an icon */
    }
  }
  if (packageCurrent(folder, script)) return { ok: true, current: true };
  try {
    await execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script],
      { windowsHide: true, encoding: "utf8", timeout: 180000 }
    );
  } catch (err) {
    // Exit code 2: this PC lacks what the package needs, and register.ps1 changed nothing.
    const skipped = err && err.code === 2;
    const detail = skipped
      ? String(err.stderr || "").trim()
      : [err && err.stderr, err && err.stdout, err && err.message].filter(Boolean).join("\n");
    return { ok: false, skipped, error: detail || "Could not register the folder menu" };
  }
  await removeClassic(execFile);
  return { ok: true };
}

module.exports = { MENU_KEY, STORE, commands, commandFileText, install, verb, shellDir };
