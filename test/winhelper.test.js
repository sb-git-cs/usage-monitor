const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const { createHelper } = require("../src/winhelper");

// A stand-in for UsageMonitorHelper.exe: answer(channel, payload, proc) gives the reply payload for
// each request line, or undefined to stay silent.
function fakeHelper(answer = (channel, payload) => `${channel}:${payload}`) {
  const procs = [];
  const spawn = (file, args, opts) => {
    const proc = new EventEmitter();
    proc.file = file;
    proc.opts = opts;
    proc.pid = 1000 + procs.length;
    proc.stdout = new PassThrough();
    proc.stdin = new PassThrough();
    proc.written = [];
    proc.killed = false;
    proc.kill = () => { proc.killed = true; setImmediate(() => proc.emit("exit", null)); };
    proc.reply = (channel, payload) => proc.stdout.write(`${channel} ${payload}\n`);
    let rest = "";
    proc.stdin.on("data", (chunk) => {
      rest += chunk;
      let i;
      while ((i = rest.indexOf("\n")) >= 0) {
        const line = rest.slice(0, i);
        rest = rest.slice(i + 1);
        proc.written.push(line);
        const space = line.indexOf(" ");
        const reply = answer(line.slice(0, space), line.slice(space + 1), proc);
        if (reply !== undefined) proc.reply(line.slice(0, space), reply);
      }
    });
    procs.push(proc);
    return proc;
  };
  return { spawn, procs };
}

test("one hidden helper answers every channel, in order within each", async () => {
  const fake = fakeHelper((channel, payload, proc) => {
    // The sessions channel answers late, so the sys replies overtake it.
    if (channel === "sess") { setTimeout(() => proc.reply(channel, `late ${payload}`), 5); return undefined; }
    return `${channel}:${payload}`;
  });
  const h = createHelper({ spawn: fake.spawn, file: "C:\\app\\helper.exe" });
  const replies = await Promise.all([
    h.request("sys", "sample"), h.request("sess", "a"), h.request("sys", "battery"), h.request("sess", "b"), h.request("cred", "{}"),
  ]);
  assert.deepEqual(replies, ["sys:sample", "late a", "sys:battery", "late b", "cred:{}"]);
  assert.equal(fake.procs.length, 1, "one process for everything");
  assert.equal(fake.procs[0].file, "C:\\app\\helper.exe");
  assert.equal(fake.procs[0].opts.windowsHide, true);
  // A channel sends its next request only after the previous reply.
  assert.deepEqual(fake.procs[0].written.filter((l) => l.startsWith("sess")), ["sess a", "sess b"]);
  h.stop();
});

test("a request cannot smuggle a second line to the helper", async () => {
  const fake = fakeHelper();
  const h = createHelper({ spawn: fake.spawn, file: "x" });
  assert.equal(await h.request("cred", "{\"a\":1}\nsys sample"), "cred:{\"a\":1} sys sample");
  assert.equal(fake.procs[0].written.length, 1);
  h.stop();
});

test("a stuck or crashed helper is replaced, but not more often than every 30 seconds", async () => {
  let clock = 0;
  const fake = fakeHelper((channel, payload, proc) => (proc.pid === 1000 ? undefined : "ok"));
  const h = createHelper({ spawn: fake.spawn, file: "x", now: () => clock });
  const other = h.request("sess", "waiting behind the stuck helper", { timeoutMs: 1000 });
  await assert.rejects(h.request("sys", "sample", { timeoutMs: 20 }), /sys request timed out/);
  await assert.rejects(other, /restarted after a timeout/, "the other channels' requests fail with it");
  assert.equal(fake.procs[0].killed, true, "a hung helper is killed");
  clock += 1000;
  await assert.rejects(h.request("sys", "sample"), /restarting/, "no restart storm");
  assert.equal(h.send("bar", "watch"), false);
  clock += 30000;
  assert.equal(await h.request("sys", "sample"), "ok");
  assert.equal(fake.procs.length, 2);
  fake.procs[1].emit("exit", 1);
  clock += 30000;
  assert.equal(await h.request("sys", "sample"), "ok", "a crashed helper is started again");
  assert.equal(fake.procs.length, 3);
  h.stop();
});

test("an old helper's delayed exit cannot fail its replacement's requests", async () => {
  let clock = 0;
  const fake = fakeHelper((channel, payload, proc) => {
    if (proc.pid !== 1000) setTimeout(() => proc.reply(channel, "ok"), 10);
    return undefined;
  });
  const h = createHelper({ spawn: fake.spawn, file: "x", now: () => clock, restartGapMs: 30 });
  await assert.rejects(h.request("sys", "sample", { timeoutMs: 20 }), /timed out/);
  clock = 100;
  const next = h.request("sys", "sample");
  fake.procs[0].emit("exit", 1);
  fake.procs[0].stdout.write("sys stale reply\n");
  assert.equal(await next, "ok");
  h.stop();
});

test("stopping fails waiting requests, closes stdin and never starts another helper", async () => {
  const fake = fakeHelper(() => undefined);
  const h = createHelper({ spawn: fake.spawn, file: "x" });
  const outcomes = Promise.allSettled([h.request("sys", "sample"), h.request("sys", "battery"), h.request("sess", "{}")]);
  await new Promise(setImmediate);
  let exited = 0;
  h.onExit(() => exited++);
  h.stop();
  assert.deepEqual((await outcomes).map((r) => r.status), ["rejected", "rejected", "rejected"]);
  assert.equal(exited, 1);
  assert.equal(fake.procs[0].stdin.writableEnded, true, "stdin closing ends the helper");
  await assert.rejects(h.request("sys", "sample"), /stopped/);
  assert.equal(h.send("bar", "watch"), false);
  assert.equal(fake.procs.length, 1);
});

test("lines nobody asked for go to the channel's listeners", async () => {
  const fake = fakeHelper((channel) => (channel === "bar" ? undefined : "reply"));
  const h = createHelper({ spawn: fake.spawn, file: "x" });
  const seen = [];
  const off = h.on("bar", (line) => seen.push(line));
  assert.equal(h.send("bar", "watch"), true);
  fake.procs[0].reply("bar", "shown=1");
  fake.procs[0].stdout.write("bar layout={\"tray\":null}\r\n");
  assert.equal(await h.request("sys", "sample"), "reply", "replies are not mistaken for events");
  assert.deepEqual(seen, ["shown=1", "layout={\"tray\":null}"]);
  off();
  fake.procs[0].reply("bar", "shown=0");
  await new Promise(setImmediate);
  assert.equal(seen.length, 2);
  assert.deepEqual(fake.procs[0].written, ["bar watch", "sys sample"]);
  h.stop();
});

test("a helper that cannot be built or started fails the request instead of throwing", async () => {
  let clock = 0;
  const h = createHelper({ file: () => { throw new Error("csc.exe not found"); }, now: () => clock });
  await assert.rejects(h.request("sys", "sample"), /csc\.exe not found/);
  await assert.rejects(h.request("sys", "sample"), /restarting/, "a failed start is not retried at once");
  const missing = createHelper({ file: "C:\\nowhere\\UsageMonitorHelper.exe", now: () => clock });
  await assert.rejects(missing.request("sys", "sample"), /ENOENT|helper exited/);
});

test("the real helper answers each channel from one hidden process", { skip: process.platform !== "win32" }, async () => {
  const h = createHelper();
  try {
    const sample = JSON.parse(await h.request("sys", "sample storage", { timeoutMs: 30000 }));
    const pid = h.pid;
    assert.ok(Array.isArray(sample.disks) && Array.isArray(sample.volumes), JSON.stringify(sample));
    assert.ok(sample.gpu === null || (sample.gpu >= 0 && sample.gpu <= 100));
    for (const v of sample.volumes) assert.match(v.mount, /^[A-Z]:$/);
    const battery = JSON.parse(await h.request("sys", "battery"));
    assert.ok(battery.error === true || (typeof battery.hasBattery === "boolean" && battery.capacityUnit === "mWh"));
    const scan = JSON.parse(await h.request("sess", JSON.stringify({ op: "scan", pids: [process.pid], names: [] })));
    assert.equal(scan.procs.length, 1);
    assert.equal(scan.procs[0].pid, process.pid);
    assert.equal(typeof scan.procs[0].cmd, "string");
    assert.equal(typeof scan.procs[0].start, "string");
    // A process that is gone, or whose id now belongs to another program, is never typed into.
    assert.deepEqual(JSON.parse(await h.request("sess", JSON.stringify({ op: "type", pid: process.pid, start: "1", text: "x" }))), { ok: false, error: "terminal closed" });
    assert.deepEqual(JSON.parse(await h.request("sess", JSON.stringify({ op: "peek", pid: 0x7ffffff0, expect: "x" }))), { shown: false });
    assert.deepEqual(JSON.parse(await h.request("sess", "not json")), { error: true });
    assert.deepEqual(JSON.parse(await h.request("cred", JSON.stringify({ op: "read", target: "usage-monitor:test:missing" }))), { text: null });
    // An idle helper never keeps Node running, so the wait for a line nobody asked for needs its own timer.
    let timer;
    const layout = Promise.race([
      new Promise((resolve) => h.on("bar", (line) => { if (line.startsWith("layout=")) resolve(JSON.parse(line.slice(7))); })),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("no taskbar layout within 20 s")), 20000); }),
    ]);
    assert.equal(h.send("bar", "watch"), true);
    const first = await layout.finally(() => clearTimeout(timer));
    assert.ok(Array.isArray(first.occupied) && typeof first.shown === "boolean");
    assert.equal(h.pid, pid, "still the same process");
  } finally {
    h.stop();
  }
});
