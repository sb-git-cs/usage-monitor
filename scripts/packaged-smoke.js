// CI: starts the built app (electron-builder --dir output) with --smoke-report (src/smoke.js) in a
// throwaway profile and checks what it reports: no process crashed, every window painted, the
// screen shows what was painted where the screen can be read, only the Chromium processes that
// src/chromium.js keeps out of the main process are running, the files scripts/after-pack.js
// drops are gone, token and session-file scans run in a utility process from inside app.asar,
// and on Windows a round trip through the helper works.
// Usage: node scripts/packaged-smoke.js [dist folder, default dist]   (Linux: under xvfb-run)
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { inProcess } = require("../src/chromium");
const { unusedFiles } = require("./after-pack");
const pkg = require("../package.json");

const dist = path.resolve(process.argv[2] || path.join(__dirname, "..", "dist"));

// The built app's executable and the folder that holds Electron's files.
function findApp() {
  if (process.platform === "win32") {
    const dir = path.join(dist, "win-unpacked");
    return { exe: path.join(dir, `${pkg.build.productName}.exe`), dir };
  }
  if (process.platform === "darwin") {
    for (const d of fs.existsSync(dist) ? fs.readdirSync(dist) : []) {
      const app = path.join(dist, d, `${pkg.build.productName}.app`);
      if (d.startsWith("mac") && fs.existsSync(app)) return { exe: path.join(app, "Contents", "MacOS", pkg.build.productName), dir: app };
    }
    return null;
  }
  const dir = path.join(dist, "linux-unpacked");
  const names = [pkg.build.linux && pkg.build.linux.executableName, pkg.name, pkg.build.productName].filter(Boolean);
  const exe = names.map((n) => path.join(dir, n)).find((f) => fs.existsSync(f));
  return exe ? { exe, dir } : null;
}

function check(report, app) {
  const failures = [];
  if (report.error) return [`the app failed: ${report.error}`];
  for (const c of report.crashes) failures.push(`a ${c.type} process ended (${c.reason}, exit ${c.exitCode})`);
  const chips = report.windows.find((w) => /chips\.html$/.test(w.page));
  if (!chips) failures.push("the chips window was not created");
  for (const w of report.windows) {
    if (w.error) failures.push(`${w.page}: ${w.error}`);
    else if (w.visible && !(w.painted > 500)) failures.push(`${w.page} painted ${w.painted} pixels`);
    if (w.onScreenPct != null && w.onScreenPct < 90) failures.push(`${w.page}: only ${w.onScreenPct}% of it is on screen as painted`);
  }
  const want = inProcess(process.platform);
  if (want.gpu && report.processes.some((p) => p.type === "GPU")) failures.push("a GPU process is running, but it should run in the main process");
  if (want.network && report.processes.some((p) => /NetworkService/.test(p.service || ""))) failures.push("the network service is running in its own process");
  for (const name of unusedFiles(process.platform)) if (fs.existsSync(path.join(app.dir, name))) failures.push(`${name} should have been left out of the build`);
  if (process.platform === "win32" && !(report.helper && report.helper.ok)) failures.push(`the Windows helper did not answer: ${JSON.stringify(report.helper)}`);
  if (!(report.offload && report.offload.ok && report.offload.separate)) failures.push(`scans did not run in a utility process: ${JSON.stringify(report.offload)}`);
  return failures;
}

async function main() {
  const app = findApp();
  if (!app || !fs.existsSync(app.exe)) throw new Error(`no built app in ${dist}; run electron-builder --dir first`);
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "um-smoke-report-")), "report.json");
  const args = [`--smoke-report=${file}`, ...(process.platform === "linux" ? ["--no-sandbox"] : [])];
  const code = await new Promise((resolve, reject) => {
    const child = spawn(app.exe, args, { stdio: "inherit" });
    const timer = setTimeout(() => { child.kill(); reject(new Error("the app did not finish its smoke run within 120 s")); }, 120000);
    child.on("error", reject);
    child.on("exit", (exitCode) => { clearTimeout(timer); resolve(exitCode); });
  });
  if (!fs.existsSync(file)) throw new Error(`the app exited (${code}) without a report`);
  const report = JSON.parse(fs.readFileSync(file, "utf8"));
  console.log(JSON.stringify({ exitCode: code, ...report }, null, 2));
  const failures = check(report, app);
  if (code !== 0) failures.unshift(`the app exited with ${code}`);
  if (failures.length) throw new Error(`packaged smoke run failed:\n- ${failures.join("\n- ")}`);
  console.log(`packaged smoke run passed (${process.platform}, ${report.processes.length} processes)`);
}

main().catch((err) => { console.error(err.message); process.exitCode = 1; });
