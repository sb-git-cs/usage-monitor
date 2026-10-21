const { execFile } = require("child_process");
const path = require("path");

function layoutScript() {
  try {
    const { app } = require("electron");
    if (app.isPackaged) return path.join(process.resourcesPath, "taskbar-layout.ps1");
  } catch {
    /* unpackaged */
  }
  return path.join(__dirname, "..", "scripts", "taskbar-layout.ps1");
}
const PAD = 6;
let cache = { at: 0, data: null };
let refreshing = false;
let rerun = false;
// Which window (chips) should be owned by the taskbar; the probe script applies it on every run,
// which also re-attaches the chips after Explorer restarts and replaces the taskbar.
const owner = { hwnd: null, own: false, capture: false, applied: null };
let watchProc = null;
let watchCallbacks = [];
let watchRestart = null;

// The on-screen thickness of the taskbar. A collapsed auto-hide bar is a sliver or is
// off the monitor entirely; a shown bar is the full strip. Missing information stays shown
// so the chips are not hidden just because the probe could not see the taskbar.
function taskbarShown(tray, monitor, windowVisible = true) {
  if (windowVisible === false) return false;
  if (!tray || !monitor) return true;
  const left = Math.max(tray.x, monitor.x);
  const top = Math.max(tray.y, monitor.y);
  const right = Math.min(tray.x + tray.w, monitor.x + monitor.w);
  const bottom = Math.min(tray.y + tray.h, monitor.y + monitor.h);
  if (right - left <= 0 || bottom - top <= 0) return false;
  const thick = tray.w >= tray.h ? bottom - top : right - left;
  return thick >= 12;
}

function fallbackFromScreen() {
  try {
    const { screen } = require("electron");
    const d = screen.getPrimaryDisplay();
    const { bounds, workArea } = d;
    const bottom = bounds.y + bounds.height - (workArea.y + workArea.height);
    const trayH = Math.max(bottom, 40);
    const tray = {
      x: bounds.x,
      y: bounds.y + bounds.height - trayH,
      w: bounds.width,
      h: trayH,
    };
    return {
      tray,
      occupied: [
        { name: "ReBarWindow32", x: bounds.x, y: tray.y, w: Math.floor(bounds.width * 0.55), h: tray.h },
        { name: "TrayNotifyWnd", x: bounds.x + bounds.width - 180, y: tray.y, w: 180, h: tray.h },
      ],
    };
  } catch {
    return null;
  }
}

function ownerWant() {
  return owner.hwnd ? `${owner.hwnd}:${owner.own ? 1 : 0}:${owner.capture ? 1 : 0}` : null;
}

function ownerCommand() {
  return `own ${owner.hwnd} ${owner.own ? 1 : 0} ${owner.capture ? 1 : 0} ${process.pid}`;
}

// Sends a line to the long-lived watch process; false when it is not running.
function sendToWatch(line) {
  if (!watchProc || !watchProc.stdin || !watchProc.stdin.writable) return false;
  try {
    watchProc.stdin.write(`${line}\n`);
    return true;
  } catch {
    return false;
  }
}

function applyLayout(parsed) {
  if (!parsed) return;
  if (parsed.tray) cache = { at: Date.now(), data: toDipLayout(parsed) };
  if (parsed.ownerApplied && typeof parsed.owner === "string") owner.applied = parsed.owner;
}

// A one-shot probe, used only before the watch process is up (or if it has stopped). A read
// (allowRerun false) never queues a second probe; an owner change does, so its new state applies.
function refreshAsync(allowRerun = false) {
  // Only Windows has a taskbar to probe; elsewhere the screen work area is used.
  if (process.platform !== "win32") return;
  if (refreshing) {
    if (allowRerun) rerun = true;
    return;
  }
  refreshing = true;
  const args = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", layoutScript()];
  const want = ownerWant();
  if (want) args.push("-Hwnd", owner.hwnd, "-Own", owner.own ? "1" : "0", "-Capture", owner.capture ? "1" : "0", "-AppPid", String(process.pid));
  execFile("powershell.exe", args, { encoding: "utf8", timeout: 6000, windowsHide: true }, (err, stdout) => {
    refreshing = false;
    if (!err && stdout) {
      try {
        applyLayout(JSON.parse(String(stdout).trim()));
      } catch {
        /* keep previous */
      }
    }
    if (rerun) {
      rerun = false;
      refreshAsync(allowRerun);
    }
  });
}

function setChipsOwner(hwnd, own, capture) {
  if (process.platform !== "win32" || !hwnd || !/^\d+$/.test(String(hwnd))) return;
  owner.hwnd = String(hwnd);
  owner.own = !!own;
  owner.capture = !!capture;
  if (owner.applied === ownerWant()) return;
  // The running watch process applies it; a one-shot probe does so only when it is not up.
  if (!sendToWatch(ownerCommand())) refreshAsync(true);
}

// One hidden PowerShell process reports when the taskbar slides away or comes back.
function startTaskbarWatch() {
  if (watchProc || process.platform !== "win32") return;
  const { spawn } = require("child_process");
  const proc = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", layoutScript(), "-Watch"], {
    windowsHide: true,
    stdio: ["pipe", "pipe", "ignore"],
  });
  watchProc = proc;
  proc.stdin.on("error", () => {});
  // Hand the process the current owner so it keeps the chips attached without a separate probe.
  if (ownerWant()) sendToWatch(ownerCommand());
  let buffer = "";
  proc.stdout.setEncoding("utf8");
  proc.stdout.on("data", (chunk) => {
    if (watchProc !== proc) return;
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line === "shown=0" || line === "shown=1") {
        for (const cb of watchCallbacks) cb(line === "shown=1");
      } else if (line.startsWith("layout=")) {
        try {
          applyLayout(JSON.parse(line.slice(7)));
        } catch {
          /* keep previous */
        }
      }
    }
  });
  const ended = () => {
    if (watchProc !== proc) return;
    watchProc = null;
    if (!watchCallbacks.length) return;
    watchRestart = setTimeout(() => {
      watchRestart = null;
      startTaskbarWatch();
    }, 5000);
    if (watchRestart.unref) watchRestart.unref();
  };
  proc.on("exit", ended);
  proc.on("error", ended);
}

function watchTaskbar(onChange) {
  if (process.platform !== "win32" || typeof onChange !== "function") return;
  watchCallbacks.push(onChange);
  startTaskbarWatch();
}

function stopTaskbarWatch() {
  watchCallbacks = [];
  if (watchRestart) clearTimeout(watchRestart);
  watchRestart = null;
  const proc = watchProc;
  watchProc = null;
  if (!proc) return;
  try { proc.kill(); } catch { /* already gone */ }
}

function toDipLayout(layout) {
  const { screen } = require("electron");
  const convert = (r) => {
    const rect = screen.screenToDipRect(null, { x: r.x, y: r.y, width: r.w, height: r.h });
    return { ...r, x: rect.x, y: rect.y, w: rect.width, h: rect.height };
  };
  return { ...layout, tray: convert(layout.tray), occupied: (layout.occupied || []).map(convert) };
}

function loadLayout() {
  const now = Date.now();
  // The watch process streams fresh layouts, so a reading never spawns a probe while it is up.
  if (!cache.data || (now - cache.at > 8000 && !watchProc)) refreshAsync();
  return cache.data || fallbackFromScreen();
}

function invalidate() {
  cache = { at: 0, data: cache.data };
  if (!sendToWatch("probe")) refreshAsync();
}

function axisOf(tray) {
  if (!tray) return { edge: "bottom", horizontal: true };
  const { screen } = require("electron");
  const { bounds } = screen.getDisplayMatching({ x: tray.x, y: tray.y, width: tray.w, height: tray.h });
  if (tray.w >= tray.h) {
    return { edge: tray.y + tray.h / 2 >= bounds.y + bounds.height / 2 ? "bottom" : "top", horizontal: true };
  }
  return { edge: tray.x + tray.w / 2 >= bounds.x + bounds.width / 2 ? "right" : "left", horizontal: false };
}

function intervalsOnAxis(tray, occupied, horizontal) {
  const start = horizontal ? tray.x : tray.y;
  const end = start + (horizontal ? tray.w : tray.h);
  const blocks = occupied
    .map((o) => {
      const a = horizontal ? o.x : o.y;
      const b = a + (horizontal ? o.w : o.h);
      return [Math.max(start, a), Math.min(end, b)];
    })
    .filter(([a, b]) => b - a > 8)
    .sort((p, q) => p[0] - q[0]);

  const gaps = [];
  let cursor = start;
  for (const [a, b] of blocks) {
    if (a - cursor > 12) gaps.push([cursor, a]);
    cursor = Math.max(cursor, b);
  }
  if (end - cursor > 12) gaps.push([cursor, end]);
  return gaps;
}

function extraOccupied(extras) {
  return (extras || []).filter(Boolean);
}

function rectsOverlap(a, b, min) {
  const ix = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const iy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return ix > min && iy > min;
}

function overlapsOccupied(x, y, w, h, extras) {
  const layout = loadLayout();
  const tray = layout && layout.tray;
  if (!tray) return false;
  const self = { x, y, w, h };
  const occupied = [...(layout.occupied || []), ...extraOccupied(extras)];
  return occupied.some((o) => rectsOverlap(self, o, 8));
}

function dockRoom(w, h, extras) {
  const layout = loadLayout();
  const tray = layout && layout.tray;
  if (!tray) return { fits: false, maxGap: 0 };
  const { horizontal } = axisOf(tray);
  if ((horizontal ? h > tray.h : w > tray.w)) return { fits: false, maxGap: 0 };
  const occupied = [...(layout.occupied || []), ...extraOccupied(extras)];
  const needed = (horizontal ? w : h) + PAD * 2 + 16;
  let maxGap = 0;
  for (const [a, b] of intervalsOnAxis(tray, occupied, horizontal)) {
    maxGap = Math.max(maxGap, b - a);
  }
  return { fits: maxGap >= needed, maxGap, needed };
}

function isWellDocked(x, y, w, h, extras) {
  const layout = loadLayout();
  const tray = layout && layout.tray;
  if (!tray) return false;
  const { horizontal } = axisOf(tray);
  if (x < tray.x || y < tray.y || x + w > tray.x + tray.w || y + h > tray.y + tray.h) return false;
  return !overlapsOccupied(x, y, w, h, extras);
}

function snapDocked(x, y, w, h, extras) {
  const layout = loadLayout();
  const tray = layout && layout.tray;
  if (!tray) {
    return { x, y, offTaskbar: false, ok: false };
  }
  const { horizontal } = axisOf(tray);
  const occupied = [...(layout.occupied || []), ...extraOccupied(extras)];
  const gaps = intervalsOnAxis(tray, occupied, horizontal).map(([a, b]) => [
    a + PAD,
    b - PAD,
  ]);

  const along = horizontal ? x : y;
  const size = horizontal ? w : h;
  const usable = gaps.filter(([a, b]) => b - a >= size);
  if (!usable.length) {
    return { x, y, offTaskbar: false, ok: false };
  }

  let chosen = usable[usable.length - 1];
  let best = Infinity;
  for (const g of usable) {
    const clamped = Math.min(Math.max(along, g[0]), g[1] - size);
    const dist = Math.abs(clamped - along);
    if (dist < best) {
      best = dist;
      chosen = g;
    }
  }
  const snappedAlong = Math.min(Math.max(along, chosen[0]), chosen[1] - size);

  const trayAlongCross = horizontal ? tray.y : tray.x;
  const thickness = horizontal ? tray.h : tray.w;
  const cross = trayAlongCross + Math.round((thickness - (horizontal ? h : w)) / 2);
  const cursorCross = horizontal ? y : x;
  const offTaskbar = Math.abs(cursorCross - trayAlongCross) > thickness + 28;

  if (horizontal) return { x: Math.round(snappedAlong), y: Math.round(cross), offTaskbar, ok: true };
  return { x: Math.round(cross), y: Math.round(snappedAlong), offTaskbar, ok: true };
}

function defaultDocked(w, h, extras) {
  const layout = loadLayout();
  const tray = layout && layout.tray;
  if (!tray) return null;
  const { horizontal } = axisOf(tray);
  const occupied = [...(layout.occupied || []), ...extraOccupied(extras)];
  const gaps = intervalsOnAxis(tray, occupied, horizontal)
    .map(([a, b]) => [a + PAD, b - PAD])
    .filter(([a, b]) => b - a >= (horizontal ? w : h));
  if (!gaps.length) return snapDocked(tray.x, tray.y, w, h, extras);
  const gap = gaps[gaps.length - 1];
  const along = gap[1] - (horizontal ? w : h);
  const trayAlongCross = horizontal ? tray.y : tray.x;
  const thickness = horizontal ? tray.h : tray.w;
  const cross = trayAlongCross + Math.round((thickness - (horizontal ? h : w)) / 2);
  if (horizontal) return { x: Math.round(along), y: Math.round(cross), offTaskbar: false, ok: true };
  return { x: Math.round(cross), y: Math.round(along), offTaskbar: false, ok: true };
}

function anchorAboveTaskbar(w, h, extras, preferredAlong) {
  const layout = loadLayout();
  const tray = layout && layout.tray;
  if (!tray) return null;
  const { edge, horizontal } = axisOf(tray);
  const occupied = [...(layout.occupied || []), ...extraOccupied(extras)];
  const sizeAlong = horizontal ? w : h;
  const gaps = intervalsOnAxis(tray, occupied, horizontal)
    .map(([a, b]) => [a + PAD, b - PAD])
    .filter(([a, b]) => b - a >= sizeAlong);

  let along;
  if (gaps.length) {
    let chosen = gaps[gaps.length - 1];
    if (preferredAlong != null) {
      let best = Infinity;
      for (const g of gaps) {
        const clamped = Math.min(Math.max(preferredAlong, g[0]), g[1] - sizeAlong);
        const dist = Math.abs(clamped - preferredAlong);
        if (dist < best) {
          best = dist;
          chosen = g;
        }
      }
      along = Math.min(Math.max(preferredAlong, chosen[0]), chosen[1] - sizeAlong);
    } else {
      along = chosen[1] - sizeAlong;
    }
  } else {
    along = (horizontal ? tray.x + tray.w : tray.y + tray.h) - sizeAlong - PAD;
  }

  let x;
  let y;
  if (horizontal) {
    x = along;
    y = edge === "bottom" ? tray.y - h : tray.y + tray.h;
  } else {
    y = along;
    x = edge === "right" ? tray.x - w : tray.x + tray.w;
  }
  return { x: Math.round(x), y: Math.round(y), ok: true, offTaskbar: false };
}

module.exports = {
  loadLayout,
  invalidate,
  snapDocked,
  defaultDocked,
  anchorAboveTaskbar,
  setChipsOwner,
  taskbarShown,
  watchTaskbar,
  stopTaskbarWatch,
  isWellDocked,
  overlapsOccupied,
  dockRoom,
};
