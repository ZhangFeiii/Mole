const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld(
  "mole",
  Object.freeze({
    bootstrap: () => ipcRenderer.invoke("mole:bootstrap"),
    chooseDirectory: () => ipcRenderer.invoke("mole:choose"),
    status: () => ipcRenderer.invoke("mole:status"),
    scan: (root, id) => ipcRenderer.invoke("mole:scan", root, id),
    cancel: (id) => ipcRenderer.invoke("mole:cancel", id),
    reveal: (path) => ipcRenderer.invoke("mole:reveal", path),
    onProgress: (callback) => {
      const listener = (_event, data) => callback(data);
      ipcRenderer.on("mole:progress", listener);
      return () => ipcRenderer.removeListener("mole:progress", listener);
    },
  }),
);
