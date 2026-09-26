const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Store } = require("../src/net/store");

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "usage-monitor-net-"));
}

test("usage is buffered, merged into totals before flushing, and persisted", (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new Store(path.join(dir, "network.db"));
  const chrome = store.appId("c:\\chrome.exe", "Google Chrome", "C:\\chrome.exe");
  assert.equal(store.appId("c:\\chrome.exe", "Google Chrome", "C:\\chrome.exe"), chrome);
  store.addUsage(chrome, 100, 1000, 10);
  store.addUsage(chrome, 100, 500, 5);
  store.addUsage(chrome, 101, 1, 1);
  assert.deepEqual(store.totals(0), [{ key: "c:\\chrome.exe", name: "Google Chrome", path: "C:\\chrome.exe", rx: 1501, tx: 16, first: 100 }]);
  store.flush();
  store.addUsage(chrome, 101, 9, 9);
  assert.equal(store.totals(101)[0].rx, 10, "flushed and pending rows add up");
  assert.deepEqual(store.series("c:\\chrome.exe", 0), [
    { minute: 100, rx: 1500, tx: 15 },
    { minute: 101, rx: 10, tx: 10 },
  ]);
  assert.equal(store.earliestMinute(), 100);
  store.close();
  const reopened = new Store(path.join(dir, "network.db"));
  assert.equal(reopened.totals(0)[0].rx, 1510, "close flushes pending rows");
  assert.equal(reopened.appInfo("c:\\chrome.exe").name, "Google Chrome");
  reopened.close();
});

test("pruning keeps apps marked keep-forever and deletion is per app or global", (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new Store(path.join(dir, "network.db"));
  const a = store.appId("a", "A", null);
  const b = store.appId("b", "B", null);
  for (const id of [a, b]) {
    store.addUsage(id, 10, 1, 1);
    store.addUsage(id, 50, 1, 1);
    store.addFlow(id, "1.2.3.4", 443, "tcp", "example.com", 5, 5, 10 * 60);
  }
  store.prune(40, ["b"]);
  assert.deepEqual(
    store.totals(0).map((r) => [r.key, r.rx]).sort(),
    [
      ["a", 1],
      ["b", 2],
    ]
  );
  assert.equal(store.connections("a").length, 0);
  assert.equal(store.connections("b").length, 1);
  store.deleteApp("b");
  assert.deepEqual(store.totals(0).map((r) => r.key), ["a"]);
  store.deleteAll();
  assert.deepEqual(store.totals(0), []);
  assert.equal(store.earliestMinute(), null);
  store.close();
});

test("connections merge by endpoint, keep the first and last time seen, and learn domains later", (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new Store(path.join(dir, "network.db"));
  const id = store.appId("app", "App", null);
  store.addFlow(id, "93.184.216.34", 443, "tcp", null, 100, 10, 1000);
  store.flush();
  store.addFlow(id, "93.184.216.34", 443, "tcp", null, 50, 5, 1010);
  store.addFlow(id, "8.8.8.8", 53, "udp", "dns.google", 1, 1, 1005);
  const merged = store.connections("app");
  assert.deepEqual(merged[0], { remote: "93.184.216.34", port: 443, proto: "tcp", domain: null, first_seen: 1000, last_seen: 1010, rx: 150, tx: 15 });
  store.setDomain("93.184.216.34", "example.com");
  assert.equal(store.connections("app")[0].domain, "example.com");
  store.deleteConnections("app");
  assert.deepEqual(store.connections("app"), []);
  store.close();
});

test("records move to a new folder, refuse to overwrite, and can switch to an existing database", (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new Store(path.join(dir, "one", "network.db"));
  store.addUsage(store.appId("x", "X", null), 5, 7, 7);
  const moved = store.relocate(path.join(dir, "two"));
  assert.equal(moved, path.join(dir, "two", "network.db"));
  assert.equal(fs.existsSync(path.join(dir, "one", "network.db")), false);
  assert.equal(store.totals(0)[0].rx, 7);
  const other = new Store(path.join(dir, "three", "network.db"));
  other.addUsage(other.appId("y", "Y", null), 5, 99, 1);
  other.close();
  assert.throws(() => store.relocate(path.join(dir, "three")), /already exists/);
  store.relocate(path.join(dir, "three"), { useExisting: true });
  assert.deepEqual(store.totals(0).map((r) => [r.key, r.rx]), [["y", 99]]);
  assert.equal(fs.existsSync(path.join(dir, "two", "network.db")), true, "switching keeps the previous records");
  store.close();
});

test("a damaged database is set aside instead of stopping the monitor", (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "network.db");
  fs.writeFileSync(file, Buffer.alloc(4096, 0x5a));
  const store = new Store(file);
  assert.ok(store.recovered);
  assert.ok(fs.existsSync(store.recovered.movedTo));
  store.addUsage(store.appId("z", "Z", null), 1, 1, 1);
  assert.equal(store.totals(0).length, 1);
  store.close();
});
