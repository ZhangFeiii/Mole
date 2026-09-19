const {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  shell,
  session,
} = require("electron");
const path = require("node:path");
const fs = require("node:fs/promises");
const { pathToFileURL } = require("node:url");
const { startAgent } = require("./agent.cjs");
const { authorizePath, trustedSender } = require("./security.cjs");

app.setName("Mole Desktop");
const indexPath = path.join(__dirname, "../dist/index.html");
const trustedURL = pathToFileURL(indexPath).href;
const executable = path.join(
  app.isPackaged
    ? path.join(process.resourcesPath, "agent")
    : path.join(__dirname, "../resources"),
  `desktop-agent${process.platform === "win32" ? ".exe" : ""}`,
);
let window;
let home;
let roots = [];
let activeScan;
let statusJob;
let lastStatus;
let lastStatusAt = 0;

function handle(channel, fn) {
  ipcMain.handle(channel, (event, ...args) => {
    if (!trustedSender(event, window?.webContents, trustedURL))
      throw new Error("Untrusted IPC sender");
    return fn(...args);
  });
}

handle("mole:bootstrap", () => ({
  home,
  platform: process.platform,
  version: app.getVersion(),
  readOnly: true,
}));
handle("mole:choose", async () => {
  const choice = await dialog.showOpenDialog(window, {
    title: "选择要只读分析的本地文件夹",
    defaultPath: home,
    properties: ["openDirectory"],
  });
  if (choice.canceled || !choice.filePaths[0]) return null;
  const selected = await fs.realpath(choice.filePaths[0]);
  if (process.platform === "win32" && /^(\\\\|\/\/)/.test(selected))
    throw new Error("暂不支持网络目录");
  if (!roots.includes(selected)) roots.push(selected);
  return selected;
});
handle("mole:status", async () => {
  if (Date.now() - lastStatusAt < 1500 && lastStatus) return lastStatus;
  if (!statusJob) {
    const job = startAgent(executable, "status");
    statusJob = job;
    job.promise = job.promise
      .then((result) => {
        lastStatus = result;
        lastStatusAt = Date.now();
        return result;
      })
      .finally(() => {
        if (statusJob === job) statusJob = undefined;
      });
  }
  return statusJob.promise;
});
handle("mole:scan", async (root, id) => {
  if (typeof id !== "string" || !/^[a-zA-Z0-9-]{1,80}$/.test(id))
    throw new Error("Invalid scan ID");
  if (activeScan) throw new Error("已有扫描正在进行，请先停止");
  // Reserve the slot before awaiting authorization to prevent concurrent starts.
  const state = { id, job: undefined, cancelled: false };
  activeScan = state;
  try {
    const authorized = await authorizePath(root, roots);
    if (state.cancelled) return { cancelled: true };
    state.job = startAgent(executable, "scan", authorized, (data) => {
      if (
        activeScan === state &&
        !state.cancelled &&
        window &&
        !window.isDestroyed()
      )
        window.webContents.send("mole:progress", { id, data });
    });
    return await state.job.promise;
  } finally {
    if (activeScan === state) activeScan = undefined;
  }
});
handle("mole:cancel", (id) => {
  if (activeScan?.id === id) {
    activeScan.cancelled = true;
    activeScan.job?.cancel();
  }
});
handle("mole:reveal", async (value) => {
  const authorized = await authorizePath(value, roots);
  shell.showItemInFolder(authorized);
});

function stopJobs() {
  activeScan?.job?.cancel();
  statusJob?.cancel();
}
async function createWindow() {
  home = await fs.realpath(app.getPath("home"));
  roots = [home];
  window = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 980,
    minHeight: 680,
    title: "Mole Desktop",
    backgroundColor: "#f7f8fa",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.on("closed", () => {
    stopJobs();
    window = undefined;
  });
  window.once("ready-to-show", () => window.show());
  await window.loadFile(indexPath);
}

app
  .whenReady()
  .then(async () => {
    session.defaultSession.setPermissionRequestHandler(
      (_contents, _permission, callback) => callback(false),
    );
    session.defaultSession.setPermissionCheckHandler(() => false);
    // No telemetry, remote fonts, or network requests from the renderer.
    session.defaultSession.webRequest.onBeforeRequest(
      { urls: ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*"] },
      (_details, callback) => callback({ cancel: true }),
    );
    await createWindow();
  })
  .catch((error) => {
    dialog.showErrorBox("Mole Desktop 无法启动", error.message);
    app.quit();
  });
app.on("before-quit", stopJobs);
app.on("window-all-closed", () => app.quit());
