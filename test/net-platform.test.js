const test = require("node:test");
const assert = require("node:assert/strict");
const { load } = require("./helpers");
const { normalizeNet } = require("../src/net/settings");

test("network settings reject malformed values and keep focus and ignore lists apart", () => {
  const n = normalizeNet({
    enabled: "yes",
    retention_minutes: 42,
    range: "999",
    db_dir: "   ",
    focus: [{ key: "a", name: "A" }, { key: "a" }, { key: "b" }, null, { name: "no key" }],
    ignore: [{ key: "b", name: "B" }],
    rules: {
      ok: { name: "OK", blocked: true, cap: { limit_bytes: 100, period: "weekly", used_bytes: -3 } },
      empty: { name: "nothing set" },
      bad: "x",
      badcap: { keep_forever: true, cap: { limit_bytes: 0 } },
    },
  });
  assert.equal(n.enabled, true);
  assert.equal(n.retention_minutes, 60);
  assert.equal(n.range, "60");
  assert.equal(n.db_dir, null);
  assert.deepEqual(n.focus, [{ key: "a", name: "A" }], "an ignored app cannot also be focused");
  assert.deepEqual(n.ignore, [{ key: "b", name: "B" }]);
  assert.deepEqual(Object.keys(n.rules).sort(), ["badcap", "ok"]);
  assert.equal(n.rules.ok.cap.period, "total");
  assert.equal(n.rules.ok.cap.used_bytes, 0);
  assert.equal(n.rules.badcap.cap, null);
  assert.deepEqual(normalizeNet(null).rules, {});
});

test("config carries validated network settings", () => {
  const cfg = load("src/config.js", { fs: { readFileSync: () => JSON.stringify({ net: { retention_minutes: 1440, rules: { k: { keep_forever: true } } } }) } });
  const loaded = cfg.load();
  assert.equal(loaded.net.retention_minutes, 1440);
  assert.equal(loaded.net.rules.k.keep_forever, true);
  assert.equal(cfg.load().net.enabled, true);
});

function fakeSocket() {
  const written = [];
  return { written, write: (s) => written.push(s), destroy() {} };
}

test("Windows helper protocol: samples, DNS, block lists and command results", async () => {
  const { WindowsProvider } = require("../src/net/providers/windows");
  const provider = new WindowsProvider({ workDir: "." });
  const seen = { sample: [], dns: [], blocked: [], status: [] };
  for (const name of Object.keys(seen)) provider.on(name, (v) => seen[name].push(v));
  provider.helperDir = "Z:\\missing";
  provider.socket = fakeSocket();
  provider.onLine('{"t":"hello","protocol":1,"capture":true,"error":null,"firewall":false}');
  assert.equal(seen.status.pop().state, "running");
  assert.match(provider.socket.written[0], /^\d+\tFLOWS\t\n$/);
  provider.onLine('{"t":"blocked","paths":["C:\\\\A.exe"]}');
  provider.onLine('{"t":"blocked","paths":[]}');
  assert.deepEqual(seen.blocked, [
    { paths: ["C:\\A.exe"], initial: true },
    { paths: [], initial: false },
  ]);
  provider.onLine('{"t":"tick","ts":5,"apps":[{"k":"c:\\\\a.exe","p":"C:\\\\a.exe","n":"A","x":"a.exe","rx":1,"tx":2,"pids":[4]}],"flows":[{"k":"c:\\\\a.exe","ip":"1.1.1.1","port":53,"proto":"udp","rx":3,"tx":4}]}');
  assert.deepEqual(seen.sample[0], {
    ts: 5,
    apps: [{ key: "c:\\a.exe", path: "C:\\a.exe", name: "A", rx: 1, tx: 2, pids: [4] }],
    flows: [{ key: "c:\\a.exe", ip: "1.1.1.1", port: 53, proto: "udp", rx: 3, tx: 4 }],
  });
  provider.onLine('{"t":"dns","name":"example.com","ips":["93.184.216.34"]}');
  assert.deepEqual(seen.dns, [{ name: "example.com", ips: ["93.184.216.34"] }]);
  provider.onLine("not json");

  const blocking = provider.setBlocked("C:\\a.exe", true);
  const [id, command, arg] = provider.socket.written.pop().trim().split("\t");
  assert.deepEqual([command, arg], ["BLOCK", "C:\\a.exe"]);
  provider.onLine(JSON.stringify({ t: "result", id, ok: false, error: "denied" }));
  await assert.rejects(blocking, /denied/);
  await assert.rejects(provider.send("BLOCK", "bad\tpath"), /Invalid/);
  provider.socket = null;
  await assert.rejects(provider.setBlocked("C:\\a.exe", false), /not running/);
  provider.stop();
});

test("Windows helper version matches the hash setup.ps1 records", () => {
  const { sourceVersion } = require("../src/net/providers/windows");
  assert.match(sourceVersion(), /^[0-9a-f]{16}$/);
});

test("Linux autostart entries quote paths for the Exec key", () => {
  const { desktopArg } = require("../src/autostart");
  assert.equal(desktopArg('/opt/Usage Monitor/usage "x" $HOME\\'), '"/opt/Usage Monitor/usage \\"x\\" \\$HOME\\\\"');
});
