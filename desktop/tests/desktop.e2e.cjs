const { test, expect, _electron: electron } = require("@playwright/test");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");

let app, page, root;
const fixtureFiles = new Map([
  ["项目资料/design-assets.bin", 7 * 1024 * 1024],
  ["项目资料/source-notes.md", 1 * 1024 * 1024],
  ["视频片段/weekend-cut.mp4", 12 * 1024 * 1024],
  ["下载归档/toolkit.zip", 3 * 1024 * 1024],
  ["阅读清单.md", 256 * 1024],
]);
let hashes;
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
  app = await electron.launch({
    args: [path.resolve(__dirname, "..")],
    env: {
      ...process.env,
      MOLE_E2E: "1",
      MOLE_TEST_ROOT: root,
      ELECTRON_DISABLE_SECURITY_WARNINGS: "false",
    },
  });
  page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
});
test.afterAll(async () => {
  await app?.close();
});

test("overview is a real isolated desktop window with live metrics", async () => {
  await expect(
    page.getByRole("heading", { name: "看清空间，从容整理。" }),
  ).toBeVisible();
  await expect(page.getByText("只读模式", { exact: true })).toBeVisible();
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
  await page.screenshot({ path: "test-results/overview.png", fullPage: true });
});

test("scan and treemap match real fixture bytes, drill down, filter and go back", async () => {
  await page.getByRole("button", { name: "分析我的文件", exact: true }).click();
  await expect(page.getByText("扫描完成", { exact: true })).toBeVisible();
  await expect(page.getByTestId("scan-files")).toHaveText("5");
  const expectedBytes = [...fixtureFiles.values()].reduce((a, b) => a + b, 0);
  const totals = await page.evaluate(async () => {
    const boot = await window.mole.bootstrap();
    return window.mole.scan(boot.home, "verification-scan");
  });
  expect(totals.bytes).toBe(expectedBytes);
  expect(totals.partial).toBe(false);
  await expect(page.getByTestId("treemap")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "删除", exact: true }),
  ).toHaveCount(0);
  await page.screenshot({ path: "test-results/analyze.png", fullPage: true });
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
  await page.screenshot({ path: "test-results/status.png", fullPage: true });
  expect(await snapshot()).toEqual(hashes);
});
