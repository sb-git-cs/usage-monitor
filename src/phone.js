// Shares the plan meters with a paired phone over the local network. Off until the user
// turns it on in Settings. Protocol (docs/phone-protocol.md):
//   Pairing: the desktop shows a 20-character code, in a QR code with its addresses. Both
//   sides derive the device id and keys from the code, so the code never crosses the network.
//   Requests: GET with X-UM-Id, X-UM-Time and X-UM-Sig (HMAC-SHA256 of method, path and time).
//   Responses: AES-256-GCM, with the request time as additional data, so a recorded answer
//   cannot be replayed later and nobody else on the network can read the meters.
const crypto = require("crypto");
const http = require("http");
const os = require("os");

const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789"; // no 0/O, 1/I/L, U
const CODE_LENGTH = 20;
const PAIRING_TTL_MS = 10 * 60_000;
const MAX_SKEW_MS = 5 * 60_000;
const FAILURE_LIMIT = 20; // per address per minute
const PROTOCOL = 1;

// ---- crypto shared with the Android app (android/.../PairingCrypto.kt) ---------------

function normalizeCode(code) {
  return String(code || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

// 30 symbols x 20 characters is about 98 bits.
function newCode() {
  let out = "";
  for (let i = 0; i < CODE_LENGTH; i++) out += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  return out;
}

function formatCode(code) {
  return normalizeCode(code).replace(/(.{5})(?=.)/g, "$1-");
}

function deviceId(code) {
  return crypto.createHash("sha256").update(`um-id:${normalizeCode(code)}`).digest("hex").slice(0, 16);
}

function masterKey(code) {
  return Buffer.from(crypto.hkdfSync("sha256", Buffer.from(normalizeCode(code), "utf8"), Buffer.from("usage-monitor", "utf8"), Buffer.from("um-key-v1", "utf8"), 32));
}

function subKey(master, label) {
  return Buffer.from(crypto.hkdfSync("sha256", master, Buffer.alloc(0), Buffer.from(label, "utf8"), 32));
}

function sign(master, method, pathname, time) {
  return crypto.createHmac("sha256", subKey(master, "um-mac-v1")).update(`${method}\n${pathname}\n${time}`).digest("base64url");
}

function encrypt(master, time, payload, iv = crypto.randomBytes(12)) {
  const cipher = crypto.createCipheriv("aes-256-gcm", subKey(master, "um-enc-v1"), iv);
  cipher.setAAD(Buffer.from(String(time), "utf8"));
  const data = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(payload), "utf8")), cipher.final(), cipher.getAuthTag()]);
  return { v: PROTOCOL, iv: iv.toString("base64url"), data: data.toString("base64url") };
}

function decrypt(master, time, box) {
  const raw = Buffer.from(box.data, "base64url");
  const decipher = crypto.createDecipheriv("aes-256-gcm", subKey(master, "um-enc-v1"), Buffer.from(box.iv, "base64url"));
  decipher.setAAD(Buffer.from(String(time), "utf8"));
  decipher.setAuthTag(raw.subarray(raw.length - 16));
  return JSON.parse(Buffer.concat([decipher.update(raw.subarray(0, raw.length - 16)), decipher.final()]).toString("utf8"));
}

function pairingLink({ code, addresses, port, name }) {
  const q = new URLSearchParams({ h: addresses.join(","), p: String(port), c: formatCode(code), n: name });
  return `usagemonitor://pair?${q.toString()}`;
}

// IPv4 addresses the phone can try, LAN first; includes VPN addresses such as Tailscale's.
function localAddresses(interfaces = os.networkInterfaces()) {
  const out = [];
  for (const list of Object.values(interfaces)) {
    for (const a of list || []) {
      const v4 = a.family === "IPv4" || a.family === 4;
      if (!v4 || a.internal || a.address.startsWith("169.254.")) continue;
      out.push(a.address);
    }
  }
  const lan = (ip) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);
  return [...new Set(out)].sort((a, b) => Number(lan(b)) - Number(lan(a)));
}

// ---- server -----------------------------------------------------------------------

class PhoneLink {
  constructor({ getConfig, saveConfig, payload, onChange = () => {}, now = Date.now, createServer = http.createServer, hostname = os.hostname() } = {}) {
    this.getConfig = getConfig;
    this.saveConfig = saveConfig;
    this.payload = payload;
    this.onChange = onChange;
    this.now = now;
    this.createServer = createServer;
    this.hostname = hostname;
    this.server = null;
    this.listening = false;
    this.error = null;
    this.pending = null; // { code, id, key, expires }
    this.failures = new Map();
  }

  get cfg() {
    return this.getConfig().phone;
  }

  apply() {
    if (this.cfg.enabled) this.start();
    else this.stop();
  }

  start() {
    const port = this.cfg.port;
    if (this.server && this.server.port === port) return;
    this.stop();
    const server = this.createServer((req, res) => this.handle(req, res));
    server.port = port;
    this.server = server;
    server.on("error", (err) => {
      if (this.server !== server) return;
      this.listening = false;
      this.error = err.code === "EADDRINUSE" ? `Port ${port} is already in use. Pick another port.` : err.message;
      this.onChange();
    });
    server.listen(port, "0.0.0.0", () => {
      if (this.server !== server) return;
      this.listening = true;
      this.error = null;
      this.onChange();
    });
  }

  stop() {
    this.pending = null;
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    this.listening = false;
    try {
      server.close();
      // Drop kept-alive connections too, so turning sharing off takes effect at once.
      server.closeAllConnections();
    } catch {
      /* not listening */
    }
    this.onChange();
  }

  startPairing() {
    const code = newCode();
    this.pending = { code, id: deviceId(code), key: masterKey(code), expires: this.now() + PAIRING_TTL_MS };
    this.onChange();
    return this.status();
  }

  cancelPairing() {
    this.pending = null;
    this.onChange();
  }

  removeDevice(id) {
    const phone = this.cfg;
    phone.devices = phone.devices.filter((d) => d.id !== id);
    this.saveConfig();
    this.onChange();
  }

  status() {
    const now = this.now();
    if (this.pending && now > this.pending.expires) this.pending = null;
    const addresses = localAddresses();
    const pairing = this.pending
      ? {
          code: formatCode(this.pending.code),
          expires_at: this.pending.expires,
          link: pairingLink({ code: this.pending.code, addresses, port: this.cfg.port, name: this.hostname }),
        }
      : null;
    return {
      enabled: this.cfg.enabled,
      listening: this.listening,
      error: this.error,
      port: this.cfg.port,
      addresses,
      name: this.hostname,
      devices: this.cfg.devices.map(({ id, name, created_at, last_seen }) => ({ id, name, created_at, last_seen })),
      pairing,
    };
  }

  tooManyFailures(ip) {
    const now = this.now();
    const f = this.failures.get(ip);
    return !!f && now - f.since < 60_000 && f.count >= FAILURE_LIMIT;
  }

  fail(ip) {
    const now = this.now();
    const f = this.failures.get(ip);
    if (!f || now - f.since >= 60_000) this.failures.set(ip, { since: now, count: 1 });
    else f.count++;
    if (this.failures.size > 1000) this.failures.clear();
  }

  // Returns { device, key, time } for a correctly signed request, else null.
  authenticate(req, pathname) {
    const id = String(req.headers["x-um-id"] || "");
    const time = Number(req.headers["x-um-time"]);
    const sig = String(req.headers["x-um-sig"] || "");
    if (!/^[0-9a-f]{16}$/.test(id) || !Number.isFinite(time) || Math.abs(this.now() - time) > MAX_SKEW_MS) return null;
    let device = this.cfg.devices.find((d) => d.id === id);
    let key = device ? Buffer.from(device.key, "base64url") : null;
    const pending = this.pending && this.pending.id === id && this.now() <= this.pending.expires ? this.pending : null;
    if (!key && pending) key = pending.key;
    if (!key) return null;
    const expected = Buffer.from(sign(key, req.method, pathname, time), "utf8");
    const given = Buffer.from(sig, "utf8");
    if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;
    if (!device) {
      // First signed request from the phone completes the pairing.
      const name = decodeURIComponent(String(req.headers["x-um-name"] || "")).replace(/[\u0000-\u001f]/g, "").trim().slice(0, 60) || "Phone";
      device = { id, key: key.toString("base64url"), name, created_at: this.now(), last_seen: null };
      this.cfg.devices = [...this.cfg.devices.filter((d) => d.id !== id), device];
      this.pending = null;
    }
    return { device, key, time };
  }

  handle(req, res) {
    const ip = req.socket.remoteAddress || "?";
    const url = new URL(req.url, "http://phone.invalid");
    const reply = (status, body) => {
      res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify(body));
    };
    if (req.method !== "GET" || !["/v1/ping", "/v1/snapshot"].includes(url.pathname)) return reply(404, { error: "not found" });
    if (this.tooManyFailures(ip)) return reply(429, { error: "too many attempts" });
    const auth = this.authenticate(req, url.pathname);
    if (!auth) {
      this.fail(ip);
      return reply(401, { error: "not paired" });
    }
    const wasSeen = auth.device.last_seen;
    auth.device.last_seen = this.now();
    // Save right away for a new pairing; otherwise at most every 10 minutes.
    if (!wasSeen || this.now() - wasSeen > 10 * 60_000) {
      this.saveConfig();
      this.onChange();
    }
    const body = url.pathname === "/v1/ping" ? { ok: true, name: this.hostname } : this.payload();
    reply(200, encrypt(auth.key, auth.time, body));
  }
}

module.exports = {
  PhoneLink,
  newCode,
  formatCode,
  normalizeCode,
  deviceId,
  masterKey,
  subKey,
  sign,
  encrypt,
  decrypt,
  pairingLink,
  localAddresses,
  PROTOCOL,
};
