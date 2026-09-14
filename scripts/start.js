const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

const root = path.resolve(__dirname, "..");
let exe;
try {
  exe = require("electron");
} catch {
  exe = path.join(root, "node_modules", "electron", "dist", "electron.exe");
}
if (typeof exe !== "string" || !fs.existsSync(exe)) {
  console.error("Electron binary not found. Run npm install.");
  process.exit(1);
}

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(exe, [root], {
  cwd: root,
  detached: true,
  stdio: "ignore",
  windowsHide: true,
  env,
});
child.unref();
