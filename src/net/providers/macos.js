// macOS: nettop (built in, no admin rights) streams per-process and per-connection byte
// deltas once a second. Blocking would need a network extension, so it is not offered.
const { EventEmitter } = require("events");
const { spawn, execFile } = require("child_process");
const { createNettopParser, parsePs, macIdentity } = require("../parsers");

const NETTOP = "/usr/bin/nettop";
const PS = "/bin/ps";
// -d: deltas, -n: no reverse DNS (lookups would leave the Mac), -t external: skip loopback.
const ARGS = ["-L", "0", "-d", "-n", "-s", "1", "-t", "external", "-J", "bytes_in,bytes_out"];
const PID_TTL_MS = 10 * 60_000;

class MacProvider extends EventEmitter {
  constructor() {
    super();
    this.capabilities = { block: false, domains: false, udp: true, setup: false, flows: true };
    this.pids = new Map();
    this.child = null;
    this.stopped = true;
    this.restarts = 0;
    this.queue = Promise.resolve();
    this.status = { state: "starting", message: "Starting nettop…" };
  }

  setStatus(status) {
    this.status = status;
    this.emit("status", status);
  }

  start() {
    this.stopped = false;
    this.launch();
  }

  launch() {
    const parser = createNettopParser((rows) => {
      this.queue = this.queue.then(() => this.onRows(rows)).catch(() => {});
    });
    let child;
    try {
      // stdin stays an open pipe: nettop spins a CPU core when stdin reaches EOF.
      child = spawn(NETTOP, ARGS, { stdio: ["pipe", "pipe", "pipe"] });
    } catch (err) {
      this.retry(`Could not start nettop: ${err.message}`);
      return;
    }
    this.child = child;
    let buf = "";
    let stderr = "";
    let idle = null;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        parser.line(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
      clearTimeout(idle);
      idle = setTimeout(() => parser.flush(), 300);
      if (this.status.state !== "running") {
        this.restarts = 0;
        this.setStatus({ state: "running", message: null });
      }
    });
    child.stderr.on("data", (d) => {
      stderr = (stderr + d).slice(-2000);
    });
    child.on("error", (err) => {
      stderr = err.message;
    });
    child.on("close", (code) => {
      clearTimeout(idle);
      if (this.child === child) this.child = null;
      if (this.stopped) return;
      this.retry(`nettop stopped (${code == null ? "signal" : `exit ${code}`}). ${stderr.trim()}`.trim());
    });
    this.setStatus({ state: "starting", message: "Starting nettop…" });
  }

  retry(message) {
    this.setStatus({ state: "error", message });
    const delay = Math.min(60_000, 5000 * 2 ** this.restarts++);
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      if (!this.stopped) this.launch();
    }, delay);
  }

  lookup(pids) {
    return new Promise((resolve) => {
      execFile(PS, ["-o", "pid=,comm=", "-p", pids.join(",")], { timeout: 5000 }, (_err, stdout) => {
        // ps exits non-zero when some pids have gone; its output is still valid.
        resolve(parsePs(stdout));
      });
    });
  }

  async onRows(rows) {
    const now = Date.now();
    const missing = [];
    for (const r of rows) {
      const cached = this.pids.get(r.pid);
      // nettop truncates names; a different name means the pid was reused.
      if (!cached || cached.name !== r.name) missing.push(r.pid);
    }
    if (missing.length) {
      const found = await this.lookup([...new Set(missing)]);
      for (const r of rows) {
        if (!missing.includes(r.pid)) continue;
        this.pids.set(r.pid, { name: r.name, identity: macIdentity(found.get(r.pid), r.name), seen: now });
      }
    }
    const apps = new Map();
    const flows = [];
    for (const r of rows) {
      const entry = this.pids.get(r.pid);
      entry.seen = now;
      const id = entry.identity;
      let app = apps.get(id.key);
      if (!app) {
        app = { key: id.key, path: id.path, name: id.name, rx: 0, tx: 0, pids: [] };
        apps.set(id.key, app);
      }
      app.rx += r.rx;
      app.tx += r.tx;
      app.pids.push(r.pid);
      for (const f of r.flows) flows.push({ key: id.key, ...f });
    }
    for (const [pid, entry] of this.pids) if (now - entry.seen > PID_TTL_MS) this.pids.delete(pid);
    this.emit("sample", { ts: now, apps: [...apps.values()], flows });
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    if (this.child) this.child.kill();
    this.child = null;
  }
}

module.exports = { MacProvider, NETTOP_ARGS: ARGS };
