const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  mkdtemp,
  realpath,
  writeFile,
  readFile,
  mkdir,
} = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { startAgent } = require("../electron/agent.cjs");
const executable = path.resolve(
  __dirname,
  `../resources/desktop-agent${process.platform === "win32" ? ".exe" : ""}`,
);

test("native status returns actual machine readings", async () => {
  const data = await startAgent(executable, "status").promise;
  assert.ok(data.collectedAt > Date.now() - 20000);
  assert.ok(data.memoryTotal > 0);
  assert.ok(data.cores > 0);
  assert.ok(Array.isArray(data.volumes));
  assert.ok(
    data.cpuPercent === null ||
      (data.cpuPercent >= 0 && data.cpuPercent <= 100),
  );
});

test("native scanner reads nested Unicode and metacharacter paths without writes", async () => {
  const root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "mole-native-")),
  );
  const nested = path.join(root, "中文 & more");
  await mkdir(nested);
  const file = path.join(nested, "sample.txt");
  await writeFile(file, "mole-only-reads");
  const progress = [];
  const data = await startAgent(executable, "scan", root, (p) =>
    progress.push(p),
  ).promise;
  assert.equal(data.files, 1);
  assert.equal(data.bytes, Buffer.byteLength("mole-only-reads"));
  assert.equal(data.partial, false);
  assert.equal(await readFile(file, "utf8"), "mole-only-reads");
  assert.ok(progress.length > 0);
});

test("cancel terminates the collector without returning successful readings", async () => {
  const job = startAgent(executable, "status");
  job.cancel();
  assert.deepEqual(await job.promise, { cancelled: true });
});

test("mutating commands and missing executable fail closed", async () => {
  for (const command of ["clean", "uninstall", "optimize", "powershell"])
    assert.throws(() => startAgent(executable, command));
  await assert.rejects(
    startAgent(path.resolve("missing-agent"), "status").promise,
    /无法启动/,
  );
});
