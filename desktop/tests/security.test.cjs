const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtemp, realpath, mkdir } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {
  isWithin,
  authorizePath,
  trustedSender,
} = require("../electron/security.cjs");

test("path boundary rejects traversal and sibling prefixes", () => {
  const root = path.resolve("safe");
  assert.equal(isWithin(root, root), true);
  assert.equal(isWithin(root, path.join(root, "nested")), true);
  assert.equal(isWithin(root, path.resolve("safe-other")), false);
  assert.equal(isWithin(root, path.resolve("safe", "..", "secret")), false);
});

test("only explicitly authorized roots are accessible", async () => {
  const dir = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "mole-security-")),
  );
  const inside = path.join(dir, "选择的目录");
  const outside = path.join(dir, "private");
  await mkdir(inside);
  await mkdir(outside);
  assert.equal(await authorizePath(inside, [inside]), inside);
  await assert.rejects(authorizePath(outside, [inside]), /授权/);
  await assert.rejects(authorizePath("relative", [inside]), /无效/);
  await assert.rejects(authorizePath(null, [inside]), /无效/);
  await assert.rejects(authorizePath(`${inside}\0`, [inside]), /无效/);
});

test("IPC accepts only the trusted main frame of the application", () => {
  const url = "file:///app/dist/index.html";
  const frame = { url };
  const contents = { mainFrame: frame };
  assert.equal(
    trustedSender({ sender: contents, senderFrame: frame }, contents, url),
    true,
  );
  assert.equal(
    trustedSender({ sender: {}, senderFrame: frame }, contents, url),
    false,
  );
  assert.equal(
    trustedSender({ sender: contents, senderFrame: { url } }, contents, url),
    false,
  );
  for (const hostile of [
    "https://evil.invalid",
    "file:///app/dist/other.html",
    `${url}?remote=1`,
  ]) {
    frame.url = hostile;
    assert.equal(
      trustedSender({ sender: contents, senderFrame: frame }, contents, url),
      false,
    );
  }
});
