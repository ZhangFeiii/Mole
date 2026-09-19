const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFile } = require("node:fs/promises");
const { spawn } = require("node:child_process");
const path = require("node:path");
const {
  createOptimizeService,
  OPERATIONS,
  NATIVE_OPERATIONS,
} = require("../electron/optimize.cjs");

const scriptPath = path.resolve(__dirname, "../windows/optimize.ps1");

function makeDrive(driveLetter) {
  return {
    driveLetter,
    identity: `volume:fixture-${driveLetter[0].toUpperCase()}`,
  };
}

function makeProbe(overrides = {}) {
  return {
    ok: true,
    operation: NATIVE_OPERATIONS.PROBE,
    isAdmin: true,
    dnsAvailable: true,
    optimizeAvailable: true,
    drives: [makeDrive("D:"), makeDrive("C:")],
    ...overrides,
  };
}

function makeMockRunner({ probe = makeProbe(), onCall } = {}) {
  const calls = [];
  const runPowerShell = async (scriptName, request, options) => {
    calls.push({ scriptName, request, options });
    if (onCall) return onCall({ scriptName, request, options, calls });
    if (request.operation === NATIVE_OPERATIONS.PROBE) return probe;
    if (request.operation === NATIVE_OPERATIONS.DNS)
      return { ok: true, operation: request.operation, message: "DNS 已刷新" };
    if (request.operation === NATIVE_OPERATIONS.DISKS)
      return {
        ok: true,
        operation: request.operation,
        message: "磁盘优化完成",
        drives: request.driveLetters.map((drive) => ({
          driveLetter: drive.driveLetter,
          identity: drive.identity,
          status: "completed",
        })),
      };
    throw new Error(`unexpected native operation: ${request.operation}`);
  };
  return { calls, runPowerShell };
}

test("non-Windows preview is explicit and never invokes PowerShell", async () => {
  let called = false;
  const service = createOptimizeService({
    platform: "darwin",
    runPowerShell: async () => {
      called = true;
      throw new Error("must not run native maintenance on macOS");
    },
  });

  const plan = await service.preview();
  assert.match(plan.id, /^[0-9a-f-]{36}$/);
  assert.ok(Number.isFinite(Date.parse(plan.createdAt)));
  assert.ok(Number.isFinite(Date.parse(plan.expiresAt)));
  assert.equal(plan.items.length, 2);
  assert.deepEqual(
    plan.items.map(({ id, enabled }) => ({ id, enabled })),
    [
      { id: OPERATIONS.DNS, enabled: false },
      { id: OPERATIONS.DISKS, enabled: false },
    ],
  );
  assert.ok(plan.items.every((item) => item.reason));
  assert.deepEqual(plan.warnings, []);

  const result = await service.execute(plan.id, [OPERATIONS.DNS]);
  assert.equal(result.results[0].status, "unsupported");
  assert.equal(called, false);
});

test("Windows preview exposes real capabilities and execute only runs selected IDs", async () => {
  const mock = makeMockRunner();
  const service = createOptimizeService({
    platform: "win32",
    runPowerShell: mock.runPowerShell,
  });

  const plan = await service.preview();
  assert.deepEqual(
    plan.items.map(({ id, enabled, requiresAdmin, targets }) => ({
      id,
      enabled,
      requiresAdmin,
      targets,
    })),
    [
      {
        id: OPERATIONS.DNS,
        enabled: true,
        requiresAdmin: undefined,
        targets: undefined,
      },
      {
        id: OPERATIONS.DISKS,
        enabled: true,
        requiresAdmin: true,
        targets: ["C:", "D:"],
      },
    ],
  );
  assert.match(
    plan.items.find((item) => item.id === OPERATIONS.DISKS).description,
    /C:, D:/,
  );
  assert.equal(mock.calls.length, 1);
  assert.equal(mock.calls[0].scriptName, "optimize");
  assert.equal(mock.calls[0].request.operation, NATIVE_OPERATIONS.PROBE);
  assert.equal(mock.calls[0].options.timeoutMs, 15_000);

  await assert.rejects(
    service.execute(plan.id, [OPERATIONS.DNS, OPERATIONS.DNS]),
    /不得重复/,
  );
  const result = await service.execute(plan.id, [OPERATIONS.DNS]);
  assert.deepEqual(
    result.results.map(({ id, status }) => ({ id, status })),
    [{ id: OPERATIONS.DNS, status: "completed" }],
  );
  assert.deepEqual(
    mock.calls.map(({ request }) => request.operation),
    [NATIVE_OPERATIONS.PROBE, NATIVE_OPERATIONS.PROBE, NATIVE_OPERATIONS.DNS],
  );
  assert.equal(mock.calls[2].options.timeoutMs, 30_000);
});

test("disk execution rechecks administrator state and does not invoke Optimize-Volume when permission is lost", async () => {
  let probeCount = 0;
  const mock = makeMockRunner({
    onCall: ({ request, calls }) => {
      if (request.operation === NATIVE_OPERATIONS.PROBE) {
        probeCount += 1;
        return makeProbe({ isAdmin: probeCount === 1 });
      }
      throw new Error(
        `unexpected mutating call: ${calls.at(-1).request.operation}`,
      );
    },
  });
  const service = createOptimizeService({
    platform: "win32",
    runPowerShell: mock.runPowerShell,
  });

  const plan = await service.preview();
  const result = await service.execute(plan.id, [OPERATIONS.DISKS]);
  assert.deepEqual(result.results, [
    {
      id: OPERATIONS.DISKS,
      name: "优化本地磁盘",
      status: "permission-denied",
      message: "需要以管理员权限运行应用；不会自动提权",
    },
  ]);
  assert.deepEqual(
    mock.calls.map(({ request }) => request.operation),
    [NATIVE_OPERATIONS.PROBE, NATIVE_OPERATIONS.PROBE],
  );
});

test("disabled preview items stay disabled even if the environment later becomes capable", async () => {
  const mock = makeMockRunner({ probe: makeProbe({ isAdmin: false }) });
  const service = createOptimizeService({
    platform: "win32",
    runPowerShell: mock.runPowerShell,
  });
  const plan = await service.preview();
  const result = await service.execute(plan.id, [OPERATIONS.DISKS]);
  assert.equal(result.results[0].status, "permission-denied");
  assert.match(result.results[0].message, /管理员权限/);
  assert.equal(
    mock.calls.length,
    1,
    "disabled selection must not trigger a second probe",
  );
});

test("disk optimization is disabled when the native probe lacks a volume identity", async () => {
  const mock = makeMockRunner({
    probe: makeProbe({ drives: [{ driveLetter: "C:" }] }),
  });
  const service = createOptimizeService({
    platform: "win32",
    runPowerShell: mock.runPowerShell,
  });
  const plan = await service.preview();
  const diskItem = plan.items.find((item) => item.id === OPERATIONS.DISKS);
  assert.equal(diskItem.enabled, false);
  assert.match(diskItem.reason, /磁盘|卷|标识|本地/);
  const result = await service.execute(plan.id, [OPERATIONS.DISKS]);
  assert.equal(result.results[0].status, "unsupported");
  assert.equal(mock.calls.length, 1);
});

test("a failed preview probe is fail-closed and cannot be revived by later readings", async () => {
  let probes = 0;
  const mock = makeMockRunner({
    onCall: ({ request }) => {
      if (request.operation === NATIVE_OPERATIONS.PROBE) {
        probes += 1;
        return probes === 1
          ? { ok: false, errorCode: "failed", message: "probe failed" }
          : makeProbe();
      }
      throw new Error("no maintenance call is allowed");
    },
  });
  const service = createOptimizeService({
    platform: "win32",
    runPowerShell: mock.runPowerShell,
  });
  const plan = await service.preview();
  const result = await service.execute(plan.id, [OPERATIONS.DNS]);
  assert.equal(result.results[0].status, "failed");
  assert.match(result.results[0].message, /probe failed/);
  assert.equal(mock.calls.length, 1);
});

test("a malformed preview probe is fail-closed", async () => {
  const mock = makeMockRunner({
    onCall: ({ request }) => {
      if (request.operation === NATIVE_OPERATIONS.PROBE)
        return { drives: [makeDrive("C:")], isAdmin: true };
      throw new Error("malformed probe must not reach maintenance");
    },
  });
  const service = createOptimizeService({
    platform: "win32",
    runPowerShell: mock.runPowerShell,
  });
  const plan = await service.preview();
  const result = await service.execute(plan.id, [OPERATIONS.DNS]);
  assert.equal(result.results[0].status, "failed");
  assert.match(result.results[0].message, /安全检查失败/);
  assert.equal(mock.calls.length, 1);
});

test("disk execution intersects with the frozen preview targets and reports changes", async () => {
  let probes = 0;
  const mock = makeMockRunner({
    onCall: ({ request }) => {
      if (request.operation === NATIVE_OPERATIONS.PROBE) {
        probes += 1;
        return makeProbe({
          drives:
            probes === 1
              ? [makeDrive("C:"), makeDrive("D:")]
              : [makeDrive("C:"), makeDrive("E:")],
        });
      }
      if (request.operation === NATIVE_OPERATIONS.DISKS)
        return {
          ok: true,
          operation: request.operation,
          message: "磁盘优化完成",
        };
      throw new Error(`unexpected native operation: ${request.operation}`);
    },
  });
  const service = createOptimizeService({
    platform: "win32",
    runPowerShell: mock.runPowerShell,
  });
  const plan = await service.preview();
  const result = await service.execute(plan.id, [OPERATIONS.DISKS]);
  const diskResult = result.results[0];
  assert.equal(diskResult.status, "completed");
  assert.deepEqual(diskResult.targets, ["C:"]);
  assert.deepEqual(diskResult.skippedTargets, ["D:"]);
  assert.deepEqual(diskResult.unlistedCurrentTargets, ["E:"]);
  assert.match(diskResult.message, /交集/);
  const diskCall = mock.calls.find(
    ({ request }) => request.operation === NATIVE_OPERATIONS.DISKS,
  );
  assert.deepEqual(
    diskCall.request.driveLetters.map((drive) => drive.driveLetter),
    ["C:"],
  );
});

test("a same-letter volume replacement is rejected by identity", async () => {
  let probes = 0;
  const mock = makeMockRunner({
    onCall: ({ request }) => {
      if (request.operation === NATIVE_OPERATIONS.PROBE) {
        probes += 1;
        return makeProbe({
          drives: [
            {
              driveLetter: "C:",
              identity: probes === 1 ? "volume:original" : "volume:replacement",
            },
          ],
        });
      }
      throw new Error("volume replacement must not reach native optimization");
    },
  });
  const service = createOptimizeService({
    platform: "win32",
    runPowerShell: mock.runPowerShell,
  });
  const plan = await service.preview();
  const result = await service.execute(plan.id, [OPERATIONS.DISKS]);
  assert.equal(result.results[0].status, "unsupported");
  assert.match(result.results[0].message, /已变化|重新预览/);
  assert.deepEqual(
    mock.calls.map(({ request }) => request.operation),
    [NATIVE_OPERATIONS.PROBE, NATIVE_OPERATIONS.PROBE],
  );
});

test("unsupported capabilities and native failures are reported distinctly", async () => {
  const unsupportedMock = makeMockRunner({
    onCall: ({ request }) => {
      if (request.operation === NATIVE_OPERATIONS.PROBE) {
        return makeProbe({
          dnsAvailable: true,
          optimizeAvailable: false,
        });
      }
      throw new Error("unexpected native operation");
    },
  });
  const unsupportedService = createOptimizeService({
    platform: "win32",
    runPowerShell: unsupportedMock.runPowerShell,
  });
  const unsupportedPlan = await unsupportedService.preview();
  const unsupportedResult = await unsupportedService.execute(
    unsupportedPlan.id,
    [OPERATIONS.DISKS],
  );
  assert.equal(unsupportedResult.results[0].status, "unsupported");
  assert.equal(unsupportedMock.calls.length, 1);

  const failedMock = makeMockRunner({
    onCall: ({ request }) => {
      if (request.operation === NATIVE_OPERATIONS.PROBE)
        return makeProbe({ optimizeAvailable: true });
      if (request.operation === NATIVE_OPERATIONS.DNS)
        return { ok: false, errorCode: "failed", message: "DNS 服务暂时失败" };
      throw new Error("unexpected native operation");
    },
  });
  const failedService = createOptimizeService({
    platform: "win32",
    runPowerShell: failedMock.runPowerShell,
  });
  const failedPlan = await failedService.preview();
  const failedResult = await failedService.execute(failedPlan.id, [
    OPERATIONS.DNS,
  ]);
  assert.equal(failedResult.results[0].status, "failed");
  assert.equal(
    failedMock.calls.filter(
      ({ request }) => request.operation === NATIVE_OPERATIONS.DNS,
    ).length,
    1,
  );
});

test("unknown native outcomes are surfaced without suggesting an immediate retry", async () => {
  const mock = makeMockRunner({
    onCall: ({ request }) => {
      if (request.operation === NATIVE_OPERATIONS.PROBE)
        return makeProbe({ optimizeAvailable: true });
      const error = new Error("PowerShell timed out");
      error.code = "OUTCOME_UNKNOWN";
      throw error;
    },
  });
  const service = createOptimizeService({
    platform: "win32",
    runPowerShell: mock.runPowerShell,
  });
  const plan = await service.preview();
  const result = await service.execute(plan.id, [OPERATIONS.DNS]);
  assert.equal(result.results[0].status, "unknown");
  assert.match(result.results[0].message, /检查系统状态/);
});

test("expired and unknown plans cannot be executed", async () => {
  const mock = makeMockRunner();
  const service = createOptimizeService({
    platform: "win32",
    runPowerShell: mock.runPowerShell,
  });
  await assert.rejects(service.execute("not-a-plan", []), /不存在或已过期/);

  const originalNow = Date.now;
  try {
    let now = 1_700_000_000_000;
    Date.now = () => now;
    const plan = await service.preview();
    now += 5 * 60 * 1000 + 1;
    await assert.rejects(service.execute(plan.id, []), /不存在或已过期/);
  } finally {
    Date.now = originalNow;
  }
});

test("PowerShell maintenance script has a fixed operation surface", async () => {
  const source = await readFile(scriptPath, "utf8");
  assert.match(source, /\"probe\"/);
  assert.match(source, /\"flush-dns\"/);
  assert.match(source, /\"optimize-disks\"/);
  assert.match(source, /Clear-DnsClientCache/);
  assert.match(source, /Optimize-Volume/);
  assert.match(source, /Get-CimInstance/);
  assert.match(source, /VolumeSerialNumber/);
  assert.match(source, /identity/);
  assert.doesNotMatch(source, /Invoke-Expression/i);
  assert.doesNotMatch(source, /Start-Process/i);
  assert.doesNotMatch(source, /Remove-Item/i);
  assert.doesNotMatch(source, /Set-ItemProperty/i);
  assert.doesNotMatch(source, /Set-Service/i);
  assert.doesNotMatch(source, /powercfg/i);
});

function runProcess(command, args, input, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      shell: false,
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code, signal) =>
      resolve({ code, signal, stdout, stderr }),
    );
    child.stdin.end(input);
  });
}

test("an unknown first operation stops the remaining selected maintenance", async () => {
  const operations = [];
  const service = createOptimizeService({
    platform: "win32",
    runPowerShell: async (_script, request) => {
      operations.push(request.operation);
      if (request.operation === "probe") return makeProbe();
      const error = new Error("operation outcome unknown");
      error.code = "OUTCOME_UNKNOWN";
      throw error;
    },
  });
  const plan = await service.preview();
  const result = await service.execute(plan.id, [
    OPERATIONS.DNS,
    OPERATIONS.DISKS,
  ]);
  assert.deepEqual(
    result.results.map((item) => item.status),
    ["unknown", "skipped"],
  );
  assert.equal(operations.includes("optimize-disks"), false);
});

test("execution progress and cancellation stop only operations not yet started", async () => {
  const controller = new AbortController();
  const progress = [];
  const calls = [];
  const mock = makeMockRunner({
    onCall: ({ request }) => {
      calls.push(request.operation);
      if (request.operation === NATIVE_OPERATIONS.PROBE) return makeProbe();
      if (request.operation === NATIVE_OPERATIONS.DNS) {
        controller.abort();
        return {
          ok: true,
          operation: request.operation,
          message: "DNS 已刷新",
        };
      }
      throw new Error("cancelled operation must not start");
    },
  });
  const service = createOptimizeService({
    platform: "win32",
    runPowerShell: mock.runPowerShell,
  });
  const plan = await service.preview();
  const result = await service.execute(
    plan.id,
    [OPERATIONS.DNS, OPERATIONS.DISKS],
    {
      signal: controller.signal,
      onProgress: (event) => progress.push(event),
    },
  );
  assert.deepEqual(calls, [
    NATIVE_OPERATIONS.PROBE,
    NATIVE_OPERATIONS.PROBE,
    NATIVE_OPERATIONS.DNS,
  ]);
  assert.deepEqual(
    result.results.map(({ id, status }) => ({ id, status })),
    [
      { id: OPERATIONS.DNS, status: "completed" },
      { id: OPERATIONS.DISKS, status: "cancelled" },
    ],
  );
  assert.deepEqual(
    progress.map(({ completed, total }) => ({ completed, total })),
    [
      { completed: 1, total: 2 },
      { completed: 2, total: 2 },
    ],
  );
});

test("aborted preview does not invoke a native probe", async () => {
  const controller = new AbortController();
  controller.abort();
  let called = false;
  const service = createOptimizeService({
    platform: "win32",
    runPowerShell: async () => {
      called = true;
      throw new Error("must not probe after cancellation");
    },
  });
  await assert.rejects(
    service.preview({ signal: controller.signal }),
    /预览已取消/,
  );
  assert.equal(called, false);
});

test(
  "Windows PowerShell 5.1 parser accepts optimize.ps1",
  { skip: process.platform !== "win32" },
  async () => {
    const command =
      "$tokens = $null; $errors = $null; [System.Management.Automation.Language.Parser]::ParseFile([Environment]::GetEnvironmentVariable('MOLE_OPTIMIZE_SCRIPT'), [ref]$tokens, [ref]$errors) | Out-Null; if ($errors.Count -gt 0) { $errors | ForEach-Object { Write-Error $_.Message }; exit 1 }";
    const result = await runProcess(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command],
      "",
      { MOLE_OPTIMIZE_SCRIPT: scriptPath },
    );
    assert.equal(result.code, 0, result.stderr || result.stdout);
  },
);
test(
  "Windows volume identity rejects cloned serial aliases",
  { skip: process.platform !== "win32" },
  async () => {
    const result = await runProcess(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        path.join(__dirname, "fixtures/optimize-volume-identity.ps1"),
      ],
      "",
    );
    assert.equal(result.code, 0, result.stderr || result.stdout);
  },
);

test(
  "Windows native probe is read-only and returns one JSON response",
  { skip: process.platform !== "win32" },
  async () => {
    const result = await runProcess(
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
      `${JSON.stringify({ operation: NATIVE_OPERATIONS.PROBE })}\n`,
    );
    assert.equal(result.code, 0, result.stderr || result.stdout);
    const lines = result.stdout.trim().split(/\r?\n/);
    assert.equal(lines.length, 1, result.stdout);
    const response = JSON.parse(lines[0]);
    assert.equal(response.ok, true);
    assert.equal(response.operation, NATIVE_OPERATIONS.PROBE);
    assert.equal(typeof response.isAdmin, "boolean");
    assert.ok(Array.isArray(response.drives));
    assert.ok(
      response.drives.every((drive) => /^[A-Z]:$/.test(drive.driveLetter)),
    );
  },
);
