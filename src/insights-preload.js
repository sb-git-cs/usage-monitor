const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("insightsApi", {
  onTab: (cb) => ipcRenderer.on("insights:tab", (_e, tab) => cb(tab)),
  get: (days) => ipcRenderer.invoke("insights:get", days),
  action: (action, value) => ipcRenderer.invoke("insights:action", action, value),
  export: (format, days, model) => ipcRenderer.invoke("insights:export", format, days, model),
});
