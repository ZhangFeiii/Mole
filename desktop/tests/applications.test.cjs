const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  APPLICATIONS_SCRIPT,
  createApplicationsService,
} = require("../electron/applications.cjs");

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
      assert.deepEqual(
        request.items.map((item) => item.id),
        ["safe-app", "safe-appx"],
      );
      assert.equal("uninstall" in request.items[0], false);
      assert.equal("executable" in request.items[0], false);
      assert.equal(
        request.items[0].identity.registryPath,
        "HKCU:\\Software\\Fixture\\Safe",
      );
      return {
        ok: true,
        action: "execute",
        results: [
          {
            id: "safe-app",
            name: "A Safe App",
            status: "success",
            message: "done",
            exitCode: 0,
          },
          {
            id: "safe-appx",
            name: "A Store App",
            status: "reboot-required",
            message: "restart",
            exitCode: 3010,
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
    1,
  );
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
