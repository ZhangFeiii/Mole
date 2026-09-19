const fs = require("node:fs/promises");
const { constants } = require("node:fs");
const path = require("node:path");
const { randomUUID, createHash } = require("node:crypto");
const {
  normalize,
  chainOf,
  fingerprint,
  directorySnapshot,
  requireSafeAttributes,
} = require("./cleanup-safety.cjs");

const MAX_BYTES = 1024 * 1024;
const hash = (value) => createHash("sha256").update(value).digest("hex");
const ACTIVE_TRANSACTIONS = new Set();
const stateDigest = (items) =>
  hash(
    JSON.stringify(
      items
        .map(({ id, path, createdAt, source }) => ({
          id,
          path,
          createdAt,
          source,
        }))
        .sort((a, b) => a.id.localeCompare(b.id)),
    ),
  );
async function exists(filename) {
  try {
    await fs.lstat(filename);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

// Storage location is fixed by trusted main code. Its API accepts already
// authorized plan entries or stored IDs, never a renderer-supplied filename.
function createProtectionStore({ directory, inspect, now = Date.now }) {
  if (!path.isAbsolute(directory || "") || /^(\\\\|\/\/)/.test(directory))
    throw new Error("保护记录需要固定本地目录");
  const statePath = path.join(directory, "protected-paths.json"),
    lockPath = path.join(directory, "protection-write.lock");
  let memo,
    observed = false;
  async function ensureDirectory(create = false) {
    for (const current of chainOf(directory)) {
      let s;
      try {
        s = await fs.lstat(current, { bigint: true });
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        if (!create) return false;
        await directorySnapshot(path.dirname(current), inspect);
        await fs.mkdir(current, { mode: 0o700 });
        s = await fs.lstat(current, { bigint: true });
      }
      if (!s.isDirectory() || s.isSymbolicLink())
        throw new Error("保护目录发生重定向");
      const native = await inspect([current]);
      requireSafeAttributes(native.get(current), true);
      if (normalize(await fs.realpath(current)) !== normalize(current))
        throw new Error("保护目录不再位于固定位置");
    }
    return true;
  }
  function validate(data) {
    if (
      !data ||
      data.version !== 1 ||
      !Array.isArray(data.items) ||
      data.items.length > 2000
    )
      throw new Error("保护记录格式损坏");
    const ids = new Set();
    for (const item of data.items) {
      if (
        !item ||
        typeof item.path !== "string" ||
        !path.isAbsolute(item.path) ||
        /[\x00-\x1f]/.test(item.path) ||
        item.path.length > 32767 ||
        item.id !== hash(normalize(item.path)) ||
        ids.has(item.id) ||
        !Number.isFinite(Date.parse(item.createdAt)) ||
        !["cleanup", "analysis"].includes(item.source)
      )
        throw new Error("保护记录包含无效项目");
      ids.add(item.id);
    }
    return data.items.map((item) => ({
      id: item.id,
      path: item.path,
      createdAt: item.createdAt,
      source: item.source,
      removable: true,
    }));
  }
  async function committedReceipt() {
    const s = await fs.lstat(lockPath, { bigint: true });
    if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1n || s.size > 4096n)
      throw new Error("保护事务锁不是可识别的普通文件");
    const native = await inspect([lockPath]);
    requireSafeAttributes(native.get(lockPath), false, {
      allowInUse: true,
      allowReadonly: true,
    });
    const handle = await fs.open(
      lockPath,
      constants.O_RDONLY | (constants.O_NOFOLLOW || 0),
    );
    let receipt;
    try {
      if (fingerprint(await handle.stat({ bigint: true })) !== fingerprint(s))
        throw new Error("保护事务锁身份变化");
      const bytes = await handle.readFile();
      if (bytes.length > 4096) throw new Error("事务锁过大");
      receipt = JSON.parse(
        new TextDecoder("utf8", { fatal: true }).decode(bytes),
      );
      if (fingerprint(await handle.stat({ bigint: true })) !== fingerprint(s))
        throw new Error("保护事务锁在读取中变化");
    } catch (error) {
      throw new Error(`保护记录可能正在写入或上次未完成：${error.message}`);
    } finally {
      await handle.close();
    }
    if (
      receipt.version !== 1 ||
      receipt.status !== "committed" ||
      typeof receipt.id !== "string" ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(
        receipt.id,
      ) ||
      !/^[a-f0-9]{64}$/.test(receipt.digest || "")
    )
      throw new Error("保护记录可能正在写入或上次未完成，已停止清理");
    await fs.lstat(statePath);
    const items = await read({ ignoreLock: true });
    if (stateDigest(items) !== receipt.digest)
      throw new Error("保护提交回执与记录不一致，已停止清理");
    return { receipt, identity: fingerprint(s) };
  }
  async function read({ ignoreLock = false } = {}) {
    if (!(await ensureDirectory())) {
      if (observed) throw new Error("保护记录目录意外消失，已停止清理");
      return [];
    }
    if (!ignoreLock && (await exists(lockPath))) await committedReceipt();
    let s;
    try {
      s = await fs.lstat(statePath, { bigint: true });
      observed = true;
    } catch (error) {
      if (error.code === "ENOENT") {
        if (observed) throw new Error("保护记录意外消失，已停止清理");
        memo = undefined;
        return [];
      }
      throw error;
    }
    if (
      !s.isFile() ||
      s.isSymbolicLink() ||
      s.nlink !== 1n ||
      s.size > BigInt(MAX_BYTES)
    )
      throw new Error("保护记录不是有效的普通文件");
    const native = await inspect([statePath]);
    requireSafeAttributes(native.get(statePath), false, {
      allowInUse: true,
      allowReadonly: true,
    });
    const signature = fingerprint(s);
    if (memo?.signature === signature) return structuredClone(memo.items);
    const handle = await fs.open(
      statePath,
      constants.O_RDONLY | (constants.O_NOFOLLOW || 0),
    );
    try {
      const bound = await handle.stat({ bigint: true });
      if (fingerprint(bound) !== signature)
        throw new Error("保护记录在读取前变化");
      const raw = await handle.readFile();
      if (raw.length > MAX_BYTES) throw new Error("保护记录过大");
      const after = await handle.stat({ bigint: true });
      if (fingerprint(after) !== signature)
        throw new Error("保护记录在读取中变化");
      let data;
      try {
        data = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(raw),
        );
      } catch {
        throw new Error("保护记录编码或JSON损坏");
      }
      const items = validate(data);
      memo = { signature, items };
      return structuredClone(items);
    } finally {
      await handle.close();
    }
  }
  async function safeRemoveOwned(filename, identity, parentIdentity) {
    const chain = await directorySnapshot(directory, inspect);
    let current;
    try {
      current = await fs.lstat(filename, { bigint: true });
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    if (
      chain.at(-1).identity !== parentIdentity ||
      fingerprint(current) !== identity ||
      current.isSymbolicLink()
    )
      throw new Error("保护事务文件身份变化，保留现场");
    await fs.unlink(filename);
  }
  async function mutate(change) {
    await ensureDirectory(true);
    const before = await directorySnapshot(directory, inspect),
      parentIdentity = before.at(-1).identity;
    if (await exists(lockPath)) {
      const terminal = await committedReceipt();
      if (ACTIVE_TRANSACTIONS.has(terminal.receipt.id))
        throw new Error("另一个保护事务尚未结束");
      const native = await inspect([lockPath]);
      requireSafeAttributes(native.get(lockPath), false);
      await safeRemoveOwned(lockPath, terminal.identity, parentIdentity);
    }
    const lock = await fs.open(lockPath, "wx", 0o600);
    const transactionId = randomUUID();
    ACTIVE_TRANSACTIONS.add(transactionId);
    let lockIdentity,
      temp,
      tempIdentity,
      handle,
      committed = false;
    try {
      await lock.writeFile(
        JSON.stringify({
          id: transactionId,
          createdAt: new Date(now()).toISOString(),
        }),
      );
      await lock.sync();
      lockIdentity = fingerprint(await lock.stat({ bigint: true }));
      const items = await read({ ignoreLock: true }),
        next = change(items);
      validate({ version: 1, items: next });
      const payload = JSON.stringify({ version: 1, items: next }) + "\n";
      if (Buffer.byteLength(payload) > MAX_BYTES)
        throw new Error("保护记录超过大小上限");
      temp = path.join(directory, `protection-${randomUUID()}.pending`);
      handle = await fs.open(temp, "wx", 0o600);
      await handle.writeFile(payload);
      await handle.sync();
      tempIdentity = fingerprint(await handle.stat({ bigint: true }));
      await handle.close();
      handle = undefined;
      const after = await directorySnapshot(directory, inspect);
      if (after.at(-1).identity !== parentIdentity)
        throw new Error("保护目录身份变化，未发布更新");
      // Check an existing destination instead of following a link or overwriting
      // an unrecognized object. Atomic rename never modifies a linked target.
      if (await exists(statePath)) await read({ ignoreLock: true });
      await fs.rename(temp, statePath);
      temp = undefined;
      memo = undefined;
      observed = true;
      // A durable completed receipt lets readers distinguish an AV-blocked
      // housekeeping unlink from an unresolved settings mutation after restart.
      const receipt = Buffer.from(
        JSON.stringify({
          version: 1,
          id: transactionId,
          status: "committed",
          digest: stateDigest(next),
        }),
      );
      await lock.truncate(0);
      await lock.write(receipt, 0, receipt.length, 0);
      await lock.sync();
      lockIdentity = fingerprint(await lock.stat({ bigint: true }));
      committed = true;
      return next.map((item) => ({ ...item, removable: true }));
    } finally {
      let cleanupError;
      try {
        if (handle) await handle.close();
      } catch (error) {
        cleanupError = error;
      }
      try {
        await lock.close();
      } catch (error) {
        cleanupError = cleanupError || error;
      }
      try {
        if (temp && tempIdentity)
          await safeRemoveOwned(temp, tempIdentity, parentIdentity);
      } catch (error) {
        cleanupError = cleanupError || error;
      }
      // Always attempt our own lock release, even if pending-file cleanup failed.
      try {
        if (lockIdentity)
          await safeRemoveOwned(lockPath, lockIdentity, parentIdentity);
      } catch (error) {
        cleanupError = cleanupError || error;
      }
      ACTIVE_TRANSACTIONS.delete(transactionId);
      if (cleanupError) {
        // Only an exact completed receipt permits continuing to read valid
        // protection rules. Unknown or mismatched state remains fail-closed.
        if (!committed) throw cleanupError;
        try {
          if (await exists(lockPath)) await committedReceipt();
        } catch {
          throw cleanupError;
        }
      }
    }
  }
  return {
    list: () => read(),
    async addAuthorized(target, source = "cleanup") {
      if (
        typeof target !== "string" ||
        !path.isAbsolute(target) ||
        /[\x00-\x1f]/.test(target)
      )
        throw new Error("无效的保护对象");
      const id = hash(normalize(target));
      const items = await mutate((current) =>
        current.some((item) => item.id === id)
          ? current
          : [
              ...current,
              {
                id,
                path: target,
                source,
                createdAt: new Date(now()).toISOString(),
              },
            ],
      );
      return items.find((item) => item.id === id);
    },
    async remove(id) {
      if (typeof id !== "string" || !/^[a-f0-9]{64}$/.test(id))
        throw new Error("只能移除已存储的自定义保护 ID");
      return mutate((current) => {
        if (!current.some((item) => item.id === id))
          throw new Error("保护项目不存在，内置保护不可移除");
        return current.filter((item) => item.id !== id);
      });
    },
  };
}
module.exports = { createProtectionStore };
