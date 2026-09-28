// Finishes a git update whose dependencies changed. Usage Monitor starts this detached and
// quits: `npm ci` deletes node_modules, including the Electron binary the app runs from,
// so it can only run once the app has exited. Then the app is started again through
// start.js, which also downloads the Electron binary (Electron fetches it on first use).
// Progress goes to logs/update.log next to the app's main.log.
const { spawnSync, spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const { logDir } = require("../src/paths");

const root = path.resolve(__dirname, "..");
const WAIT_MS = 60_000;

function log(message) {
  try {
    fs.mkdirSync(logDir(), { recursive: true });
    fs.appendFileSync(path.join(logDir(), "update.log"), `${new Date().toISOString()} ${message}\n`, "utf8");
  } catch {
    /* nowhere to report */
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function npmCi() {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  // npm.cmd needs a shell on Windows; the arguments are fixed.
  const r = spawnSync(npm, ["ci", "--no-audit", "--no-fund"], { cwd: root, shell: process.platform === "win32", windowsHide: true, encoding: "utf8", timeout: 10 * 60_000 });
  const out = `${r.stdout || ""}${r.stderr || ""}`.trim().split(/\r?\n/).slice(-15).join("\n");
  return { ok: r.status === 0, out: out || (r.error && r.error.message) || `exit ${r.status}` };
}

const pidArg = process.argv.indexOf("--pid");
const pid = pidArg > 0 ? Number(process.argv[pidArg + 1]) : 0;
log(`post-update started for pid ${pid || "?"}`);
const deadline = Date.now() + WAIT_MS;
while (pid && alive(pid) && Date.now() < deadline) sleep(250);
// File handles on Windows can outlive the process briefly.
sleep(1500);

let result = npmCi();
if (!result.ok) {
  log(`npm ci failed, retrying:\n${result.out}`);
  sleep(5000);
  result = npmCi();
}
log(result.ok ? "dependencies installed" : `npm ci failed:\n${result.out}`);

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(process.execPath, [path.join(__dirname, "start.js")], { cwd: root, detached: true, stdio: "ignore", windowsHide: true, env });
child.on("error", (err) => log(`restart failed: ${err.message}`));
child.unref();
log("restarting Usage Monitor");
