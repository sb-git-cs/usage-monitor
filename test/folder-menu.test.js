const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { MENU_LABEL, MENU_KEY, LEGACY_KEYS, STORE, pickerScript, launcherText, explorerCommand, install } = require("../src/folder-menu");

test("the launcher runs the unpacked picker on the system node", () => {
  assert.equal(MENU_LABEL, "Open model picker here");
  assert.equal(
    pickerScript("C:\\Program Files\\Usage Monitor\\resources\\app.asar\\src"),
    path.join("C:\\Program Files\\Usage Monitor\\resources\\app.asar.unpacked\\src", "model-picker", "cli.js")
  );
  assert.equal(pickerScript("/repo/src"), path.join("/repo/src", "model-picker", "cli.js"));
  const text = launcherText("C:\\Users\\100% me\\cli.js");
  assert.match(text, /^@echo off\r\n/);
  assert.match(text, /where node >nul 2>&1 \|\| \(echo .*Node\.js.* & exit \/b 1\)\r\n/);
  assert.match(text, /\r\nnode "C:\\Users\\100%% me\\cli\.js" %\*\r\n$/);
  assert.equal(
    explorerCommand("C:\\Users\\a & b\\shell\\model-picker.cmd"),
    'cmd.exe /d /s /k "pushd "%V." && "C:\\Users\\a & b\\shell\\model-picker.cmd""'
  );
  assert.equal(LEGACY_KEYS.includes(`${STORE}\\UsageMonitor.Godmode.cursor`), true);
});

test("install writes the launcher, registers the package, then removes the classic and godmode menus", async () => {
  const writes = [];
  const removed = [];
  const calls = [];
  const result = await install({
    platform: "win32",
    shellDir: "C:\\temp\\shell",
    script: "C:\\app\\register.ps1",
    picker: "C:\\app\\cli.js",
    writeFile: (file, text) => writes.push([file, text]),
    rename: (from, to) => writes.push(["rename", from, to]),
    remove: (file) => removed.push(file),
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
  assert.equal(writes[0][0], "C:\\temp\\shell\\model-picker.cmd.tmp");
  assert.equal(writes[0][1], launcherText("C:\\app\\cli.js"));
  assert.equal(writes[1][0], "rename");
  assert.equal(writes[1][2], "C:\\temp\\shell\\model-picker.cmd");
  assert.deepEqual(removed, ["C:\\temp\\shell\\godmode-commands.txt"]);
  assert.equal(calls[0][0], "powershell.exe");
  assert.equal(calls[0][1].at(-1), "C:\\app\\register.ps1");
  assert.equal(calls[1][0], "reg.exe");
  assert.equal(calls[1][1][1], MENU_KEY);
  const deleted = calls.filter((call) => call[0] === "reg.exe").map((call) => call[1][1]);
  for (const key of LEGACY_KEYS) assert.equal(deleted.includes(key), true);
  assert.equal(calls.some((call) => call[1][0] === "add"), false);
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
  assert.equal(added.some((call) => call[1][1] === MENU_KEY && call[1].includes(MENU_LABEL)), true);
  // Only the godmode keys are cleared; the new item stays.
  const deleted = calls.filter((call) => call[0] === "reg.exe" && call[1][0] === "delete").map((call) => call[1][1]);
  assert.deepEqual(deleted, [...LEGACY_KEYS]);
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
  assert.equal(added.some((call) => call[1].includes("SubCommands")), false);
  const command = added.find((call) => call[1][1] === `${MENU_KEY}\\command`);
  assert.equal(command[1].at(-2), explorerCommand("C:\\temp\\shell\\model-picker.cmd"));
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
