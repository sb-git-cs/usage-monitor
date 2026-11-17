const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { createOffload } = require("../src/offload");

// A stand-in for Electron's utilityProcess: each fork runs `mod` the way offload-child.js does.
function fakeUtility(mod) {
  const forks = [];
  const up = {
    fork(file, args, opts) {
      const proc = new EventEmitter();
      proc.file = file;
      proc.opts = opts;
      proc.received = [];
      proc.killed = false;
      let target = null;
      proc.kill = () => { proc.killed = true; setImmediate(() => proc.emit("exit", 1)); };
      proc.postMessage = (data) => {
        proc.received.push(data);
        setImmediate(async () => {
          if (data.init) { target = data.init.factory ? mod[data.init.factory](data.init.options) : mod; return; }
          if (data.stop) { if (target.flush) target.flush(); proc.emit("exit", 0); return; }
          try { proc.emit("message", { id: data.id, ok: true, value: await target[data.fn](...data.args) }); }
          catch (err) { proc.emit("message", { id: data.id, ok: false, error: err.message, errorName: err.name }); }
        });
      };
      forks.push(proc);
      return proc;
    },
  };
  return { up, forks };
}

test("calls run in one utility process, matched to their callers", async () => {
  const fake = fakeUtility({ double: (n) => n * 2, fail: () => { throw new TypeError("bad input"); } });
  const off = createOffload("/app/src/mod.js", { utility: () => fake.up, name: "test" });
  assert.deepEqual(await Promise.all([off.call("double", 2), off.call("double", 5)]), [4, 10]);
  await assert.rejects(off.call("fail"), (err) => err.name === "TypeError" && err.message === "bad input");
  assert.equal(fake.forks.length, 1);
  assert.match(fake.forks[0].file, /offload-child\.js$/);
  assert.equal(fake.forks[0].opts.serviceName, "Usage Monitor test");
  assert.deepEqual(fake.forks[0].received[0], { init: { modulePath: "/app/src/mod.js", factory: null, options: {} } });
  off.stop();
});

test("a scanner made by a factory is kept between calls, saved and ended after a quiet spell", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let made = 0, flushed = 0;
  const fake = fakeUtility({ createScanner: (opts) => {
    made++;
    let scans = 0;
    return { scan: () => ({ n: ++scans, dir: opts.dir }), flush: () => { flushed++; } };
  } });
  const off = createOffload("/app/src/scanner.js", { utility: () => fake.up, factory: "createScanner", options: { dir: "C:\\cache" }, idleMs: 60000 });
  const tick = async () => { for (let i = 0; i < 4; i++) await new Promise(setImmediate); };
  let result = off.call("scan");
  await tick();
  assert.deepEqual(await result, { n: 1, dir: "C:\\cache" });
  t.mock.timers.tick(59000);
  result = off.call("scan");
  await tick();
  assert.equal((await result).n, 2, "a call before the deadline keeps the same process and state");
  assert.equal(off.running, true);
  t.mock.timers.tick(60000);
  await tick();
  assert.equal(off.running, false);
  assert.equal(flushed, 1, "the scanner saves before its process ends");
  assert.equal(made, 1);
  result = off.call("scan");
  await tick();
  assert.equal((await result).n, 1, "the next call starts a fresh process");
  assert.equal(fake.forks.length, 2);
  assert.equal(made, 2);
  off.stop();
});

test("a process that dies fails what it was asked, and the next call starts another", async () => {
  const fake = fakeUtility({ slow: () => new Promise(() => {}), quick: () => "ok" });
  const off = createOffload("/m.js", { utility: () => fake.up });
  const stuck = off.call("slow");
  await new Promise(setImmediate);
  fake.forks[0].kill();
  await assert.rejects(stuck, /process ended/);
  assert.equal(await off.call("quick"), "ok");
  assert.equal(fake.forks.length, 2);
  off.stop();
});

test("outside Electron's main process the calls run in-process on the given module", async () => {
  let flushed = 0;
  const off = createOffload("/not/loaded.js", { utility: () => null, inline: { createScanner: () => ({ scan: (o) => o.days, flush: () => { flushed++; } }) }, factory: "createScanner" });
  assert.equal(await off.call("scan", { days: 7 }), 7);
  assert.equal(off.separate, false);
  off.stop();
  assert.equal(flushed, 1, "stopping saves the in-process scanner");
});
