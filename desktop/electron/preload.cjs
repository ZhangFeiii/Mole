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
    trashAnalysisEntry: (entryId) =>
      ipcRenderer.invoke("mole:trash-analysis", entryId),
    maintenancePreview: (kind, options) =>
      ipcRenderer.invoke("mole:maintenance-preview", kind, options),
    maintenanceExecute: (kind, planId, selectedIds) =>
      ipcRenderer.invoke("mole:maintenance-execute", kind, planId, selectedIds),
    maintenanceWorkspace: (kind) =>
      ipcRenderer.invoke("mole:maintenance-workspace", kind),
    maintenanceState: () => ipcRenderer.invoke("mole:maintenance-state"),
    maintenanceCancel: (kind) =>
      ipcRenderer.invoke("mole:maintenance-cancel", kind),
    maintenanceRecover: () => ipcRenderer.invoke("mole:maintenance-recover"),
    protect: (planId, itemId) =>
      ipcRenderer.invoke("mole:protect", planId, itemId),
    protectedItems: () => ipcRenderer.invoke("mole:protected-items"),
    unprotect: (id) => ipcRenderer.invoke("mole:unprotect", id),
    systemPage: (page) => ipcRenderer.invoke("mole:system-page", page),
    onMaintenanceProgress: (callback) => {
      const listener = (_event, data) => callback(data);
      ipcRenderer.on("mole:maintenance-progress", listener);
      return () =>
        ipcRenderer.removeListener("mole:maintenance-progress", listener);
    },
    onProgress: (callback) => {
      const listener = (_event, data) => callback(data);
      ipcRenderer.on("mole:progress", listener);
      return () => ipcRenderer.removeListener("mole:progress", listener);
    },
  }),
);
