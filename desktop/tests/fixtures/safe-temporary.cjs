const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const owned = new Map();

async function make_temporary(prefix) {
  if (!/^mole-[a-z-]+-$/.test(prefix))
    throw new Error("Unexpected fixture prefix");
  const directory = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), prefix)),
  );
  const stat = await fs.lstat(directory, { bigint: true });
  owned.set(directory, { dev: stat.dev, ino: stat.ino });
  return directory;
}
async function safe_remove_temporary(directory) {
  const expected = owned.get(directory);
  if (
    !expected ||
    directory === path.parse(directory).root ||
    directory === os.homedir() ||
    directory === os.tmpdir()
  )
    throw new Error("Refusing to remove an unowned fixture");
  const stat = await fs.lstat(directory, { bigint: true });
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.dev !== expected.dev ||
    stat.ino !== expected.ino ||
    (await fs.realpath(directory)) !== directory
  )
    throw new Error("Fixture directory identity changed");
  await fs.rm(directory, { recursive: true, force: false });
  owned.delete(directory);
}
module.exports = { make_temporary, safe_remove_temporary };
