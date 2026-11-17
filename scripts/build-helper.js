// Builds helpers/windows/bin/UsageMonitorHelper.exe, the app's resident Windows helper, with the
// C# compiler that ships with Windows. electron-builder runs it before packing ("beforePack" in
// package.json); `node scripts/build-helper.js` builds it on its own. A checkout that runs the app
// from source builds it on first use, so this is only needed for packaging.
const path = require("node:path");
const { build } = require("../src/winhelper");

const OUT = path.join(__dirname, "..", "helpers", "windows", "bin", "UsageMonitorHelper.exe");

module.exports = async function beforePack(context) {
  if (context && context.electronPlatformName && context.electronPlatformName !== "win32") return;
  build(OUT);
};

if (require.main === module) {
  try {
    console.log(build(OUT));
  } catch (err) {
    console.error(String(err.stdout || "") + String(err.stderr || "") || err.message);
    process.exit(1);
  }
}
