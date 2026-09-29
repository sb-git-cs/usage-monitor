const test = require("node:test");
const assert = require("node:assert/strict");
const { cpuUsage, storageUsage, percent } = require("../src/system");
const { load } = require("./helpers");

test("CPU uses elapsed ticks across every core, never lifetime average", () => {
  assert.equal(cpuUsage([{ idle: 1000, total: 2000 }, { idle: 2000, total: 3000 }],
    [{ idle: 1050, total: 2100 }, { idle: 2100, total: 3100 }]), 25);
  assert.equal(cpuUsage([], []), null);
  assert.equal(cpuUsage([{ idle: 10, total: 20 }], [{ idle: 10, total: 20 }]), null);
  assert.equal(cpuUsage([{ idle: 10, total: 20 }], [{ idle: 0, total: 10 }]), null);
  for (const value of [null, undefined, NaN, -1, "50"]) assert.equal(percent(value), null);
});

test("storage highlights the fullest drive and excludes unavailable volumes", () => {
  const result = storageUsage([{ mount: "C:", used: 90, size: 100 }, { mount: "D:", used: 100, size: 1000 }, { size: 0, used: 0 }]);
  assert.equal(result.space, 90);
  assert.equal(result.volumes.length, 2);
  assert.equal(storageUsage([]).space, null);
});

test("hardware normalizes Windows samples and keeps missing readings unknown", async () => {
  if (process.platform !== "win32") return;
  const api = load("src/system.js", { "node:child_process": {
    execFile(_cmd, _args, opts, cb) {
      assert.equal(opts.windowsHide, true);
      assert.ok(opts.timeout > 0);
      cb(null, JSON.stringify({ gpuPresent: true, gpu: null, disks: [{ name: "C:", busy: 15 }, { name: "D:", busy: 70 }] }));
    },
  } }, ["hardwareSample"]);
  const sample = await api.hardwareSample();
  assert.equal(sample.disk, 70);
  assert.equal(sample.gpu, null);
  assert.equal(sample.gpuPresent, true);
});

test("collector consumes failed probes and does not publish results after stopping", async () => {
  let finishStorage;
  const api = load("src/system.js", { systeminformation: {
    mem: async () => ({ total: 100, available: 20 }),
    fsSize: () => new Promise(resolve => { finishStorage = resolve; }),
    graphics: async () => { throw new Error("unavailable"); }, fsStats: async () => ({ rx_sec: null, wx_sec: null }),
  }, "node:child_process": { execFile(_c, _a, _o, cb) { cb(new Error("unavailable")); } } });
  const seen = [];
  const poll = api.start(s => seen.push(s));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(seen.at(-1).disk, null);
  assert.equal(seen.at(-1).space, null);
  poll.stop();
  const count = seen.length;
  finishStorage([{ mount: "C:", used: 50, size: 100 }]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(seen.length, count);
});

test("memory is read from os on Windows without starting systeminformation's PowerShell query", async () => {
  const api = load("src/system.js", {
    "node:os": { totalmem: () => 1000, freemem: () => 250, cpus: () => [] },
    systeminformation: { mem: async () => { throw new Error("si.mem spawns PowerShell on Windows"); } },
  });
  assert.equal(await api.memoryUsage("win32"), 75);
  const other = load("src/system.js", { systeminformation: { mem: async () => ({ total: 100, available: 20 }) } });
  assert.equal(await other.memoryUsage("linux"), 80);
  const empty = load("src/system.js", { systeminformation: { mem: async () => ({ total: 0, available: 0 }) } });
  assert.equal(await empty.memoryUsage("darwin"), null);
});

test("a stalled hardware probe clears its readings but keeps the GPU chip", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"] });
  let hardwareCalls = 0;
  const api = load("src/system.js", {
    systeminformation: {
      mem: async () => ({ total: 100, available: 50 }), fsSize: async () => [],
      graphics: async () => (hardwareCalls++ === 0 ? { controllers: [{ utilizationGpu: 40 }] } : new Promise(() => {})),
      fsStats: async () => ({ rx_sec: 1, wx_sec: 1 }),
    },
    "node:child_process": { execFile(_c, _a, _o, cb) { if (hardwareCalls++ === 0) cb(null, JSON.stringify({ gpuPresent: true, gpu: 40, disks: [] })); } },
  });
  const seen = [];
  const poll = api.start(s => seen.push(s));
  const flush = () => new Promise(resolve => setImmediate(resolve));
  await flush();
  assert.equal(seen.at(-1).gpu, 40);
  // The second probe starts at 5s and never returns; it counts as stalled once it is older than 15s.
  for (let i = 0; i < 5; i++) { t.mock.timers.tick(5000); await flush(); }
  poll.stop();
  assert.equal(seen.at(-1).gpu, null, "stale usage is discarded after 15 seconds");
  assert.equal(seen.at(-1).gpuPresent, true, "the GPU chip stays visible");
});
