// Exposes a few native helpers to the UI. Nothing else from Node reaches the page.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("nl", {
  app: true,
  platform: process.platform,
  pickFolder: () => ipcRenderer.invoke("pick-folder"),
  openPath: (p) => ipcRenderer.invoke("open-path", p),
});
