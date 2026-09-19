const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

const MANIFEST_VERSION = 1;
const MANIFEST_RELATIVE_PATH = path.join(
  "electron",
  "generated-integrity.json",
);
const AGENT_BASENAME = "desktop-agent";
const SCRIPT_NAMES = Object.freeze(["applications.ps1", "optimize.ps1"]);

function isWindowsTarget(value) {
  return value === "win32" || value === "windows";
}

function targetName(value = process.env.GOOS || process.platform) {
  return isWindowsTarget(value) ? `${AGENT_BASENAME}.exe` : AGENT_BASENAME;
}

function assetDefinitions({
  desktopRoot,
  target = process.env.GOOS || process.platform,
} = {}) {
  const root = path.resolve(desktopRoot || path.resolve(__dirname, ".."));
  const agentName = targetName(target);
  const definitions = [
    {
      logicalName: `agent/${agentName}`,
      sourcePath: path.join(root, "resources", agentName),
    },
    ...SCRIPT_NAMES.map((name) => ({
      logicalName: `windows/${name}`,
      sourcePath: path.join(root, "windows", name),
    })),
  ];
  return { desktopRoot: root, definitions };
}

function assertRegularFile(stat, filename) {
  if (stat.isSymbolicLink())
    throw new Error(`Integrity input must not be a symbolic link: ${filename}`);
  if (!stat.isFile())
    throw new Error(`Integrity input is not a file: ${filename}`);
}

async function hashFile(filename) {
  const stat = await fsp.lstat(filename);
  assertRegularFile(stat, filename);
  const hash = crypto.createHash("sha256");
  const stream = fs.createReadStream(filename);
  try {
    for await (const chunk of stream) hash.update(chunk);
  } finally {
    stream.destroy();
  }
  return { sha256: hash.digest("hex"), size: stat.size };
}

async function createManifest(options = {}) {
  const { definitions } = assetDefinitions(options);
  const assets = {};
  for (const definition of definitions) {
    const digest = await hashFile(definition.sourcePath);
    assets[definition.logicalName] = {
      path: definition.logicalName,
      sha256: digest.sha256,
      size: digest.size,
    };
  }
  return {
    version: MANIFEST_VERSION,
    generatedAt: new Date().toISOString(),
    assets,
  };
}

function manifestPath(desktopRoot) {
  return path.join(
    path.resolve(desktopRoot || path.resolve(__dirname, "..")),
    MANIFEST_RELATIVE_PATH,
  );
}

async function readJson(filename) {
  let value;
  try {
    value = JSON.parse(await fsp.readFile(filename, "utf8"));
  } catch (error) {
    throw new Error(
      `Cannot read integrity manifest ${filename}: ${error.message}`,
    );
  }
  return value;
}

function validateManifestShape(manifest, definitions) {
  if (!manifest || manifest.version !== MANIFEST_VERSION)
    throw new Error("Unsupported integrity manifest version");
  if (
    !manifest.assets ||
    typeof manifest.assets !== "object" ||
    Array.isArray(manifest.assets)
  )
    throw new Error("Integrity manifest assets must be an object");
  const expected = new Set(definitions.map((item) => item.logicalName));
  const actual = Object.keys(manifest.assets);
  if (
    actual.length !== expected.size ||
    actual.some((name) => !expected.has(name))
  )
    throw new Error("Integrity manifest contains missing or unexpected assets");
  for (const definition of definitions) {
    const item = manifest.assets[definition.logicalName];
    if (
      !item ||
      item.path !== definition.logicalName ||
      typeof item.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(item.sha256) ||
      !Number.isSafeInteger(item.size) ||
      item.size < 0
    )
      throw new Error(`Invalid integrity entry: ${definition.logicalName}`);
  }
}

async function writeManifest(options = {}) {
  const { desktopRoot, definitions } = assetDefinitions(options);
  const output = manifestPath(desktopRoot);
  const manifest = await createManifest({
    desktopRoot,
    target: options.target,
  });
  validateManifestShape(manifest, definitions);
  await fsp.mkdir(path.dirname(output), { recursive: true });
  const temporary = `${output}.${process.pid}.tmp`;
  await fsp.writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o644,
  });
  await fsp.rename(temporary, output);
  return { manifest, output };
}

async function checkManifest(options = {}) {
  const { desktopRoot, definitions } = assetDefinitions(options);
  const filename = manifestPath(desktopRoot);
  const manifest = await readJson(filename);
  validateManifestShape(manifest, definitions);
  const current = await createManifest({ desktopRoot, target: options.target });
  for (const definition of definitions) {
    const expected = manifest.assets[definition.logicalName];
    const actual = current.assets[definition.logicalName];
    if (expected.sha256 !== actual.sha256 || expected.size !== actual.size)
      throw new Error(
        `Integrity manifest is stale for ${definition.logicalName}`,
      );
  }
  return manifest;
}

async function main() {
  const result = process.argv.includes("--check")
    ? await checkManifest()
    : await writeManifest();
  if (process.argv.includes("--check"))
    console.log(
      `Integrity manifest is current (${Object.keys(result.assets).length} assets)`,
    );
  else console.log(`Wrote integrity manifest: ${manifestPath()}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  AGENT_BASENAME,
  MANIFEST_RELATIVE_PATH,
  MANIFEST_VERSION,
  SCRIPT_NAMES,
  assetDefinitions,
  checkManifest,
  createManifest,
  manifestPath,
  targetName,
  validateManifestShape,
  writeManifest,
};
