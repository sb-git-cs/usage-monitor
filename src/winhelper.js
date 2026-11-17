// The one resident Windows helper (helpers/windows/UsageMonitorHelper.cs) answers hardware and
// battery samples, coding-session processes and consoles, the taskbar and Credential Manager from
// a single small process. It replaced three resident PowerShell processes (70-110 MB each) and a
// PowerShell start, with a C# compile, for every credential read.
//
// Lines are "<channel> <payload>" both ways. Requests of a channel are answered in order, one at a
// time; channels run side by side. A channel can also send lines nobody asked for (the taskbar's
// "shown=" and "layout="), which go to its listeners. A request that takes too long kills the
// helper; the next request starts a new one, but not more often than every 30 seconds while it
// keeps failing. The helper ends when its stdin closes, so it never outlives the app.
const fs = require("node:fs");
const path = require("node:path");
const childProcess = require("node:child_process");

const EXE = "UsageMonitorHelper.exe";
const SOURCE = path.join(__dirname, "..", "helpers", "windows", "UsageMonitorHelper.cs");
const RESTART_GAP_MS = 30000;

function compilerPath(env = process.env) {
  return path.join(env.SystemRoot || env.windir || "C:\\Windows", "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");
}

// Compiles the helper with the C# compiler that ships with Windows (.NET Framework 4). Only
// mscorlib and System are referenced, so the helper loads nothing else.
function build(out, source = SOURCE) {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  childProcess.execFileSync(compilerPath(), ["/nologo", "/noconfig", "/target:winexe", "/platform:x64", "/optimize+",
    "/r:System.dll", `/out:${out}`, source], { windowsHide: true, stdio: "pipe" });
  return out;
}

// The packaged copy beside the app. A checkout builds its own on first use and after the source changes.
function helperPath() {
  try {
    const { app } = require("electron");
    if (app && app.isPackaged) return path.join(process.resourcesPath, "helper", EXE);
  } catch {
    /* not in Electron */
  }
  const out = path.join(__dirname, "..", "helpers", "windows", "bin", EXE);
  let stale = true;
  try {
    stale = fs.statSync(out).mtimeMs < fs.statSync(SOURCE).mtimeMs;
  } catch {
    /* not built yet */
  }
  return stale ? build(out) : out;
}

function createHelper({ spawn = childProcess.spawn, file = helperPath, now = Date.now, restartGapMs = RESTART_GAP_MS } = {}) {
  let proc = null;
  let buffer = "";
  let startedAt = -Infinity;
  let stopped = false;
  const lanes = new Map();
  const listeners = new Map();
  const exitListeners = new Set();

  function lane(channel) {
    let l = lanes.get(channel);
    if (!l) lanes.set(channel, (l = { queue: [], busy: null, timer: null }));
    return l;
  }

  function dispatch(line) {
    const space = line.indexOf(" ");
    const channel = space < 0 ? line : line.slice(0, space);
    const payload = space < 0 ? "" : line.slice(space + 1);
    const l = lanes.get(channel);
    if (l && l.busy) {
      const entry = l.busy;
      l.busy = null;
      clearTimeout(l.timer);
      entry.resolve(payload);
      pump(channel);
      return;
    }
    for (const fn of listeners.get(channel) || []) fn(payload);
  }

  // A helper that exited, failed to start or was killed fails everything it was asked.
  function gone(child, err) {
    if (proc !== child) return;
    proc = null;
    buffer = "";
    for (const l of lanes.values()) {
      clearTimeout(l.timer);
      const pending = l.busy ? [l.busy, ...l.queue] : l.queue;
      l.busy = null;
      l.queue = [];
      for (const entry of pending) entry.reject(err);
    }
    for (const fn of exitListeners) fn();
  }

  function launch() {
    if (stopped) throw new Error("helper stopped");
    if (now() - startedAt < restartGapMs) throw new Error("helper is restarting");
    startedAt = now();
    const child = spawn(typeof file === "function" ? file() : file, [], { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
    proc = child;
    buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      if (proc !== child) return;
      buffer += chunk;
      let i;
      while ((i = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, i).replace(/\r$/, "");
        buffer = buffer.slice(i + 1);
        if (line) dispatch(line);
      }
    });
    child.on("error", (err) => gone(child, err));
    child.on("exit", () => gone(child, new Error("helper exited")));
    child.stdin.on("error", () => {});
    // An idle helper never keeps Node running; a waiting request's timer does until it is answered.
    for (const handle of [child, child.stdin, child.stdout]) if (handle && typeof handle.unref === "function") handle.unref();
    return child;
  }

  function ensure() {
    if (proc) return proc;
    try {
      return launch();
    } catch (err) {
      return err;
    }
  }

  function timedOut(channel, entry) {
    const l = lane(channel);
    if (l.busy !== entry) return;
    l.busy = null;
    entry.reject(new Error(`${channel} request timed out`));
    const child = proc;
    if (!child) return;
    gone(child, new Error("helper restarted after a timeout"));
    try {
      child.kill();
    } catch {
      /* already gone */
    }
  }

  function pump(channel) {
    const l = lane(channel);
    if (l.busy || !l.queue.length) return;
    const child = ensure();
    if (child instanceof Error) {
      const pending = l.queue;
      l.queue = [];
      for (const entry of pending) entry.reject(child);
      return;
    }
    const entry = l.queue.shift();
    l.busy = entry;
    l.timer = setTimeout(() => timedOut(channel, entry), entry.timeoutMs);
    child.stdin.write(`${channel} ${entry.payload}\n`);
  }

  return {
    // One reply line's payload for one request line.
    request(channel, payload, { timeoutMs = 10000 } = {}) {
      return new Promise((resolve, reject) => {
        lane(channel).queue.push({ payload: String(payload).replace(/[\r\n]+/g, " "), resolve, reject, timeoutMs });
        pump(channel);
      });
    },
    // A line that expects no reply; false when the helper is not running and cannot start now.
    send(channel, line) {
      const child = ensure();
      if (child instanceof Error) return false;
      try {
        child.stdin.write(`${channel} ${String(line).replace(/[\r\n]+/g, " ")}\n`);
        return true;
      } catch {
        return false;
      }
    },
    on(channel, fn) {
      if (!listeners.has(channel)) listeners.set(channel, new Set());
      listeners.get(channel).add(fn);
      return () => listeners.get(channel).delete(fn);
    },
    onExit(fn) {
      exitListeners.add(fn);
      return () => exitListeners.delete(fn);
    },
    // Ends the helper for good: pending requests fail and nothing starts another one.
    stop() {
      stopped = true;
      const child = proc;
      if (!child) return;
      gone(child, new Error("helper stopped"));
      try {
        child.stdin.end();
      } catch {
        /* already closed */
      }
      // stdin closing ends the helper; make sure anyway.
      setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* already gone */
        }
      }, 1000).unref();
    },
    get pid() {
      return proc ? proc.pid : null;
    },
  };
}

// The app's shared helper, started by the first request.
let shared = null;
const helper = () => (shared ||= createHelper());

module.exports = {
  request: (channel, payload, opts) => helper().request(channel, payload, opts),
  send: (channel, line) => helper().send(channel, line),
  on: (channel, fn) => helper().on(channel, fn),
  onExit: (fn) => helper().onExit(fn),
  stop: () => { if (shared) shared.stop(); },
  createHelper,
  helperPath,
  build,
  compilerPath,
};
