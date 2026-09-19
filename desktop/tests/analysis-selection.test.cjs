const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {
  createAnalysisSelections,
} = require("../electron/analysis-selection.cjs");
test("manual recycle IDs bind to the server's original scan snapshot, never client paths", async () => {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "mole-selection-")),
  );
  const filename = path.join(root, "document.txt");
  await fs.writeFile(filename, "fixture");
  const stat = await fs.stat(filename, { bigint: true });
  const manager = createAnalysisSelections({
    platform: "win32",
    inspectAttributes: async (paths) =>
      paths.map((path) => ({ path, attributes: 0x20, inUse: false })),
  });
  const result = await manager.bind(
    {
      entries: [
        {
          path: filename,
          size: 7,
          name: "document.txt",
          directory: false,
          modified: new Date(Number(stat.mtimeMs)).toISOString(),
        },
      ],
      largeFiles: [],
    },
    root,
  );
  assert.ok(result.entries[0].entryId);
  const saved = (await manager.authorize([result.entries[0].entryId]))[0];
  assert.equal(saved.path, filename);
  assert.equal(typeof saved.identity, "string");
  await assert.rejects(manager.authorize([filename]));
  manager.clear();
  await assert.rejects(manager.authorize([result.entries[0].entryId]));
});
test("changed or busy files never acquire actionable scan IDs", async () => {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "mole-selection-")),
  );
  const filename = path.join(root, "busy.txt");
  await fs.writeFile(filename, "new");
  const manager = createAnalysisSelections({
    platform: "win32",
    inspectAttributes: async (paths) =>
      paths.map((path) => ({ path, attributes: 0x20, inUse: true })),
  });
  const result = await manager.bind(
    {
      entries: [
        {
          path: filename,
          size: 1,
          directory: false,
          modified: new Date().toISOString(),
        },
      ],
      largeFiles: [],
    },
    root,
  );
  assert.equal(result.entries[0].entryId, undefined);
});
