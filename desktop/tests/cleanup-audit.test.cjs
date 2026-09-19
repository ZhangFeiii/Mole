const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { createCleanupService } = require("../electron/cleanup.cjs");

test("malformed UTF-8 whitelist must fail closed, never silently narrow protection", async () => {
  const home = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "mole-review-audit-")),
  );
  const root = path.join(home, "Temp");
  await fs.mkdir(root);
  const file = path.join(root, "protected.tmp");
  await fs.writeFile(file, "fixture-only");
  const whitelist = path.join(home, "whitelist.txt");
  await fs.writeFile(
    whitelist,
    Buffer.concat([Buffer.from(file), Buffer.from([0xff])]),
  );
  const service = createCleanupService({
    platform: "win32",
    home,
    env: {},
    now: () => Date.now() + 10 * 86400000,
    testRoots: [{ id: "fixture", name: "测试", path: root }],
    testWhitelistPath: whitelist,
    inspectAttributes: async (paths) =>
      Promise.all(
        paths.map(async (p) => {
          const s = await fs.lstat(p);
          return {
            path: p,
            attributes: s.isDirectory() ? 0x10 : 0x80,
            inUse: false,
          };
        }),
      ),
    trashItem: async () => assert.fail("must never reach mutation"),
  });
  await assert.rejects(service.preview(), /编码|白名单|UTF/);
  assert.equal(await fs.readFile(file, "utf8"), "fixture-only");
});
