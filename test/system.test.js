const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const { cpuUsage, storageUsage, percent, createWorker, spawnWorker } = require("../src/system");
const { load } = require("./helpers");

// A stand-in for the PowerShell worker: answer(n) decides the reply to the nth "sample" line
// (a value to send as JSON, or undefined to stay silent).
function fakeWorker(answer = () => ({ gpuPresent: false, gpu: null, disks: [] })) {
  const procs = [];
  const start = () => {
    const proc = new EventEmitter();
    proc.pid = 1000 + procs.length;
    proc.stdout = new PassThrough();
    proc.stdin = new PassThrough();
    proc.killed = false;
    proc.kill = () => { proc.killed = true; setImmediate(() => proc.emit("exit", null)); };
    let n = 0;
    proc.written = "";
    proc.stdin.on("data", (chunk) => {
      proc.written += chunk;
      for (const line of String(chunk).split("\n")) {
        if (line !== "sample") continue;
        const reply = answer(n++, proc);
        if (reply !== undefined) proc.stdout.write(`${JSON.stringify(reply)}\n`);
      }
    });
    procs.push(proc);
    return proc;
  };
  return { start, procs };
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
  if (process.platform !== "win32") return;
  const fake = fakeWorker(() => ({ gpuPresent: true, gpu: null, disks: [{ name: "C:", busy: 15 }, { name: "D:", busy: 70 }] }));
  const api = load("src/system.js", { "node:child_process": {
    spawn(cmd, args, opts) {
      assert.equal(cmd, "powershell.exe");
      assert.ok(args.includes("-EncodedCommand"));
      assert.equal(opts.windowsHide, true);
      return fake.start();
    },
  } }, ["hardwareSample"]);
  const sample = await api.hardwareSample();
  assert.equal(sample.disk, 70);
  assert.equal(sample.gpu, null);
  assert.equal(sample.gpuPresent, true);
  await api.hardwareSample();
  assert.equal(fake.procs.length, 1, "one PowerShell process answers every sample");
});

test("the hardware worker answers many samples from one process", async () => {
  const fake = fakeWorker((n) => ({ gpuPresent: true, gpu: n, disks: [] }));
  const worker = createWorker({ start: fake.start });
  for (let i = 0; i < 5; i++) assert.equal((await worker.sample()).gpu, i);
  assert.equal(fake.procs.length, 1);
  worker.stop();
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(fake.procs[0].written, /exit\n$/, "stop asks the loop to end");
});

test("a stuck or crashed worker is replaced, but not more often than every 30 seconds", async () => {
  let clock = 0;
  const fake = fakeWorker((n, proc) => (proc.pid === 1000 ? undefined : { gpuPresent: true, gpu: 5, disks: [] }));
  const worker = createWorker({ start: fake.start, timeoutMs: 20, restartGapMs: 30000, now: () => clock });
  await assert.rejects(worker.sample(), /timed out/);
  assert.equal(fake.procs[0].killed, true, "a hung sampler is killed");
  clock += 1000;
  await assert.rejects(worker.sample(), /restarting/, "no restart storm");
  clock += 30000;
  assert.equal((await worker.sample()).gpu, 5);
  assert.equal(fake.procs.length, 2);
  fake.procs[1].emit("exit", 1);
  clock += 30000;
  assert.equal((await worker.sample()).gpu, 5, "a crashed sampler is started again");
  assert.equal(fake.procs.length, 3);
  worker.stop();
});

test("the real PowerShell worker returns samples from one process", { skip: process.platform !== "win32" }, async () => {
  const worker = createWorker({ start: spawnWorker, timeoutMs: 30000 });
  try {
    const first = await worker.sample();
    const pid = worker.pid;
    const second = await worker.sample();
    assert.equal(worker.pid, pid);
    for (const s of [first, second]) {
      assert.ok(Array.isArray(s.disks), JSON.stringify(s));
      assert.ok(s.gpu === null || (s.gpu >= 0 && s.gpu <= 100));
    }
  } finally {
    worker.stop();
  }
});

test("collector consumes failed probes and does not publish results after stopping", async () => {
  let finishStorage;
  const api = load("src/system.js", { systeminformation: {
    mem: async () => ({ total: 100, available: 20 }),
    fsSize: () => new Promise(resolve => { finishStorage = resolve; }),
    graphics: async () => { throw new Error("unavailable"); }, fsStats: async () => ({ rx_sec: null, wx_sec: null }),
  }, "node:child_process": { spawn() { throw new Error("unavailable"); } } });
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
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout", "Date"] });
  let hardwareCalls = 0;
  const fake = fakeWorker((n) => (n === 0 ? { gpuPresent: true, gpu: 40, disks: [] } : undefined));
  const api = load("src/system.js", {
    systeminformation: {
      mem: async () => ({ total: 100, available: 50 }), fsSize: async () => [],
      graphics: async () => (hardwareCalls++ === 0 ? { controllers: [{ utilizationGpu: 40 }] } : new Promise(() => {})),
      fsStats: async () => ({ rx_sec: 1, wx_sec: 1 }),
    },
    "node:child_process": { spawn: () => fake.start() },
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
