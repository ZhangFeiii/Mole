const {
  make_temporary,
  safe_remove_temporary,
} = require("./fixtures/safe-temporary.cjs");
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawn, execFile } = require("node:child_process");
const { promisify } = require("node:util");
const fsp = require("node:fs/promises");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { createAssetVerifier } = require("../electron/integrity.cjs");

const packagedExecutable = process.env.MOLE_PACKAGED_EXE
  ? path.resolve(process.env.MOLE_PACKAGED_EXE)
  : null;

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function stopOwnedChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  assert.ok(Number.isSafeInteger(child.pid) && child.pid > 0);
  const closed = new Promise((resolve) => {
    const timer = setTimeout(
      () => resolve(new Error("Owned packaged process did not close")),
      15000,
    );
    child.once("close", () => {
      clearTimeout(timer);
      resolve(null);
    });
  });
  // Terminate only the process tree returned by this test's own spawn. Killing
  // just Electron's parent can leave Chromium holding the temporary profile.
  try {
    await promisify(execFile)(
      path.join(process.env.SystemRoot, "System32", "taskkill.exe"),
      ["/PID", String(child.pid), "/T", "/F"],
      { windowsHide: true, shell: false, timeout: 10000 },
    );
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      const closeError = await closed;
      throw closeError || error;
    }
  }
  const error = await closed;
  if (error) throw error;
}

async function waitForRunning(child, milliseconds) {
  const started = Date.now();
  while (Date.now() - started < milliseconds) {
    if (child.exitCode !== null)
      throw new Error(
        `packaged application exited with code ${child.exitCode}`,
      );
    await wait(100);
  }
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = address.port;
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

async function cdpReady(port, timeoutMs = 20000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      await new Promise((resolve, reject) => {
        const request = http.get(
          `http://127.0.0.1:${port}/json/version`,
          (response) => {
            response.resume();
            response.once("end", () =>
              response.statusCode === 200
                ? resolve()
                : reject(new Error(`CDP status ${response.statusCode}`)),
            );
          },
        );
        request.setTimeout(500, () =>
          request.destroy(new Error("CDP timeout")),
        );
        request.once("error", reject);
      });
      return;
    } catch {
      await wait(100);
    }
  }
  throw new Error("packaged renderer CDP endpoint did not start");
}

test(
  "hardened packaged runtime has required fuses, ASAR manifest and starts",
  { skip: !packagedExecutable || process.platform !== "win32" },
  async () => {
    const { getCurrentFuseWire, FuseV1Options } = require("@electron/fuses");
    const asar = require("@electron/asar");
    // @electron/fuses intentionally exports FuseV1Options but not the wire
    // byte enum at runtime. These are the documented v1 DISABLE/ENABLE bytes.
    const FUSE_DISABLED = 0x30;
    const FUSE_ENABLED = 0x31;
    const executableStat = await fsp.stat(packagedExecutable);
    assert.ok(executableStat.isFile());
    const resourcesRoot = path.join(
      path.dirname(packagedExecutable),
      "resources",
    );
    const archive = path.join(resourcesRoot, "app.asar");
    assert.equal((await fsp.stat(archive)).isFile(), true);

    const fuseWire = await getCurrentFuseWire(packagedExecutable);
    assert.equal(fuseWire[FuseV1Options.RunAsNode], FUSE_DISABLED);
    assert.equal(
      fuseWire[FuseV1Options.EnableNodeOptionsEnvironmentVariable],
      FUSE_DISABLED,
    );
    assert.equal(
      fuseWire[FuseV1Options.EnableNodeCliInspectArguments],
      FUSE_DISABLED,
    );
    assert.equal(fuseWire[FuseV1Options.OnlyLoadAppFromAsar], FUSE_ENABLED);
    assert.equal(
      fuseWire[FuseV1Options.EnableEmbeddedAsarIntegrityValidation],
      FUSE_ENABLED,
    );

    const appRoot = await make_temporary("mole-packaged-asar-");
    const userData = await make_temporary("mole-packaged-user-");
    const tamperResources = await make_temporary("mole-packaged-resources-");
    try {
      await asar.extractAll(archive, appRoot);
      const verifier = createAssetVerifier({
        appRoot,
        resourcesRoot,
        isPackaged: true,
        platform: "win32",
      });
      const verification = await verifier.verifyAll();
      assert.equal(verification.ok, true);
      assert.equal(verification.assets.length, 3);

      await fsp.cp(
        path.join(resourcesRoot, "agent"),
        path.join(tamperResources, "agent"),
        { recursive: true },
      );
      await fsp.cp(
        path.join(resourcesRoot, "windows"),
        path.join(tamperResources, "windows"),
        { recursive: true },
      );
      const tamperedVerifier = createAssetVerifier({
        appRoot,
        resourcesRoot: tamperResources,
        isPackaged: true,
        platform: "win32",
      });
      await tamperedVerifier.verifyAll();
      await fsp.appendFile(
        path.join(tamperResources, "windows", "optimize.ps1"),
        "\n# tampered fixture\n",
      );
      await assert.rejects(
        tamperedVerifier.verify("windows/optimize.ps1"),
        (error) => error.code === "ASSET_TAMPERED",
      );

      const child = spawn(
        packagedExecutable,
        [`--user-data-dir=${userData}`, "--disable-gpu"],
        { windowsHide: true, shell: false, stdio: "ignore" },
      );
      try {
        await waitForRunning(child, 4000);
        assert.equal(
          child.exitCode,
          null,
          "the real packaged executable did not stay running",
        );
      } finally {
        await stopOwnedChild(child);
      }
    } finally {
      await safe_remove_temporary(appRoot);
      await safe_remove_temporary(userData);
      await safe_remove_temporary(tamperResources);
    }
  },
);

test(
  "hardened package supports renderer-only read-only page smoke and screenshots",
  { skip: !packagedExecutable || process.platform !== "win32" },
  async () => {
    const { chromium } = require("@playwright/test");
    const port = await freePort();
    const userData = await make_temporary("mole-packaged-cdp-");
    const screenshotRoot = path.resolve("test-results", "packaged");
    await fsp.mkdir(screenshotRoot, { recursive: true });
    const child = spawn(
      packagedExecutable,
      [
        `--user-data-dir=${userData}`,
        `--remote-debugging-port=${port}`,
        "--disable-gpu",
      ],
      { windowsHide: true, shell: false, stdio: "ignore" },
    );
    let browser;
    try {
      // This is an explicit Chromium renderer CDP port for CI only. It is not
      // the Node inspector flag disabled by the production fuse.
      await cdpReady(port);
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
      const context = browser.contexts()[0];
      assert.ok(context, "packaged app did not create a browser context");
      const page =
        context.pages()[0] ||
        (await context.waitForEvent("page", { timeout: 20000 }));
      await page.waitForURL(/^file:.*\/dist\/index\.html$/, { timeout: 20000 });
      await page.waitForLoadState("domcontentloaded");
      await page
        .getByRole("navigation", { name: "主导航" })
        .waitFor({ state: "visible" });
      const pages = [
        ["垃圾清理", "扫描可清理缓存", "cleanup"],
        ["软件管理", "扫描已安装软件", "applications"],
        ["性能维护", "检查维护选项", "optimize"],
        ["磁盘分析", null, "analyze"],
        ["系统状态", null, "status"],
      ];
      for (const [navigation, preview, filename] of pages) {
        await page
          .getByRole("button", { name: navigation, exact: true })
          .click();
        if (preview) {
          await page
            .getByRole("button", { name: preview, exact: true })
            .click();
          await page
            .locator(".maintenance-page:visible")
            .getByText(/预览清单 ·/)
            .waitFor({
              state: "visible",
              timeout: 90000,
            });
          assert.equal(
            await page.locator('input[type="checkbox"]:checked').count(),
            0,
            `${navigation} unexpectedly selected a maintenance item`,
          );
        }
        await page.mouse.move(1, 1);
        await page.screenshot({
          path: path.join(screenshotRoot, `${filename}.png`),
          fullPage: true,
          animations: "disabled",
        });
      }
    } finally {
      try {
        await stopOwnedChild(child);
      } finally {
        await browser?.close().catch(() => {});
      }
      await safe_remove_temporary(userData);
    }
  },
);
