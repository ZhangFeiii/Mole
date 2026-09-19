const {
  make_temporary,
  safe_remove_temporary,
} = require("./fixtures/safe-temporary.cjs");
const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {
  checkManifest,
  assetDefinitions,
  writeManifest,
} = require("../scripts/integrity-manifest.cjs");
const {
  createAssetVerifier,
  logicalNames,
} = require("../electron/integrity.cjs");

test("production package config hardens Electron and stays explicitly unsigned", async () => {
  const packageJSON = JSON.parse(
    await fsp.readFile(path.join(__dirname, "..", "package.json"), "utf8"),
  );
  assert.deepEqual(packageJSON.build.electronFuses, {
    runAsNode: false,
    enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: false,
    onlyLoadAppFromAsar: true,
    enableEmbeddedAsarIntegrityValidation: true,
  });
  assert.equal(packageJSON.build.win.signExecutable, false);
  assert.deepEqual(packageJSON.build.win.signExts, [
    ".dll",
    "!desktop-agent.exe",
  ]);
  assert.equal("signAndEditExecutable" in packageJSON.build.win, false);
  assert.equal(
    packageJSON.build.extraResources.some((entry) =>
      JSON.stringify(entry).includes("generated-integrity.json"),
    ),
    false,
  );
});

async function makeFixture() {
  const desktopRoot = await make_temporary("mole-integrity-");
  const resourcesRoot = path.join(desktopRoot, "resources");
  await fsp.mkdir(path.join(resourcesRoot, "agent"), { recursive: true });
  await fsp.mkdir(path.join(resourcesRoot, "windows"), { recursive: true });
  await fsp.mkdir(path.join(desktopRoot, "windows"), { recursive: true });
  await fsp.mkdir(path.join(desktopRoot, "electron"), { recursive: true });
  const agent = logicalNames(process.platform)[0];
  const buildAgentPath = path.join(resourcesRoot, path.basename(agent));
  const agentPath = path.join(resourcesRoot, agent);
  await fsp.writeFile(
    buildAgentPath,
    Buffer.from("signed collector fixture\n"),
  );
  await fsp.copyFile(buildAgentPath, agentPath);
  for (const [name, content] of [
    ["applications.ps1", "# reviewed application fixture\n"],
    ["optimize.ps1", "# reviewed optimize fixture\n"],
  ]) {
    const source = path.join(desktopRoot, "windows", name);
    await fsp.writeFile(source, content);
    await fsp.copyFile(source, path.join(resourcesRoot, "windows", name));
  }
  await writeManifest({ desktopRoot, target: process.platform });
  return { desktopRoot, resourcesRoot, agent, agentPath };
}

async function removeFixture(fixture) {
  await safe_remove_temporary(fixture.desktopRoot);
}

test("generated manifest covers only fixed runtime assets", async () => {
  const fixture = await makeFixture();
  try {
    const expected = assetDefinitions({
      desktopRoot: fixture.desktopRoot,
      target: process.platform,
    }).definitions.map((item) => item.logicalName);
    const verifier = createAssetVerifier({
      appRoot: fixture.desktopRoot,
      resourcesRoot: fixture.resourcesRoot,
      isPackaged: true,
    });
    const result = await verifier.verifyAll();
    assert.equal(result.ok, true);
    assert.deepEqual(
      result.assets.map((item) => item.logicalName),
      expected,
    );
    assert.equal(
      result.assets.every((item) => item.cached === false),
      true,
    );
    const cached = await verifier.verify(fixture.agent);
    assert.equal(cached.cached, true);
    await checkManifest({
      desktopRoot: fixture.desktopRoot,
      target: process.platform,
    });
  } finally {
    await removeFixture(fixture);
  }
});

test("asset verifier rehashes when a file fingerprint changes", async () => {
  const fixture = await makeFixture();
  try {
    const verifier = createAssetVerifier({
      appRoot: fixture.desktopRoot,
      resourcesRoot: fixture.resourcesRoot,
      isPackaged: true,
    });
    await verifier.verify(fixture.agent);
    const original = await fsp.readFile(fixture.agentPath);
    await fsp.writeFile(
      fixture.agentPath,
      Buffer.from("tampered collector fixture\n"),
    );
    await assert.rejects(
      verifier.verify(fixture.agent),
      (error) => error.code === "ASSET_TAMPERED",
    );
    await fsp.writeFile(fixture.agentPath, original);
    const restored = await verifier.verify(fixture.agent);
    assert.equal(restored.ok, true);
    assert.equal(restored.cached, false);
  } finally {
    await removeFixture(fixture);
  }
});

test("asset verifier maps the source-tree layout in development", async () => {
  const fixture = await makeFixture();
  try {
    const verifier = createAssetVerifier({
      appRoot: fixture.desktopRoot,
      resourcesRoot: fixture.desktopRoot,
      isPackaged: false,
    });
    const result = await verifier.verifyAll();
    assert.equal(result.ok, true);
    assert.equal(result.assets.length, 3);
    assert.equal(
      result.assets[0].path.endsWith(
        path.join("resources", path.basename(fixture.agentPath)),
      ),
      true,
    );
  } finally {
    await removeFixture(fixture);
  }
});

test("asset verifier rejects unknown names and manifest path injection", async () => {
  const fixture = await makeFixture();
  try {
    const verifier = createAssetVerifier({
      appRoot: fixture.desktopRoot,
      resourcesRoot: fixture.resourcesRoot,
      isPackaged: true,
    });
    await assert.rejects(
      verifier.verify("windows/../outside.ps1"),
      (error) => error.code === "ASSET_UNKNOWN",
    );
    const manifestPath = path.join(
      fixture.desktopRoot,
      "electron",
      "generated-integrity.json",
    );
    const manifest = JSON.parse(await fsp.readFile(manifestPath, "utf8"));
    manifest.assets[fixture.agent].path = "../outside";
    await fsp.writeFile(manifestPath, JSON.stringify(manifest));
    await assert.rejects(
      verifier.verify(fixture.agent),
      (error) => error.code === "MANIFEST_INVALID",
    );
  } finally {
    await removeFixture(fixture);
  }
});

test("asset verifier rejects a replaced resource symlink", async (t) => {
  if (process.platform === "win32")
    return t.skip(
      "creating symlinks requires elevated Windows test permissions",
    );
  const fixture = await makeFixture();
  try {
    const outside = path.join(
      path.dirname(fixture.desktopRoot),
      "outside-agent.bin",
    );
    await fsp.writeFile(outside, crypto.randomBytes(32));
    await fsp.unlink(fixture.agentPath);
    await fsp.symlink(outside, fixture.agentPath);
    const verifier = createAssetVerifier({
      appRoot: fixture.desktopRoot,
      resourcesRoot: fixture.resourcesRoot,
      isPackaged: true,
    });
    await assert.rejects(
      verifier.verify(fixture.agent),
      (error) => error.code === "ASSET_LINK",
    );
    await fsp.unlink(outside);
  } finally {
    await removeFixture(fixture);
  }
});

test("asset verifier rejects a symlinked resource parent directory", async () => {
  const fixture = await makeFixture();
  const outside = await make_temporary("mole-integrity-outside-");
  try {
    await fsp.copyFile(
      path.join(fixture.resourcesRoot, "windows", "optimize.ps1"),
      path.join(outside, "optimize.ps1"),
    );
    await fsp.rename(
      path.join(fixture.resourcesRoot, "windows"),
      path.join(fixture.resourcesRoot, "windows-original"),
    );
    await fsp.symlink(
      outside,
      path.join(fixture.resourcesRoot, "windows"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const verifier = createAssetVerifier({
      appRoot: fixture.desktopRoot,
      resourcesRoot: fixture.resourcesRoot,
      isPackaged: true,
    });
    await assert.rejects(
      verifier.verify("windows/optimize.ps1"),
      (error) => error.code === "ASSET_LINK",
    );
  } finally {
    await safe_remove_temporary(outside);
    await removeFixture(fixture);
  }
});
