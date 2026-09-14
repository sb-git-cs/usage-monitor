const { execFile } = require("child_process");
const path = require("path");

const SCRIPT = path.join(__dirname, "..", "scripts", "taskbar-layout.ps1");
const PAD = 6;
let cache = { at: 0, data: null };
let refreshing = false;

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

function refreshAsync() {
  if (refreshing) return;
  refreshing = true;
  execFile(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", SCRIPT],
    { encoding: "utf8", timeout: 4000, windowsHide: true },
    (err, stdout) => {
      refreshing = false;
      if (err || !stdout) return;
      try {
        const parsed = JSON.parse(String(stdout).trim());
        if (parsed && parsed.tray) cache = { at: Date.now(), data: parsed };
      } catch {
        /* keep previous */
      }
    }
  );
}

function loadLayout() {
  const now = Date.now();
  if (!cache.data || now - cache.at > 8000) refreshAsync();
  return cache.data || fallbackFromScreen();
}

function invalidate() {
  cache = { at: 0, data: cache.data };
  refreshAsync();
}

function axisOf(tray) {
  if (!tray) return { edge: "bottom", horizontal: true };
  if (tray.w >= tray.h) {
    return { edge: tray.y > 200 ? "bottom" : "top", horizontal: true };
  }
  return { edge: tray.x > 200 ? "right" : "left", horizontal: false };
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

module.exports = { loadLayout, invalidate, snapDocked, defaultDocked, anchorAboveTaskbar };
