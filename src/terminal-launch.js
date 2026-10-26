// Starts a fixed command, such as a CLI's sign-in, in a visible terminal. Nothing the
// user types is inserted into it, and the app does not type into a terminal that is
// already open.
const { spawn, execFileSync } = require("node:child_process");
const os = require("node:os");

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
// space or & in the home directory stays one argument. The command name and flags are fixed.
function cmdQuote(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

// The fixed command to run: { label, file, args, title }.
function commandOf(command) {
  if (command && typeof command === "object" && typeof command.file === "string" && Array.isArray(command.args)) {
    return { label: String(command.label || command.file), file: command.file, args: command.args.map(String), title: String(command.title || command.label || command.file) };
  }
  return null;
}

// id names the tool the command is for; the command itself decides what runs.
function plan(id, { platform = process.platform, cwd = os.homedir(), terminal = platform === "win32" ? "cmd" : platform === "darwin" ? "osascript" : "x-terminal-emulator", command = null } = {}) {
  const cli = commandOf(command);
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

function open(id, deps = {}) {
  if (!commandOf(deps.command)) return { ok: false, error: "Unknown tool" };
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

module.exports = { plan, terminalFor, open };
