// Shares the plan meters with a paired phone over the local network. Off until the user
// turns it on, or clicks Pair a phone (that turns it on). Protocol (docs/phone-protocol.md):
//   Pairing: the desktop shows a 20-character code, in a QR code with its addresses. Both
//   sides derive the device id and keys from the code, so the code never crosses the network.
//   Requests: X-UM-Id, X-UM-Time and X-UM-Sig (HMAC-SHA256 of method, path and time).
//   GET /v1/ping and GET /v1/snapshot read the computer. POST /v1/account/<tool> asks it to
//   open that tool's sign-in; POST /v1/account/<tool>/<id> selects a saved sign-in.
//   POST /v1/link asks to read usage directly (confirmed here), POST /v1/unlink stops it, and
//   GET /v1/tokens then returns current access tokens; refresh tokens never leave this computer.
//   POST /v1/rekey replaces the code-derived key with a random one, used from the next request.
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
  constructor({ getConfig, saveConfig, payload, tokens = async () => ({}), onChange = () => {}, onAccount = () => {}, onLink = () => {}, now = Date.now, createServer = http.createServer, hostname = os.hostname() } = {}) {
    this.getConfig = getConfig;
    this.saveConfig = saveConfig;
    this.payload = payload;
    this.tokens = tokens;
    this.onChange = onChange;
    this.onAccount = onAccount;
    this.onLink = onLink;
    this.now = now;
    this.createServer = createServer;
    this.hostname = hostname;
    this.server = null;
    this.listening = false;
    this.error = null;
    this.pending = null; // { code, id, key, expires }
    this.failures = new Map();
    this.seen = new Map(); // signed POST requests already acted on -> when they stop being accepted
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
    server.requestTimeout = 10000;
    server.headersTimeout = 5000;
    server.maxHeadersCount = 40;
    server.maxConnections = 32;
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

  // Sharing starts here when it was off. apply() runs before the code is created, because
  // starting the listener clears any code already waiting. A repeat call keeps the current
  // code so a second click does not invalidate a QR code already on screen.
  beginPairing() {
    if (!this.cfg.enabled) this.cfg.enabled = true;
    this.apply();
    if (!this.pending || this.now() > this.pending.expires) return this.startPairing();
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

  // Lets a paired phone read usage directly with this computer's sign-ins, or stops it.
  setDirect(id, direct) {
    const device = this.cfg.devices.find((d) => d.id === id);
    if (!device || device.direct === direct) return;
    device.direct = direct;
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
      devices: this.cfg.devices.map(({ id, name, created_at, last_seen, direct }) => ({ id, name, created_at, last_seen, direct: !!direct })),
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

  // A signed request stays valid for MAX_SKEW_MS, so a copy recorded on the network could ask
  // again. Requests that change something are accepted once; the phone signs each one afresh.
  replayed(auth, method, pathname) {
    const now = this.now();
    for (const [key, until] of this.seen) if (until < now) this.seen.delete(key);
    const key = `${auth.device.id}|${method}|${pathname}|${auth.time}`;
    if (this.seen.has(key)) return true;
    if (this.seen.size >= 1000) this.seen.delete(this.seen.keys().next().value);
    this.seen.set(key, auth.time + MAX_SKEW_MS);
    return false;
  }

  // Returns { device, key, time } for a correctly signed request, { skewed: true } for a correct
  // signature from a phone whose clock is more than MAX_SKEW_MS off, else null.
  authenticate(req, pathname) {
    const id = String(req.headers["x-um-id"] || "");
    const time = Number(req.headers["x-um-time"]);
    const sig = String(req.headers["x-um-sig"] || "");
    if (!/^[0-9a-f]{16}$/.test(id) || !Number.isFinite(time)) return null;
    let device = this.cfg.devices.find((d) => d.id === id);
    const pending = this.pending && this.pending.id === id && this.now() <= this.pending.expires ? this.pending : null;
    // A rotated key (/v1/rekey) replaces the current one at its first use; until then both work.
    const keys = device ? [device.key, device.next_key].filter(Boolean).map((k) => Buffer.from(k, "base64url")) : pending ? [pending.key] : [];
    const given = Buffer.from(sig, "utf8");
    const key = keys.find((k) => {
      const expected = Buffer.from(sign(k, req.method, pathname, time), "utf8");
      return expected.length === given.length && crypto.timingSafeEqual(expected, given);
    });
    if (!key) return null;
    if (Math.abs(this.now() - time) > MAX_SKEW_MS) return { skewed: true };
    if (device && device.next_key && key.toString("base64url") === device.next_key) {
      device.key = device.next_key;
      delete device.next_key;
      this.saveConfig();
    }
    if (!device) {
      // First signed request from the phone completes the pairing.
      let decoded;
      try { decoded = decodeURIComponent(String(req.headers["x-um-name"] || "")); } catch { return null; }
      const name = decoded.replace(/[\u0000-\u001f]/g, "").trim().slice(0, 60) || "Phone";
      device = { id, key: key.toString("base64url"), name, created_at: this.now(), last_seen: null };
      this.cfg.devices = [...this.cfg.devices.filter((d) => d.id !== id), device];
      this.pending = null;
    }
    return { device, key, time };
  }

  handle(req, res) {
    const ip = req.socket.remoteAddress || "?";
    const reply = (status, body) => {
      if (res.destroyed || res.writableEnded) return;
      res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify(body));
    };
    let url;
    try { url = new URL(req.url, "http://phone.invalid"); } catch { return reply(400, { error: "invalid request" }); }
    // Native paired clients do not send browser Origin headers. Do not expose a LAN API to web pages.
    if (req.headers.origin) return reply(403, { error: "browser requests are not supported" });
    const accountRoute = /^\/v1\/account\/(claude|codex|gemini|grok|cursor|copilot)(?:\/([A-Za-z0-9_.:@-]{1,200}))?$/.exec(url.pathname);
    const reading = req.method === "GET" && ["/v1/ping", "/v1/snapshot", "/v1/tokens"].includes(url.pathname);
    const switching = req.method === "POST" && accountRoute;
    const linking = req.method === "POST" && ["/v1/link", "/v1/unlink"].includes(url.pathname);
    const rekeying = req.method === "POST" && url.pathname === "/v1/rekey";
    if (!reading && !switching && !linking && !rekeying) return reply(404, { error: "not found" });
    if (this.tooManyFailures(ip)) return reply(429, { error: "too many attempts" });
    const auth = this.authenticate(req, url.pathname);
    if (!auth) {
      this.fail(ip);
      return reply(401, { error: "not paired" });
    }
    // Still paired; "pair again" would not help when the phone's clock is wrong.
    if (auth.skewed) return reply(400, { error: "clock" });
    req.resume();
    if ((switching || linking || rekeying) && this.replayed(auth, req.method, url.pathname)) return reply(409, { error: "repeated request" });
    const wasSeen = auth.device.last_seen;
    auth.device.last_seen = this.now();
    // Save right away for a new pairing; otherwise at most every 10 minutes.
    if (!wasSeen || this.now() - wasSeen > 10 * 60_000) {
      this.saveConfig();
      this.onChange();
    }
    if (rekeying) {
      // The pairing code was on screen and its key derives from it, so the phone swaps it for a
      // random key that was never shown. A lost reply leaves the current key working.
      auth.device.next_key = crypto.randomBytes(32).toString("base64url");
      this.saveConfig();
      return reply(200, encrypt(auth.key, auth.time, { ok: true, key: auth.device.next_key }));
    }
    if (switching) {
      const provider = accountRoute[1];
      const account = accountRoute[2] || null;
      reply(200, encrypt(auth.key, auth.time, { ok: true, provider, account }));
      try { this.onAccount(provider, account); } catch { /* a dialog failure must not take the link down */ }
      return;
    }
    if (linking) {
      // Linking is confirmed on this computer; stopping needs no confirmation.
      if (url.pathname === "/v1/unlink") this.setDirect(auth.device.id, false);
      reply(200, encrypt(auth.key, auth.time, { ok: true, direct: !!auth.device.direct }));
      if (url.pathname === "/v1/link" && !auth.device.direct) {
        try { this.onLink(auth.device); } catch { /* a dialog failure must not take the link down */ }
      }
      return;
    }
    if (url.pathname === "/v1/tokens") {
      if (!auth.device.direct) return reply(403, { error: "direct reading is off" });
      Promise.resolve()
        .then(() => this.tokens())
        .then((tokens) => {
          // Token readers may renew a sign-in asynchronously; access can be revoked meanwhile.
          const device = this.cfg.devices.find((d) => d.id === auth.device.id && d.key === auth.device.key);
          if (!device) return reply(401, { error: "not paired" });
          if (!this.cfg.enabled || !device.direct) return reply(403, { error: "direct reading is off" });
          if (res.destroyed) return;
          reply(200, encrypt(auth.key, auth.time, { v: 1, generated_at: new Date(this.now()).toISOString(), tokens: tokens || {} }));
        })
        .catch(() => reply(500, { error: "tokens unavailable" }));
      return;
    }
    try {
      const body = url.pathname === "/v1/ping" ? { ok: true, name: this.hostname } : this.payload();
      reply(200, encrypt(auth.key, auth.time, body));
    } catch { reply(500, { error: "reading unavailable" }); }
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
