const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const {
  createCleanupService,
  createNativeInspector,
  compileWhitelist,
} = require("../electron/cleanup.cjs");

const DAY = 86400000;
async function fixture(options = {}) {
  const home = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "mole-cleanup-test-")),
  );
  const root = path.join(home, "Temp");
  const trash = path.join(home, "test-recycle-bin");
  await fs.mkdir(root);
  await fs.mkdir(trash);
  const now = { value: Date.now() + 10 * DAY };
  const attributes = new Map();
  const moved = [];
  const inspector = async (paths) =>
    Promise.all(
      paths.map(async (target) => {
        try {
          const stat = await fs.lstat(target);
          const flags =
            attributes.get(target) ??
            (stat.isSymbolicLink() ? 0x400 : stat.isDirectory() ? 0x10 : 0x80);
          return { path: target, attributes: flags };
        } catch (error) {
          return { path: target, attributes: null, error: error.message };
        }
      }),
    );
  const service = createCleanupService({
    platform: "win32",
    home,
    env: {},
    now: () => now.value,
    testRoots: [
      {
        id: "test-temp",
        name: "测试缓存",
        path: root,
        extensions: [".tmp", ".log"],
        daysOld: 7,
      },
    ],
    inspectAttributes: inspector,
    trashItem: async (target) => {
      moved.push(target);
      await fs.rename(target, path.join(trash, path.basename(target)));
    },
    ...options,
  });
  async function file(name, data = "test-only") {
    const target = path.join(root, name);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, data);
    return target;
  }
  return {
    home,
    root,
    trash,
    now,
    attributes,
    moved,
    inspector,
    service,
    file,
  };
}

test("preview is read-only and only known old cache files are eligible", async () => {
  const f = await fixture();
  const old = await f.file("old.tmp"),
    recent = await f.file("recent.tmp");
  await f.file("personal.docx");
  await f.file("private.key.tmp");
  await f.file("draft.docx.tmp");
  await f.file(".git/cache.tmp");
  await fs.utimes(recent, new Date(f.now.value), new Date(f.now.value));
  const before = await fs.readFile(old, "utf8");
  const plan = await f.service.preview();
  assert.deepEqual(
    plan.items.map((i) => i.name),
    ["old.tmp"],
  );
  assert.equal(await fs.readFile(old, "utf8"), before);
  assert.equal(f.moved.length, 0);
  assert.equal(plan.items[0].enabled, true);
});

test("production LOCALAPPDATA cannot redirect cleanup into Documents or other roots", async () => {
  const f = await fixture();
  const documents = path.join(f.home, "Documents");
  const privateFile = path.join(documents, "Temp", "old.tmp");
  await fs.mkdir(path.dirname(privateFile), { recursive: true });
  await fs.writeFile(privateFile, "important-user-data");
  let inspections = 0,
    mutations = 0;
  for (const local of [
    documents,
    f.home,
    path.join(f.home, "Downloads"),
    path.join(f.home, "AppData", "Roaming"),
    "AppData/Local",
    "",
  ]) {
    const service = createCleanupService({
      platform: "win32",
      home: f.home,
      env: { LOCALAPPDATA: local },
      now: () => f.now.value,
      inspectAttributes: async (paths) => {
        inspections++;
        return f.inspector(paths);
      },
      trashItem: async () => {
        mutations++;
      },
    });
    await assert.rejects(service.preview(), /规范 AppData\/Local/);
  }
  assert.equal(inspections, 0);
  assert.equal(mutations, 0);
  assert.equal(await fs.readFile(privateFile, "utf8"), "important-user-data");
});

test("production defaults use only the trusted home AppData Local cache", async () => {
  const f = await fixture();
  const local = path.join(f.home, "AppData", "Local");
  const cacheFile = path.join(local, "Temp", "old.tmp");
  const privateFile = path.join(f.home, "Documents", "Temp", "old.tmp");
  for (const target of [cacheFile, privateFile]) {
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, "preserve-until-confirmed");
  }
  for (const env of [
    {},
    { LOCALAPPDATA: local, USERPROFILE: path.join(f.home, "Documents") },
  ]) {
    const service = createCleanupService({
      platform: "win32",
      home: f.home,
      env,
      now: () => f.now.value,
      inspectAttributes: f.inspector,
      trashItem: async () => assert.fail("preview must not mutate"),
    });
    const plan = await service.preview();
    assert.deepEqual(
      plan.items.map((item) => item.path),
      [cacheFile],
    );
  }
  assert.equal(
    await fs.readFile(privateFile, "utf8"),
    "preserve-until-confirmed",
  );
});

test("Windows production requires an explicit trusted home instead of environment inference", async () => {
  const f = await fixture();
  let calls = 0;
  const service = createCleanupService({
    platform: "win32",
    env: {
      USERPROFILE: f.home,
      LOCALAPPDATA: path.join(f.home, "AppData", "Local"),
    },
    inspectAttributes: async () => {
      calls++;
      return [];
    },
    trashItem: async () => assert.fail("must not mutate"),
  });
  await assert.rejects(service.preview(), /主进程提供/);
  assert.equal(calls, 0);
});

test("only selected IDs move to injected fixture trash; plans cannot replay", async () => {
  const f = await fixture();
  const a = await f.file("a.tmp"),
    b = await f.file("b.tmp");
  const plan = await f.service.preview();
  const item = plan.items.find((i) => i.path === a);
  const result = await f.service.execute(plan.id, [item.id]);
  assert.equal(result.results[0].status, "success");
  assert.deepEqual(f.moved, [a]);
  await assert.rejects(fs.stat(a), { code: "ENOENT" });
  assert.equal(await fs.readFile(b, "utf8"), "test-only");
  assert.equal(
    await fs.readFile(path.join(f.trash, "a.tmp"), "utf8"),
    "test-only",
  );
  await assert.rejects(f.service.execute(plan.id, [item.id]), /过期/);
});

test("forged paths, duplicate IDs and exact expiry are rejected without mutations", async () => {
  const f = await fixture();
  const target = await f.file("a.tmp");
  const plan = await f.service.preview();
  const id = plan.items[0].id;
  for (const ids of [[target], [id, id], [], ["forged"]])
    await assert.rejects(f.service.execute(plan.id, ids));
  f.now.value = Date.parse(plan.expiresAt);
  await assert.rejects(f.service.execute(plan.id, [id]), /过期/);
  assert.equal(f.moved.length, 0);
});

test("modified, replaced, hard-linked and directory-swapped files are preserved", async () => {
  const f = await fixture();
  const target = await f.file("a.tmp");
  let plan = await f.service.preview();
  await fs.writeFile(target, "changed");
  let result = await f.service.execute(plan.id, [plan.items[0].id]);
  assert.equal(result.results[0].status, "failed");
  plan = await f.service.preview();
  await fs.rename(target, path.join(f.home, "original.tmp"));
  await fs.mkdir(target);
  result = await f.service.execute(plan.id, [plan.items[0].id]);
  assert.equal(result.results[0].status, "failed");
  const linked = await f.file("linked.tmp");
  await fs.link(linked, path.join(f.home, "second-link.tmp"));
  plan = await f.service.preview();
  assert.equal(
    plan.items.some((i) => i.path === linked),
    false,
  );
  assert.equal(f.moved.length, 0);
});

test("native reparse/offline/recall flags and missing attributes fail closed", async () => {
  const f = await fixture();
  for (const [i, flags] of [
    0x400, 0x1000, 0x40000, 0x400000, 0x1, 0x4,
  ].entries())
    f.attributes.set(await f.file(`blocked-${i}.tmp`), flags);
  const good = await f.file("good.tmp");
  const plan = await f.service.preview();
  assert.deepEqual(
    plan.items.map((i) => i.path),
    [good],
  );
  f.attributes.set(good, 0x400000);
  const result = await f.service.execute(plan.id, [plan.items[0].id]);
  assert.equal(result.results[0].status, "failed");
  assert.equal(f.moved.length, 0);
  const broken = await fixture({ inspectAttributes: async () => [] });
  await broken.file("old.tmp");
  assert.equal((await broken.service.preview()).items.length, 0);
});

test("ancestor reparse flags block preview and changes after preview block execute", async () => {
  const f = await fixture();
  const target = await f.file("sub/a.tmp");
  const parent = path.dirname(target);
  f.attributes.set(parent, 0x410);
  assert.equal((await f.service.preview()).items.length, 0);
  f.attributes.delete(parent);
  const plan = await f.service.preview();
  f.attributes.set(parent, 0x410);
  const result = await f.service.execute(plan.id, [plan.items[0].id]);
  assert.equal(result.results[0].status, "failed");
  assert.equal(f.moved.length, 0);
});

test("OS links and Windows junctions never expose outside files as candidates", async (t) => {
  const f = await fixture();
  const outside = path.join(f.home, "outside");
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, "private.tmp"), "keep");
  const link = path.join(f.root, "junction");
  if (process.platform === "win32")
    await promisify(execFile)("cmd.exe", ["/c", "mklink", "/J", link, outside]);
  else await fs.symlink(outside, link);
  if (process.platform === "win32") f.attributes.set(link, 0x410);
  const plan = await f.service.preview();
  assert.equal(plan.items.length, 0);
  assert.equal(
    await fs.readFile(path.join(outside, "private.tmp"), "utf8"),
    "keep",
  );
});

test("whitelist protects children and is reread immediately before execution", async () => {
  const f = await fixture();
  const a = await f.file("sub/a.tmp");
  const b = await f.file("b.tmp");
  const config = path.join(f.home, ".config", "mole");
  await fs.mkdir(config, { recursive: true });
  const list = path.join(config, "whitelist.txt");
  await fs.writeFile(list, path.dirname(a));
  const plan = await f.service.preview();
  assert.deepEqual(
    plan.items.map((i) => i.path),
    [b],
  );
  await fs.appendFile(list, "\n" + b);
  const result = await f.service.execute(plan.id, [plan.items[0].id]);
  assert.equal(result.results[0].status, "failed");
  assert.equal(f.moved.length, 0);
  await fs.writeFile(list, Buffer.from("\ufeff" + f.root, "utf16le"));
  assert.equal((await f.service.preview()).items.length, 0);
  await fs.writeFile(list, "[unsupported]");
  await assert.rejects(f.service.preview(), /不支持/);
});

test("glob whitelist expands known variables without broadening deletion", () => {
  const rules = compileWhitelist(
    ["# comment", "%USERPROFILE%/Temp/keep*", "$env:LOCALAPPDATA/blocked"],
    {
      USERPROFILE: "C:/Users/Test",
      LOCALAPPDATA: "C:/Users/Test/AppData/Local",
    },
  );
  assert.ok(rules[0].test("c:/users/test/temp/keep-me/a.tmp"));
  assert.ok(rules[1].test("C:/Users/Test/AppData/Local/blocked/a.tmp"));
  assert.throws(() => compileWhitelist(["%UNKNOWN%/x"], {}), /未知/);
});

test("recycle-bin failure has no permanent-delete fallback", async () => {
  const f = await fixture({
    trashItem: async () => {
      throw new Error("recycle unavailable");
    },
  });
  const target = await f.file("keep.tmp");
  const plan = await f.service.preview();
  const result = await f.service.execute(plan.id, [plan.items[0].id]);
  assert.equal(result.results[0].status, "failed");
  assert.match(result.results[0].message, /未改用永久删除/);
  assert.equal(await fs.readFile(target, "utf8"), "test-only");
});

test("dry-run and non-Windows platforms cannot modify fixtures", async () => {
  const f = await fixture({ env: { MOLE_DRY_RUN: "1" } });
  await f.file("keep.tmp");
  const plan = await f.service.preview();
  const result = await f.service.execute(plan.id, [plan.items[0].id]);
  assert.equal(result.results[0].status, "skipped");
  assert.equal(f.moved.length, 0);
  const unsupported = createCleanupService({ platform: "darwin" });
  await assert.rejects(unsupported.preview(), /Windows/);
});

test("cancel/close during validation stops all not-yet-started trash calls", async () => {
  const f = await fixture();
  await f.file("keep.tmp");
  let cancelOnInspect = false;
  const service = createCleanupService({
    platform: "win32",
    home: f.home,
    env: {},
    now: () => f.now.value,
    testRoots: [{ id: "test", name: "测试", path: f.root }],
    inspectAttributes: async (paths) => {
      const rows = await f.inspector(paths);
      if (cancelOnInspect) service.close();
      return rows;
    },
    trashItem: async () => assert.fail("trash must not run after close"),
  });
  const plan = await service.preview();
  cancelOnInspect = true;
  const result = await service.execute(plan.id, [plan.items[0].id]);
  assert.notEqual(result.results[0].status, "success");
  await assert.rejects(service.preview(), /关闭/);
});

test(
  "Windows native collector inspects fixture metadata without PowerShell",
  { skip: process.platform !== "win32" },
  async () => {
    const root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "mole-native-inspect-")),
    );
    const file = path.join(root, "file.tmp");
    await fs.writeFile(file, "native-fixture");
    const inspect = createNativeInspector(
      path.resolve(__dirname, "../resources/desktop-agent.exe"),
    );
    const rows = await inspect([root, file]);
    assert.ok(rows[0].attributes & 0x10);
    assert.equal(rows[1].attributes & 0x10, 0);
    assert.equal(await fs.readFile(file, "utf8"), "native-fixture");
  },
);

test("trash timeout is unknown, stops the batch and locks subsequent writes", async () => {
  let calls = 0;
  const f = await fixture({
    trashTimeoutMs: 10,
    trashItem: () => {
      calls++;
      return new Promise(() => {});
    },
  });
  await f.file("a.tmp");
  await f.file("b.tmp");
  const plan = await f.service.preview();
  const result = await f.service.execute(
    plan.id,
    plan.items.map((i) => i.id),
  );
  assert.deepEqual(
    result.results.map((r) => r.status),
    ["unknown", "skipped"],
  );
  assert.equal(calls, 1);
  await assert.rejects(f.service.preview(), { code: "OUTCOME_UNKNOWN" });
});

test("native rejection after moving a fixture is not reported as a clean failure", async () => {
  let f;
  f = await fixture({
    trashItem: async (target) => {
      await fs.rename(target, path.join(f.trash, path.basename(target)));
      throw new Error("late failure");
    },
  });
  await f.file("a.tmp");
  const plan = await f.service.preview();
  const result = await f.service.execute(plan.id, [plan.items[0].id]);
  assert.equal(result.results[0].status, "unknown");
  await assert.rejects(f.service.preview(), { code: "OUTCOME_UNKNOWN" });
});
