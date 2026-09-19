const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createMaintenanceController } = require("../electron/maintenance.cjs");

function fixture(overrides = {}) {
  const calls = [];
  const plan = {
    id: "plan",
    items: [
      { id: "ok", name: "Safe cache", enabled: true },
      { id: "protected", name: "Windows", enabled: false },
    ],
  };
  const service = {
    preview: async () => plan,
    execute: async (...args) => {
      calls.push(args);
      return { results: args[1].map((id) => ({ id, status: "completed" })) };
    },
  };
  const controller = createMaintenanceController({
    services: { cleanup: service, applications: service, optimize: service },
    confirm: async () => true,
    audit: async () => {},
    platform: "win32",
    ...overrides,
  });
  return { controller, calls };
}
test("maintenance requires fresh server plan and exact enabled IDs", async () => {
  const { controller, calls } = fixture();
  await assert.rejects(controller.execute("cleanup", "plan", ["ok"]), /过期/);
  await controller.preview("cleanup");
  for (const ids of [["C:\\Windows"], ["protected"], ["ok", "ok"], []])
    await assert.rejects(controller.execute("cleanup", "plan", ids));
  assert.equal(calls.length, 0);
  await controller.execute("cleanup", "plan", ["ok"]);
  assert.deepEqual(
    calls.map((args) => args.slice(0, 2)),
    [["plan", ["ok"]]],
  );
  assert.ok(calls[0][2].signal instanceof AbortSignal);
  await assert.rejects(controller.execute("cleanup", "plan", ["ok"]), /过期/);
});
test("cancel and audit failure never execute", async () => {
  for (const options of [
    { confirm: async () => false },
    {
      audit: async () => {
        throw new Error("disk full");
      },
    },
  ]) {
    const { controller, calls } = fixture(options);
    await controller.preview("cleanup");
    try {
      await controller.execute("cleanup", "plan", ["ok"]);
    } catch (error) {
      assert.match(error.message, /disk full/);
    }
    assert.equal(calls.length, 0);
  }
});
test("non-Windows and unsupported actions fail closed", async () => {
  const { controller } = fixture({ platform: "darwin" });
  await assert.rejects(controller.preview("cleanup"), /Windows/);
  await assert.rejects(controller.preview("shell"), /Unsupported/);
});
test("plans expire and native dialogs serialize competing operations", async () => {
  let now = 0,
    allow;
  const { controller, calls } = fixture({
    now: () => now,
    confirm: () =>
      new Promise((resolve) => {
        allow = resolve;
      }),
  });
  await controller.preview("cleanup");
  now = 300001;
  await assert.rejects(controller.execute("cleanup", "plan", ["ok"]), /过期/);
  await controller.preview("cleanup");
  const pending = controller.execute("cleanup", "plan", ["ok"]);
  await assert.rejects(
    controller.execute("cleanup", "plan", ["ok"]),
    /正在进行/,
  );
  await assert.rejects(controller.preview("optimize"), /正在进行/);
  allow(true);
  await pending;
  assert.equal(calls.length, 1);
});

test("confirmation cannot extend expiry and execution state covers the dialog", async () => {
  let now = 0,
    allow;
  const { controller, calls } = fixture({
    now: () => now,
    confirm: () =>
      new Promise((resolve) => {
        allow = resolve;
      }),
  });
  await controller.preview("cleanup");
  const pending = controller.execute("cleanup", "plan", ["ok"]);
  assert.equal(controller.isExecuting(), true);
  await new Promise((resolve) => setImmediate(resolve));
  now = 300000;
  allow(true);
  await assert.rejects(pending, /过期/);
  assert.equal(calls.length, 0);
  assert.equal(controller.isExecuting(), false);
});

test("an uncertain native outcome blocks later writes but not read-only previews", async () => {
  const service = {
    preview: async () => ({ id: "plan", items: [{ id: "ok", enabled: true }] }),
    execute: async () => ({ results: [{ id: "ok", status: "unknown" }] }),
  };
  const { controller } = fixture({ services: { cleanup: service } });
  await controller.preview("cleanup");
  const result = await controller.execute("cleanup", "plan", ["ok"]);
  assert.match(result.warnings[0], /锁定/);
  await controller.preview("cleanup");
  await assert.rejects(
    controller.execute("cleanup", "plan", ["ok"]),
    /结果未知/,
  );
});

test("invalid or incomplete native results become unknown and lock further writes", async () => {
  for (const response of [undefined, {}, { results: [] }]) {
    const service = {
      preview: async () => ({
        id: "plan",
        items: [{ id: "ok", enabled: true }],
      }),
      execute: async () => response,
    };
    const { controller } = fixture({ services: { cleanup: service } });
    await controller.preview("cleanup");
    assert.equal(
      (await controller.execute("cleanup", "plan", ["ok"])).results[0].status,
      "unknown",
    );
    await controller.preview("cleanup");
    await assert.rejects(
      controller.execute("cleanup", "plan", ["ok"]),
      /结果未知/,
    );
  }
});

test("explicit exit while confirming cannot start a deferred mutation", async () => {
  let approve;
  const events = [];
  const { controller, calls } = fixture({
    confirm: () =>
      new Promise((resolve) => {
        approve = resolve;
      }),
    audit: async (event) => {
      events.push(event.event);
    },
  });
  await controller.preview("cleanup");
  const pending = controller.execute("cleanup", "plan", ["ok"]);
  await new Promise((resolve) => setImmediate(resolve));
  await controller.abandon();
  approve(true);
  assert.equal((await pending).cancelled, true);
  assert.equal(calls.length, 0);
  assert.deepEqual(events, ["abandoned"]);
});
