const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const phone = require("../src/phone");
const vectors = require("./fixtures/phone-vectors.json");

// These vectors are also checked by the Android app's unit tests (PairingCryptoTest), so
// both sides derive the same ids and keys and read each other's messages.
test("pairing crypto matches the shared test vectors", () => {
  const master = phone.masterKey(vectors.code);
  assert.equal(phone.normalizeCode(vectors.code), vectors.normalized);
  assert.equal(phone.deviceId(vectors.code), vectors.device_id);
  assert.equal(master.toString("base64url"), vectors.master_key);
  assert.equal(phone.subKey(master, "um-mac-v1").toString("base64url"), vectors.mac_key);
  assert.equal(phone.subKey(master, "um-enc-v1").toString("base64url"), vectors.enc_key);
  assert.equal(phone.sign(master, vectors.method, vectors.path, vectors.time), vectors.signature);
  const box = phone.encrypt(master, vectors.time, JSON.parse(vectors.plaintext), Buffer.from(vectors.iv, "base64url"));
  assert.deepEqual(box, vectors.box);
  assert.deepEqual(phone.decrypt(master, vectors.time, vectors.box), JSON.parse(vectors.plaintext));
  assert.throws(() => phone.decrypt(master, vectors.time + 1, vectors.box), "a reply bound to another request is rejected");
  assert.equal(phone.pairingLink({ code: vectors.normalized, addresses: ["192.168.1.20", "100.101.102.103"], port: 47329, name: "Studio PC" }), vectors.link);
});

test("codes use an unambiguous alphabet and lists LAN addresses first", () => {
  const code = phone.newCode();
  assert.match(code, /^[ABCDEFGHJKMNPQRSTVWXYZ2-9]{20}$/);
  assert.match(phone.formatCode(code), /^(\w{5}-){3}\w{5}$/);
  const list = phone.localAddresses({
    lo: [{ family: "IPv4", address: "127.0.0.1", internal: true }],
    tailscale0: [{ family: "IPv4", address: "100.101.102.103", internal: false }],
    wlan0: [{ family: "IPv4", address: "192.168.1.20", internal: false }, { family: "IPv6", address: "fe80::1", internal: false }],
    eth9: [{ family: "IPv4", address: "169.254.3.3", internal: false }],
  });
  assert.deepEqual(list, ["192.168.1.20", "100.101.102.103"]);
});

function request(port, { path = "/v1/snapshot", headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port, path, headers, agent: false }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, body: body ? JSON.parse(body) : null }));
    }).on("error", reject);
  });
}

function signed(code, time, path = "/v1/snapshot", extra = {}, method = "GET") {
  const key = phone.masterKey(code);
  return { "X-UM-Id": phone.deviceId(code), "X-UM-Time": String(time), "X-UM-Sig": phone.sign(key, method, path, time), ...extra };
}

function post(port, path, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, method: "POST", headers, agent: false }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, body: body ? JSON.parse(body) : null }));
    });
    req.on("error", reject);
    req.end();
  });
}

async function startLink(t, overrides = {}) {
  let now = Date.now();
  const cfg = { phone: { enabled: true, port: 0, devices: [] } };
  let saves = 0;
  const link = new phone.PhoneLink({
    getConfig: () => cfg,
    saveConfig: () => saves++,
    payload: () => ({ v: 1, providers: [{ id: "claude", windows: [{ kind: "five_hour", used_pct: 42 }] }] }),
    now: () => now,
    hostname: "desk",
    ...overrides,
  });
  link.apply();
  await new Promise((resolve) => link.server.once("listening", resolve));
  t.after(() => link.stop());
  return { link, cfg, port: link.server.address().port, clock: { set: (v) => (now = v), get: () => now }, saves: () => saves };
}

test("a phone pairs with the code, then reads encrypted meters", async (t) => {
  const { link, cfg, port, clock, saves } = await startLink(t);
  const { pairing } = link.startPairing();
  const code = pairing.code;
  assert.match(pairing.link, /^usagemonitor:\/\/pair\?h=/);
  const time = clock.get();
  const res = await request(port, { path: "/v1/ping", headers: signed(code, time, "/v1/ping", { "X-UM-Name": encodeURIComponent("Pixel 8") }) });
  assert.equal(res.status, 200);
  assert.deepEqual(phone.decrypt(phone.masterKey(code), time, res.body), { ok: true, name: "desk" });
  assert.equal(cfg.phone.devices.length, 1);
  assert.equal(cfg.phone.devices[0].name, "Pixel 8");
  assert.equal(link.status().pairing, null, "a code pairs one phone");
  assert.ok(saves() >= 1, "the pairing is saved");

  const t2 = clock.get() + 1000;
  clock.set(t2);
  const snap = await request(port, { headers: signed(code, t2) });
  assert.equal(snap.status, 200);
  assert.equal(phone.decrypt(phone.masterKey(code), t2, snap.body).providers[0].windows[0].used_pct, 42);
  assert.deepEqual(Object.keys(snap.body).sort(), ["data", "iv", "v"]);
  assert.ok(!/used_pct|claude/.test(Buffer.from(snap.body.data, "base64url").toString("latin1")), "nothing readable on the wire");
});

test("unsigned, wrongly signed, stale and unknown requests are refused", async (t) => {
  const { link, port, clock } = await startLink(t);
  const code = link.startPairing().pairing.code;
  const now = clock.get();
  assert.equal((await request(port)).status, 401);
  assert.equal((await request(port, { headers: { ...signed(code, now), "X-UM-Sig": "x".repeat(43) } })).status, 401);
  assert.equal((await request(port, { headers: signed(code, now - 6 * 60_000) })).status, 401, "more than five minutes off");
  assert.equal((await request(port, { headers: signed(phone.newCode(), now) })).status, 401);
  assert.equal((await request(port, { path: "/admin" })).status, 404);
  clock.set(now + 11 * 60_000);
  assert.equal((await request(port, { headers: signed(code, now + 11 * 60_000) })).status, 401, "an unused code expires");
});

test("repeated failures from one address are rate limited", async (t) => {
  const { port } = await startLink(t);
  for (let i = 0; i < 20; i++) await request(port);
  assert.equal((await request(port)).status, 429);
});

test("removing a phone revokes it, and turning sharing off closes the port", async (t) => {
  const { link, cfg, port, clock } = await startLink(t);
  const code = link.startPairing().pairing.code;
  assert.equal((await request(port, { headers: signed(code, clock.get()) })).status, 200);
  link.removeDevice(phone.deviceId(code));
  assert.equal((await request(port, { headers: signed(code, clock.get()) })).status, 401);
  cfg.phone.enabled = false;
  link.apply();
  await assert.rejects(request(port), /ECONNREFUSED/);
});

test("a paired phone can ask the computer to switch an account", async (t) => {
  const asked = [];
  const { link, port, clock } = await startLink(t, { onAccount: (provider, id) => asked.push([provider, id]) });
  const code = link.startPairing().pairing.code;
  const time = clock.get();
  assert.equal((await request(port, { path: "/v1/ping", headers: signed(code, time, "/v1/ping") })).status, 200);
  const path = "/v1/account/claude";
  const res = await post(port, path, signed(code, time, path, {}, "POST"));
  assert.equal(res.status, 200);
  assert.deepEqual(phone.decrypt(phone.masterKey(code), time, res.body), { ok: true, provider: "claude", account: null });
  assert.deepEqual(asked, [["claude", null]]);
  const picked = "/v1/account/grok/user-1";
  const second = await post(port, picked, signed(code, time, picked, {}, "POST"));
  assert.deepEqual(phone.decrypt(phone.masterKey(code), time, second.body), { ok: true, provider: "grok", account: "user-1" });
  assert.deepEqual(asked[1], ["grok", "user-1"]);
  for (const tool of ["cursor", "copilot"]) {
    const toolPath = `/v1/account/${tool}`;
    const toolRes = await post(port, toolPath, signed(code, time, toolPath, {}, "POST"));
    assert.deepEqual(phone.decrypt(phone.masterKey(code), time, toolRes.body), { ok: true, provider: tool, account: null });
  }
  assert.equal((await post(port, "/v1/account/nope", signed(code, time, "/v1/account/nope", {}, "POST"))).status, 404);
  assert.equal((await post(port, path, signed(code, time, path))).status, 401, "a GET signature does not authorize the switch");
  assert.equal(asked.length, 4);
});

test("tokens are served only after the computer allows direct reading, until it is stopped", async (t) => {
  const asked = [];
  let tokenCalls = 0;
  const { link, cfg, port, clock } = await startLink(t, {
    onLink: (device) => asked.push(device.id),
    tokens: async () => {
      tokenCalls++;
      return { claude: { access_token: "at-1", expires_at: 123, plan: "Max" } };
    },
  });
  const code = link.startPairing().pairing.code;
  const id = phone.deviceId(code);
  const key = phone.masterKey(code);
  const time = clock.get();
  assert.equal((await request(port, { path: "/v1/ping", headers: signed(code, time, "/v1/ping") })).status, 200);

  assert.equal((await request(port, { path: "/v1/tokens", headers: signed(code, time, "/v1/tokens") })).status, 403);
  assert.equal(tokenCalls, 0, "nothing is read before the computer allows it");

  const linked = await post(port, "/v1/link", signed(code, time, "/v1/link", {}, "POST"));
  assert.deepEqual(phone.decrypt(key, time, linked.body), { ok: true, direct: false });
  assert.deepEqual(asked, [id], "the computer is asked to confirm");
  assert.equal(cfg.phone.devices[0].direct, undefined, "asking alone grants nothing");

  link.setDirect(id, true);
  assert.equal(link.status().devices[0].direct, true);
  const res = await request(port, { path: "/v1/tokens", headers: signed(code, time, "/v1/tokens") });
  assert.equal(res.status, 200);
  const body = phone.decrypt(key, time, res.body);
  assert.deepEqual(body.tokens, { claude: { access_token: "at-1", expires_at: 123, plan: "Max" } });
  assert.ok(!/at-1/.test(Buffer.from(res.body.data, "base64url").toString("latin1")), "tokens are encrypted on the wire");
  assert.equal((await post(port, "/v1/link", signed(code, time, "/v1/link", {}, "POST"))).status, 200);
  assert.equal(asked.length, 1, "an allowed phone is not asked about again");

  const stopped = await post(port, "/v1/unlink", signed(code, time, "/v1/unlink", {}, "POST"));
  assert.deepEqual(phone.decrypt(key, time, stopped.body), { ok: true, direct: false });
  assert.equal((await request(port, { path: "/v1/tokens", headers: signed(code, time, "/v1/tokens") })).status, 403);
  assert.equal((await request(port, { path: "/v1/tokens", headers: signed(code, time, "/v1/snapshot") })).status, 401, "a signature for another path is refused");
});

test("beginPairing turns sharing on without dropping the new code", () => {
  const cfg = { phone: { enabled: false, port: 9, devices: [] } };
  let pendingAtListen = "not-called";
  const link = new phone.PhoneLink({
    getConfig: () => cfg,
    saveConfig: () => {},
    payload: () => ({}),
    createServer() {
      return {
        on() {},
        listen(_port, _host, cb) {
          pendingAtListen = link.pending;
          cb();
        },
        close() {},
        closeAllConnections() {},
      };
    },
  });
  const first = link.beginPairing();
  assert.equal(cfg.phone.enabled, true);
  assert.equal(link.listening, true);
  assert.equal(pendingAtListen, null);
  assert.match(first.pairing.code, /^(\w{5}-){3}\w{5}$/);
  assert.equal(link.beginPairing().pairing.code, first.pairing.code);
  link.cancelPairing();
  assert.equal(link.status().pairing, null);
  assert.notEqual(link.beginPairing().pairing.code, first.pairing.code);
});

test("a pending token response respects revoked direct reading and removed phones", async (t) => {
  for (const revoke of ["unlink", "remove"]) {
    let finishTokens;
    let started;
    const reading = new Promise((resolve) => { started = resolve; });
    const { link, port, clock } = await startLink(t, {
      tokens: () => new Promise((resolve) => { finishTokens = resolve; started(); }),
    });
    const code = link.startPairing().pairing.code;
    const id = phone.deviceId(code);
    const time = clock.get();
    await request(port, { path: "/v1/ping", headers: signed(code, time, "/v1/ping") });
    link.setDirect(id, true);
    const pending = request(port, { path: "/v1/tokens", headers: signed(code, time, "/v1/tokens") });
    await reading;
    if (revoke === "unlink") link.setDirect(id, false);
    else link.removeDevice(id);
    finishTokens({ claude: { access_token: "must-not-be-sent" } });
    const response = await pending;
    assert.equal(response.status, revoke === "unlink" ? 403 : 401);
    assert.equal(response.body.data, undefined, "revoked requests receive no encrypted token payload");
  }
});
