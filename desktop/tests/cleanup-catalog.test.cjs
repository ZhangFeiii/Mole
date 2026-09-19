const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  GROUPS,
  profileLocations,
  rootsForProfile,
  staticRoots,
} = require("../electron/cleanup-catalog.cjs");

const HOME = "C:\\Users\\catalog-fixture";
const ROOT_FIELDS = [
  "id",
  "groupId",
  "name",
  "path",
  "kind",
  "extensions",
  "daysOld",
  "recommendation",
  "reason",
  "processNames",
  "source",
  "enabled",
];

function location(id) {
  const item = profileLocations(HOME).find((entry) => entry.id === id);
  assert.ok(item, `missing location ${id}`);
  return item;
}

function assertRootShape(item) {
  assert.deepEqual(Object.keys(item).sort(), [...ROOT_FIELDS].sort());
  assert.equal(typeof item.id, "string");
  assert.equal(typeof item.groupId, "string");
  assert.equal(typeof item.name, "string");
  assert.equal(typeof item.path, "string");
  assert.ok(["cache", "log", "temp", "protected"].includes(item.kind));
  assert.ok(item.extensions === null || Array.isArray(item.extensions));
  assert.equal(Number.isInteger(item.daysOld), true);
  assert.ok(
    ["recommended", "manual", "protected"].includes(item.recommendation),
  );
  assert.equal(typeof item.reason, "string");
  assert.ok(Array.isArray(item.processNames));
  assert.equal(typeof item.source, "string");
  assert.equal(typeof item.enabled, "boolean");
  if (item.recommendation === "protected") assert.equal(item.enabled, false);
}

test("static roots stay below trusted AppData/Local and preserve the fixed ages", () => {
  const roots = staticRoots(HOME);
  assert.deepEqual(
    roots.map((item) => item.path),
    [
      "C:\\Users\\catalog-fixture\\AppData\\Local\\Temp",
      "C:\\Users\\catalog-fixture\\AppData\\Local\\CrashDumps",
      "C:\\Users\\catalog-fixture\\AppData\\Local\\D3DSCache",
    ],
  );
  for (const item of roots) assertRootShape(item);
  assert.deepEqual(roots[0].extensions, [
    ".tmp",
    ".temp",
    ".log",
    ".dmp",
    ".etl",
    ".cache",
  ]);
  assert.equal(roots[0].daysOld, 7);
  assert.equal(roots[1].daysOld, 7);
  assert.equal(roots[1].kind, "log");
  assert.equal(roots[2].kind, "protected");
  assert.equal(roots[2].recommendation, "protected");
  assert.equal(roots[2].enabled, false);
  assert.equal(roots[2].daysOld, 0);
});

test("profile locations are fixed Local/Roaming registrations, never environment roots", () => {
  const locations = profileLocations(HOME);
  assert.deepEqual(
    locations.map((item) => item.id),
    ["chrome", "edge", "firefox", "vscode", "vscode-insiders", "npm", "pip"],
  );
  assert.equal(
    location("chrome").path,
    "C:\\Users\\catalog-fixture\\AppData\\Local\\Google\\Chrome\\User Data",
  );
  assert.equal(
    location("firefox").path,
    "C:\\Users\\catalog-fixture\\AppData\\Local\\Mozilla\\Firefox\\Profiles",
  );
  assert.equal(
    location("vscode").path,
    "C:\\Users\\catalog-fixture\\AppData\\Roaming\\Code",
  );
  assert.equal(
    location("npm").path,
    "C:\\Users\\catalog-fixture\\AppData\\Local\\npm-cache",
  );
  assert.equal(
    location("pip").path,
    "C:\\Users\\catalog-fixture\\AppData\\Local\\pip\\Cache",
  );
  for (const item of locations) {
    assert.ok(
      item.path.startsWith("C:\\Users\\catalog-fixture\\AppData\\Local\\") ||
        item.path.startsWith("C:\\Users\\catalog-fixture\\AppData\\Roaming\\"),
    );
  }
});

test("Chromium catalog is narrow, age-gated, and process-guarded", () => {
  for (const [id, processName] of [
    ["chrome", "chrome.exe"],
    ["edge", "msedge.exe"],
  ]) {
    const roots = rootsForProfile(location(id), "Profile 2");
    assert.equal(roots.length, 2);
    for (const item of roots) {
      assertRootShape(item);
      assert.equal(item.daysOld, 1);
      assert.deepEqual(item.processNames, [processName]);
      assert.match(item.path, /\\Profile 2\\(?:Cache\\Cache_Data|Code Cache)$/);
      assert.doesNotMatch(
        item.path,
        /Service Worker|Cookies|History|Login Data|Local Storage/,
      );
    }
  }
  const defaultRoots = rootsForProfile(location("chrome"), "Default");
  assert.ok(defaultRoots.every((item) => item.path.includes("\\Default\\")));
  assert.throws(() => rootsForProfile(location("chrome"), "Other"));
  assert.throws(() => rootsForProfile(location("chrome"), ".."));
  assert.throws(() => rootsForProfile(location("chrome"), "Profile x"));
});

test("Firefox only accepts a single registered Local profile component", () => {
  const [item] = rootsForProfile(location("firefox"), "abcd.default-release");
  assertRootShape(item);
  assert.equal(
    item.path,
    `${location("firefox").path}\\abcd.default-release\\cache2`,
  );
  assert.equal(item.daysOld, 1);
  assert.deepEqual(item.processNames, ["firefox.exe"]);
  assert.doesNotMatch(item.path, /Roaming/);
  for (const name of ["..", "a\\b", "a/b", "", ".", "profile?name"]) {
    assert.throws(() => rootsForProfile(location("firefox"), name));
  }
});

test("VS Code roots cover only logs and CachedData with the full process guards", () => {
  const code = rootsForProfile(location("vscode"));
  assert.deepEqual(
    code.map((item) => item.path),
    [
      `${location("vscode").path}\\logs`,
      `${location("vscode").path}\\CachedData`,
    ],
  );
  assert.deepEqual(
    code.map((item) => item.daysOld),
    [7, 7],
  );
  assert.equal(code[0].kind, "log");
  assert.equal(code[1].kind, "cache");
  assert.deepEqual(code[0].processNames, ["Code.exe"]);
  assert.ok(
    code.every(
      (item) =>
        !/^(?:\\User|\\Backups|\\settings|\\globalStorage)(?:\\|$)/i.test(
          item.path.slice(location("vscode").path.length),
        ),
    ),
  );

  const insiders = rootsForProfile(location("vscode-insiders"));
  assert.deepEqual(insiders[0].processNames, ["Code - Insiders.exe"]);
  assert.ok(insiders.every((item) => item.path.includes("Code - Insiders")));
  assert.throws(() => rootsForProfile(location("vscode"), "User"));
});

test("npm and pip roots are manual and match documented cache subdirectories", () => {
  const npm = rootsForProfile(location("npm"));
  assert.equal(npm.length, 1);
  assert.equal(npm[0].path, `${location("npm").path}\\_cacache`);
  assert.equal(npm[0].daysOld, 7);
  assert.equal(npm[0].recommendation, "manual");
  assert.deepEqual(npm[0].processNames, ["node.exe"]);

  const pip = rootsForProfile(location("pip"));
  assert.deepEqual(
    pip.map((item) => item.path),
    ["http", "http-v2", "wheels"].map(
      (name) => `${location("pip").path}\\${name}`,
    ),
  );
  assert.ok(
    pip.every((item) => item.daysOld === 7 && item.recommendation === "manual"),
  );
  assert.ok(
    pip.every((item) =>
      [
        "python.exe",
        "pythonw.exe",
        "python3.exe",
        "python3.14.exe",
        "pip.exe",
      ].every((name) => item.processNames.includes(name)),
    ),
  );
});

test("D3DSCache is protected and no catalog function traverses or deletes anything", () => {
  const roots = [
    ...staticRoots(HOME),
    ...rootsForProfile(location("chrome"), "Default"),
    ...rootsForProfile(location("firefox"), "abc.default"),
    ...rootsForProfile(location("vscode")),
    ...rootsForProfile(location("npm")),
    ...rootsForProfile(location("pip")),
  ];
  for (const item of roots) {
    assertRootShape(item);
    assert.equal(typeof item.path, "string");
  }
  assert.deepEqual(GROUPS.SHADER, { id: "shader", name: "Windows 着色器缓存" });
});

test("untrusted home values and forged location descriptors fail closed", () => {
  for (const home of [
    "",
    "relative\\home",
    "%LOCALAPPDATA%",
    "C:\\Users\\%USERNAME%",
    "C:\\Users\\$env:USERNAME",
    "\\\\server\\share\\user",
    "C:\\Users\\A\\..\\B",
  ]) {
    assert.throws(() => staticRoots(home));
    assert.throws(() => profileLocations(home));
  }
  const forged = {
    ...location("chrome"),
    path: "C:\\Users\\attacker\\Documents",
  };
  assert.throws(() => rootsForProfile(forged, "Default"));
});
