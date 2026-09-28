// Main-process log file. The app normally runs detached (npm start, the Startup shortcut,
// packaged builds), where console output goes nowhere, so errors and update activity are
// appended to logs/main.log under the local app data folder. The file is capped at 1 MB;
// the previous one is kept as main.old.log.
const fs = require("fs");
const path = require("path");
const util = require("util");
const { logDir } = require("./paths");

const MAX_BYTES = 1024 * 1024;

let file = null;
let size = 0;
let failed = false;

function logFile() {
  return path.join(logDir(), "main.log");
}

function open() {
  if (file || failed) return !!file;
  try {
    fs.mkdirSync(logDir(), { recursive: true });
    file = logFile();
    try {
      size = fs.statSync(file).size;
    } catch {
      size = 0;
    }
    return true;
  } catch {
    failed = true;
    return false;
  }
}

function rotate() {
  try {
    fs.renameSync(file, path.join(path.dirname(file), "main.old.log"));
  } catch {
    /* keep appending to the current file */
  }
  size = 0;
}

function write(level, args) {
  if (!open()) return;
  const text = args.map((a) => (a instanceof Error ? a.stack || a.message : typeof a === "string" ? a : util.inspect(a, { depth: 3 }))).join(" ");
  const line = `${new Date().toISOString()} [${level}] ${text.replace(/\r?\n/g, "\n    ")}\n`;
  try {
    if (size + line.length > MAX_BYTES) rotate();
    fs.appendFileSync(file, line, "utf8");
    size += Buffer.byteLength(line);
  } catch {
    /* logging must never break the app */
  }
}

const info = (...args) => write("info", args);
const warn = (...args) => write("warn", args);
const error = (...args) => write("error", args);

// Mirrors console.warn/console.error into the log and records crashes instead of showing
// Electron's modal "A JavaScript error occurred in the main process" box.
function install() {
  for (const [name, fn] of [["warn", warn], ["error", error]]) {
    const original = console[name].bind(console);
    console[name] = (...args) => {
      fn(...args);
      original(...args);
    };
  }
  process.on("uncaughtException", (err) => console.error("uncaught exception", err));
  process.on("unhandledRejection", (reason) => console.error("unhandled rejection", reason));
}

module.exports = { info, warn, error, install, logFile };
