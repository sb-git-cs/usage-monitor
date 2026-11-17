// The utility-process side of offload.js: loads the module once, answers calls, saves and exits on stop.
let target = null;

process.parentPort.on("message", async ({ data }) => {
  if (data.init) {
    const mod = require(data.init.modulePath);
    target = data.init.factory ? mod[data.init.factory](data.init.options || {}) : mod;
    return;
  }
  if (data.stop) {
    try {
      if (target && typeof target.flush === "function") await target.flush();
    } finally {
      process.exit(0);
    }
  }
  try {
    const value = await target[data.fn](...data.args);
    process.parentPort.postMessage({ id: data.id, ok: true, value });
  } catch (err) {
    process.parentPort.postMessage({ id: data.id, ok: false, error: String((err && err.message) || err), errorName: err && err.name });
  }
});
