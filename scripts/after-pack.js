// electron-builder "afterPack": removes Chromium components a build of this app never loads.
// Hardware acceleration is off (src/main.js) and no page uses WebGL or WebGPU, so these are dead
// weight: the WebGPU shader compiler (dxcompiler, dxil), software Vulkan for WebGL (vk_swiftshader,
// vulkan) and, on Windows, ANGLE's Direct3D shader compiler (d3dcompiler_47). Without them Chromium
// reports the same GPU feature status and every window draws the same (scripts/packaged-smoke.js
// checks a built app). On Windows they are 36.7 MB installed and about 13 MB of each download.
// macOS keeps them: they sit inside the signed Electron framework, and removing them breaks its
// signature, which macOS reports on a downloaded unsigned app as "damaged".
// If the app ever turns hardware acceleration back on, drop this hook.
const fs = require("node:fs");
const path = require("node:path");

const UNUSED = {
  win32: ["dxcompiler.dll", "dxil.dll", "vk_swiftshader.dll", "vk_swiftshader_icd.json", "vulkan-1.dll", "d3dcompiler_47.dll"],
  linux: ["libvk_swiftshader.so", "vk_swiftshader_icd.json", "libvulkan.so.1"],
};

function unusedFiles(platform) {
  return UNUSED[platform] || [];
}

module.exports = async function afterPack(context) {
  for (const name of unusedFiles(context.electronPlatformName)) fs.rmSync(path.join(context.appOutDir, name), { force: true });
};

module.exports.unusedFiles = unusedFiles;
module.exports.UNUSED_ON_WINDOWS = UNUSED.win32;
