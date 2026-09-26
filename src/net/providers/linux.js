// Linux: polls `ss -tinp` (iproute2, no root needed) for per-socket TCP byte counters
// and turns them into per-second deltas. UDP sockets carry no byte counters, and
// blocking would need root firewall rules, so neither is offered.
const { EventEmitter } = require("events");
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const { parseSs, diffSockets } = require("../parsers");

const SS_PATHS = ["/usr/bin/ss", "/bin/ss", "/usr/sbin/ss", "/sbin/ss"];
const PID_TTL_MS = 10 * 60_000;

class LinuxProvider extends EventEmitter {
  constructor({ desktop } = {}) {
    super();
    this.capabilities = { block: false, domains: false, udp: false, setup: false, flows: true };
    this.desktop = desktop || null;
    this.prev = new Map();
    this.baseline = true;
    this.pids = new Map();
    this.busy = false;
    this.status = { state: "starting", message: "Starting…" };
  }

  setStatus(status) {
    if (this.status.state === status.state && this.status.message === status.message) return;
    this.status = status;
    this.emit("status", status);
  }

  start() {
    this.ss = SS_PATHS.find((p) => fs.existsSync(p));
    if (!this.ss) {
      this.setStatus({ state: "error", message: "The ss tool from iproute2 is not installed, so network usage cannot be read." });
      return;
    }
    this.baseline = true;
    this.prev = new Map();
    this.timer = setInterval(() => this.poll(), 1000);
    this.poll();
  }

  poll() {
    if (this.busy) return;
    this.busy = true;
    execFile(this.ss, ["-tinp"], { timeout: 4000, maxBuffer: 64 * 1024 * 1024, encoding: "utf8" }, (err, stdout, stderr) => {
      this.busy = false;
      if (!this.timer) return;
      if (err) {
        this.setStatus({ state: "error", message: `ss failed: ${(stderr || err.message).trim()}` });
        return;
      }
      this.setStatus({ state: "running", message: null });
      const { next, deltas } = diffSockets(this.prev, parseSs(stdout), this.baseline);
      this.prev = next;
      this.baseline = false;
      this.emitSample(deltas);
    });
  }

  identity(pid, comm) {
    if (pid == null) return { key: "other", path: null, name: "Other (not attributed)" };
    const now = Date.now();
    const cached = this.pids.get(pid);
    if (cached && cached.comm === comm) {
      cached.seen = now;
      return cached.identity;
    }
    let exe = null;
    try {
      exe = fs.readlinkSync(`/proc/${pid}/exe`).replace(/ \(deleted\)$/, "");
    } catch {
      exe = null;
    }
    let identity;
    if (exe) {
      const entry = this.desktop ? this.desktop.lookup(exe, comm) : null;
      identity = { key: exe, path: exe, name: (entry && entry.name) || path.posix.basename(exe) };
    } else {
      const label = comm || `pid ${pid}`;
      identity = { key: `proc:${label.toLowerCase()}`, path: null, name: label };
    }
    this.pids.set(pid, { comm, identity, seen: now });
    return identity;
  }

  emitSample(deltas) {
    const now = Date.now();
    const apps = new Map();
    const flows = [];
    for (const d of deltas) {
      const id = this.identity(d.pid, d.comm);
      let app = apps.get(id.key);
      if (!app) {
        app = { key: id.key, path: id.path, name: id.name, rx: 0, tx: 0, pids: [] };
        apps.set(id.key, app);
      }
      app.rx += d.rx;
      app.tx += d.tx;
      if (d.pid != null && !app.pids.includes(d.pid)) app.pids.push(d.pid);
      flows.push({ key: id.key, ip: d.ip, port: d.port, proto: "tcp", rx: d.rx, tx: d.tx });
    }
    for (const [pid, entry] of this.pids) if (now - entry.seen > PID_TTL_MS) this.pids.delete(pid);
    this.emit("sample", { ts: now, apps: [...apps.values()], flows });
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }
}

module.exports = { LinuxProvider };
