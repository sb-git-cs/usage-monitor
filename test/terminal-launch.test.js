const test = require("node:test");
const assert = require("node:assert/strict");
const { plan, terminalFor, open } = require("../src/terminal-launch");

const DIR = "C:\\Users\\a & b";
const LOGIN = Object.freeze({ label: "Claude Code", title: "Claude Code sign-in", file: "claude", args: ["auth", "login"] });

test("Windows opens a visible console from cmd, or Windows Terminal when it is present", () => {
  const cmd = plan("claude", { platform: "win32", cwd: DIR, terminal: "cmd", command: LOGIN });
  assert.equal(cmd.command, "cmd.exe");
  assert.deepEqual(cmd.args, ["/d", "/c", "start", '"Claude Code sign-in"', "/D", `"${DIR}"`, "cmd.exe", "/d", "/k", "claude", "auth", "login"]);
  assert.equal(cmd.options.windowsHide, true);
  assert.equal(cmd.options.windowsVerbatimArguments, true);
  assert.equal(cmd.options.shell, undefined);
  assert.equal(cmd.args.filter((arg) => arg.includes("&")).length, 1);

  const wt = plan("codex", { platform: "win32", cwd: DIR, terminal: "wt", command: { file: "codex", args: ["login"] } });
  assert.equal(wt.command, "wt.exe");
  assert.equal(wt.options.windowsVerbatimArguments, true);
  assert.ok(wt.args.includes("--"));
  assert.deepEqual(wt.args.slice(wt.args.indexOf("--") + 1), ["cmd.exe", "/d", "/k", "codex", "login"]);
  assert.equal(wt.args[wt.args.indexOf("--title") + 1], '"codex"');
  assert.equal(terminalFor("win32", (name) => name === "wt.exe"), "wt");
  assert.equal(terminalFor("win32", () => false), "cmd");
});

test("macOS and Linux plans quote the directory and never pass the command through a shell", () => {
  const home = "/Users/a b/o'brien";
  const grok = { file: "grok", args: ["login"] };
  const mac = plan("grok", { platform: "darwin", cwd: home, terminal: "osascript", command: grok });
  assert.equal(mac.command, "osascript");
  // AppleScript sees \\ as one backslash, so the shell receives the POSIX '\'' quote.
  assert.equal(mac.args[1], `tell application "Terminal" to do script "cd '/Users/a b/o'\\\\''brien' && exec 'grok' 'login'"`);
  assert.equal(mac.options.shell, undefined);

  const quoted = plan("claude", { platform: "darwin", cwd: '/Users/say "hi"', command: LOGIN });
  assert.equal(quoted.args[1], `tell application "Terminal" to do script "cd '/Users/say \\"hi\\"' && exec 'claude' 'auth' 'login'"`);

  const gnome = plan("cursor", { platform: "linux", cwd: home, terminal: "gnome-terminal", command: { file: "cursor-agent", args: ["login"] } });
  assert.deepEqual(gnome.args, [`--working-directory=${home}`, "--", "cursor-agent", "login"]);
  const xterm = plan("gemini", { platform: "linux", cwd: home, terminal: "xterm", command: { file: "agy", args: [] } });
  assert.deepEqual(xterm.args, ["-e", "agy"]);
  assert.equal(xterm.options.cwd, home);
  assert.equal(terminalFor("linux", (name) => name === "konsole"), "konsole");
  assert.equal(terminalFor("linux", () => false), "x-terminal-emulator");
});

test("open spawns the planned command and refuses a call without one", () => {
  const calls = [];
  const child = {
    on(event, fn) {
      calls.push(["on", event]);
      assert.equal(typeof fn, "function");
    },
    unref() {
      calls.push("unref");
    },
  };
  const which = () => {
    throw new Error("which should not run when terminal is passed");
  };
  const result = open("copilot", {
    platform: "win32",
    cwd: DIR,
    terminal: "cmd",
    which,
    command: { label: "Copilot", file: "gh", args: ["auth", "login"] },
    spawn: (command, args, options) => {
      calls.push(["spawn", command, args, options.windowsHide]);
      return child;
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.command, "cmd.exe");
  assert.deepEqual(result.args.slice(-3), ["gh", "auth", "login"]);
  assert.equal(calls[0][0], "spawn");
  assert.equal(calls[0][1], "cmd.exe");
  assert.equal(calls[0][3], true);
  assert.equal(calls[1][0], "on");
  assert.equal(calls[2], "unref");
  assert.ok(result.args[3].startsWith('"'));
  assert.ok(result.args[5].includes("&"));

  // The folder menu no longer starts CLIs by id, so an id alone launches nothing.
  let spawned = false;
  assert.deepEqual(open("claude", { spawn: () => { spawned = true; } }), { ok: false, error: "Unknown tool" });
  assert.equal(spawned, false);
  assert.equal(plan("claude"), null);

  const thrown = open("claude", {
    platform: "win32",
    terminal: "cmd",
    command: LOGIN,
    spawn: () => { throw new Error("blocked"); },
  });
  assert.deepEqual(thrown, { ok: false, error: "blocked" });
});
