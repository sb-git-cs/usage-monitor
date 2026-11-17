const test = require("node:test");
const assert = require("node:assert/strict");
const { cpuUsage, storageUsage, percent } = require("../src/system");
const { load } = require("./helpers");

// A stand-in for the resident Windows helper's "sys" channel: answer(n, request) gives the nth
// reply, as a value (sent as JSON), a string (sent as is), or undefined to never answer.
function fakeHelper(answer = () => ({ gpuPresent: false, gpu: null, disks: [] })) {
  const requests = [];
  let n = 0;
  return {
    requests,
    request(channel, payload) {
      assert.equal(channel, "sys");
      requests.push(payload);
      const reply = answer(n++, payload);
      if (reply === undefined) return new Promise(() => {});
      return Promise.resolve(typeof reply === "string" ? reply : JSON.stringify(reply));
    },
  };
}

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
  const fake = fakeHelper(() => ({ gpuPresent: true, gpu: null, disks: [{ name: "C:", busy: 15 }, { name: "D:", busy: 70 }] }));
  const api = load("src/system.js", { "./winhelper": fake }, ["hardwareSample"]);
  const sample = await api.hardwareSample(false, "win32");
  assert.equal(sample.disk, 70);
  assert.equal(sample.gpu, null);
  assert.equal(sample.gpuPresent, true);
  assert.equal(sample.space, undefined, "drives are read only when asked");
  const withStorage = await api.hardwareSample(true, "win32");
  assert.equal(withStorage.space, undefined, "a sample without volumes leaves storage unknown");
  assert.deepEqual(fake.requests, ["sample", "sample storage"]);
});

test("the real helper's samples come through as hardware and storage readings", { skip: process.platform !== "win32" }, async () => {
  const api = load("src/system.js", {}, ["hardwareSample"]);
  try {
    for (const s of [await api.hardwareSample(true), await api.hardwareSample(false)]) {
      assert.ok(Array.isArray(s.disks), JSON.stringify(s));
      assert.ok(s.gpu === null || (s.gpu >= 0 && s.gpu <= 100));
      assert.ok(s.disk === null || (s.disk >= 0 && s.disk <= 100));
    }
  } finally {
    require("../src/winhelper").stop();
  }
});

test("collector consumes failed probes and does not publish results after stopping", async () => {
  let finishStorage;
  const api = load("src/system.js", { systeminformation: {
    mem: async () => ({ total: 100, available: 20 }),
    fsSize: () => new Promise(resolve => { finishStorage = resolve; }),
    graphics: async () => { throw new Error("unavailable"); }, fsStats: async () => ({ rx_sec: null, wx_sec: null }),
  }, "./winhelper": { request: async () => { throw new Error("unavailable"); } } });
  const seen = [];
  const poll = api.start(s => seen.push(s));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(seen.at(-1).disk, null);
  assert.equal(seen.at(-1).space, null);
  poll.stop();
  const count = seen.length;
  // On Windows the drives come from the hardware helper, not systeminformation.
  if (finishStorage) finishStorage([{ mount: "C:", used: 50, size: 100 }]);
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
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout", "Date"] });
  let hardwareCalls = 0;
  const fake = fakeHelper((n) => (n === 0 ? { gpuPresent: true, gpu: 40, disks: [] } : undefined));
  const api = load("src/system.js", {
    systeminformation: {
      mem: async () => ({ total: 100, available: 50 }), fsSize: async () => [],
      graphics: async () => (hardwareCalls++ === 0 ? { controllers: [{ utilizationGpu: 40 }] } : new Promise(() => {})),
      fsStats: async () => ({ rx_sec: 1, wx_sec: 1 }),
    },
    "./winhelper": fake,
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

test("on Windows the hardware helper also reads the drives, every sixth sample", { skip: process.platform !== "win32" }, async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout", "Date"] });
  const fake = fakeHelper((n, line) => (
    { gpuPresent: false, gpu: null, disks: [], ...(line === "sample storage" ? { volumes: [{ mount: "C:", used: 90, size: 100 }] } : {}) }));
  const requests = fake.requests;
  const api = load("src/system.js", {
    systeminformation: { fsSize: async () => { throw new Error("si.fsSize starts PowerShell on Windows"); } },
    "./winhelper": fake,
  });
  const seen = [];
  const poll = api.start((s) => seen.push(s));
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  await flush();
  assert.equal(seen.at(-1).space, 90);
  for (let i = 0; i < 6; i++) { t.mock.timers.tick(5000); await flush(); }
  poll.stop();
  assert.deepEqual(requests, ["sample storage", "sample", "sample", "sample", "sample", "sample", "sample storage"]);
});

test("paused sampling stops reading until it resumes", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout", "Date"] });
  let reads = 0;
  const fake = fakeHelper(() => { reads++; return { gpuPresent: false, gpu: null, disks: [] }; });
  const api = load("src/system.js", {
    // Off Windows the GPU list is cached, so the disk probe is what each sample reads.
    systeminformation: { fsSize: async () => [], graphics: async () => { reads++; return { controllers: [] }; }, fsStats: async () => { reads++; return { rx_sec: 0, wx_sec: 0 }; }, mem: async () => ({ total: 1, available: 1 }) },
    "./winhelper": fake,
  });
  const poll = api.start(() => {});
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  await flush();
  poll.setPaused(true);
  const before = reads;
  for (let i = 0; i < 4; i++) { t.mock.timers.tick(5000); await flush(); }
  assert.equal(reads, before, "nothing is sampled while paused");
  poll.setPaused(false);
  await flush();
  assert.ok(reads > before, "sampling restarts at once");
  poll.stop();
});

test("off Windows the GPU list is re-read every 10 minutes unless it reports utilization", async (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  let reads = 0;
  let live = false;
  const api = load("src/system.js", { systeminformation: {
    graphics: async () => { reads++; return { controllers: [{ model: "GPU", utilizationGpu: live ? 30 : null }] }; },
    fsStats: async () => ({ rx_sec: 1, wx_sec: 2 }),
  } });
  for (let i = 0; i < 4; i++) assert.equal((await api.hardwareSample(false, "darwin")).gpuPresent, true);
  assert.equal(reads, 1, "system_profiler is not started every 5 seconds");
  t.mock.timers.tick(600001);
  live = true;
  assert.equal((await api.hardwareSample(false, "linux")).gpu, 30);
  await api.hardwareSample(false, "linux");
  assert.equal(reads, 3, "a GPU that reports utilization is read every sample");
});


test("hardware and battery requests go to the helper's sys channel, and simultaneous callers share a reading", async () => {
  const fake = fakeHelper((n, line) => ({ request: line }));
  const api = load("src/system.js", { "./winhelper": fake }, ["windowsSample", "stopWindowsWorker"]);
  const hardware = api.windowsSample("sample storage");
  const battery = api.batterySample();
  assert.equal(api.batterySample(), battery, "simultaneous battery callers share a reading");
  assert.deepEqual(await hardware, { request: "sample storage" });
  assert.deepEqual(await battery, { request: "battery" });
  assert.notEqual(api.batterySample(), battery, "a finished reading is not reused");
  assert.deepEqual(fake.requests, ["sample storage", "battery", "battery"]);
});

test("stopping the sampler forgets its shared readings and leaves the helper to the app", async () => {
  let stopped = 0;
  const fake = { ...fakeHelper(() => undefined), stop: () => { stopped++; } };
  const api = load("src/system.js", { "./winhelper": fake }, ["windowsSample", "stopWindowsWorker"]);
  const battery = api.batterySample();
  api.stopWindowsWorker();
  assert.notEqual(api.batterySample(), battery, "a reading asked for after stopping is a new one");
  assert.equal(stopped, 0, "the sessions and the taskbar still use the helper");
});

test("a failed shared request does not poison the next request", async () => {
  const fake = fakeHelper((n, line) => (n === 0 ? "invalid json" : { request: line }));
  const api = load("src/system.js", { "./winhelper": fake }, ["windowsSample", "stopWindowsWorker"]);
  const hardware = api.windowsSample();
  const battery = api.batterySample();
  await assert.rejects(hardware, SyntaxError);
  assert.deepEqual(await battery, { request: "battery" });
  assert.deepEqual(await api.windowsSample(), { request: "sample" }, "the failed reading is not kept");
});
