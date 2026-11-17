// Runs a module's functions in a short-lived Electron utility process that ends after a quiet spell.
// What a big scan allocates then leaves with that process: a 30-day token report over this PC's
// transcripts left 34 MB committed in the main process when run there (108 MB right after), 73 MB
// on a worker thread (its native memory stays in the process), and 0.7 MB in a utility process.
// Outside Electron's main process (unit tests, scripts) calls run in-process on `inline`.
const path = require("node:path");

function utilityProcess() {
  try {
    const electron = require("electron");
    return electron.utilityProcess && electron.app && electron.app.isReady() ? electron.utilityProcess : null;
  } catch {
    return null;
  }
}

// modulePath: the module the process loads. factory/options: call module[factory](options) once and
// use what it returns (a scanner with methods) instead of the module's own functions.
function createOffload(modulePath, { inline = null, factory = null, options = {}, idleMs = 60_000, name = "scan", utility = utilityProcess } = {}) {
  let child = null;
  let idleTimer = null;
  let nextId = 1;
  let local = null;
  const pending = new Map();

  function inProcess() {
    if (!local) {
      const mod = inline || require(modulePath);
      local = factory ? mod[factory](options) : mod;
    }
    return local;
  }

  function failAll(err) {
    for (const p of pending.values()) p.reject(err);
    pending.clear();
  }

  function idle() {
    clearTimeout(idleTimer);
    if (!child || pending.size) return;
    idleTimer = setTimeout(stop, idleMs);
    if (idleTimer.unref) idleTimer.unref();
  }

  function start(up) {
    const proc = up.fork(path.join(__dirname, "offload-child.js"), [], { serviceName: `Usage Monitor ${name}`, stdio: "ignore" });
    child = proc;
    proc.on("message", (msg) => {
      if (child !== proc || !msg || !pending.has(msg.id)) return;
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.value);
      else p.reject(Object.assign(new Error(msg.error), { name: msg.errorName || "Error" }));
      idle();
    });
    proc.on("exit", () => {
      if (child !== proc) return;
      child = null;
      clearTimeout(idleTimer);
      failAll(new Error(`the ${name} process ended`));
    });
    proc.postMessage({ init: { modulePath, factory, options } });
    return proc;
  }

  function call(fn, ...args) {
    const up = utility();
    if (!up) return Promise.resolve().then(() => inProcess()[fn](...args));
    clearTimeout(idleTimer);
    const proc = child || start(up);
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      proc.postMessage({ id, fn, args });
    });
  }

  // Ends the process; it saves first (a module with flush() is flushed). In-process, flushes directly.
  function stop() {
    clearTimeout(idleTimer);
    const proc = child;
    if (!proc) {
      if (local && typeof local.flush === "function") local.flush();
      return;
    }
    child = null;
    failAll(new Error(`the ${name} process stopped`));
    proc.postMessage({ stop: true });
    const killer = setTimeout(() => proc.kill(), 2000);
    if (killer.unref) killer.unref();
  }

  return { call, stop, get running() { return !!child; }, get separate() { return !!utility(); } };
}

module.exports = { createOffload };
