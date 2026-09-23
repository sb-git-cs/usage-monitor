const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");
const { app, dialog } = require("electron");

function repoRoot() {
  return path.resolve(__dirname, "..");
}

function isGitCheckout() {
  try {
    return fs.existsSync(path.join(repoRoot(), ".git"));
  } catch {
    return false;
  }
}

function run(cmd, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      {
        cwd: repoRoot(),
        windowsHide: true,
        timeout: timeoutMs || 45000,
        env: process.env,
        shell: process.platform === "win32" && cmd !== "git" && !cmd.endsWith(".exe"),
      },
      (err, stdout, stderr) => {
        if (err) {
          const msg = (stderr && String(stderr).trim()) || err.message;
          reject(new Error(msg));
          return;
        }
        resolve(String(stdout || "").trim());
      }
    );
  });
}

function git(args, timeoutMs) {
  return run("git", args, timeoutMs);
}

async function remoteRef() {
  try {
    const upstream = await git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
    if (upstream) return upstream;
  } catch {
    /* no upstream */
  }
  return "origin/main";
}

async function check() {
  if (!isGitCheckout()) return { available: false, skipped: true };
  await git(["fetch", "origin"]);
  const local = await git(["rev-parse", "HEAD"]);
  const remote = await git(["rev-parse", await remoteRef()]);
  if (!remote || local === remote) return { available: false, local, remote };
  let summary = "";
  try {
    summary = await git(["log", "--oneline", `${local}..${remote}`]);
  } catch {
    summary = "";
  }
  const lines = summary
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 8);
  return { available: true, local, remote, summary: lines.join("\n") };
}

async function apply() {
  await git(["pull", "--ff-only"], 60000);
  const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
  await run(npmCmd, ["install"], 180000);
}

function relaunch() {
  app.relaunch();
  app.exit(0);
}

function box(parent, opts) {
  if (parent && !parent.isDestroyed()) return dialog.showMessageBox(parent, opts);
  return dialog.showMessageBox(opts);
}

async function promptAndUpdate(parent, info) {
  const detail = info.summary
    ? `New commits:\n${info.summary}`
    : "A newer version is on GitHub.";
  const { response } = await box(parent, {
    type: "question",
    title: "Usage Monitor",
    message: "An update is available. Update now?",
    detail,
    buttons: ["Yes", "No"],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  });
  if (response !== 0) return { updated: false };
  try {
    await apply();
  } catch (err) {
    await box(parent, {
      type: "error",
      title: "Usage Monitor",
      message: "Update failed.",
      detail: String(err.message || err),
      buttons: ["OK"],
    });
    return { updated: false, error: err };
  }
  relaunch();
  return { updated: true };
}

async function run({ parent, promptIfNone } = {}) {
  let info;
  try {
    info = await check();
  } catch (err) {
    if (promptIfNone) {
      await box(parent, {
        type: "error",
        title: "Usage Monitor",
        message: "Could not check for updates.",
        detail: String(err.message || err),
        buttons: ["OK"],
      });
    }
    return { available: false, error: err };
  }
  if (info.skipped) {
    if (promptIfNone) {
      await box(parent, {
        type: "info",
        title: "Usage Monitor",
        message: "This copy was not installed from Git, so it cannot self-update.",
        buttons: ["OK"],
      });
    }
    return info;
  }
  if (!info.available) {
    if (promptIfNone) {
      await box(parent, {
        type: "info",
        title: "Usage Monitor",
        message: "You're on the latest version.",
        buttons: ["OK"],
      });
    }
    return info;
  }
  return promptAndUpdate(parent, info);
}

module.exports = { check, apply, run, isGitCheckout };
