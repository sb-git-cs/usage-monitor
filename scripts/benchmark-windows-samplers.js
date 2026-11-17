// Memory and CPU of the Windows helper under the app's steady load: a hardware sample every 5 s
// (drives every 30 s), a session scan every 5 s, a battery reading every 10 s and the taskbar
// watch. Read-only. Usage: node scripts/benchmark-windows-samplers.js [seconds, default 60]
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { createHelper } = require("../src/winhelper");

function usage(pid) {
  const [ws, priv, cpu, threads] = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    `$p = Get-Process -Id ${pid}; '{0}|{1}|{2}|{3}' -f $p.WorkingSet64, $p.PrivateMemorySize64, $p.TotalProcessorTime.TotalMilliseconds, $p.Threads.Count`],
  { windowsHide: true, encoding: "utf8" }).trim().split("|").map(Number);
  return { workingSetMiB: +(ws / 1048576).toFixed(1), privateMiB: +(priv / 1048576).toFixed(1), cpuMs: Math.round(cpu), threads };
}

async function main() {
  if (process.platform !== "win32") throw new Error("Windows only");
  const seconds = Number(process.argv[2]) || 60;
  const helper = createHelper();
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  try {
    const sample = JSON.parse(await helper.request("sys", "sample storage", { timeoutMs: 30000 }));
    const battery = JSON.parse(await helper.request("sys", "battery"));
    if (!Array.isArray(sample.disks) || !Array.isArray(sample.volumes) || battery.capacityUnit !== "mWh" && !battery.error) throw new Error("the helper returned invalid data");
    helper.send("bar", "watch");
    const start = usage(helper.pid);
    for (let tick = 0; tick < seconds / 5; tick++) {
      await helper.request("sys", tick % 6 === 0 ? "sample storage" : "sample");
      if (tick % 2 === 0) await helper.request("sys", "battery");
      await helper.request("sess", JSON.stringify({ op: "scan", pids: [], names: ["codex", "claude", "node"], only: { name: "node", cmd: "codex|claude|gemini" } }));
      await wait(5000);
    }
    const end = usage(helper.pid);
    const result = { seconds, processes: 1, workingSetMiB: end.workingSetMiB, privateMiB: end.privateMiB, threads: end.threads,
      cpuMsPerMinute: Math.round((end.cpuMs - start.cpuMs) * 60 / seconds) };
    fs.mkdirSync(path.resolve(".qa"), { recursive: true });
    fs.writeFileSync(path.resolve(".qa/optimization-samplers-memory.json"), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
  } finally {
    helper.stop();
  }
}
main().catch((err) => { console.error(err); process.exitCode = 1; });
