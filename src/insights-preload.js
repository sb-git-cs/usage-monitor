const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("insightsApi", {
  get: (days) => ipcRenderer.invoke("insights:get", days),
  action: (action, value) => ipcRenderer.invoke("insights:action", action, value),
  export: (format, days) => ipcRenderer.invoke("insights:export", format, days),
});
