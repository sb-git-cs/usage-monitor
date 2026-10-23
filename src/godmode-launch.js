// Starts one of the coding CLIs the app already tracks, in a visible terminal, with that
// CLI's own skip-permissions flag. The command table is fixed. Nothing the user types is
// inserted into it. File Explorer launches these; the app does not type into a terminal
// that is already open.
const { spawn, execFileSync } = require("node:child_process");
const os = require("node:os");

const MENU_LABEL = "Open in terminal (godmode)";

// Flags checked against the installed CLIs' --help (Claude, Codex 0.162.1, Grok 1.0.52,
// agy 1.3.5, cursor-agent). Codex --yolo is accepted here and is the short form of the
// bypass flag below. Grok is started with --always-approve, the flag its help prints.
const CLIS = Object.freeze([
  Object.freeze({ id: "claude", label: "Claude Code", file: "claude", args: Object.freeze(["--dangerously-skip-permissions"]) }),
  Object.freeze({ id: "codex", label: "Codex", file: "codex", args: Object.freeze(["--dangerously-bypass-approvals-and-sandbox"]) }),
  Object.freeze({ id: "grok", label: "Grok Build", file: "grok", args: Object.freeze(["--always-approve"]) }),
  Object.freeze({ id: "gemini", label: "Gemini", file: "agy", args: Object.freeze(["--dangerously-skip-permissions"]) }),
  Object.freeze({ id: "cursor", label: "Cursor", file: "cursor-agent", args: Object.freeze(["--force"]) }),
]);

function cliById(id) {
  return CLIS.find((cli) => cli.id === id) || null;
}

function defaultWhich(name) {
  try {
    execFileSync(process.platform === "win32" ? "where.exe" : "which", [name], { stdio: "ignore", windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

function terminalFor(platform, which) {
  if (platform === "win32") return which("wt.exe") || which("wt") ? "wt" : "cmd";
  if (platform === "darwin") return "osascript";
  for (const name of ["x-terminal-emulator", "gnome-terminal", "konsole", "xterm"]) {
    if (which(name)) return name;
  }
  return "x-terminal-emulator";
}

function shQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function appleQuote(value) {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function hidden(cwd) {
  return { cwd, detached: true, stdio: "ignore", windowsHide: true };
}

// cmd.exe parses the starter command line itself. Quote the title and folder so a
// space or & in the home directory stays one argument. The CLI name and flags are fixed.
function cmdQuote(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

// A fixed command to run in a terminal instead of a godmode CLI: { label, file, args, title }.
function commandOf(id, command) {
  if (command && typeof command === "object" && typeof command.file === "string" && Array.isArray(command.args)) {
    return { label: String(command.label || command.file), file: command.file, args: command.args.map(String), title: String(command.title || command.label || command.file) };
  }
  const cli = cliById(id);
  return cli ? { ...cli, title: `${cli.label} (godmode)` } : null;
}

function plan(id, { platform = process.platform, cwd = os.homedir(), terminal = platform === "win32" ? "cmd" : platform === "darwin" ? "osascript" : "x-terminal-emulator", command = null } = {}) {
  const cli = commandOf(id, command);
  if (!cli) return null;
  const dir = cwd || os.homedir();
  const title = cli.title;
  if (platform === "win32" && terminal === "wt") {
    return {
      command: "wt.exe",
      args: ["-w", "0", "new-tab", "--title", cmdQuote(title), "-d", cmdQuote(dir), "--", "cmd.exe", "/d", "/k", cli.file, ...cli.args],
      options: { ...hidden(dir), windowsVerbatimArguments: true },
    };
  }
  if (platform === "win32") {
    // The first quoted string is the window title. /k keeps the console open.
    return {
      command: "cmd.exe",
      args: ["/d", "/c", "start", cmdQuote(title), "/D", cmdQuote(dir), "cmd.exe", "/d", "/k", cli.file, ...cli.args],
      options: { ...hidden(dir), windowsVerbatimArguments: true },
    };
  }
  if (platform === "darwin") {
    const inner = `cd ${shQuote(dir)} && exec ${[cli.file, ...cli.args].map(shQuote).join(" ")}`;
    return {
      command: "osascript",
      args: ["-e", `tell application "Terminal" to do script ${appleQuote(inner)}`],
      options: { detached: true, stdio: "ignore" },
    };
  }
  const options = { cwd: dir, detached: true, stdio: "ignore" };
  if (terminal === "gnome-terminal") {
    return { command: "gnome-terminal", args: [`--working-directory=${dir}`, "--", cli.file, ...cli.args], options };
  }
  if (terminal === "konsole") {
    return { command: "konsole", args: ["--workdir", dir, "-e", cli.file, ...cli.args], options };
  }
  return { command: terminal || "x-terminal-emulator", args: ["-e", cli.file, ...cli.args], options };
}

// Explorer fills %V with the folder that was right-clicked. The trailing dot keeps a
// drive root such as C:\ from eating the closing quote; Windows treats that dot as the folder.
function explorerCommand(id) {
  const cli = cliById(id);
  if (!cli) return null;
  const title = cmdQuote(`${cli.label} (godmode)`);
  return `cmd.exe /d /c start ${title} /D "%V." cmd.exe /d /k ${cli.file} ${cli.args.join(" ")}`;
}

function open(id, deps = {}) {
  if (!commandOf(id, deps.command)) return { ok: false, error: "Unknown tool" };
  const platform = deps.platform || process.platform;
  const which = deps.which || defaultWhich;
  const spec = plan(id, {
    platform,
    cwd: deps.cwd || os.homedir(),
    terminal: deps.terminal || terminalFor(platform, which),
    command: deps.command || null,
  });
  if (!spec) return { ok: false, error: "Unknown tool" };
  const spawnFn = deps.spawn || spawn;
  let child;
  try {
    child = spawnFn(spec.command, spec.args, spec.options);
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
  if (child && typeof child.on === "function") {
    child.on("error", (err) => {
      if (typeof deps.onError === "function") deps.onError(err);
    });
  }
  if (child && typeof child.unref === "function") child.unref();
  return { ok: true, command: spec.command, args: spec.args };
}

module.exports = { CLIS, MENU_LABEL, plan, terminalFor, open, explorerCommand };
