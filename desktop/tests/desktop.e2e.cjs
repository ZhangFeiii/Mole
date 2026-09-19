const { test, expect, _electron: electron } = require("@playwright/test");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");

if (process.env.MOLE_PACKAGED_EXE)
  throw new Error(
    "Use npm run test:packaged for hardened packages; source E2E requires the development main-process test bridge.",
  );

let app, page, root, profile;
const fixtureFiles = new Map([
  ["项目资料/design-assets.bin", 7 * 1024 * 1024],
  ["项目资料/source-notes.md", 1 * 1024 * 1024],
  ["视频片段/weekend-cut.mp4", 12 * 1024 * 1024],
  ["下载归档/toolkit.zip", 3 * 1024 * 1024],
  ["阅读清单.md", 256 * 1024],
]);
let hashes;
async function screenshot(name) {
  // Capture the settled view, not the previous navigation hover/transition.
  await page.mouse.move(1, 1);
  await page.screenshot({
    path: `test-results/${name}.png`,
    fullPage: true,
    animations: "disabled",
  });
}
async function snapshot() {
  const out = {};
  for (const name of fixtureFiles.keys())
    out[name] = crypto
      .createHash("sha256")
      .update(await fs.readFile(path.join(root, name)))
      .digest("hex");
  return out;
}
test.describe.configure({ mode: "serial" });
test.beforeAll(async () => {
  root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "mole-e2e-")),
  );
  for (const [name, size] of fixtureFiles) {
    const filename = path.join(root, name);
    await fs.mkdir(path.dirname(filename), { recursive: true });
    await fs.writeFile(filename, Buffer.alloc(size, 0x4d));
  }
  hashes = await snapshot();
  profile = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "mole-e2e-profile-")),
  );
  app = await electron.launch({
    args: [path.resolve(__dirname, ".."), `--user-data-dir=${profile}`],
    env: {
      ...process.env,
      ELECTRON_DISABLE_SECURITY_WARNINGS: "false",
    },
  });
  page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await expect(
    page.getByRole("heading", { name: "让空间回到你手中。" }),
  ).toBeVisible();
  await expect(
    page.getByRole("navigation", { name: "主导航" }).getByRole("button"),
  ).toHaveCount(5);
  await page.getByRole("button", { name: "打开概览", exact: true }).click();
  // Exercise the real main-process directory authorization path. Only the
  // native picker response is supplied by the test.
  await app.evaluate(({ dialog }, selected) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [selected],
    });
  }, root);
  await page
    .getByRole("button", { name: "选择其他文件夹", exact: true })
    .click();
  await page.getByRole("button", { name: "打开概览", exact: true }).click();
});
test.afterAll(async () => {
  await app?.close();
});

test("overview is a real isolated desktop window with live metrics", async () => {
  await expect(
    page.getByRole("heading", { name: "看清空间，从容整理。" }),
  ).toBeVisible();
  await expect(
    page.getByText(process.platform === "win32" ? "受控维护" : "只读模式", {
      exact: true,
    }),
  ).toBeVisible();
  await expect
    .poll(() => page.locator(".metric-value").nth(1).textContent())
    .not.toBe("—");
  expect(await page.evaluate(() => typeof window.require)).toBe("undefined");
  const prefs = await app.evaluate(({ BrowserWindow }) => {
    const p =
      BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
    return {
      node: p.nodeIntegration,
      isolated: p.contextIsolation,
      sandbox: p.sandbox,
    };
  });
  expect(prefs).toEqual({ node: false, isolated: true, sandbox: true });
  await screenshot("overview");
});

test("scan and treemap match real fixture bytes, drill down, filter and go back", async () => {
  await page.getByRole("button", { name: "分析我的文件", exact: true }).click();
  await expect(page.getByText("扫描完成", { exact: true })).toBeVisible();
  await expect(page.getByTestId("scan-files")).toHaveText("5");
  const expectedBytes = [...fixtureFiles.values()].reduce((a, b) => a + b, 0);
  const totals = await page.evaluate(
    async (scanRoot) => window.mole.scan(scanRoot, "verification-scan"),
    root,
  );
  expect(totals.bytes).toBe(expectedBytes);
  expect(totals.partial).toBe(false);
  await expect(page.getByTestId("treemap")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "删除", exact: true }),
  ).toHaveCount(0);
  await screenshot("analyze");
  await page.getByRole("tab", { name: /大文件/ }).click();
  await page.getByRole("textbox", { name: "筛选结果" }).fill("weekend");
  await expect(page.locator("tbody tr")).toHaveCount(1);
  await expect(page.locator("tbody")).toContainText("weekend-cut.mp4");
  await page.getByRole("textbox", { name: "筛选结果" }).fill("");
  await page.getByRole("tab", { name: /目录占用/ }).click();
  await page
    .locator("tbody")
    .getByRole("button", { name: "项目资料", exact: true })
    .click();
  await expect(page.getByTestId("scan-files")).toHaveText("2");
  await page.getByRole("button", { name: "返回上层扫描" }).click();
  await expect(page.getByTestId("scan-files")).toHaveText("5");
  expect(await snapshot()).toEqual(hashes);
});

test("folder chooser, empty state, denied roots and live status work", async () => {
  const empty = path.join(root, "empty");
  await fs.mkdir(empty);
  await app.evaluate(({ dialog }, selected) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [selected],
    });
  }, empty);
  await page.getByRole("button", { name: "选择文件夹", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "先了解，再整理。" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "开始扫描", exact: true }).click();
  await expect(page.getByTestId("scan-files")).toHaveText("0");
  await expect(page.getByText("此目录没有已统计到的非空文件。")).toBeVisible();
  const denied = await page.evaluate(async () => {
    try {
      await window.mole.scan(
        (await window.mole.bootstrap()).platform === "win32" ? "C:\\" : "/",
        "denied-test",
      );
      return false;
    } catch {
      return true;
    }
  });
  expect(denied).toBe(true);
  await page.getByRole("button", { name: "系统状态", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "每一次变化，都看得见。" }),
  ).toBeVisible();
  await expect(page.locator(".status-number").first()).not.toHaveText("—");
  await screenshot("status");
  expect(await snapshot()).toEqual(hashes);
});

test("maintenance pages preview real capabilities and cancelling never executes", async () => {
  test.setTimeout(180000);
  // Never confirm a mutation against the runner's real files or installed apps.
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({
      response: 0,
      checkboxChecked: false,
    });
  });
  for (const [kind, name, title, preview] of [
    ["cleanup", "垃圾清理", "让空间回到你手中。", "扫描可清理缓存"],
    ["applications", "软件管理", "软件去留，由你决定。", "扫描已安装软件"],
    ["optimize", "性能维护", "有依据地维护电脑。", "检查维护选项"],
  ]) {
    await page.getByRole("button", { name, exact: true }).click();
    await expect(page.getByRole("heading", { name: title })).toBeVisible();
    await expect(
      page
        .getByRole("navigation", { name: "主导航" })
        .locator('[aria-current="page"]'),
    ).toHaveText(name);
    await expect(
      page.locator(".maintenance-page:visible .page-heading p"),
    ).toHaveCSS("color", "rgb(94, 112, 100)");
    if (process.platform !== "win32") {
      await expect(
        page.getByRole("button", { name: preview, exact: true }),
      ).toBeDisabled();
      const rejected = await page.evaluate(async (kind) => {
        try {
          await window.mole.maintenancePreview(kind);
          return false;
        } catch {
          return true;
        }
      }, kind);
      expect(rejected).toBe(true);
    } else {
      await page.getByRole("button", { name: preview, exact: true }).click();
      await expect(
        page.locator(".maintenance-page:visible").getByText(/预览清单 ·/),
      ).toBeVisible({
        timeout: 90000,
      });
      await expect(page.locator('input[type="checkbox"]:checked')).toHaveCount(
        0,
      );
      if (kind === "applications") {
        const row = page
          .locator(".maintenance-page:visible .maintenance-item")
          .first();
        const publisher = row.locator("div > small").first();
        if (await publisher.count()) {
          const nameBox = await row.locator("strong").boundingBox();
          const publisherBox = await publisher.boundingBox();
          expect(publisherBox.y).toBeGreaterThanOrEqual(
            nameBox.y + nameBox.height - 1,
          );
        }
      }
      const plan = await page.evaluate(
        (kind) => window.mole.maintenancePreview(kind),
        kind,
      );
      expect(Array.isArray(plan.items)).toBe(true);
      const enabled = plan.items.find((item) => item.enabled !== false);
      if (enabled) {
        const cancelled = await page.evaluate(
          async ({ kind, id, selected }) =>
            window.mole.maintenanceExecute(kind, id, [selected]),
          { kind, id: plan.id, selected: enabled.id },
        );
        expect(cancelled.cancelled).toBe(true);
        expect(cancelled.results).toEqual([]);
      }
      const forged = await page.evaluate(
        async ({ kind, id }) => {
          try {
            await window.mole.maintenanceExecute(kind, id, [
              "not-a-preview-item",
            ]);
            return false;
          } catch {
            return true;
          }
        },
        { kind, id: plan.id },
      );
      expect(forged).toBe(true);
    }
    await screenshot(kind);
  }
  expect(await snapshot()).toEqual(hashes);
});

test("Windows recycle bin receives only a dedicated disposable cache fixture", async () => {
  test.skip(
    process.platform !== "win32" || process.env.GITHUB_ACTIONS !== "true",
    "Native mutation runs only in ephemeral Windows CI",
  );
  test.setTimeout(90000);
  const directory = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "mole-recycle-测试-")),
  );
  const disposable = path.join(directory, "disposable.tmp");
  const protectedFile = path.join(directory, "important.docx.tmp");
  await fs.writeFile(disposable, "disposable fixture cache");
  await fs.writeFile(protectedFile, "preserve this fixture document");
  const proof = await app.evaluate(async ({ app, shell }, directory) => {
    const load = process
      .getBuiltinModule("node:module")
      .createRequire(app.getAppPath() + "/package.json");
    const path = load("node:path");
    const { createCleanupService } = load("./electron/cleanup.cjs");
    const { createMaintenanceController } = load("./electron/maintenance.cjs");
    const events = [];
    const cleanup = createCleanupService({
      executable: path.join(
        app.isPackaged
          ? path.join(process.resourcesPath, "agent")
          : path.join(app.getAppPath(), "resources"),
        "desktop-agent.exe",
      ),
      trashItem: (value) => shell.trashItem(value),
      home: directory,
      env: {},
      testRoots: [
        {
          id: "fixture",
          name: "Disposable test cache",
          path: directory,
          extensions: [".tmp"],
          daysOld: 0,
        },
      ],
      testWhitelistPath: path.join(directory, "whitelist.txt"),
    });
    const controller = createMaintenanceController({
      services: { cleanup },
      confirm: async () => {
        events.push("confirmed");
        return true;
      },
      audit: async (event) => {
        events.push(event.event);
      },
    });
    const plan = await controller.preview("cleanup");
    if (plan.items.length !== 1 || plan.items[0].name !== "disposable.tmp")
      return { plan, events };
    const result = await controller.execute("cleanup", plan.id, [
      plan.items[0].id,
    ]);
    return { result, events };
  }, directory);
  expect(proof.result, JSON.stringify(proof)).toBeTruthy();
  expect(proof.result.results[0].status, JSON.stringify(proof)).toBe("success");
  expect(proof.events).toEqual(["confirmed", "started", "finished"]);
  await expect(fs.stat(disposable)).rejects.toThrow();
  expect(await fs.readFile(protectedFile, "utf8")).toBe(
    "preserve this fixture document",
  );
});

test("analysis recycles only the explicitly selected fixture through the real main IPC", async () => {
  test.skip(
    process.platform !== "win32" || process.env.GITHUB_ACTIONS !== "true",
    "Disposable write test is Windows CI only",
  );
  const directory = await fs.realpath(
    await fs.mkdtemp(path.join(os.homedir(), "mole-analysis-fixture-")),
  );
  const selectedFile = path.join(directory, "selected-note.txt"),
    kept = path.join(directory, "keep-note.txt");
  await fs.writeFile(selectedFile, "selected fixture");
  await fs.writeFile(kept, "keep fixture");
  await app.evaluate(({ dialog }, selected) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [selected],
    });
    dialog.showMessageBox = async () => ({
      response: 1,
      checkboxChecked: false,
    });
  }, directory);
  await page.getByRole("button", { name: "磁盘分析", exact: true }).click();
  await page.getByRole("button", { name: "选择文件夹", exact: true }).click();
  await page.getByRole("button", { name: "开始扫描", exact: true }).click();
  await expect(page.getByTestId("scan-files")).toHaveText("2");
  await expect(
    page.getByRole("button", { name: "回收 selected-note.txt" }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "回收 selected-note.txt" }).click();
  await expect(page.getByTestId("scan-files")).toHaveText("1");
  await expect(fs.stat(selectedFile)).rejects.toThrow();
  expect(await fs.readFile(kept, "utf8")).toBe("keep fixture");
  const journal = await page.evaluate(() => window.mole.maintenanceState());
  expect(journal.recovery.required).toBe(false);
  expect(journal.recovery.history[0].kind).toBe("files");
  expect(await snapshot()).toEqual(hashes);
});

test("a pending operation survives an app restart and requires explicit recovery", async () => {
  test.skip(
    process.platform !== "win32" || process.env.GITHUB_ACTIONS !== "true",
    "Recovery IPC test is Windows CI only",
  );
  await app.evaluate(async ({ app }) => {
    const load = process
      .getBuiltinModule("node:module")
      .createRequire(app.getAppPath() + "/package.json");
    const path = load("node:path");
    const { createOperationStore } = load("./electron/operation-store.cjs");
    const journal = createOperationStore({
      directory: path.join(app.getPath("userData"), "maintenance-journal"),
    });
    await journal.begin({
      id: "e2e-interrupted-operation",
      kind: "cleanup",
      count: 1,
      names: ["synthetic pending task"],
      phase: "running",
    });
  });
  await app.close();
  app = await electron.launch({
    args: [path.resolve(__dirname, ".."), "--user-data-dir=" + profile],
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "false" },
  });
  page = await app.firstWindow();
  await expect(
    page.getByText("上次操作需要核查，写入已锁定", { exact: true }),
  ).toBeVisible();
  const before = await page.evaluate(() => window.mole.maintenanceState());
  expect(before.recovery.required).toBe(true);
  // Read-only previews remain usable while recovery is required. Their IDs
  // must disappear from every mounted page once recovery rebuilds services.
  await page.getByRole("button", { name: "性能维护", exact: true }).click();
  await page.getByRole("button", { name: "检查维护选项", exact: true }).click();
  await expect(
    page.locator(".maintenance-page:visible").getByText(/预览清单 ·/),
  ).toBeVisible({ timeout: 30000 });
  const selectable = page.locator(
    '.maintenance-page:visible input[type="checkbox"]:enabled',
  );
  if (await selectable.count()) await selectable.first().check();
  await page.getByRole("button", { name: "垃圾清理", exact: true }).click();
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 0 });
  });
  await page
    .getByRole("button", { name: "操作记录与恢复", exact: true })
    .click();
  const recoveryDialog = page.getByRole("dialog");
  await expect(recoveryDialog).toBeVisible();
  await recoveryDialog
    .getByRole("button", { name: "我已核查，申请解除保护" })
    .click();
  await expect(
    recoveryDialog.getByText("写入保护锁已启用", { exact: true }),
  ).toBeVisible();
  expect(
    (await page.evaluate(() => window.mole.maintenanceState())).recovery
      .required,
  ).toBe(true);
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 1 });
  });
  await screenshot("recovery");
  await recoveryDialog
    .getByRole("button", { name: "我已核查，申请解除保护" })
    .click();
  await expect(
    recoveryDialog.getByText("已人工核查", { exact: false }),
  ).toBeVisible();
  expect(
    (await page.evaluate(() => window.mole.maintenanceState())).recovery
      .required,
  ).toBe(false);
  await recoveryDialog
    .getByRole("button", { name: "关闭", exact: true })
    .click();
  await expect(
    page.getByText("上次操作需要核查，写入已锁定", { exact: true }),
  ).toBeHidden();
  await page.getByRole("button", { name: "性能维护", exact: true }).click();
  await expect(
    page.locator(".maintenance-page:visible").getByText(/预览清单 ·/),
  ).toHaveCount(0);
  await expect(page.locator('input[type="checkbox"]:checked')).toHaveCount(0);
  expect(await snapshot()).toEqual(hashes);
});
