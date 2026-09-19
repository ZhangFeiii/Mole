const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const os = require("node:os");
const { spawn } = require("node:child_process");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const {
  APPLICATIONS_SCRIPT,
  createApplicationsService,
} = require("../electron/applications.cjs");
const { createPowerShellRunner } = require("../electron/powershell.cjs");

const nativeCI =
  process.platform === "win32" && process.env.GITHUB_ACTIONS === "true";
const execFileAsync = promisify(execFile);

async function runWindowsFixture(action, token, executablePath) {
  const systemRoot = process.env.SystemRoot || "C:\\Windows";
  const executable = path.join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const scriptPath = path.join(__dirname, "fixtures/applications-fixture.ps1");
  return new Promise((resolve, reject) => {
    const child = spawn(
      executable,
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        scriptPath,
      ],
      {
        shell: false,
        windowsHide: true,
        env: { ...process.env, GITHUB_ACTIONS: "true" },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const stdout = [];
    const stderr = [];
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Windows fixture timed out"));
    }, 30000);
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      const text = Buffer.concat(stdout)
        .toString("utf8")
        .replace(/^\uFEFF/, "")
        .trim();
      if (code !== 0) {
        reject(
          new Error(
            Buffer.concat(stderr).toString("utf8") || `fixture exited ${code}`,
          ),
        );
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch (error) {
        reject(new Error(`fixture response invalid: ${error.message}`));
      }
    });
    child.stdin.end(
      JSON.stringify({ action, token, executable: executablePath }),
    );
  });
}

function makeQueryPayload() {
  return {
    ok: true,
    action: "query",
    items: [
      {
        id: "safe-app",
        kind: "win32",
        name: "A Safe App",
        description: "fixture",
        publisher: "Fixture Publisher",
        version: "1.2.3",
        scope: "user",
        enabled: true,
        identity: {
          registryPath: "HKCU:\\Software\\Fixture\\Safe",
          registryView: "Registry64",
          scope: "user",
          displayName: "A Safe App",
          publisher: "Fixture Publisher",
          version: "1.2.3",
          uninstallHash: "safe-hash",
          productCode: "",
          installLocation: "",
          systemComponent: "",
          noRemove: "",
          releaseType: "",
          parentKeyName: "",
          uninstallExecutableHash: "sha256-fixture",
          uninstallExecutableLength: "123",
          uninstallExecutableLastWriteUtc: "2026-09-19T00:00:00.0000000Z",
          msiProductCode: "",
        },
        // The renderer must never be able to replace this with its own command.
        uninstall: {
          executable: "C:\\Program Files\\Fixture\\uninstall.exe",
          arguments: "/quiet",
        },
      },
      {
        id: "protected-edge",
        kind: "win32",
        name: "Microsoft Edge",
        publisher: "Microsoft Corporation",
        version: "1.0",
        enabled: true,
        identity: {
          registryPath: "HKLM:\\Software\\Fixture\\Edge",
          registryView: "Registry64",
          displayName: "Microsoft Edge",
          publisher: "Microsoft Corporation",
          version: "1.0",
          uninstallHash: "edge-hash",
        },
        uninstall: {
          executable: "C:\\Windows\\System32\\msiexec.exe",
          arguments: "/x {00000000-0000-0000-0000-000000000000}",
        },
      },
      {
        id: "script-app",
        kind: "win32",
        name: "Script Installer",
        publisher: "Fixture Publisher",
        version: "1.0",
        enabled: true,
        identity: {
          registryPath: "HKCU:\\Software\\Fixture\\Script",
          registryView: "Registry64",
          displayName: "Script Installer",
          publisher: "Fixture Publisher",
          version: "1.0",
          uninstallHash: "script-hash",
          uninstallExecutableHash: "script-executable-hash",
        },
        uninstall: {
          executable: "C:\\Windows\\System32\\powershell.exe",
          arguments: "-NoProfile -Command Remove-Item C:\\important",
        },
      },
      {
        id: "safe-appx",
        kind: "appx",
        name: "A Store App",
        publisher: "Fixture Publisher",
        version: "2.0.0.0",
        enabled: true,
        identity: {
          packageFullName: "Fixture.StoreApp_2.0.0.0_neutral__fixture",
          name: "Fixture.StoreApp",
          publisher: "Fixture Publisher",
          version: "2.0.0.0",
          packageFamilyName: "Fixture.StoreApp_fixture",
          isFramework: false,
          isResourcePackage: false,
        },
      },
    ],
    warnings: [],
  };
}

test("preview creates a server-side expiring plan and protects unsafe items", async () => {
  const calls = [];
  const service = createApplicationsService({
    platform: "win32",
    runPowerShell: async (scriptName, request, options) => {
      calls.push({ scriptName, request, options });
      assert.equal(request.action, "query");
      return makeQueryPayload();
    },
  });

  const plan = await service.preview();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].scriptName, APPLICATIONS_SCRIPT);
  assert.equal(typeof plan.id, "string");
  assert.equal(plan.expiresAt > plan.createdAt, true);
  assert.equal(plan.items.find((item) => item.id === "safe-app").enabled, true);
  assert.equal(
    plan.items.find((item) => item.id === "protected-edge").enabled,
    false,
  );
  assert.match(
    plan.items.find((item) => item.id === "protected-edge").reason,
    /受保护/,
  );
  assert.equal(
    plan.items.find((item) => item.id === "script-app").enabled,
    false,
  );
  assert.match(
    plan.items.find((item) => item.id === "script-app").reason,
    /脚本|shell/,
  );
  assert.equal(
    plan.items.find((item) => item.id === "safe-appx").enabled,
    true,
  );
  // Uninstaller details stay in the service plan and are not exposed to UI.
  assert.equal("uninstall" in plan.items[0], false);
});

test("execute only sends enabled plan identities and reports native results", async () => {
  const calls = [];
  const service = createApplicationsService({
    platform: "win32",
    runPowerShell: async (scriptName, request) => {
      calls.push({ scriptName, request });
      if (request.action === "query") return makeQueryPayload();
      assert.equal(request.action, "execute");
      assert.equal(request.items.length, 1);
      assert.equal("uninstall" in request.items[0], false);
      assert.equal("executable" in request.items[0], false);
      const itemId = request.items[0].id;
      if (itemId === "safe-app") {
        assert.equal(
          request.items[0].identity.registryPath,
          "HKCU:\\Software\\Fixture\\Safe",
        );
        assert.equal(
          request.items[0].identity.uninstallExecutableHash,
          "sha256-fixture",
        );
      }
      assert.ok(["safe-app", "safe-appx"].includes(itemId));
      return {
        ok: true,
        action: "execute",
        results: [
          {
            id: itemId,
            name: itemId === "safe-app" ? "A Safe App" : "A Store App",
            status: itemId === "safe-app" ? "success" : "reboot-required",
            message: itemId === "safe-app" ? "done" : "restart",
            ...(itemId === "safe-app" ? { exitCode: 0 } : { exitCode: 3010 }),
          },
        ],
        warnings: [],
      };
    },
  });

  const plan = await service.preview();
  const result = await service.execute(plan.id, [
    "not-in-plan",
    "safe-app",
    "protected-edge",
    "script-app",
    "safe-appx",
  ]);
  assert.deepEqual(
    result.results.map((item) => [item.id, item.status]),
    [
      ["not-in-plan", "rejected"],
      ["safe-app", "success"],
      ["protected-edge", "blocked"],
      ["script-app", "blocked"],
      ["safe-appx", "reboot-required"],
    ],
  );
  assert.equal(result.results.at(-1).rebootRequired, true);
  assert.equal(
    calls.filter((call) => call.request.action === "execute").length,
    2,
  );
});

test("an unknown uninstall stops the native queue and marks later entries skipped", async () => {
  const calls = [];
  const service = createApplicationsService({
    platform: "win32",
    runPowerShell: async (_scriptName, request) => {
      calls.push(request);
      if (request.action === "query") return makeQueryPayload();
      return {
        ok: true,
        action: "execute",
        // Native PowerShell stops after the first unknown item.
        results: [
          {
            id: "safe-app",
            status: "unknown",
            message: "官方程序退出但登记仍存在",
          },
        ],
        warnings: ["已停止剩余项目"],
      };
    },
  });
  const plan = await service.preview();
  const result = await service.execute(plan.id, ["safe-app", "safe-appx"]);
  assert.deepEqual(
    result.results.map((item) => [item.id, item.status]),
    [
      ["safe-app", "unknown"],
      ["safe-appx", "skipped"],
    ],
  );
  assert.match(result.results[1].message, /未知/);
  assert.equal(
    calls.filter((request) => request.action === "execute").length,
    1,
  );
  await assert.rejects(service.execute(plan.id, ["safe-app"]), /过期|不存在/);
});

test("cancellation keeps the current vendor process and skips the remaining queue with progress", async () => {
  const calls = [];
  const progress = [];
  const controller = new AbortController();
  const service = createApplicationsService({
    platform: "win32",
    runPowerShell: async (_scriptName, request) => {
      if (request.action === "query") return makeQueryPayload();
      calls.push(request.items.map((item) => item.id));
      assert.equal(request.items.length, 1);
      // Cancellation arrives after the first official uninstaller has
      // started.  The service must await and report that result, not kill it.
      controller.abort();
      const id = request.items[0].id;
      return {
        ok: true,
        action: "execute",
        results: [
          {
            id,
            status: "success",
            message: "official uninstaller exited",
          },
        ],
        warnings: [],
      };
    },
  });
  const plan = await service.preview();
  const result = await service.execute(plan.id, ["safe-app", "safe-appx"], {
    signal: controller.signal,
    onProgress: (event) => progress.push(event),
  });
  assert.deepEqual(calls, [["safe-app"]]);
  assert.deepEqual(
    result.results.map((item) => [item.id, item.status]),
    [
      ["safe-app", "success"],
      ["safe-appx", "skipped"],
    ],
  );
  assert.match(result.results[1].message, /取消/);
  assert.deepEqual(progress, [
    { completed: 0, total: 2, currentName: "A Safe App" },
    { completed: 1, total: 2, currentName: "A Safe App" },
    { completed: 1, total: 2, currentName: "A Store App" },
    { completed: 2, total: 2, currentName: "A Store App" },
  ]);
});

test("a successful transport with incomplete item results remains outcome-unknown", async () => {
  const service = createApplicationsService({
    platform: "win32",
    runPowerShell: async (_scriptName, request) =>
      request.action === "query"
        ? makeQueryPayload()
        : { ok: true, action: "execute", results: [] },
  });
  const plan = await service.preview();
  const result = await service.execute(plan.id, ["safe-app"]);
  assert.equal(result.results[0].status, "unknown");
});

test("running software and non-removable/runtime Appx entries are disabled with metadata", async () => {
  const service = createApplicationsService({
    platform: "win32",
    runPowerShell: async () => ({
      ok: true,
      action: "query",
      items: [
        {
          id: "running-editor",
          kind: "win32",
          name: "Contoso Editor",
          enabled: true,
          running: true,
          knownProcessNames: ["ContosoEditor"],
          identity: {
            registryPath: "HKCU:\\Software\\Fixture\\Editor",
            registryView: "Registry64",
          },
          uninstall: {
            executable: "C:\\Temp\\Contoso\\uninstall.exe",
            arguments: "",
          },
        },
        {
          id: "runtime-appx",
          kind: "appx",
          name: "Contoso Runtime",
          enabled: true,
          identity: {
            packageFullName: "Contoso.Runtime_1.0.0.0_neutral__fixture",
            name: "Contoso.Runtime",
            publisher: "Contoso",
            version: "1.0.0.0",
            nonRemovable: true,
            isFramework: false,
            isResourcePackage: false,
          },
        },
      ],
      warnings: [],
    }),
  });
  const plan = await service.preview();
  const running = plan.items.find((item) => item.id === "running-editor");
  const runtime = plan.items.find((item) => item.id === "runtime-appx");
  assert.equal(running.enabled, false);
  assert.equal(running.running, true);
  assert.deepEqual(running.knownProcessNames, ["ContosoEditor"]);
  assert.match(running.reason, /运行/);
  assert.equal(runtime.enabled, false);
  assert.match(runtime.reason, /受保护/);
});

test("expired plans are rejected without invoking PowerShell", async () => {
  let now = 1000;
  let executeCalls = 0;
  const service = createApplicationsService({
    platform: "win32",
    now: () => now,
    planTtlMs: 2000,
    runPowerShell: async (_scriptName, request) => {
      if (request.action === "execute") executeCalls += 1;
      return makeQueryPayload();
    },
  });
  const plan = await service.preview();
  now = plan.expiresAt + 1;
  await assert.rejects(service.execute(plan.id, ["safe-app"]), /过期|不存在/);
  assert.equal(executeCalls, 0);
});

test("outcome-unknown runner failures are surfaced without replay", async () => {
  const service = createApplicationsService({
    platform: "win32",
    runPowerShell: async (_scriptName, request) => {
      if (request.action === "query") return makeQueryPayload();
      const error = new Error("uninstaller timed out");
      error.code = "OUTCOME_UNKNOWN";
      throw error;
    },
  });
  const plan = await service.preview();
  const result = await service.execute(plan.id, ["safe-app"]);
  assert.equal(result.results[0].status, "unknown");
  await assert.rejects(service.execute(plan.id, ["safe-app"]), /过期|不存在/);
});

test("malformed execution output is also outcome-unknown", async () => {
  const service = createApplicationsService({
    platform: "win32",
    runPowerShell: async (_scriptName, request) =>
      request.action === "query" ? makeQueryPayload() : "{truncated",
  });
  const plan = await service.preview();
  const result = await service.execute(plan.id, ["safe-app"]);
  assert.equal(result.results[0].status, "unknown");
});

test("selection IDs are strict and duplicate-safe", async () => {
  const service = createApplicationsService({
    platform: "win32",
    runPowerShell: async (_scriptName, request) =>
      request.action === "query"
        ? makeQueryPayload()
        : { ok: true, action: "execute", results: [] },
  });
  const plan = await service.preview();
  await assert.rejects(
    service.execute(plan.id, ["safe-app", "safe-app"]),
    /重复/,
  );
  // A rejected selection does not get silently coerced into an ID.
  await assert.rejects(service.execute(plan.id, [null]), /无效/);
});

test("non-Windows preview is read-only and execute fails closed", async () => {
  let called = false;
  const service = createApplicationsService({
    platform: "darwin",
    runPowerShell: async () => {
      called = true;
      throw new Error("must not run");
    },
  });
  const plan = await service.preview();
  assert.equal(plan.items.length, 0);
  assert.equal(called, false);
  await assert.rejects(service.execute(plan.id, []), /不支持|Windows/);
});

test("PowerShell file is a Windows-only read/query/execute boundary", () => {
  const scriptPath = path.join(__dirname, "../windows/applications.ps1");
  const source = fs.readFileSync(scriptPath, "utf8");
  assert.match(source, /#Requires -Version 5\.1/);
  assert.match(source, /"query"/);
  assert.match(source, /"execute"/);
  assert.match(source, /Get-AppxPackage/);
  assert.match(source, /Remove-AppxPackage/);
  assert.match(source, /Registry64/);
  assert.match(source, /Registry32/);
  assert.match(source, /Start-Process/);
  assert.match(source, /NonRemovable/);
  assert.match(source, /uninstallExecutableHash/);
  assert.match(source, /Get-Process/);
  assert.match(source, /ProductCode/);
  assert.match(source, /Get-TrustedPathBoundary/);
  assert.match(source, /DriveType/);
  assert.match(source, /break/);
  assert.match(source, /Status\s*,?\s*"unknown"|"unknown"/);
  assert.doesNotMatch(source, /Invoke-Expression/);
  assert.doesNotMatch(source, /shell\s*=\s*\$true/i);
});

test(
  "Windows PowerShell parser accepts applications.ps1 without executing it",
  {
    skip:
      process.platform !== "win32" || process.env.MOLE_NATIVE_WINDOWS !== "1",
  },
  async () => {
    const { spawn } = require("node:child_process");
    const scriptPath = path.join(__dirname, "../windows/applications.ps1");
    const quotedPath = scriptPath.replace(/'/g, "''");
    const command = [
      "$tokens=$null",
      "$errors=$null",
      `[System.Management.Automation.Language.Parser]::ParseFile('${quotedPath}',[ref]$tokens,[ref]$errors)|Out-Null`,
      "if($errors.Count -gt 0){$errors|ForEach-Object{$_.Message}|Write-Error;exit 1}",
      "exit 0",
    ].join(";");
    const child = spawn(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command],
      { windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"] },
    );
    const stderr = [];
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    const code = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        child.kill();
        reject(new Error("PowerShell parser timed out"));
      }, 30000);
      child.once("error", reject);
      child.once("close", (exitCode) => {
        clearTimeout(timeout);
        resolve(exitCode);
      });
    });
    assert.equal(code, 0, Buffer.concat(stderr).toString("utf8"));
  },
);

test(
  "Windows trusted path checks every ancestor before accessing an untrusted child",
  {
    skip:
      process.platform !== "win32" || process.env.MOLE_NATIVE_WINDOWS !== "1",
  },
  async () => {
    const systemRoot = process.env.SystemRoot || "C:\\Windows";
    const executable = path.join(
      systemRoot,
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );
    const fixturePath = path.join(
      __dirname,
      "fixtures/applications-path-fixture.ps1",
    );
    const sourcePath = path.join(__dirname, "../windows/applications.ps1");
    const child = spawn(
      executable,
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        fixturePath,
        "-SourcePath",
        sourcePath,
      ],
      { windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"] },
    );
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    const code = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        child.kill();
        reject(new Error("Windows trusted path fixture timed out"));
      }, 30000);
      child.once("error", reject);
      child.once("close", (exitCode) => {
        clearTimeout(timeout);
        resolve(exitCode);
      });
    });
    assert.equal(code, 0, Buffer.concat(stderr).toString("utf8"));
    const lines = Buffer.concat(stdout).toString("utf8").trim().split(/\r?\n/);
    assert.deepEqual(JSON.parse(lines[0]), { ok: true });
  },
);

test(
  "Windows fixture rejects mismatched or extra-target MSI commands without uninstalling",
  { skip: !nativeCI, timeout: 120000 },
  async () => {
    const runPowerShell = createPowerShellRunner({
      scriptsDirectory: path.resolve(__dirname, "../windows"),
    });
    const service = createApplicationsService({ runPowerShell });
    for (const [action, namePart] of [
      ["register-msi-mismatch", "MSI Mismatch"],
      ["register-msi-extra", "MSI Extra Args"],
    ]) {
      const token = crypto.randomUUID();
      try {
        assert.deepEqual(await runWindowsFixture(action, token), { ok: true });
        const plan = await service.preview();
        const item = plan.items.find((candidate) =>
          candidate.name.includes(`${namePart} ${token}`),
        );
        assert.ok(item, `fixture ${action} was discovered`);
        assert.equal(item.enabled, false, item.reason);
        assert.match(item.reason, /MSI|ProductCode|参数|GUID/);
      } finally {
        await runWindowsFixture("remove", token);
      }
    }
  },
);

test(
  "Windows fixture rejects an executable replaced after preview",
  { skip: !nativeCI, timeout: 180000 },
  async () => {
    const directory = await fsp.realpath(
      await fsp.mkdtemp(path.join(os.tmpdir(), "mole-review-exe-")),
    );
    const executable = path.join(directory, "MoleReviewFixture.exe");
    const token = crypto.randomUUID();
    try {
      await execFileAsync(
        "go",
        ["build", "-o", executable, "./desktop/tests/fixtures/uninstaller"],
        { cwd: path.resolve(__dirname, "../..") },
      );
      assert.deepEqual(
        await runWindowsFixture("register-exe", token, executable),
        { ok: true },
      );
      const runPowerShell = createPowerShellRunner({
        scriptsDirectory: path.resolve(__dirname, "../windows"),
      });
      const service = createApplicationsService({ runPowerShell });
      const plan = await service.preview();
      const item = plan.items.find((candidate) =>
        candidate.name.includes(`Mole Review Executable Fixture ${token}`),
      );
      assert.ok(item, "executable fixture was discovered");
      assert.equal(item.enabled, true, item.reason);

      // Replace the file while leaving the registry command unchanged.  The
      // second query must detect the SHA-256 identity change before launch.
      await fsp.writeFile(executable, Buffer.from("replacement fixture"));
      const result = await service.execute(plan.id, [item.id]);
      assert.equal(
        result.results[0].status,
        "identity-changed",
        JSON.stringify(result),
      );
    } finally {
      await runWindowsFixture("remove", token).catch(() => {});
      await fsp.rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  "Windows native query smoke test is opt-in and never executes an uninstall",
  {
    skip:
      process.platform !== "win32" || process.env.MOLE_NATIVE_WINDOWS !== "1",
  },
  async () => {
    const { spawn } = require("node:child_process");
    const scriptPath = path.join(__dirname, "../windows/applications.ps1");
    const child = spawn(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        scriptPath,
      ],
      { windowsHide: true, shell: false, stdio: ["pipe", "pipe", "pipe"] },
    );
    const chunks = [];
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    const stderr = [];
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.stdin.end(JSON.stringify({ action: "query" }));
    const code = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        child.kill();
        reject(new Error("PowerShell query timed out"));
      }, 30000);
      child.once("error", reject);
      child.once("close", (exitCode) => {
        clearTimeout(timeout);
        resolve(exitCode);
      });
    });
    assert.equal(code, 0, Buffer.concat(stderr).toString("utf8"));
    const lines = Buffer.concat(chunks).toString("utf8").trim().split(/\r?\n/);
    assert.equal(lines.length, 1);
    const response = JSON.parse(lines[0]);
    assert.equal(response.ok, true);
    assert.equal(response.action, "query");
    assert.ok(Array.isArray(response.items));
  },
);
