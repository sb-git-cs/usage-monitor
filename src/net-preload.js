const { contextBridge, ipcRenderer } = require("electron");

const listen = (channel) => (cb) => ipcRenderer.on(channel, (_e, value) => cb(value));

contextBridge.exposeInMainWorld("netUsage", {
  getState: () => ipcRenderer.invoke("net:state"),
  onState: listen("net:state"),
  onUpdate: listen("net:update"),
  onCommand: listen("net:command"),
  onToast: listen("net:toast"),
  setRange: (id) => ipcRenderer.send("net:range", String(id)),
  icon: (key) => ipcRenderer.invoke("net:icon", key),
  series: (key, range) => ipcRenderer.invoke("net:series", key, range),
  connections: (key) => ipcRenderer.invoke("net:connections", key),
  action: (type, key, arg) => ipcRenderer.invoke("net:action", type, key, arg),
  rowMenu: (key) => ipcRenderer.send("net:row-menu", key),
  setSettings: (patch) => ipcRenderer.invoke("net:settings", patch),
  chooseFolder: (useDefault) => ipcRenderer.invoke("net:choose-folder", useDefault === true),
  openFolder: () => ipcRenderer.send("net:open-folder"),
  deleteData: (scope, minutes) => ipcRenderer.invoke("net:delete", scope, minutes),
  exportCsv: (text, name) => ipcRenderer.invoke("net:export", text, name),
  helper: (op) => ipcRenderer.invoke("net:helper", op),
});
