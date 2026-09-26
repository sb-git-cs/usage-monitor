// Windows: an elevated helper (helpers/windows/NetCapture.cs) reads kernel ETW network
// events and Windows Firewall rules, and talks to this process over a named pipe.
const { EventEmitter } = require("events");
const net = require("net");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFile } = require("child_process");

const SYSTEM_ROOT = process.env.SystemRoot || process.env.windir || "C:\\Windows";
const POWERSHELL = path.join(SYSTEM_ROOT, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const SCHTASKS = path.join(SYSTEM_ROOT, "System32", "schtasks.exe");
const WHOAMI = path.join(SYSTEM_ROOT, "System32", "whoami.exe");
const COMMAND_TIMEOUT_MS = 20000;
const CONNECT_WAIT_MS = 15000;

function helperSourceDir() {
  try {
    const { app } = require("electron");
    if (app.isPackaged) return path.join(process.resourcesPath, "net-helper");
  } catch {
    /* unpackaged or tests */
  }
  return path.join(__dirname, "..", "..", "..", "helpers", "windows");
}

// Must match the version setup.ps1 writes: SHA-256 of the C# source, first 16 hex digits.
function sourceVersion(dir = helperSourceDir()) {
  const code = fs.readFileSync(path.join(dir, "NetCapture.cs"), "utf8").replace(/^\uFEFF/, "");
  return crypto.createHash("sha256").update(code, "utf8").digest("hex").slice(0, 16);
}

function run(file, args, timeout = 15000) {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout, encoding: "utf8" }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout: String(stdout || ""), stderr: String(stderr || "") });
    });
  });
}

async function userSid() {
  const res = await run(WHOAMI, ["/user", "/fo", "csv", "/nh"]);
  const m = /"(S-1-[0-9-]+)"/.exec(res.stdout);
  if (m) return m[1];
  const ps = await run(POWERSHELL, ["-NoProfile", "-NonInteractive", "-Command", "[Security.Principal.WindowsIdentity]::GetCurrent().User.Value"]);
  const sid = ps.stdout.trim();
  if (/^S-1-[0-9-]+$/.test(sid)) return sid;
  throw new Error("Could not determine the Windows user account.");
}

const psQuote = (s) => `'${String(s).replace(/'/g, "''")}'`;
const argQuote = (s) => `"${String(s)}"`;

class WindowsProvider extends EventEmitter {
  constructor({ workDir }) {
    super();
    this.capabilities = { block: true, domains: true, udp: true, setup: true, flows: true };
    this.workDir = workDir;
    this.socket = null;
    this.server = null;
    this.pending = new Map();
    this.seq = 0;
    this.flowKeys = [];
    this.stopped = true;
    this.status = { state: "starting", message: "Starting the network helper…" };
    this.helper = { installed: false, version: null, expected: null, outdated: false, connected: false, firewall: null };
  }

  setStatus(status) {
    this.status = { ...status, helper: { ...this.helper } };
    this.emit("status", this.status);
  }

  async start() {
    this.stopped = false;
    this.sid = await userSid();
    this.taskName = `\\UsageMonitor\\NetCapture-${this.sid}`;
    const programFiles = process.env.ProgramW6432 || process.env.ProgramFiles || "C:\\Program Files";
    this.helperDir = path.join(programFiles, "Usage Monitor Network Helper", this.sid);
    this.pipePath = `\\\\.\\pipe\\UsageMonitor.NetCapture.${this.sid}`;
    await this.listen();
    this.refreshInstall();
    if (!this.helper.installed) {
      this.setStatus({
        state: "setup_required",
        action: "install",
        message: "Per-app monitoring on Windows needs a small helper with administrator rights. Approve it once; after that it starts on its own.",
      });
      return;
    }
    this.setStatus({ state: "starting", message: "Waiting for the network helper…" });
    this.waitTimer = setTimeout(() => {
      if (!this.socket && !this.stopped) this.startHelper().catch(() => {});
    }, 3000);
  }

  listen() {
    return new Promise((resolve, reject) => {
      const server = net.createServer((sock) => this.accept(sock));
      server.once("error", reject);
      server.listen(this.pipePath, () => {
        server.removeListener("error", reject);
        server.on("error", (err) => this.setStatus({ state: "error", message: `Pipe error: ${err.message}` }));
        this.server = server;
        resolve();
      });
    });
  }

  refreshInstall() {
    this.helper.installed = fs.existsSync(path.join(this.helperDir, "UsageMonitorNetHelper.exe"));
    try {
      this.helper.version = fs.readFileSync(path.join(this.helperDir, "version.txt"), "utf8").trim();
    } catch {
      this.helper.version = null;
    }
    try {
      this.helper.expected = sourceVersion();
    } catch {
      this.helper.expected = null;
    }
    this.helper.outdated = !!(this.helper.installed && this.helper.expected && this.helper.version !== this.helper.expected);
  }

  accept(sock) {
    if (this.socket || this.stopped) {
      sock.destroy();
      return;
    }
    this.socket = sock;
    clearTimeout(this.waitTimer);
    sock.setEncoding("utf8");
    let buf = "";
    sock.on("data", (chunk) => {
      buf += chunk;
      if (buf.length > 16 * 1024 * 1024) {
        sock.destroy();
        return;
      }
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        this.onLine(line);
      }
    });
    sock.on("error", () => {});
    sock.on("close", () => {
      if (this.socket !== sock) return;
      this.socket = null;
      this.helper.connected = false;
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error("The network helper disconnected."));
      }
      this.pending.clear();
      if (this.stopped) return;
      this.setStatus({ state: "starting", message: "Reconnecting to the network helper…" });
      clearTimeout(this.waitTimer);
      this.waitTimer = setTimeout(() => {
        if (this.socket || this.stopped) return;
        this.refreshInstall();
        this.setStatus(
          this.helper.installed
            ? { state: "not_running", action: "start", message: "The network helper is not running." }
            : { state: "setup_required", action: "install", message: "The network helper was removed. Set it up again to record usage." }
        );
      }, 10000);
    });
  }

  onLine(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (!msg || typeof msg !== "object") return;
    if (msg.t === "hello") {
      this.helper.connected = true;
      this.helper.firewall = msg.firewall === true;
      this.awaitingList = true;
      this.refreshInstall();
      if (msg.capture) {
        const notes = [];
        if (this.helper.outdated) notes.push("A newer network helper is available.");
        if (!this.helper.firewall) notes.push("Windows Firewall is off for this network, so blocking has no effect.");
        this.setStatus({ state: "running", message: notes.join(" ") || null, action: this.helper.outdated ? "update" : null });
      } else {
        this.setStatus({ state: "error", action: "install", message: msg.error || "The network helper could not start capturing." });
      }
      this.send("FLOWS", this.flowKeys.join("|")).catch(() => {});
    } else if (msg.t === "tick") {
      this.emit("sample", {
        ts: msg.ts,
        apps: (Array.isArray(msg.apps) ? msg.apps : []).map((a) => ({
          key: a.k,
          path: a.p || null,
          name: a.n || a.x || a.k,
          rx: a.rx,
          tx: a.tx,
          pids: a.pids,
        })),
        flows: (Array.isArray(msg.flows) ? msg.flows : []).map((f) => ({ key: f.k, ip: f.ip, port: f.port, proto: f.proto, rx: f.rx, tx: f.tx })),
      });
    } else if (msg.t === "dns") {
      this.emit("dns", { name: msg.name, ips: msg.ips });
    } else if (msg.t === "blocked") {
      this.emit("blocked", { paths: Array.isArray(msg.paths) ? msg.paths : [], initial: !!this.awaitingList });
      this.awaitingList = false;
    } else if (msg.t === "result") {
      const p = this.pending.get(String(msg.id));
      if (!p) return;
      this.pending.delete(String(msg.id));
      clearTimeout(p.timer);
      if (msg.ok) p.resolve();
      else p.reject(new Error(msg.error || "The network helper reported an error."));
    }
  }

  send(command, arg = "") {
    return new Promise((resolve, reject) => {
      if (!this.socket) {
        reject(new Error("The network helper is not running."));
        return;
      }
      if (/[\t\r\n]/.test(arg)) {
        reject(new Error("Invalid argument."));
        return;
      }
      const id = String(++this.seq);
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("The network helper did not answer."));
      }, COMMAND_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.write(`${id}\t${command}\t${arg}\n`);
    });
  }

  setBlocked(programPath, blocked) {
    return this.send(blocked ? "BLOCK" : "UNBLOCK", String(programPath));
  }

  setFlowKeys(keys) {
    this.flowKeys = keys.filter((k) => typeof k === "string" && !/[|\t\r\n]/.test(k));
    if (this.socket) this.send("FLOWS", this.flowKeys.join("|")).catch(() => {});
  }

  waitForConnection(ms = CONNECT_WAIT_MS) {
    if (this.socket) return Promise.resolve(true);
    return new Promise((resolve) => {
      const started = Date.now();
      const check = setInterval(() => {
        if (this.socket || this.stopped || Date.now() - started > ms) {
          clearInterval(check);
          resolve(!!this.socket);
        }
      }, 250);
    });
  }

  async startHelper() {
    this.setStatus({ state: "starting", message: "Starting the network helper…" });
    const res = await run(SCHTASKS, ["/Run", "/TN", this.taskName]);
    if (res.code === 0 && (await this.waitForConnection(8000))) return;
    this.refreshInstall();
    const message = res.code !== 0 ? `Could not start the network helper: ${(res.stderr || res.stdout).trim() || `exit ${res.code}`}` : "The network helper did not connect.";
    this.setStatus({ state: "not_running", action: "install", message });
    throw new Error(message);
  }

  // Runs setup.ps1 elevated. Resolves with the setup result or throws with a readable message.
  async elevate(remove) {
    const src = helperSourceDir();
    fs.mkdirSync(this.workDir, { recursive: true });
    const result = path.join(this.workDir, `net-helper-${process.pid}-${Date.now()}.json`);
    const argLine = [
      "-NoProfile",
      "-ExecutionPolicy Bypass",
      `-File ${argQuote(path.join(src, "setup.ps1"))}`,
      `-Source ${argQuote(src)}`,
      `-UserSid ${this.sid}`,
      `-Result ${argQuote(result)}`,
      remove ? "-Remove" : "",
    ].join(" ");
    const command =
      "try { $p = Start-Process -FilePath " + psQuote(POWERSHELL) + " -ArgumentList " + psQuote(argLine) +
      " -Verb RunAs -WindowStyle Hidden -Wait -PassThru; exit $p.ExitCode } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1223 }";
    const res = await run(POWERSHELL, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command], 300000);
    let outcome = null;
    try {
      outcome = JSON.parse(fs.readFileSync(result, "utf8").replace(/^\uFEFF/, ""));
    } catch {
      outcome = null;
    }
    try {
      fs.rmSync(result, { force: true });
    } catch {
      /* ignore */
    }
    if (outcome && outcome.ok) return outcome;
    if (outcome && outcome.error) throw new Error(outcome.error);
    if (/cancell?ed by the user/i.test(res.stderr)) throw new Error("Administrator approval was declined.");
    throw new Error(res.stderr.trim() || `Setup failed (exit ${res.code}).`);
  }

  async install() {
    this.setStatus({ state: "starting", message: "Waiting for administrator approval…" });
    let outcome;
    try {
      outcome = await this.elevate(false);
    } catch (err) {
      this.refreshInstall();
      this.setStatus({ state: this.helper.installed ? "not_running" : "setup_required", action: "install", message: err.message });
      throw err;
    }
    this.refreshInstall();
    if (await this.waitForConnection()) {
      if (outcome.warning) this.setStatus({ ...this.status, message: outcome.warning });
      return;
    }
    await this.startHelper();
  }

  async remove() {
    if (this.socket) {
      await this.send("UNINSTALL").catch(() => {});
    } else {
      await this.elevate(true);
    }
    await new Promise((r) => setTimeout(r, 1500));
    this.refreshInstall();
    this.setStatus({ state: "setup_required", action: "install", message: "The network helper was removed." });
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.waitTimer);
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error("Stopped."));
    }
    this.pending.clear();
    if (this.socket) this.socket.destroy();
    this.socket = null;
    if (this.server) this.server.close();
    this.server = null;
  }
}

module.exports = { WindowsProvider, sourceVersion, helperSourceDir };
