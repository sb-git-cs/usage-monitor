const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("filesApi", {
  get: (days) => ipcRenderer.invoke("files:get", days),
  open: (id) => ipcRenderer.invoke("files:open", id),
  reveal: (id) => ipcRenderer.invoke("files:reveal", id),
  copy: (id) => ipcRenderer.invoke("files:copy", id),
  openFolder: (key) => ipcRenderer.invoke("files:open-folder", key),
  onSelect: (cb) => ipcRenderer.on("files:select", (_e, key) => cb(key)),
});
