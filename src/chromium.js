// Chromium processes the app runs inside its main process. Rendering is software everywhere
// (app.disableHardwareAcceleration in main.js), so Chromium's GPU process only composites a few
// small windows and the network service only loads local pages. Inside the main process they used
// 26 MB less private memory and 90 MB less working set on Windows, and the windows drew the same.
// macOS keeps its GPU process, which also presents the windows on screen there.
// scripts/packaged-smoke.js checks a built app against this on each platform.
function inProcess(platform = process.platform) {
  return { gpu: platform === "win32" || platform === "linux", network: true };
}

function applySwitches(commandLine, platform = process.platform) {
  const run = inProcess(platform);
  if (run.gpu) commandLine.appendSwitch("in-process-gpu");
  if (run.network) commandLine.appendSwitch("enable-features", "NetworkServiceInProcess2");
}

module.exports = { inProcess, applySwitches };
