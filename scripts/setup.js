// `npm run setup`: on Windows, installs the coding CLIs (install.ps1) and starts the app.
// On macOS and Linux, installs dependencies if needed and starts the app.
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const run = (cmd, args) => spawnSync(cmd, args, { stdio: "inherit", cwd: root, shell: false });

if (process.platform === "win32") {
  const r = run("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(__dirname, "install.ps1")]);
  process.exit(r.status == null ? 1 : r.status);
}

if (!fs.existsSync(path.join(root, "node_modules", "electron"))) {
  const r = run("npm", ["install"]);
  if (r.status !== 0) process.exit(r.status == null ? 1 : r.status);
}

console.log(`Usage Monitor setup

Sign in once to each coding CLI you use (install them with their own instructions):
  claude          https://code.claude.com/
  codex login     https://github.com/openai/codex
  agy or gemini   https://antigravity.google/ or https://github.com/google-gemini/gemini-cli
  grok            https://grok.com/

Network usage needs no setup on macOS or Linux.
`);
const r = run(process.execPath, [path.join(__dirname, "start.js")]);
process.exit(r.status == null ? 0 : r.status);
