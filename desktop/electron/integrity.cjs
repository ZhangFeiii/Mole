const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

const MANIFEST_VERSION = 1;
const WINDOWS_AGENT_NAME = "desktop-agent.exe";
const POSIX_AGENT_NAME = "desktop-agent";
const SCRIPT_NAMES = Object.freeze(["applications.ps1", "optimize.ps1"]);

class AssetVerificationError extends Error {
  constructor(message, code = "ASSET_VERIFICATION_FAILED") {
    super(message);
    this.name = "AssetVerificationError";
    this.code = code;
  }
}

function isWithin(root, target) {
  const relative = path.relative(root, target);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`))
  );
}

function fingerprint(stat) {
  return [
    stat.dev,
    stat.ino,
    stat.size,
    stat.mtimeNs ?? stat.mtimeMs,
    stat.ctimeNs ?? stat.ctimeMs,
    stat.nlink,
    stat.mode,
  ]
    .map((value) => String(value ?? ""))
    .join(":");
}

function isWindowsPlatform(platform) {
  return platform === "win32" || platform === "windows";
}

function agentName(platform) {
  return isWindowsPlatform(platform) ? WINDOWS_AGENT_NAME : POSIX_AGENT_NAME;
}

function logicalNames(platform) {
  return Object.freeze([
    `agent/${agentName(platform)}`,
    ...SCRIPT_NAMES.map((name) => `windows/${name}`),
  ]);
}

function resourceRelativePath(logicalName, isPackaged) {
  if (isPackaged) return logicalName.split("/");
  if (logicalName.startsWith("agent/"))
    return ["resources", logicalName.slice("agent/".length)];
  return ["windows", logicalName.slice("windows/".length)];
}

function fail(message, code) {
  throw new AssetVerificationError(message, code);
}

function assertAbsoluteDirectory(value, label) {
  if (
    typeof value !== "string" ||
    !path.isAbsolute(value) ||
    value.includes("\0")
  )
    fail(`${label} must be an absolute path`, "INVALID_VERIFIER_ROOT");
  return path.resolve(value);
}

async function lstatRegularFile(filename, label) {
  let stat;
  try {
    stat = await fsp.lstat(filename);
  } catch (error) {
    fail(`${label} is unavailable: ${error.message}`, "ASSET_MISSING");
  }
  if (stat.isSymbolicLink())
    fail(`${label} must not be a symbolic link`, "ASSET_LINK");
  if (!stat.isFile()) fail(`${label} is not a regular file`, "ASSET_TYPE");
  return stat;
}

async function assertNoLinks(root, target, label) {
  const rootStat = await lstatRegularFileOrDirectory(root, `${label} root`);
  if (rootStat.isSymbolicLink())
    fail(`${label} root must not be a symbolic link`, "ASSET_LINK");
  const relative = path.relative(root, target);
  if (!isWithin(root, target))
    fail(`${label} escapes its resource directory`, "ASSET_PATH");
  let cursor = root;
  for (const segment of relative ? relative.split(path.sep) : []) {
    cursor = path.join(cursor, segment);
    let stat;
    try {
      stat = await fsp.lstat(cursor);
    } catch (error) {
      fail(`${label} is unavailable: ${error.message}`, "ASSET_MISSING");
    }
    if (stat.isSymbolicLink())
      fail(`${label} must not contain symbolic links`, "ASSET_LINK");
  }
}

async function lstatRegularFileOrDirectory(filename, label) {
  let stat;
  try {
    stat = await fsp.lstat(filename);
  } catch (error) {
    fail(`${label} is unavailable: ${error.message}`, "ASSET_MISSING");
  }
  if (!stat.isDirectory() && !stat.isFile() && !stat.isSymbolicLink())
    fail(`${label} has an unsupported type`, "ASSET_TYPE");
  return stat;
}

async function realpathInside(root, target, label) {
  let rootReal;
  let targetReal;
  try {
    rootReal = await fsp.realpath(root);
    targetReal = await fsp.realpath(target);
  } catch (error) {
    fail(`${label} cannot be resolved: ${error.message}`, "ASSET_PATH");
  }
  if (!isWithin(rootReal, targetReal))
    fail(`${label} resolves outside its resource directory`, "ASSET_PATH");
  return targetReal;
}

async function readManifest(filename, expectedNames) {
  await lstatRegularFile(filename, "Integrity manifest");
  let manifest;
  try {
    manifest = JSON.parse(await fsp.readFile(filename, "utf8"));
  } catch (error) {
    fail(`Integrity manifest is invalid: ${error.message}`, "MANIFEST_INVALID");
  }
  if (!manifest || manifest.version !== MANIFEST_VERSION)
    fail("Unsupported integrity manifest version", "MANIFEST_INVALID");
  if (
    !manifest.assets ||
    typeof manifest.assets !== "object" ||
    Array.isArray(manifest.assets)
  )
    fail("Integrity manifest assets must be an object", "MANIFEST_INVALID");
  const names = Object.keys(manifest.assets);
  const expected = new Set(expectedNames);
  if (
    names.length !== expected.size ||
    names.some((name) => !expected.has(name))
  )
    fail(
      "Integrity manifest contains missing or unexpected assets",
      "MANIFEST_INVALID",
    );
  for (const logicalName of expectedNames) {
    const entry = manifest.assets[logicalName];
    if (
      !entry ||
      entry.path !== logicalName ||
      typeof entry.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(entry.sha256) ||
      !Number.isSafeInteger(entry.size) ||
      entry.size < 0
    )
      fail(
        `Integrity manifest entry is invalid: ${logicalName}`,
        "MANIFEST_INVALID",
      );
  }
  return manifest;
}

async function hashFile(filename) {
  const hash = crypto.createHash("sha256");
  const stream = fs.createReadStream(filename);
  try {
    for await (const chunk of stream) hash.update(chunk);
  } finally {
    stream.destroy();
  }
  return hash.digest("hex");
}

function createAssetVerifier({
  appRoot,
  resourcesRoot,
  isPackaged = false,
  platform = process.platform,
} = {}) {
  const appDirectory = assertAbsoluteDirectory(appRoot, "appRoot");
  const resourcesDirectory = assertAbsoluteDirectory(
    resourcesRoot,
    "resourcesRoot",
  );
  const names = logicalNames(platform);
  const manifestFilename = path.join(
    appDirectory,
    "electron",
    "generated-integrity.json",
  );
  const cache = new Map();

  async function resolveAsset(logicalName, entry) {
    if (!names.includes(logicalName))
      fail(`Unknown integrity asset: ${logicalName}`, "ASSET_UNKNOWN");
    if (entry.path !== logicalName)
      fail(`Integrity path mismatch: ${logicalName}`, "MANIFEST_INVALID");
    const target = path.resolve(
      resourcesDirectory,
      ...resourceRelativePath(logicalName, isPackaged),
    );
    if (!isWithin(resourcesDirectory, target))
      fail(`Integrity asset escapes resources: ${logicalName}`, "ASSET_PATH");
    await assertNoLinks(resourcesDirectory, target, logicalName);
    const targetReal = await realpathInside(
      resourcesDirectory,
      target,
      logicalName,
    );
    const stat = await lstatRegularFile(target, logicalName);
    return { target, targetReal, stat };
  }

  async function verifyWithManifest(manifest, logicalName) {
    if (typeof logicalName !== "string" || !names.includes(logicalName))
      fail(`Unknown integrity asset: ${String(logicalName)}`, "ASSET_UNKNOWN");
    const entry = manifest.assets[logicalName];
    const resolved = await resolveAsset(logicalName, entry);
    const currentFingerprint = fingerprint(resolved.stat);
    const previous = cache.get(logicalName);
    if (previous && previous.fingerprint === currentFingerprint) {
      if (previous.sha256 !== entry.sha256 || resolved.stat.size !== entry.size)
        fail(`Integrity asset changed: ${logicalName}`, "ASSET_TAMPERED");
      return {
        ok: true,
        logicalName,
        path: resolved.targetReal,
        sha256: previous.sha256,
        cached: true,
        isPackaged,
      };
    }
    const sha256 = await hashFile(resolved.target);
    const after = await fsp.lstat(resolved.target);
    if (
      after.isSymbolicLink() ||
      !after.isFile() ||
      fingerprint(after) !== currentFingerprint
    )
      fail(
        `Integrity asset changed while reading: ${logicalName}`,
        "ASSET_CHANGED",
      );
    await assertNoLinks(resourcesDirectory, resolved.target, logicalName);
    await realpathInside(resourcesDirectory, resolved.target, logicalName);
    if (sha256 !== entry.sha256 || after.size !== entry.size)
      fail(`Integrity check failed: ${logicalName}`, "ASSET_TAMPERED");
    cache.set(logicalName, { fingerprint: currentFingerprint, sha256 });
    return {
      ok: true,
      logicalName,
      path: resolved.targetReal,
      sha256,
      cached: false,
      isPackaged,
    };
  }

  async function verify(logicalName) {
    const manifest = await readManifest(manifestFilename, names);
    return verifyWithManifest(manifest, logicalName);
  }

  async function verifyAll() {
    const manifest = await readManifest(manifestFilename, names);
    const assets = [];
    for (const logicalName of names)
      assets.push(await verifyWithManifest(manifest, logicalName));
    return { ok: true, isPackaged, assets };
  }

  return Object.freeze({ verify, verifyAll });
}

module.exports = {
  AssetVerificationError,
  MANIFEST_VERSION,
  SCRIPT_NAMES,
  agentName,
  createAssetVerifier,
  logicalNames,
  resourceRelativePath,
};
