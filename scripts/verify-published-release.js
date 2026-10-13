// Verify the latest stable release, checksum catalogue, updater references and a downloaded installer.
// Run: node scripts/verify-published-release.js [--gh-wrapper path/to/gh-wrapper.cjs]
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const yaml = require("js-yaml");
const root = path.resolve(__dirname, "..");
const version = require("../package.json").version;
const repo = "sb-git-cs/usage-monitor";
const at = process.argv.indexOf("--gh-wrapper");
const wrapper = at < 0 ? null : process.argv[at + 1];
function gh(args) {
  return execFileSync(wrapper ? process.execPath : "gh", wrapper ? [path.resolve(wrapper), ...args] : args,
    { cwd: root, encoding: "utf8", maxBuffer: 8 * 1024 * 1024, windowsHide: true });
}
const release = JSON.parse(gh(["api", `repos/${repo}/releases/tags/v${version}`]));
const latest = JSON.parse(gh(["api", `repos/${repo}/releases/latest`]));
assert.equal(release.draft, false); assert.equal(release.prerelease, false); assert.equal(release.id, latest.id);
const assets = new Map(release.assets.map((asset) => [asset.name, asset]));
assert.equal(assets.size, release.assets.length, "duplicate asset names");
const dir = path.join(root, ".qa", `published-v${version}`);
fs.mkdirSync(dir, { recursive: true });
const names = ["SHA256SUMS", "latest.yml", "latest-linux.yml", "latest-mac.yml", `UsageMonitor-Setup-${version}.exe`];
if (assets.has("latest-android.json")) names.push("latest-android.json");
gh(["release", "download", `v${version}`, "--repo", repo, "--dir", dir, "--clobber", ...names.flatMap((name) => ["--pattern", name])]);
const sums = new Map(fs.readFileSync(path.join(dir, "SHA256SUMS"), "utf8").trim().split(/\r?\n/).map((line) => {
  const m = /^([a-f0-9]{64})\s+\*?(.+)$/.exec(line); assert(m, "malformed checksum entry"); return [m[2], m[1]];
}));
assert.equal(sums.size, assets.size - 1, "every download asset must have a checksum");
for (const [name, hash] of sums) assert.equal(assets.get(name)?.digest, `sha256:${hash}`, `server digest differs: ${name}`);
const downloaded = names.map((name) => {
  const bytes = fs.readFileSync(path.join(dir, name));
  const hash = crypto.createHash("sha256").update(bytes).digest("hex");
  assert.equal(bytes.length, assets.get(name)?.size, `download size: ${name}`);
  assert.equal(`sha256:${hash}`, assets.get(name)?.digest, `download digest: ${name}`);
  if (name !== "SHA256SUMS") assert.equal(hash, sums.get(name), `published checksum: ${name}`);
  return { name, bytes: bytes.length, sha256: hash };
});
const references = [];
for (const name of ["latest.yml", "latest-linux.yml", "latest-mac.yml"]) {
  const manifest = yaml.load(fs.readFileSync(path.join(dir, name), "utf8"));
  assert.equal(manifest.version, version);
  for (const file of manifest.files) {
    const filename = decodeURIComponent(file.url);
    assert(assets.has(filename), `${name} references a missing asset: ${filename}`);
    assert.equal(assets.get(filename).size, file.size, `manifest size: ${filename}`);
    if (/\.(exe|zip)$/.test(filename)) assert(assets.has(filename + ".blockmap"), `missing blockmap: ${filename}`);
    if (names.includes(filename)) assert.equal(crypto.createHash("sha512").update(fs.readFileSync(path.join(dir, filename))).digest("base64"), file.sha512, `updater digest: ${filename}`);
    references.push({ manifest: name, file: filename, bytes: file.size });
  }
  if (manifest.path) assert(assets.has(decodeURIComponent(manifest.path)), `missing primary updater path: ${name}`);
}
if (names.includes("latest-android.json")) {
  const android = JSON.parse(fs.readFileSync(path.join(dir, "latest-android.json"), "utf8"));
  assert.equal(android.version, version); assert.equal(assets.get(android.file)?.size, android.size);
  assert.equal(sums.get(android.file), android.sha256);
}
const result = { version, url: release.html_url, assets: assets.size, checksums_verified: sums.size, downloaded, references };
fs.writeFileSync(path.join(root, ".qa/subscription-published-release.json"), JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify(result, null, 2));
