const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { protectedFile } = require("../electron/cleanup-safety.cjs");
const { createCleanupService } = require("../electron/cleanup.cjs");
const {
  createSafeTrashEngine,
  fingerprint,
} = require("../electron/safe-trash.cjs");
async function fixture(extra = {}) {
  // Windows os.tmpdir() is normally inside AppData, which is deliberately
  // forbidden for analysis-page recovery. Model a user home outside that
  // boundary instead of weakening production protection for test paths.
  const fixtureParent =
    process.platform === "win32"
      ? process.env.RUNNER_TEMP ||
        path.join(os.homedir(), ".mole-test-fixtures")
      : os.tmpdir();
  assert.ok(
    path.isAbsolute(fixtureParent) && !/^(\\\\|\/\/)/.test(fixtureParent),
    "Fixture parent must be an absolute local directory",
  );
  await fs.mkdir(fixtureParent, { recursive: true });
  const canonicalParent = await fs.realpath(fixtureParent);
  assert.equal(
    protectedFile(
      { path: canonicalParent },
      path.join(
        canonicalParent,
        "mole-cache-review-probe",
        "Documents",
        "fixture.pdf",
      ),
      [],
      { explicit: true },
    ),
    null,
    "Positive analysis fixtures must be outside production-protected directories",
  );
  const home = await fs.realpath(
      await fs.mkdtemp(path.join(canonicalParent, "mole-cache-review-")),
    ),
    time = { value: Date.now() + 10 * 86400000 },
    active = { names: [], ok: true },
    overrides = new Map(),
    moved = [];
  const inspectAttributes = async (paths) =>
    Promise.all(
      paths.map(async (p) => {
        try {
          const s = await fs.lstat(p);
          return {
            path: p,
            attributes: s.isSymbolicLink()
              ? 0x400
              : s.isDirectory()
                ? 0x10
                : 0x80,
            inUse: false,
            ...overrides.get(p),
          };
        } catch (error) {
          return {
            path: p,
            attributes: null,
            inUse: null,
            error: error.message,
            code: error.code === "ENOENT" ? "notFound" : "unavailable",
          };
        }
      }),
    );
  const trash = path.join(home, "fixture-recycle");
  await fs.mkdir(trash);
  const options = {
    platform: "win32",
    home,
    env: {},
    now: () => time.value,
    inspectAttributes,
    readActivity: async () => ({
      platform: "windows",
      ...active,
      warnings: [],
    }),
    trashItem: async (p) => {
      moved.push(p);
      await fs.rename(p, path.join(trash, path.basename(p)));
    },
    ...extra,
  };
  const write = async (relative, data = "fixture-only") => {
    const p = path.join(home, relative);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, data);
    return p;
  };
  return {
    home,
    time,
    active,
    overrides,
    moved,
    options,
    write,
    service: createCleanupService(options),
  };
}

test("real cache catalog includes payloads but never browser credentials or VSCode user data", async () => {
  const f = await fixture();
  const included = [];
  for (const relative of [
    "AppData/Local/Google/Chrome/User Data/Default/Cache/Cache_Data/opaque_0",
    "AppData/Local/Microsoft/Edge/User Data/Profile 2/Code Cache/js/hash_0",
    "AppData/Local/Mozilla/Firefox/Profiles/abc.default-release/cache2/entries/ABCDEF",
    "AppData/Roaming/Code/CachedData/version/cache.bin",
    "AppData/Roaming/Code/logs/session/main.log",
    "AppData/Local/npm-cache/_cacache/content-v2/sha512/abc",
    "AppData/Local/pip/Cache/http-v2/abc.body",
    "AppData/Local/pip/Cache/wheels/demo.whl",
  ])
    included.push(await f.write(relative));
  const protectedFiles = [];
  for (const relative of [
    "AppData/Local/Google/Chrome/User Data/Default/Cookies",
    "AppData/Local/Google/Chrome/User Data/Default/History",
    "AppData/Local/Google/Chrome/User Data/Default/Login Data",
    "AppData/Local/Google/Chrome/User Data/Default/Service Worker/CacheStorage/private",
    "AppData/Roaming/Code/User/settings.json",
    "AppData/Roaming/Code/Backups/recovery",
    "Documents/Temp/never.tmp",
    "AppData/Local/D3DSCache/shader.idx",
  ])
    protectedFiles.push(await f.write(relative));
  const plan = await f.service.preview();
  assert.deepEqual(new Set(plan.items.map((i) => i.path)), new Set(included));
  assert.ok(
    plan.items.every(
      (i) => typeof i.recommended === "boolean" && i.groupId && i.groupName,
    ),
  );
  assert.ok(
    plan.items
      .filter((i) => ["npm", "pip"].includes(i.groupId))
      .every((i) => !i.recommended),
  );
  assert.equal(
    plan.groups.find((g) => g.id === "shader").roots[0].status,
    "protected",
  );
  assert.equal(plan.partial, true);
  assert.equal(f.moved.length, 0);
  for (const p of protectedFiles)
    assert.equal(await fs.readFile(p, "utf8"), "fixture-only");
});

test("running or unknown owner disables its cache, and owners are rechecked at execution", async () => {
  const f = await fixture();
  await f.write(
    "AppData/Local/Google/Chrome/User Data/Default/Cache/Cache_Data/cache",
  );
  f.active.names = ["CHROME.EXE"];
  let plan = await f.service.preview();
  assert.equal(plan.items.length, 0);
  assert.equal(plan.partial, true);
  f.active.names = [];
  f.active.ok = false;
  plan = await f.service.preview();
  assert.equal(plan.items.length, 0);
  f.active.ok = true;
  plan = await f.service.preview();
  assert.equal(plan.items.length, 1);
  f.active.names = ["chrome.exe"];
  const result = await f.service.execute(plan.id, [plan.items[0].id]);
  assert.equal(result.results[0].status, "failed");
  assert.equal(f.moved.length, 0);
});

test("pagination continues past the initial limit with honest observed totals and rejects reused tokens", async () => {
  const f = await fixture({ testPageSize: 2 });
  for (let i = 0; i < 7; i++)
    await f.write(`AppData/Local/Temp/file-${i}.tmp`, "123");
  const paths = [],
    progress = [];
  let plan = await f.service.preview({ onProgress: (p) => progress.push(p) }),
    first = plan;
  assert.equal(plan.items.length, 2);
  assert.equal(plan.partial, true);
  assert.equal(plan.hasMore, true);
  while (true) {
    paths.push(...plan.items.map((i) => i.path));
    if (!plan.hasMore) break;
    const cursor = plan.nextCursor;
    plan = await f.service.preview({
      cursor,
      onProgress: (p) => progress.push(p),
    });
    await assert.rejects(f.service.preview({ cursor }), /令牌/);
  }
  assert.equal(paths.length, 7);
  assert.equal(new Set(paths).size, 7);
  assert.equal(plan.summary.eligibleBytes, 21);
  assert.equal(plan.summary.complete, true);
  assert.ok(progress.length > 0);
  await assert.rejects(
    f.service.execute(first.id, [first.items[0].id]),
    /过期/,
  );
});

test("native attributes and active owners are refreshed when resuming a page", async () => {
  const f = await fixture({ testPageSize: 1 });
  for (let i = 0; i < 3; i++)
    await f.write(
      `AppData/Local/Google/Chrome/User Data/Default/Cache/Cache_Data/cache-${i}`,
    );
  const plan = await f.service.preview();
  assert.equal(plan.items.length, 1);
  f.active.names = ["chrome.exe"];
  const next = await f.service.preview({ cursor: plan.nextCursor });
  assert.equal(next.items.length, 0);
  assert.equal(next.partial, true);
  assert.equal(f.moved.length, 0);
});

test("abort signal stops preview and a continuation expires exactly at its deadline", async () => {
  const f = await fixture({ testPageSize: 1 });
  for (let i = 0; i < 3; i++) await f.write(`AppData/Local/Temp/${i}.tmp`);
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(f.service.preview({ signal: abort.signal }), /取消/);
  const plan = await f.service.preview();
  f.time.value += 5 * 60000;
  await assert.rejects(f.service.preview({ cursor: plan.nextCursor }), /过期/);
  assert.equal(f.moved.length, 0);
});

test("never-clean protection is persistent, precise and removable only by its stored ID", async () => {
  const f = await fixture();
  const a = await f.write("AppData/Local/Temp/a.tmp"),
    b = await f.write("AppData/Local/Temp/b.tmp");
  const plan = await f.service.preview();
  const record = await f.service.protect(
    plan.id,
    plan.items.find((i) => i.path === a).id,
  );
  assert.equal(record.path, a);
  assert.ok(record.removable);
  assert.equal((await f.service.listProtected()).length, 1);
  const restarted = createCleanupService(f.options);
  let next = await restarted.preview();
  assert.deepEqual(
    next.items.map((i) => i.path),
    [b],
  );
  await assert.rejects(restarted.removeProtected(a), /ID/);
  await assert.rejects(restarted.removeProtected("builtin:system"), /ID/);
  await restarted.removeProtected(record.id);
  next = await restarted.preview();
  assert.deepEqual(new Set(next.items.map((i) => i.path)), new Set([a, b]));
  assert.equal(f.moved.length, 0);
});

test("corrupt persistent protection storage blocks preview instead of bypassing protection", async () => {
  const f = await fixture();
  const p = await f.write("AppData/Local/Temp/keep.tmp");
  const plan = await f.service.preview();
  await f.service.protect(plan.id, plan.items.find((i) => i.path === p).id);
  const state = path.join(
    f.home,
    ".config",
    "mole",
    "desktop-protection",
    "protected-paths.json",
  );
  await fs.writeFile(state, '{"version":1,"items":');
  await assert.rejects(f.service.preview(), /损坏/);
  assert.equal(f.moved.length, 0);
});

test("protection writer rejects a directory link instead of writing through it", async () => {
  const f = await fixture();
  const p = await f.write("AppData/Local/Temp/keep.tmp");
  const plan = await f.service.preview();
  const outside = path.join(f.home, "outside");
  await fs.mkdir(outside);
  const config = path.join(f.home, ".config");
  await fs.mkdir(config);
  const link = path.join(config, "mole");
  await fs.symlink(
    outside,
    link,
    process.platform === "win32" ? "junction" : "dir",
  );
  await assert.rejects(
    f.service.protect(plan.id, plan.items.find((i) => i.path === p).id),
    /重定向|保护/,
  );
  assert.deepEqual(await fs.readdir(outside), []);
  assert.equal(f.moved.length, 0);
});

test("a persisted record replaced by a symlink or stale lock blocks future cleanup", async () => {
  const f = await fixture();
  await f.write("AppData/Local/Temp/keep.tmp");
  let plan = await f.service.preview();
  await f.service.protect(plan.id, plan.items[0].id);
  const dir = path.join(f.home, ".config", "mole", "desktop-protection"),
    state = path.join(dir, "protected-paths.json"),
    preserved = path.join(f.home, "preserved.json");
  await fs.rename(state, preserved);
  if (process.platform === "win32") await fs.link(preserved, state);
  else await fs.symlink(preserved, state);
  await assert.rejects(f.service.preview(), /普通文件|属性|重定向/);
  assert.equal(f.moved.length, 0);
  // The dangling transaction lock is never silently cleared as if a write succeeded.
  const fresh = await fixture();
  await fresh.write("AppData/Local/Temp/keep.tmp");
  const lockDir = path.join(
    fresh.home,
    ".config",
    "mole",
    "desktop-protection",
  );
  await fs.mkdir(lockDir, { recursive: true });
  await fs.writeFile(
    path.join(lockDir, "protection-write.lock"),
    "interrupted",
  );
  await assert.rejects(fresh.service.preview(), /未完成|写入/);
  assert.equal(fresh.moved.length, 0);
});

test("replacing a directory between pages stops that root with explicit partial status", async () => {
  const f = await fixture({ testPageSize: 1 });
  const root = path.join(f.home, "AppData", "Local", "Temp");
  for (let i = 0; i < 3; i++) await f.write(`AppData/Local/Temp/${i}.tmp`);
  const plan = await f.service.preview();
  await fs.rename(root, root + "-original");
  await fs.mkdir(root);
  await fs.writeFile(path.join(root, "1.tmp"), "must-not-be-adopted");
  const next = await f.service.preview({ cursor: plan.nextCursor });
  assert.equal(next.items.length, 0);
  assert.equal(next.partial, true);
  assert.equal(f.moved.length, 0);
});

test("analysis-file recovery remains confined to explicit snapshot IDs and moves only the fixture", async () => {
  const f = await fixture();
  const p = await f.write("Documents/selected.pdf"),
    other = await f.write("Documents/keep.pdf");
  const s = await fs.lstat(p, { bigint: true });
  const engine = createSafeTrashEngine({
    ...f.options,
    authorizeSelection: async () => [
      {
        id: "selected",
        path: p,
        root: path.dirname(p),
        identity: fingerprint(s),
        size: Number(s.size),
      },
    ],
  });
  const plan = await engine.preview(["selected"]);
  assert.equal(plan.items[0].enabled, true, plan.items[0].reason);
  const result = await engine.execute(plan.id, [plan.items[0].id]);
  assert.equal(result.results[0].status, "success");
  assert.deepEqual(f.moved, [p]);
  assert.equal(await fs.readFile(other, "utf8"), "fixture-only");
});

test("analysis engine accepts only server snapshot IDs, detects replacements and rejects directories", async () => {
  const f = await fixture();
  const root = path.join(f.home, "Documents");
  const p = await f.write("Documents/report.pdf");
  const stat = await fs.lstat(p, { bigint: true });
  const snapshots = [
    {
      id: "entry-1",
      path: p,
      root,
      size: Number(stat.size),
      mtimeMs: Number(stat.mtimeMs),
      identity: fingerprint(stat),
    },
  ];
  const engine = createSafeTrashEngine({
    ...f.options,
    authorizeSelection: async (ids) =>
      snapshots.filter((s) => ids.includes(s.id)),
  });
  await assert.rejects(engine.preview([p]), /快照/);
  let plan = await engine.preview(["entry-1"]);
  assert.equal(plan.items[0].enabled, true, plan.items[0].reason);
  assert.equal(plan.items[0].recommended, false);
  await fs.writeFile(p, "replacement");
  const result = await engine.execute(plan.id, [plan.items[0].id]);
  assert.equal(result.results[0].status, "failed");
  assert.equal(f.moved.length, 0);
  plan = await engine.preview(["entry-1"]);
  assert.equal(plan.items[0].enabled, false);
  assert.match(plan.items[0].reason, /身份/);
  const folder = path.join(root, "folder");
  await fs.mkdir(folder);
  snapshots.push({ id: "folder", path: folder, root });
  plan = await engine.preview(["folder"]);
  assert.equal(plan.items[0].protectedFolder, true);
});

test("analysis and cache actions share custom protection and reject unknown in-use metadata", async () => {
  const f = await fixture();
  const p = await f.write("Documents/notes.txt"),
    root = path.dirname(p),
    s = await fs.lstat(p, { bigint: true });
  const engine = createSafeTrashEngine({
    ...f.options,
    authorizeSelection: async () => [
      { id: "id", path: p, root, identity: fingerprint(s) },
    ],
  });
  let plan = await engine.preview(["id"]);
  assert.equal(plan.items[0].enabled, true, plan.items[0].reason);
  await engine.protect(plan.id, plan.items[0].id);
  assert.equal((await f.service.listProtected())[0].path, p);
  plan = await engine.preview(["id"]);
  assert.equal(plan.items[0].enabled, false);
  await engine.removeProtected((await engine.listProtected())[0].id);
  f.overrides.set(p, { inUse: null });
  plan = await engine.preview(["id"]);
  assert.equal(plan.items[0].enabled, false);
  assert.match(plan.items[0].reason, /占用/);
});

test("analysis still rejects AppData files even inside an authorized fixture home", async () => {
  const f = await fixture();
  const target = await f.write("AppData/Local/Temp/forbidden.tmp");
  const stat = await fs.lstat(target, { bigint: true });
  const engine = createSafeTrashEngine({
    ...f.options,
    authorizeSelection: async () => [
      {
        id: "appdata-file",
        path: target,
        root: f.home,
        identity: fingerprint(stat),
        size: Number(stat.size),
      },
    ],
  });
  const plan = await engine.preview(["appdata-file"]);
  assert.equal(plan.items[0].enabled, false);
  assert.match(plan.items[0].reason, /系统、应用资料或敏感目录/);
  await assert.rejects(engine.execute(plan.id, [plan.items[0].id]), /已授权/);
  assert.equal(await fs.readFile(target, "utf8"), "fixture-only");
  assert.equal(f.moved.length, 0);
});

test("completed protection receipt survives blocked housekeeping and can be retired safely", async () => {
  const f = await fixture();
  const p = await f.write("AppData/Local/Temp/keep.tmp");
  const plan = await f.service.preview();
  const lock = path.join(
    f.home,
    ".config",
    "mole",
    "desktop-protection",
    "protection-write.lock",
  );
  const unlink = fs.unlink;
  fs.unlink = async (filename) => {
    if (filename === lock)
      throw Object.assign(new Error("simulated AV sharing conflict"), {
        code: "EPERM",
      });
    return unlink(filename);
  };
  let record;
  try {
    record = await f.service.protect(plan.id, plan.items[0].id);
  } finally {
    fs.unlink = unlink;
  }
  assert.equal(record.path, p);
  assert.ok(await fs.stat(lock));
  const restarted = createCleanupService(f.options);
  assert.equal((await restarted.listProtected()).length, 1);
  assert.equal((await restarted.preview()).items.length, 0);
  await restarted.removeProtected(record.id);
  assert.equal((await restarted.listProtected()).length, 0);
  await assert.rejects(fs.stat(lock), { code: "ENOENT" });
});

test("pending cleanup failure still attempts lock release and never touches unknown files", async () => {
  const f = await fixture();
  await f.write("AppData/Local/Temp/keep.tmp");
  const plan = await f.service.preview();
  const dir = path.join(f.home, ".config", "mole", "desktop-protection"),
    state = path.join(dir, "protected-paths.json"),
    lock = path.join(dir, "protection-write.lock");
  const rename = fs.rename,
    unlink = fs.unlink;
  fs.rename = async (from, to) => {
    if (to === state)
      throw Object.assign(new Error("simulated atomic publish failure"), {
        code: "EIO",
      });
    return rename(from, to);
  };
  fs.unlink = async (filename) => {
    if (filename.startsWith(dir) && filename.endsWith(".pending"))
      throw Object.assign(new Error("simulated pending sharing conflict"), {
        code: "EPERM",
      });
    return unlink(filename);
  };
  try {
    await assert.rejects(
      f.service.protect(plan.id, plan.items[0].id),
      /pending|sharing/,
    );
  } finally {
    fs.rename = rename;
    fs.unlink = unlink;
  }
  await assert.rejects(fs.stat(lock), { code: "ENOENT" });
  await assert.rejects(fs.stat(state), { code: "ENOENT" });
  assert.ok((await fs.readdir(dir)).some((name) => name.endsWith(".pending")));
  assert.equal(f.moved.length, 0);
});

test("analysis never offers its own protection database or whitelist for recycling", async () => {
  const f = await fixture();
  const p = await f.write(
    ".config/mole/whitelist.txt",
    "# fixture configuration",
  );
  const s = await fs.lstat(p, { bigint: true });
  const engine = createSafeTrashEngine({
    ...f.options,
    authorizeSelection: async () => [
      { id: "config", path: p, root: f.home, identity: fingerprint(s) },
    ],
  });
  const plan = await engine.preview(["config"]);
  assert.equal(plan.items[0].enabled, false);
  assert.equal(f.moved.length, 0);
});
