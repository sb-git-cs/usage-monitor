// Live check for macOS and Linux: runs this OS's real capture provider while curl downloads
// a file slowly, then verifies the bytes were attributed to curl. Used by CI.
const { spawn } = require("child_process");

function createProvider() {
  if (process.platform === "darwin") return new (require("../src/net/providers/macos").MacProvider)();
  if (process.platform === "linux") return new (require("../src/net/providers/linux").LinuxProvider)();
  return null;
}

const provider = createProvider();
if (!provider) {
  console.log("No live probe for this platform (Windows is covered by the helper tests).");
  process.exit(0);
}

const EXPECTED = 3_000_000;
const totals = new Map();
provider.on("status", (s) => console.log(`[status] ${s.state}${s.message ? ` - ${s.message}` : ""}`));
provider.on("sample", (sample) => {
  for (const app of sample.apps) {
    const t = totals.get(app.key) || { name: app.name, rx: 0, tx: 0 };
    t.rx += app.rx;
    t.tx += app.tx;
    totals.set(app.key, t);
  }
});
provider.start();

setTimeout(() => {
  // Rate-limited so the transfer spans several one-second samples.
  const curl = spawn("curl", ["-s", "-o", "/dev/null", "--max-time", "30", "--limit-rate", "1M", "https://speed.cloudflare.com/__down?bytes=5000000"]);
  curl.on("close", (code) => {
    setTimeout(() => {
      provider.stop();
      const rows = [...totals.entries()].sort((a, b) => b[1].rx - a[1].rx);
      for (const [key, t] of rows.slice(0, 8)) console.log(`${t.name.padEnd(28)} rx ${String(t.rx).padStart(10)}  tx ${String(t.tx).padStart(8)}  ${key}`);
      const hit = rows.find(([key, t]) => /curl/i.test(`${key} ${t.name}`));
      console.log(`curl exit ${code}; counted ${hit ? hit[1].rx : 0} bytes for curl`);
      if (code !== 0 || !hit || hit[1].rx < EXPECTED) {
        console.error(`FAIL: expected at least ${EXPECTED} bytes attributed to curl`);
        process.exit(1);
      }
      console.log("PASS");
      process.exit(0);
    }, 3000);
  });
}, 3000);
