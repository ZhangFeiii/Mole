const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { createOperationStore } = require("../electron/operation-store.cjs");
const {
  createMaintenanceController,
  createAuditLog,
} = require("../electron/maintenance.cjs");

async function root() {
  return fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "mole-journal-")));
}
const operation = {
  id: "operation-one",
  kind: "cleanup",
  count: 1,
  names: ["fixture.tmp"],
  phase: "running",
};

test("pending operations survive crash/restart and cannot be replayed automatically", async () => {
  const directory = path.join(await root(), "journal");
  const first = createOperationStore({ directory });
  assert.equal((await first.snapshot()).required, false);
  await first.begin(operation);
  const afterRestart = createOperationStore({ directory });
  assert.equal((await afterRestart.snapshot()).required, true);
  await assert.rejects(
    afterRestart.begin({ ...operation, id: "second" }),
    /未完成/,
  );
  await afterRestart.acknowledge();
  assert.equal((await afterRestart.snapshot()).required, false);
  await afterRestart.begin({ ...operation, id: "second" });
  await afterRestart.finish("second", { results: [{ status: "completed" }] });
  const final = await createOperationStore({ directory }).snapshot();
  assert.equal(final.required, false);
  assert.equal(final.history[0].counts.completed, 1);
});
test("unknown outcomes remain locked across a fresh controller until native acknowledgement", async () => {
  const directory = path.join(await root(), "journal");
  let calls = 0,
    confirmRecovery = false;
  const service = {
    preview: async () => ({
      id: "plan",
      items: [{ id: "item", name: "Fixture", enabled: true }],
    }),
    execute: async () => {
      calls++;
      return { results: [{ id: "item", status: "unknown" }] };
    },
  };
  const make = () =>
    createMaintenanceController({
      services: { cleanup: service },
      journal: createOperationStore({ directory }),
      platform: "win32",
      audit: async () => {},
      confirm: async (request) =>
        request.kind === "recovery" ? confirmRecovery : true,
    });
  const first = make();
  await first.preview("cleanup");
  await first.execute("cleanup", "plan", ["item"]);
  const second = make();
  await second.preview("cleanup");
  await assert.rejects(
    second.execute("cleanup", "plan", ["item"]),
    /上次|未可靠|核查/,
  );
  assert.equal(calls, 1);
  assert.equal((await second.acknowledgeRecovery()).cancelled, true);
  assert.equal((await second.state()).recovery.required, true);
  confirmRecovery = true;
  await second.acknowledgeRecovery();
  assert.equal((await second.state()).recovery.required, false);
});
test("truncated or modified state does not turn into an empty successful history", async () => {
  const directory = path.join(await root(), "journal");
  const store = createOperationStore({ directory });
  await store.begin(operation);
  await fs.writeFile(path.join(directory, "operations.json"), '{"payload":');
  const state = await createOperationStore({ directory }).snapshot();
  assert.equal(state.required, true);
  assert.equal(state.corrupt, true);
  await assert.rejects(store.acknowledge());
});
test("existing legacy logs require one explicit migration check", async () => {
  const directory = await root(),
    legacyDirectory = path.join(directory, "legacy");
  await fs.mkdir(legacyDirectory);
  await fs.writeFile(
    path.join(legacyDirectory, "maintenance-2026-09-19.jsonl"),
    '{"event":"started"}\n',
  );
  const store = createOperationStore({
    directory: path.join(directory, "journal"),
    legacyDirectory,
  });
  assert.equal((await store.snapshot()).required, true);
  await store.acknowledge();
  assert.equal((await store.snapshot()).required, false);
});
test("audit files and journal directories reject symlink/redirection without altering their target", async () => {
  const directory = await root(),
    outside = path.join(directory, "protected.txt"),
    logs = path.join(directory, "logs");
  await fs.writeFile(outside, "keep this exact content");
  await fs.mkdir(logs);
  const target = path.join(
    logs,
    "maintenance-" + new Date().toISOString().slice(0, 10) + "-0.jsonl",
  );
  try {
    await fs.symlink(outside, target, "file");
  } catch (error) {
    if (process.platform === "win32" && error.code === "EPERM") return;
    throw error;
  }
  await assert.rejects(createAuditLog(logs)({ event: "started" }));
  assert.equal(await fs.readFile(outside, "utf8"), "keep this exact content");
  const redirected = path.join(directory, "redirected");
  await fs.symlink(
    logs,
    redirected,
    process.platform === "win32" ? "junction" : "dir",
  );
  assert.equal(
    (await createOperationStore({ directory: redirected }).snapshot()).corrupt,
    true,
  );
});
test("audit appends complete JSON records and syncs them before returning", async () => {
  const directory = path.join(await root(), "logs");
  const audit = createAuditLog(directory);
  await audit({ event: "started", id: "one" });
  await audit({ event: "finished", id: "one" });
  const names = await fs.readdir(directory);
  const rows = (await fs.readFile(path.join(directory, names[0]), "utf8"))
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert.deepEqual(
    rows.map((row) => row.event),
    ["started", "finished"],
  );
});
