const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { MENU_KEY, PICKER_KEY, STORE, commands, install } = require("../src/folder-menu");

test("the folder menu lists each CLI in order with its own flag", () => {
  const items = commands();
  assert.deepEqual(items.map((item) => item.label), ["Claude Code", "Codex", "Grok Build", "Gemini", "Cursor"]);
  assert.equal(items[3].tail, "agy --dangerously-skip-permissions");
  assert.equal(items[4].tail, "cursor-agent --force");
  assert.equal(items.some((item) => /[&|<>^%!]/.test(item.tail)), false);
});

test("install writes the command file, registers the package, then removes the classic menu", async () => {
  const writes = [];
  const calls = [];
  const result = await install({
    platform: "win32",
    shellDir: "C:\\temp\\shell",
    script: "C:\\app\\register.ps1",
    writeFile: (file, text) => writes.push([file, text]),
    rename: (from, to) => writes.push(["rename", from, to]),
    execFile: (file, args) => {
      calls.push([file, args.slice()]);
      if (args[0] === "delete") {
        const err = new Error("missing");
        err.status = 1;
        throw err;
      }
    },
  });
  assert.equal(result.ok, true);
  assert.equal(writes[0][0], "C:\\temp\\shell\\godmode-commands.txt.tmp");
  assert.match(writes[0][1], /Claude Code\tclaude --dangerously-skip-permissions/);
  assert.match(writes[0][1], /Gemini\tagy --dangerously-skip-permissions/);
  assert.equal(writes[1][0], "rename");
  assert.equal(writes[1][2], "C:\\temp\\shell\\godmode-commands.txt");
  assert.equal(calls[0][0], "powershell.exe");
  assert.equal(calls[0][1].at(-1), "C:\\app\\register.ps1");
  assert.equal(calls[1][0], "reg.exe");
  assert.equal(calls[1][1][1], MENU_KEY);
  const verbs = calls.filter((call) => call[0] === "reg.exe").map((call) => call[1][1]);
  assert.equal(verbs.includes(`${STORE}\\UsageMonitor.Godmode.claude`), true);
  assert.equal(verbs.includes(`${STORE}\\UsageMonitor.Godmode.cursor`), true);
  assert.equal(verbs.includes(PICKER_KEY), true);
  assert.equal(calls.some((call) => call[1].includes("SubCommands")), false);
});

test("a failed package registration still adds the classic folder menu", async () => {
  const calls = [];
  const result = await install({
    platform: "win32",
    shellDir: "C:\\temp\\shell",
    script: "C:\\app\\register.ps1",
    writeFile: () => {},
    rename: () => {},
    execFile: (file, args) => {
      calls.push([file, args.slice()]);
      if (file === "powershell.exe" && args.includes("-File")) {
        const err = new Error("no");
        err.stderr = "install failed";
        throw err;
      }
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.classic, true);
  assert.match(result.error, /install failed/);
  const added = calls.filter((call) => call[0] === "reg.exe" && call[1][0] === "add");
  assert.equal(added.some((call) => call[1][1] === MENU_KEY && call[1].includes("SubCommands")), true);
  // Only the 1.13 model picker item is removed; the godmode menu just added stays.
  const deleted = calls.filter((call) => call[0] === "reg.exe" && call[1][0] === "delete").map((call) => call[1][1]);
  assert.deepEqual(deleted, [PICKER_KEY]);
});

test("a PC without the packaging tools gets the classic menu instead of nothing", async () => {
  const calls = [];
  const result = await install({
    platform: "win32",
    shellDir: "C:\\temp\\shell",
    script: "C:\\app\\register.ps1",
    icon: "C:\\app\\icon.ico",
    writeFile: () => {},
    rename: () => {},
    execFile: (file, args) => {
      calls.push([file, args.slice()]);
      if (file === "powershell.exe" && args.includes("-File")) {
        const err = new Error("Command failed");
        err.code = 2;
        err.stderr = "the Windows SDK packaging tools are not installed\r\n";
        throw err;
      }
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.classic, true);
  assert.equal(result.notify, false);
  assert.equal(result.error, "the Windows SDK packaging tools are not installed");
  const added = calls.filter((call) => call[0] === "reg.exe" && call[1][0] === "add");
  const parent = added.find((call) => call[1][1] === MENU_KEY && call[1].includes("SubCommands"));
  assert.match(parent[1].at(-2), /UsageMonitor\.Godmode\.claude/);
  assert.match(parent[1].at(-2), /UsageMonitor\.Godmode\.cursor/);
  const command = added.find((call) => String(call[1][1]).endsWith("UsageMonitor.Godmode.grok\\command"));
  assert.match(command[1].at(-2), /grok --always-approve/);
  const icon = added.find((call) => call[1][1] === MENU_KEY && call[1].includes("Icon"));
  assert.equal(icon[1].at(-2), "C:\\app\\icon.ico");
});

test("a declined administrator prompt is asked again and is not filed under Show more options", async () => {
  const calls = [];
  const result = await install({
    platform: "win32",
    shellDir: "C:\\temp\\shell",
    script: "C:\\app\\register.ps1",
    writeFile: () => {},
    rename: () => {},
    execFile: (file, args) => {
      calls.push([file, args.slice()]);
      if (file === "powershell.exe" && args.includes("-File")) {
        const err = new Error("Command failed");
        err.code = 2;
        err.stderr = "administrator approval is required once to add the menu to the main right-click menu\r\n";
        throw err;
      }
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.needsAdmin, true);
  assert.equal(result.classic, undefined);
  assert.equal(result.notify, false);
  assert.equal(calls.some((call) => call[0] === "reg.exe"), false);
});

test("an installed package that matches the bundled DLL is not registered again", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "um-menu-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const dll = Buffer.from("menu");
  fs.writeFileSync(path.join(dir, "GodmodeMenu.dll"), dll);
  const hash = crypto.createHash("sha256").update(dll).digest("hex").toUpperCase();
  fs.writeFileSync(path.join(dir, "package-stamp.txt"), `1.0.0.0|${hash}\r\n`);
  let called = false;
  const options = {
    platform: "win32",
    shellDir: dir,
    script: path.join(dir, "register.ps1"),
    writeFile: () => {},
    rename: () => {},
    execFile: () => { called = true; },
  };
  assert.deepEqual(await install(options), { ok: true, current: true });
  assert.equal(called, false);
  fs.writeFileSync(path.join(dir, "GodmodeMenu.dll"), "changed");
  assert.equal((await install(options)).ok, true);
  assert.equal(called, true);
});

test("install does nothing on other platforms", async () => {
  let called = false;
  assert.deepEqual(
    await install({ platform: "linux", writeFile: () => { called = true; }, execFile: () => { called = true; } }),
    { ok: false, error: "Windows only" }
  );
  assert.equal(called, false);
});
