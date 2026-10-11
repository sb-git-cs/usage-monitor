// Verify that the local Windows package contains exactly the tested application source.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const asar = require("@electron/asar");
const root = path.resolve(__dirname, "..");
const archive = path.join(root, "dist/win-unpacked/resources/app.asar");
let files = 0;
function check(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) check(file);
    else {
      const name = path.relative(root, file);
      assert.deepEqual(asar.extractFile(archive, name), fs.readFileSync(file), `Packaged source differs: ${name}`);
      files++;
    }
  }
}
check(path.join(root, "src"));
const version = require("../package.json").version;
assert.equal(JSON.parse(asar.extractFile(archive, "package.json").toString()).version, version);
const artifacts = fs.readdirSync(path.join(root, "dist")).filter((name) => name.includes(version) && /\.(exe|zip|apk)$/.test(name)).map((name) => {
  const data = fs.readFileSync(path.join(root, "dist", name));
  return { name, bytes: data.length, sha256: crypto.createHash("sha256").update(data).digest("hex") };
});
const result = { version, source_files_verified: files, artifacts };
fs.mkdirSync(path.join(root, ".qa"), { recursive: true });
fs.writeFileSync(path.join(root, ".qa/packaged-source-results.json"), JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify(result, null, 2));
