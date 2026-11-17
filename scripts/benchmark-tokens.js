// Synthetic transcripts only; never reads the user's accounts or conversations.
// node --expose-gc scripts/benchmark-tokens.js [path-to-tokens-module]
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");
const { scanTokens } = require(path.resolve(process.argv[2] || "src/tokens.js"));

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "um-memory-"));
  try {
    const projects = path.join(dir, "projects");
    fs.mkdirSync(projects);
    const file = path.join(projects, "synthetic.jsonl");
    const now = Date.now();
    const fd = fs.openSync(file, "w");
    try {
      for (let i = 0; i < 3000; i++) fs.writeSync(fd, JSON.stringify({
        type: "assistant", timestamp: new Date(now - 1000).toISOString(),
        message: { id: `message-${i}`, model: "claude-test", content: "x".repeat(8000), usage: { input_tokens: 100, output_tokens: 20 } },
      }) + "\n");
    } finally { fs.closeSync(fd); }
    global.gc?.();
    const start = performance.now();
    const report = await scanTokens({ claudeDir: dir, codexDir: dir, now });
    assert.equal(report.summary.total, 360000);
    assert.equal(report.summary.turns, 3000);
    global.gc?.();
    console.log(JSON.stringify({ inputMiB: fs.statSync(file).size / 1048576,
      elapsedMs: Math.round(performance.now() - start), peakRssMiB: process.resourceUsage().maxRSS / 1024,
      retainedHeapMiB: process.memoryUsage().heapUsed / 1048576, total: report.summary.total }, null, 2));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
main().catch((err) => { console.error(err); process.exitCode = 1; });
