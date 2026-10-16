const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { MENU_KEY, STORE, commands, install } = require("../src/folder-menu");

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
  assert.equal(calls.some((call) => call[1].includes("SubCommands")), false);
});

test("a failed package registration leaves the classic menu in place", async () => {
  const calls = [];
  const result = await install({
    platform: "win32",
    shellDir: "C:\\temp\\shell",
    script: "C:\\app\\register.ps1",
    writeFile: () => {},
    rename: () => {},
    execFile: (file) => {
      calls.push(file);
      if (file === "powershell.exe") {
        const err = new Error("no");
        err.stderr = "install failed";
        throw err;
      }
    },
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /install failed/);
  assert.equal(calls.includes("reg.exe"), false);
});

test("a PC without the packaging tools is skipped quietly", async () => {
  const result = await install({
    platform: "win32",
    shellDir: "C:\temp\shell",
    script: "C:\app\register.ps1",
    writeFile: () => {},
    rename: () => {},
    execFile: () => {
      const err = new Error("Command failed");
      err.code = 2;
      err.stderr = "the Windows SDK packaging tools are not installed\r\n";
      throw err;
    },
  });
  assert.deepEqual(result, { ok: false, skipped: true, error: "the Windows SDK packaging tools are not installed" });
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
