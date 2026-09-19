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
const {
  createMaintenanceController,
  createAuditLog,
} = require("./maintenance.cjs");
const { createPowerShellRunner } = require("./powershell.cjs");
const { createCleanupService } = require("./cleanup.cjs");
const { createApplicationsService } = require("./applications.cjs");
const { createOptimizeService } = require("./optimize.cjs");

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
let maintenance;

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
  readOnly: process.platform !== "win32",
  maintenance: process.platform === "win32",
}));
handle("mole:maintenance-preview", (kind) => maintenance.preview(kind));
handle("mole:maintenance-execute", (kind, planId, selectedIds) =>
  maintenance.execute(kind, planId, selectedIds),
);
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
let closeNotice;
let allowExit = false;
function preventUntrackedExit(event) {
  if (allowExit || !maintenance?.isExecuting()) return;
  event.preventDefault();
  if (!closeNotice) {
    closeNotice = dialog
      .showMessageBox(window, {
        type: "warning",
        title: "维护尚未结束",
        message: "建议等待当前确认或维护返回结果后再退出。",
        detail:
          "若现在退出，已启动的 Windows 卸载或维护可能继续，退出不能撤销它们。下次使用前请检查系统状态，不要重复执行。",
        buttons: ["继续等待", "确认退出（结果可能未知）"],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      })
      .then(async (choice) => {
        if (choice.response !== 1) return;
        try {
          await maintenance.abandon();
        } catch {
          dialog.showErrorBox(
            "日志写入失败",
            "维护结果未知，退出记录未能保存。请检查 Windows 是否仍有正在运行的操作。",
          );
        }
        allowExit = true;
        app.quit();
      })
      .finally(() => {
        closeNotice = undefined;
      });
  }
}
async function createWindow() {
  const runPowerShell = createPowerShellRunner({
    scriptsDirectory: app.isPackaged
      ? path.join(process.resourcesPath, "windows")
      : path.join(__dirname, "../windows"),
  });
  maintenance = createMaintenanceController({
    services: {
      cleanup: createCleanupService({
        executable,
        trashItem: (value) => shell.trashItem(value),
      }),
      applications: createApplicationsService({ runPowerShell }),
      optimize: createOptimizeService({ runPowerShell }),
    },
    audit: createAuditLog(
      path.join(app.getPath("userData"), "maintenance-logs"),
    ),
    confirm: async ({ title, items, kind }) => {
      const detail =
        items
          .slice(0, 25)
          .map((item) => `• ${item.name}`)
          .join("\n") +
        (items.length > 25 ? `\n…共 ${items.length} 项` : "") +
        (kind === "applications"
          ? "\n\n软件卸载不能通过回收站恢复。请先备份软件数据；第三方卸载程序可能显示独立确认窗口。"
          : kind === "cleanup"
            ? "\n\n文件仅移入回收站；若回收失败，不会改为永久删除。"
            : "\n\n将执行所选 Windows 维护操作；不保证提高性能。权限不足的项目会明确跳过或报错。");
      const choice = await dialog.showMessageBox(window, {
        type: "warning",
        title,
        message: `${title}？`,
        detail,
        buttons: ["取消", "确认执行"],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      return choice.response === 1;
    },
  });
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
  window.on("close", preventUntrackedExit);
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
app.on("before-quit", (event) => {
  preventUntrackedExit(event);
  if (!event.defaultPrevented) stopJobs();
});
app.on("window-all-closed", () => app.quit());
