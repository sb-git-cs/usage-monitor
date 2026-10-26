const test = require("node:test");
const assert = require("node:assert/strict");
const { CLIS, MENU_LABEL, plan, terminalFor, open } = require("../src/godmode-launch");

const DIR = "C:\\Users\\a & b";

test("the menu launches each tracked CLI with its own skip-permissions flag", () => {
  assert.equal(MENU_LABEL, "Open in terminal (godmode)");
  assert.deepEqual(CLIS.map((cli) => cli.id), ["claude", "codex", "grok", "gemini", "cursor"]);
  assert.deepEqual(CLIS.map((cli) => [cli.file, ...cli.args]), [
    ["claude", "--dangerously-skip-permissions"],
    ["codex", "--dangerously-bypass-approvals-and-sandbox"],
    ["grok", "--always-approve"],
    ["agy", "--dangerously-skip-permissions"],
    ["cursor-agent", "--force"],
  ]);
  for (const cli of CLIS) assert.ok(cli.args.every((arg) => /^--[a-z0-9-]+$/.test(arg)));
});

test("Windows opens a visible console from cmd, or Windows Terminal when it is present", () => {
  const cmd = plan("claude", { platform: "win32", cwd: DIR, terminal: "cmd" });
  assert.equal(cmd.command, "cmd.exe");
  assert.deepEqual(cmd.args, ["/d", "/c", "start", '"Claude Code (godmode)"', "/D", `"${DIR}"`, "cmd.exe", "/d", "/k", "claude", "--dangerously-skip-permissions"]);
  assert.equal(cmd.options.windowsHide, true);
  assert.equal(cmd.options.windowsVerbatimArguments, true);
  assert.equal(cmd.options.shell, undefined);
  assert.equal(cmd.args.filter((arg) => arg.includes("&")).length, 1);

  const wt = plan("codex", { platform: "win32", cwd: DIR, terminal: "wt" });
  assert.equal(wt.command, "wt.exe");
  assert.equal(wt.options.windowsVerbatimArguments, true);
  assert.ok(wt.args.includes("--"));
  assert.deepEqual(wt.args.slice(wt.args.indexOf("--") + 1), ["cmd.exe", "/d", "/k", "codex", "--dangerously-bypass-approvals-and-sandbox"]);
  assert.equal(terminalFor("win32", (name) => name === "wt.exe"), "wt");
  assert.equal(terminalFor("win32", () => false), "cmd");
});

test("macOS and Linux plans quote the directory and never pass the command through a shell", () => {
  const home = "/Users/a b/o'brien";
  const mac = plan("grok", { platform: "darwin", cwd: home, terminal: "osascript" });
  assert.equal(mac.command, "osascript");
  // AppleScript sees \\ as one backslash, so the shell receives the POSIX '\'' quote.
  assert.equal(mac.args[1], `tell application "Terminal" to do script "cd '/Users/a b/o'\\\\''brien' && exec 'grok' '--always-approve'"`);
  assert.equal(mac.options.shell, undefined);

  const quoted = plan("claude", { platform: "darwin", cwd: '/Users/say "hi"' });
  assert.equal(quoted.args[1], `tell application "Terminal" to do script "cd '/Users/say \\"hi\\"' && exec 'claude' '--dangerously-skip-permissions'"`);

  const gnome = plan("cursor", { platform: "linux", cwd: home, terminal: "gnome-terminal" });
  assert.deepEqual(gnome.args, [`--working-directory=${home}`, "--", "cursor-agent", "--force"]);
  const xterm = plan("gemini", { platform: "linux", cwd: home, terminal: "xterm" });
  assert.deepEqual(xterm.args, ["-e", "agy", "--dangerously-skip-permissions"]);
  assert.equal(xterm.options.cwd, home);
  assert.equal(terminalFor("linux", (name) => name === "konsole"), "konsole");
  assert.equal(terminalFor("linux", () => false), "x-terminal-emulator");
});

test("Explorer's folder-background command opens in the right-clicked folder", () => {
  const command = require("../src/godmode-launch").explorerCommand("grok");
  assert.equal(command, 'cmd.exe /d /c start "Grok Build (godmode)" /D "%V." cmd.exe /d /k grok --always-approve');
  assert.equal(require("../src/godmode-launch").explorerCommand("nope"), null);
  for (const cli of CLIS) {
    const line = require("../src/godmode-launch").explorerCommand(cli.id);
    assert.match(line, /\/D "%V\."/);
    assert.ok(line.endsWith(`${cli.file} ${cli.args.join(" ")}`));
  }
});

test("open spawns the planned command and ignores an unknown tool", () => {
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
  const result = open("gemini", {
    platform: "win32",
    cwd: DIR,
    terminal: "cmd",
    which,
    spawn: (command, args, options) => {
      calls.push(["spawn", command, args, options.windowsHide]);
      return child;
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.command, "cmd.exe");
  assert.deepEqual(result.args.slice(-2), ["agy", "--dangerously-skip-permissions"]);
  assert.equal(calls[0][0], "spawn");
  assert.equal(calls[0][1], "cmd.exe");
  assert.equal(calls[0][3], true);
  assert.equal(calls[1][0], "on");
  assert.equal(calls[2], "unref");
  assert.ok(result.args[3].startsWith('"'));
  assert.ok(result.args[5].includes("&"));

  let spawned = false;
  assert.deepEqual(open("copilot", { spawn: () => { spawned = true; } }), { ok: false, error: "Unknown tool" });
  assert.equal(spawned, false);
  assert.equal(plan("copilot"), null);

  const thrown = open("claude", {
    platform: "win32",
    terminal: "cmd",
    spawn: () => { throw new Error("blocked"); },
  });
  assert.deepEqual(thrown, { ok: false, error: "blocked" });
});
