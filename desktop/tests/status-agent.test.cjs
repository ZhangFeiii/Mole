const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const { startStatusCollector } = require("../electron/status-agent.cjs");

function fixture(options = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => {
    child.killed = true;
  };
  const service = startStatusCollector("/fixed/collector", {
    spawnProcess: (_file, args, settings) => {
      assert.deepEqual(args, ["status-stream"]);
      assert.equal(settings.shell, false);
      return child;
    },
    ...options,
  });
  return { child, service };
}
test("one status collector delivers multiple real sample frames", async () => {
  const { child, service } = fixture();
  const first = service.snapshot();
  child.stdout.write(
    JSON.stringify({ collectedAt: 1, volumes: [], warnings: [] }) + "\n",
  );
  assert.equal((await first).collectedAt, 1);
  child.stdout.write(
    JSON.stringify({ collectedAt: 2, volumes: [], warnings: [] }) + "\n",
  );
  assert.equal((await service.snapshot()).collectedAt, 2);
  service.cancel();
  assert.equal(child.killed, true);
});
test("status streams reject invalid frames, stops and stale samples", async () => {
  const bad = fixture();
  const pending = bad.service.snapshot();
  bad.child.stdout.write("{bad}\n");
  await assert.rejects(pending);
  assert.equal(bad.service.failed, true);
  const timed = fixture({ timeoutMs: 5 });
  await assert.rejects(timed.service.snapshot(), /超时/);
  assert.equal(timed.child.killed, true);
});
