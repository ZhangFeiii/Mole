const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const { createPowerShellRunner } = require("../electron/powershell.cjs");

test("native script transport uses fixed binaries and stdin, never command interpolation", async () => {
  let invocation, input;
  const run = createPowerShellRunner({
    platform: "win32",
    systemRoot: "C:\\Windows",
    scriptsDirectory: "/bundled/windows",
    spawnProcess: (...args) => {
      invocation = args;
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.stdin = new PassThrough();
      child.stdin.on("data", (chunk) => {
        input = chunk.toString();
      });
      child.stdin.on("finish", () => {
        child.stdout.write('{"ok":true}');
        child.emit("close", 0);
      });
      return child;
    },
  });
  const payload = { action: "preview", id: 'x; & Stop-Computer "中文"' };
  assert.deepEqual(await run("applications", payload), { ok: true });
  assert.equal(
    invocation[0],
    "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
  );
  assert.equal(invocation[2].shell, false);
  assert.ok(!invocation[1].includes(payload.id));
  assert.equal(invocation[1].includes("-Command"), false);
  assert.deepEqual(JSON.parse(input), payload);
  await assert.rejects(run("../../evil", payload), /Unsupported/);
});
test("maintenance script transport refuses non-Windows and network system roots", async () => {
  const forbidden = () => {
    throw new Error("must not spawn");
  };
  await assert.rejects(
    createPowerShellRunner({ platform: "darwin", spawnProcess: forbidden })(
      "optimize",
      {},
    ),
    /Windows/,
  );
  await assert.rejects(
    createPowerShellRunner({
      platform: "win32",
      systemRoot: "\\\\host\\share",
      spawnProcess: forbidden,
    })("optimize", {}),
    /Invalid/,
  );
});
test("malformed native responses never become successful maintenance outcomes", async () => {
  const run = createPowerShellRunner({
    platform: "win32",
    systemRoot: "C:\\Windows",
    scriptsDirectory: "/scripts",
    spawnProcess: () => {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.stdin = new PassThrough();
      child.stdin.on("finish", () => {
        child.stdout.write("not JSON");
        child.emit("close", 0);
      });
      return child;
    },
  });
  await assert.rejects(run("optimize", {}), /JSON/);
});

test("timeout of a mutating command is an unknown outcome, not a retryable failure", async () => {
  const run = createPowerShellRunner({
    platform: "win32",
    systemRoot: "C:\\Windows",
    scriptsDirectory: "/scripts",
    spawnProcess: () => {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.stdin = new PassThrough();
      child.kill = () => child.emit("close", null);
      return child;
    },
  });
  await assert.rejects(
    run("applications", { action: "execute" }, { timeoutMs: 5 }),
    (error) => error.code === "OUTCOME_UNKNOWN",
  );
});

test("a kill error cannot erase the unknown outcome after a write timeout", async () => {
  const run = createPowerShellRunner({
    platform: "win32",
    systemRoot: "C:\\Windows",
    scriptsDirectory: "/scripts",
    spawnProcess: () => {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.stdin = new PassThrough();
      child.kill = () => child.emit("error", new Error("kill failed"));
      return child;
    },
  });
  await assert.rejects(
    run("applications", { action: "execute" }, { timeoutMs: 5 }),
    (error) => error.code === "OUTCOME_UNKNOWN",
  );
});
