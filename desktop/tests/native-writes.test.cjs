const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { spawn, execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { createPowerShellRunner } = require("../electron/powershell.cjs");
const nativeCI =
  process.platform === "win32" && process.env.GITHUB_ACTIONS === "true";

test(
  "Windows hosted CI uninstalls only its newly created marked fixture application",
  { skip: !nativeCI, timeout: 180000 },
  async () => {
    const {
      createApplicationsService,
    } = require("../electron/applications.cjs");
    const directory = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "mole-uninstall-测试-")),
    );
    const executable = path.join(directory, "MoleFixture.exe");
    const marker = path.join(directory, "completed.txt");
    const token = crypto.randomUUID();
    await promisify(execFile)(
      "go",
      ["build", "-o", executable, "./desktop/tests/fixtures/uninstaller"],
      { cwd: path.resolve(__dirname, "../..") },
    );
    const env = {
      ...process.env,
      MOLE_FIXTURE_TOKEN: token,
      MOLE_FIXTURE_MARKER: marker,
    };
    await new Promise((resolve, reject) => {
      const child = spawn(
        path.join(
          process.env.SystemRoot,
          "System32/WindowsPowerShell/v1.0/powershell.exe",
        ),
        [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          path.join(__dirname, "fixtures/register-application.ps1"),
        ],
        {
          shell: false,
          windowsHide: true,
          env,
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      let stderr = "";
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });
      child.once("error", reject);
      child.once("close", (code) =>
        code === 0 ? resolve() : reject(new Error(stderr)),
      );
      child.stdin.end(JSON.stringify({ token, executable }));
    });
    const runPowerShell = createPowerShellRunner({
      scriptsDirectory: path.resolve(__dirname, "../windows"),
      spawnProcess: (file, args, options) =>
        spawn(file, args, { ...options, env }),
    });
    const service = createApplicationsService({ runPowerShell });
    const plan = await service.preview();
    const item = plan.items.find(
      (candidate) => candidate.name === `Mole Integration Fixture ${token}`,
    );
    assert.ok(item, "the unique fixture registration was discovered");
    assert.equal(item.enabled, true, item.reason);
    const result = await service.execute(plan.id, [item.id]);
    assert.equal(result.results[0].status, "success", JSON.stringify(result));
    assert.equal(await fs.readFile(marker, "utf8"), "fixture uninstalled");
    const refreshed = await service.preview();
    assert.equal(
      refreshed.items.some((candidate) => candidate.name === item.name),
      false,
    );
  },
);

test(
  "Windows hosted CI executes DNS cache maintenance without changing persistent settings",
  { skip: !nativeCI, timeout: 90000 },
  async () => {
    const { createOptimizeService } = require("../electron/optimize.cjs");
    const runPowerShell = createPowerShellRunner({
      scriptsDirectory: path.resolve(__dirname, "../windows"),
    });
    const service = createOptimizeService({ runPowerShell });
    const plan = await service.preview();
    const item = plan.items.find((candidate) => candidate.id === "dns-cache");
    assert.equal(item?.enabled, true, JSON.stringify(plan));
    const result = await service.execute(plan.id, [item.id]);
    assert.equal(result.results[0].status, "completed", JSON.stringify(result));
  },
);
