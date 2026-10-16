// Right-click the empty space in a folder. Windows 11 shows that item on the main
// menu for the signed package shipped with helpers/windows/godmode-menu. install writes
// the command list and lets register.ps1 put that package in place. Trusting its
// certificate asks for administrator approval once; a declined prompt is asked again
// next launch and does not file the item under Show more options. The classic registry
// verb is removed after the package is installed. Registration runs in the background
// and is skipped while the installed package matches the bundled DLL.
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

function regAdd(exec, key, name, data) {
  const args = ["add", key];
  if (name) args.push("/v", name);
  else args.push("/ve");
  args.push("/d", data, "/f");
  return reg(exec, args);
}

// The cascading menu Windows shows on Windows 10, and under Show more options on Windows 11.
async function registerClassic(exec, icon) {
  const verbs = commands().map((item) => item.verb).join(";");
  await regAdd(exec, MENU_KEY, "", godmode.MENU_LABEL);
  await regAdd(exec, MENU_KEY, "MUIVerb", godmode.MENU_LABEL);
  await regAdd(exec, MENU_KEY, "SubCommands", verbs);
  await regAdd(exec, MENU_KEY, "Position", "Top");
  if (icon) await regAdd(exec, MENU_KEY, "Icon", String(icon));
  for (const item of commands()) {
    const key = `${STORE}\\${item.verb}`;
    await regAdd(exec, key, "", item.label);
    await regAdd(exec, key, "MUIVerb", item.label);
    await regAdd(exec, `${key}\\command`, "", godmode.explorerCommand(item.id));
  }
  try {
    // Tell Explorer the folder association changed, so the new item shows without a restart.
    await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      "Add-Type -Namespace UM -Name N -MemberDefinition '[DllImport(\"shell32.dll\")] public static extern void SHChangeNotify(int e, uint f, System.IntPtr a, System.IntPtr b);' -ErrorAction SilentlyContinue; [UM.N]::SHChangeNotify(0x8000000, 0, [IntPtr]::Zero, [IntPtr]::Zero)"],
    { windowsHide: true, timeout: 20000 });
  } catch {
    /* the menu is registered; Explorer picks it up when it next opens a folder */
  }
}

// First time this note is needed, the app can say so. A later launch stays quiet.
function noteOnce(folder, name) {
  try {
    const stamp = path.win32.join(folder, name);
    if (fs.existsSync(stamp)) return false;
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(stamp, "1\n", "utf8");
    return true;
  } catch {
    return false;
  }
}

// register.ps1 writes "<package version>|<DLL hash>" after a successful install.
function packageCurrent(folder, script) {
  try {
    const stamp = fs.readFileSync(path.join(folder, "package-stamp.txt"), "utf8").trim();
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
  const injectedWrite = typeof writeFile === "function";
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
      // Minimized, not hidden: a hidden window cannot show the administrator prompt.
      ["-NoProfile", "-WindowStyle", "Minimized", "-ExecutionPolicy", "Bypass", "-File", script],
      { windowsHide: false, encoding: "utf8", timeout: 600000 }
    );
  } catch (err) {
    const skipped = err && err.code === 2;
    const detail = skipped
      ? String(err.stderr || "").trim()
      : [err && err.stderr, err && err.stdout, err && err.message].filter(Boolean).join("\n");
    // A declined prompt is asked again next launch. Do not file Show more options in its place.
    if (/administrator approval/i.test(detail)) {
      return {
        ok: false,
        skipped: true,
        needsAdmin: true,
        notify: injectedWrite ? false : noteOnce(folder, "menu-approval.txt"),
        error: detail,
      };
    }
    try {
      await registerClassic(execFile, icon);
    } catch (regErr) {
      const why = [detail, regErr && (regErr.stderr || regErr.message)].filter(Boolean).join("\n");
      return { ok: false, skipped, error: why || "Could not register the folder menu" };
    }
    return { ok: true, classic: true, notify: injectedWrite ? false : noteOnce(folder, "classic-menu.txt"), error: detail || undefined };
  }
  await removeClassic(execFile);
  return { ok: true };
}

module.exports = { MENU_KEY, STORE, commands, commandFileText, install, verb, shellDir };
