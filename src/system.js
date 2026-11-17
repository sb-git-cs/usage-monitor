const os = require("node:os");
const winhelper = require("./winhelper");
// Windows uses the native helper; load the cross-platform probes only when needed.
const si = () => require("systeminformation");

const SAMPLE_TIMEOUT_MS = 8000;

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
  const m = await si().mem();
  return m.total > 0 ? percent((m.total - m.available) / m.total * 100) : null;
}

// Hardware and battery samples come from the resident Windows helper ("sys" channel), which answers
// them one at a time and in order. Callers asking for the same reading while it runs share it.
const pendingSamples = new Map();

function windowsSample(request = "sample") {
  if (pendingSamples.has(request)) return pendingSamples.get(request);
  const shared = winhelper.request("sys", request, { timeoutMs: SAMPLE_TIMEOUT_MS }).then((line) => JSON.parse(line)).finally(() => {
    if (pendingSamples.get(request) === shared) pendingSamples.delete(request);
  });
  pendingSamples.set(request, shared);
  return shared;
}

function batterySample() { return windowsSample("battery"); }

// The helper also serves the sessions and the taskbar, so the sampler only forgets its shared readings;
// the app stops the helper itself when it quits.
function stopWindowsWorker() {
  pendingSamples.clear();
}

// Elsewhere si().graphics() starts system_profiler (macOS) or lspci (Linux) on every call. Only
// nvidia-smi reports utilization, so without it the GPU list is re-read every 10 minutes.
const GRAPHICS_REFRESH_MS = 600000;
let graphicsCache = null;

// withStorage: on Windows the same helper also reads the drives (systeminformation would start
// a new PowerShell process for each storage reading).
async function hardwareSample(withStorage = false, platform = process.platform) {
  if (platform === "win32") {
    const data = await windowsSample(withStorage ? "sample storage" : "sample");
    const disks = (data.disks || []).filter((d) => percent(d.busy) !== null);
    const out = { gpuPresent: data.gpuPresent, gpu: percent(data.gpu), disk: disks.length ? Math.max(...disks.map((d) => d.busy)) : null, disks, diskRate: null };
    if (withStorage && Array.isArray(data.volumes)) Object.assign(out, storageUsage(data.volumes));
    return out;
  }
  const reuse = graphicsCache && !graphicsCache.live && Date.now() - graphicsCache.at < GRAPHICS_REFRESH_MS;
  const [graphics, io] = await Promise.allSettled([reuse ? { controllers: graphicsCache.controllers } : si().graphics(), si().fsStats()]);
  const controllers = graphics.status === "fulfilled" ? graphics.value.controllers || [] : null;
  const usage = (controllers || []).map((g) => percent(g.utilizationGpu)).filter((v) => v !== null);
  if (!reuse && controllers) graphicsCache = { at: Date.now(), controllers, live: usage.length > 0 };
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
  // macOS memory readings start three processes (one synchronously), so they are read every 10 seconds there.
  let memoryTicks = 0;
  const tick = () => {
    const current = cpuTimes();
    latest.cpu = cpuUsage(previous, current);
    previous = current;
    emit();
    if (process.platform !== "darwin" || memoryTicks++ % 5 === 0) collect("memory", async () => ({ mem: await memoryUsage() }), { mem: null });
  };
  // gpuPresent is deliberately not reset here: a stalled or failed probe must not hide the GPU chip.
  // On Windows every sixth hardware sample (30 seconds) also reads the drives.
  const windows = process.platform === "win32";
  let hardwareCount = 0;
  const hardware = () => {
    const withStorage = windows && hardwareCount++ % 6 === 0;
    collect("hardware", () => hardwareSample(withStorage), { gpu: null, disk: null, diskRate: null, disks: [] });
  };
  const storage = () => collect("storage", async () => storageUsage(await si().fsSize()), { space: null, volumes: [] });
  let timers = [];
  function run() {
    memoryTicks = 0;
    tick();
    hardwareCount = 0;
    hardware();
    if (!windows) storage();
    timers = [setInterval(tick, 2000), setInterval(hardware, 5000)];
    if (!windows) timers.push(setInterval(storage, 30000));
  }
  run();
  let paused = false;
  return {
    // Nothing reads the chips while the screen is locked or the strip is hidden.
    setPaused(next) {
      if (stopped || !!next === paused) return;
      paused = !!next;
      timers.forEach(clearInterval);
      timers = [];
      if (!paused) {
        previous = cpuTimes();
        run();
      }
    },
    stop() {
      stopped = true;
      timers.forEach(clearInterval);
      stopWindowsWorker();
    },
  };
}

module.exports = { start, cpuUsage, storageUsage, percent, memoryUsage, hardwareSample, batterySample };
