const { test } = require("node:test");
const assert = require("node:assert/strict");
const { getPlatformContext } = require("../electron/native-context.cjs");
test("Windows system path comes from a native OS query, not environment inference", async () => {
  const info = await getPlatformContext("/fixed/collector", {
    platform: "win32",
    run: async (_file, args, options) => {
      assert.deepEqual(args, ["platform-info"]);
      assert.equal(options.shell, false);
      return {
        stdout: JSON.stringify({
          schema: 1,
          platform: "windows",
          systemDirectory: "D:\\WINNT\\System32",
        }),
      };
    },
  });
  assert.equal(info.systemDirectory, "D:\\WINNT\\System32");
  for (const directory of [
    "relative",
    "\\\\evil\\System32",
    "C:\\wrong",
    "C:\\Windows\\System32:stream",
  ]) {
    await assert.rejects(
      getPlatformContext("/fixed/collector", {
        platform: "win32",
        run: async () => ({
          stdout: JSON.stringify({
            schema: 1,
            platform: "windows",
            systemDirectory: directory,
          }),
        }),
      }),
    );
  }
});
