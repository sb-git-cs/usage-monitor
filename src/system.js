const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const { execFile } = require("node:child_process");
const si = require("systeminformation");

function percent(value) {
  return Number.isFinite(value) && value >= 0 ? Math.min(100, value) : null;
}

function cpuTimes() {
  return os.cpus().map(({ times }) => ({ idle: times.idle, total: Object.values(times).reduce((a, b) => a + b, 0) }));
}

function cpuUsage(previous, current) {
  if (!previous.length || previous.length !== current.length) return null;
  let idle = 0;
  let total = 0;
  for (let i = 0; i < current.length; i++) {
    const dt = current[i].total - previous[i].total;
    const di = current[i].idle - previous[i].idle;
    if (dt < 0 || di < 0 || di > dt) return null;
    total += dt;
    idle += di;
  }
  return total > 0 ? percent(100 * (1 - idle / total)) : null;
}

function storageUsage(volumes) {
  const valid = volumes.filter((v) => Number.isFinite(v.size) && v.size > 0 && Number.isFinite(v.used) && v.used >= 0);
  return {
    // Use the fullest volume so a nearly full drive is not hidden by another drive's free space.
    space: valid.length ? Math.max(...valid.map((v) => percent(v.used / v.size * 100))) : null,
    volumes: valid.map((v) => ({ name: v.mount || v.fs, used: v.used, size: v.size })),
  };
}

// On Windows systeminformation's mem() starts a PowerShell CIM query (swap) on every call; os reports the same physical figures for free.
async function memoryUsage(platform = process.platform) {
  if (platform === "win32") {
    const total = os.totalmem();
    return total > 0 ? percent((total - os.freemem()) / total * 100) : null;
  }
  const m = await si.mem();
  return m.total > 0 ? percent((m.total - m.available) / m.total * 100) : null;
}

function windowsSample() {
  return new Promise((resolve, reject) => {
    // Electron can read inside app.asar; PowerShell cannot execute a -File path inside it.
    const script = fs.readFileSync(path.join(__dirname, "system-windows.ps1"), "utf8");
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script],
      { windowsHide: true, timeout: 8000, maxBuffer: 1024 * 1024 }, (err, stdout) => {
        if (err) return reject(err);
        try { resolve(JSON.parse(stdout.trim())); } catch (error) { reject(error); }
      });
  });
}

async function hardwareSample() {
  if (process.platform === "win32") {
    const data = await windowsSample();
    const disks = (data.disks || []).filter((d) => percent(d.busy) !== null);
    return { gpuPresent: data.gpuPresent, gpu: percent(data.gpu), disk: disks.length ? Math.max(...disks.map((d) => d.busy)) : null, disks, diskRate: null };
  }
  const [graphics, io] = await Promise.allSettled([si.graphics(), si.fsStats()]);
  const controllers = graphics.status === "fulfilled" ? graphics.value.controllers || [] : null;
  const usage = (controllers || []).map((g) => percent(g.utilizationGpu)).filter((v) => v !== null);
  const rate = io.status === "fulfilled" && Number.isFinite(io.value.rx_sec) && io.value.rx_sec >= 0 && Number.isFinite(io.value.wx_sec) && io.value.wx_sec >= 0
    ? io.value.rx_sec + io.value.wx_sec : null;
  return { gpuPresent: controllers === null ? null : controllers.length > 0, gpu: usage.length ? Math.max(...usage) : null,
    disk: null, disks: [], diskRate: Number.isFinite(rate) && rate >= 0 ? rate : null };
}

function start(onUpdate) {
  let stopped = false;
  let previous = cpuTimes();
  let latest = { cpu: null, mem: null, gpuPresent: null, gpu: null, disk: null, diskRate: null, space: null, volumes: [], disks: [] };
  const pending = new Set();
  const updated = {};
  const emit = () => { if (!stopped) onUpdate({ ...latest }); };
  function collect(key, read, empty) {
    if (pending.has(key)) {
      if (Date.now() - updated[key] > 15000) { latest = { ...latest, ...empty }; emit(); }
      return;
    }
    pending.add(key);
    updated[key] = Date.now();
    Promise.resolve().then(read).catch(() => empty).then((data) => {
      if (stopped) return;
      // Remember GPU presence across transient driver/query failures, but discard old usage.
      if (key === "hardware" && data.gpuPresent == null) data.gpuPresent = latest.gpuPresent;
      latest = { ...latest, ...data };
      emit();
    }).finally(() => pending.delete(key));
  }
  const tick = () => {
    const current = cpuTimes();
    latest.cpu = cpuUsage(previous, current);
    previous = current;
    emit();
    collect("memory", async () => ({ mem: await memoryUsage() }), { mem: null });
  };
  // gpuPresent is deliberately not reset here: a stalled or failed probe must not hide the GPU chip.
  const hardware = () => collect("hardware", hardwareSample, { gpu: null, disk: null, diskRate: null, disks: [] });
  const storage = () => collect("storage", async () => storageUsage(await si.fsSize()), { space: null, volumes: [] });
  tick();
  hardware();
  storage();
  const timers = [setInterval(tick, 2000), setInterval(hardware, 5000), setInterval(storage, 30000)];
  return { stop() { stopped = true; timers.forEach(clearInterval); } };
}

module.exports = { start, cpuUsage, storageUsage, percent, memoryUsage };
