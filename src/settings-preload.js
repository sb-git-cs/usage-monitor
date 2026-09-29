const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("settingsApi", {
  get: () => ipcRenderer.invoke("settings:get"),
  set: (patch) => ipcRenderer.invoke("settings:set", patch),
  phone: (op, arg) => ipcRenderer.invoke("settings:phone", op, arg),
  checkUpdates: () => ipcRenderer.send("settings:check-updates"),
  openNetwork: () => ipcRenderer.send("settings:open-network"),
  openLogs: () => ipcRenderer.send("settings:open-logs"),
  onState: (cb) => ipcRenderer.on("settings:state", (_e, view) => cb(view)),
});
