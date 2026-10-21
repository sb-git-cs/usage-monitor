const { contextBridge, ipcRenderer } = require("electron");

// The click-away overlay only ever hides the flyout.
contextBridge.exposeInMainWorld("usage", {
  hideFlyout: () => ipcRenderer.send("usage://flyout-hide"),
});
