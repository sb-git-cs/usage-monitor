const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("usage", {
  onSnapshot: (cb) => ipcRenderer.on("usage://snapshot", (_e, snap) => cb(snap)),
  onPinned: (cb) => ipcRenderer.on("usage://pinned", (_e, pinned) => cb(pinned)),
  refresh: () => ipcRenderer.send("usage://refresh"),
  hideOverlay: () => ipcRenderer.send("usage://overlay-hide"),
  hideFlyout: () => ipcRenderer.send("usage://flyout-hide"),
  togglePin: () => ipcRenderer.send("usage://overlay-toggle-pin"),
  toggleFlyout: () => ipcRenderer.send("usage://flyout-toggle"),
  openTrayMenu: () => ipcRenderer.send("usage://tray-menu"),
  openUsage: (id) => ipcRenderer.send("usage://open-usage", id),
  resizeOverlay: (h) => ipcRenderer.send("usage://overlay-resize", h),
  getInterval: () => ipcRenderer.invoke("usage://get-interval"),
  setIntervalSecs: (secs) => ipcRenderer.send("usage://set-interval", secs),
  onInterval: (cb) => ipcRenderer.on("usage://interval", (_e, secs) => cb(secs)),
  setChipsHit: (hit) => ipcRenderer.send("usage://chips-hit", hit),
  getChipsDocked: () => ipcRenderer.invoke("usage://get-chips-docked"),
  onChipsDocked: (cb) => ipcRenderer.on("usage://chips-docked", (_e, docked) => cb(docked)),
});
