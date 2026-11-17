const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const afterPack = require("../scripts/after-pack");

const root = path.resolve(__dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "um-pack-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("Windows and Linux builds drop only the GPU components this app never loads; macOS is left signed", async (t) => {
  const cases = {
    win32: ["Usage Monitor.exe", "ffmpeg.dll", "libEGL.dll", "libGLESv2.dll", "icudtl.dat", "LICENSES.chromium.html"],
    linux: ["usage-monitor", "chrome-sandbox", "libffmpeg.so", "libEGL.so", "libGLESv2.so", "icudtl.dat"],
  };
  for (const [platform, keep] of Object.entries(cases)) {
    const dir = tempDir(t);
    const drop = afterPack.unusedFiles(platform);
    assert.ok(drop.length > 0);
    for (const name of [...keep, ...drop]) fs.writeFileSync(path.join(dir, name), "x");
    await afterPack({ electronPlatformName: "darwin", appOutDir: dir });
    assert.equal(fs.readdirSync(dir).length, keep.length + drop.length, "a macOS build is not touched");
    await afterPack({ electronPlatformName: platform, appOutDir: dir });
    assert.deepEqual(fs.readdirSync(dir).sort(), [...keep].sort(), platform);
    await afterPack({ electronPlatformName: platform, appOutDir: dir });
  }
  assert.deepEqual(afterPack.unusedFiles("darwin"), []);
});

test("the GPU process runs in the main process on Windows and Linux, the network service everywhere", () => {
  const { inProcess, applySwitches } = require("../src/chromium");
  assert.deepEqual(inProcess("win32"), { gpu: true, network: true });
  assert.deepEqual(inProcess("linux"), { gpu: true, network: true });
  assert.deepEqual(inProcess("darwin"), { gpu: false, network: true }, "macOS presents its windows from the GPU process");
  const seen = [];
  applySwitches({ appendSwitch: (...a) => seen.push(a.join("=")) }, "darwin");
  assert.deepEqual(seen, ["enable-features=NetworkServiceInProcess2"]);
});

test("those components may only be dropped while hardware acceleration stays off", () => {
  assert.equal(pkg.build.afterPack, "scripts/after-pack.js");
  const main = fs.readFileSync(path.join(root, "src", "main.js"), "utf8");
  // Unconditional and at the top level: WebGL, WebGPU and GPU compositing would need the dropped files.
  assert.match(main, /^app\.disableHardwareAcceleration\(\);$/m,
    "turning hardware acceleration on needs scripts/after-pack.js removed from package.json");
});

test("the Windows helper is built before packing and shipped beside the app", () => {
  assert.equal(pkg.build.beforePack, "scripts/build-helper.js");
  const resources = pkg.build.win.extraResources;
  assert.ok(resources.some((r) => r.from === "helpers/windows/bin/UsageMonitorHelper.exe" && r.to === "helper/UsageMonitorHelper.exe"));
  assert.ok(!resources.some((r) => /taskbar-layout\.ps1/.test(r.from)), "the PowerShell taskbar probe is gone");
  for (const file of ["system-windows.ps1", "battery-windows.ps1", "sessions-windows.ps1"]) {
    assert.equal(fs.existsSync(path.join(root, "src", file)), false, `${file} was replaced by the helper`);
  }
});
