const fs = require("node:fs/promises");
const { constants } = require("node:fs");
const path = require("node:path");
const { randomUUID, createHash } = require("node:crypto");

const LIMIT = 1024 * 1024;
const copy = (value) => structuredClone(value);
const checksum = (value) => createHash("sha256").update(value).digest("hex");
const comparable = (value) =>
  process.platform === "win32" ? value.toLowerCase() : value;

// A recovery journal is evidence of a pending operation, not a replay queue.
// It never stores executable commands or authorizes an operation after restart.
function createOperationStore({
  directory,
  inspectAttributes,
  legacyDirectory,
} = {}) {
  if (!path.isAbsolute(directory || "") || /^(\\\\|\/\/)/.test(directory))
    throw new Error("Invalid operation journal directory");
  const statePath = path.join(directory, "operations.json");
  const lockPath = path.join(directory, "active-operation.lock");
  let tail = Promise.resolve();
  function serialize(task) {
    const result = tail.then(task, task);
    tail = result.catch(() => {});
    return result;
  }
  async function safeDirectory() {
    const parsed = path.parse(directory);
    let current = parsed.root;
    const ancestors = [current];
    for (const part of directory
      .slice(parsed.root.length)
      .split(path.sep)
      .filter(Boolean)) {
      current = path.join(current, part);
      let stat;
      try {
        stat = await fs.lstat(current);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        try {
          await fs.mkdir(current, { mode: 0o700 });
        } catch (createError) {
          if (createError.code !== "EEXIST") throw createError;
        }
        stat = await fs.lstat(current);
      }
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new Error("操作记录目录包含链接或非目录，已停止写入");
      ancestors.push(current);
    }
    if (
      comparable(await fs.realpath(directory)) !==
      comparable(path.resolve(directory))
    )
      throw new Error("操作记录目录发生重定向");
    if (inspectAttributes) {
      const rows = await inspectAttributes(ancestors);
      if (
        rows.length !== ancestors.length ||
        rows.some(
          (row, i) =>
            row.path !== ancestors[i] ||
            row.error ||
            !Number.isInteger(row.attributes) ||
            !(row.attributes & 0x10) ||
            row.attributes & (0x400 | 0x1000 | 0x40000 | 0x400000),
        )
      )
        throw new Error("无法确认操作记录目录的原生属性");
    }
  }
  async function safeFile(filename, missing = true) {
    try {
      const stat = await fs.lstat(filename, { bigint: true });
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.nlink !== 1n ||
        stat.size > LIMIT
      )
        throw new Error("操作记录不是可信的普通文件");
      if (inspectAttributes) {
        const rows = await inspectAttributes([filename]);
        const row = rows[0];
        if (
          rows.length !== 1 ||
          row.path !== filename ||
          row.error ||
          !Number.isInteger(row.attributes) ||
          row.attributes & (0x10 | 0x400 | 0x1000 | 0x40000 | 0x400000)
        )
          throw new Error("操作记录属性不可确认");
      }
      return stat;
    } catch (error) {
      if (missing && error.code === "ENOENT") return null;
      throw error;
    }
  }
  async function readState() {
    await safeDirectory();
    if (!(await safeFile(statePath))) {
      let legacy = false;
      if (legacyDirectory) {
        try {
          legacy = (await fs.readdir(legacyDirectory)).some((name) =>
            /^maintenance-\d{4}-\d{2}-\d{2}(?:-\d+)?\.jsonl$/.test(name),
          );
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
      }
      return {
        version: 1,
        active: null,
        history: [],
        migrationRequired: legacy,
      };
    }
    const bytes = await fs.readFile(statePath);
    if (bytes.length > LIMIT) throw new Error("操作记录超过大小上限");
    const envelope = JSON.parse(bytes.toString("utf8"));
    if (
      typeof envelope.payload !== "string" ||
      checksum(envelope.payload) !== envelope.checksum
    )
      throw new Error("操作记录不完整或校验失败");
    const state = JSON.parse(envelope.payload);
    if (
      state.version !== 1 ||
      !Array.isArray(state.history) ||
      state.history.length > 50 ||
      (state.active !== null &&
        (typeof state.active !== "object" ||
          typeof state.active.id !== "string"))
    )
      throw new Error("操作记录格式无效");
    return state;
  }
  async function writeState(state) {
    await safeDirectory();
    await safeFile(statePath);
    const payload = JSON.stringify(state);
    const data = JSON.stringify({ payload, checksum: checksum(payload) });
    if (Buffer.byteLength(data) > LIMIT)
      throw new Error("操作记录超过大小上限");
    const temporary = path.join(directory, `operations-${randomUUID()}.tmp`);
    const handle = await fs.open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await safeDirectory();
    await safeFile(statePath);
    await fs.rename(temporary, statePath);
    // Directory fsync is supported on POSIX. Windows flushes the file above;
    // power-loss guarantees still depend on the filesystem and storage stack.
    if (process.platform !== "win32") {
      const dirHandle = await fs.open(directory, "r");
      try {
        await dirHandle.sync();
      } finally {
        await dirHandle.close();
      }
    }
  }
  async function archiveLock() {
    if (!(await safeFile(lockPath))) return;
    await fs.rename(
      lockPath,
      path.join(directory, `closed-${Date.now()}-${randomUUID()}.lock`),
    );
  }
  function historyEvent(active, status, counts = {}) {
    return {
      id: active?.id || randomUUID(),
      kind: active?.kind || "recovery",
      at: new Date().toISOString(),
      status,
      count: active?.count || 0,
      names: active?.names || [],
      counts,
    };
  }
  return {
    appendAudit: (event) =>
      serialize(async () => {
        await safeDirectory();
        const line =
          JSON.stringify({ at: new Date().toISOString(), ...event }) + "\n";
        if (Buffer.byteLength(line) > LIMIT)
          throw new Error("单条审计记录超过大小上限");
        const date = new Date().toISOString().slice(0, 10);
        for (let index = 0; index < 10000; index++) {
          const filename = path.join(
            directory,
            `maintenance-${date}-${index}.jsonl`,
          );
          const previous = await safeFile(filename);
          if (
            previous &&
            previous.size + BigInt(Buffer.byteLength(line)) > BigInt(LIMIT)
          )
            continue;
          const flags =
            constants.O_APPEND |
            constants.O_CREAT |
            constants.O_WRONLY |
            (constants.O_NOFOLLOW || 0);
          const handle = await fs.open(filename, flags, 0o600);
          try {
            await safeDirectory();
            const live = await safeFile(filename, false);
            const opened = await handle.stat({ bigint: true });
            if (
              !opened.isFile() ||
              opened.nlink !== 1n ||
              opened.dev !== live.dev ||
              opened.ino !== live.ino ||
              (previous &&
                (previous.dev !== opened.dev || previous.ino !== opened.ino))
            )
              throw new Error("审计文件身份已变化");
            await handle.writeFile(line);
            await handle.sync();
          } finally {
            await handle.close();
          }
          return;
        }
        throw new Error("审计日志过多，请先检查应用数据目录");
      }),
    snapshot: () =>
      serialize(async () => {
        try {
          const state = await readState();
          const lock = await safeFile(lockPath);
          return {
            required: Boolean(state.active || lock || state.migrationRequired),
            corrupt: false,
            active: state.active,
            history: copy(state.history),
            reason: state.migrationRequired
              ? "发现旧版操作记录，需要确认没有尚未结束的任务"
              : state.active || lock
                ? "上次维护未可靠结束；请先检查 Windows 中的卸载程序、系统任务和回收站"
                : "",
          };
        } catch (error) {
          return {
            required: true,
            corrupt: true,
            active: null,
            history: [],
            reason: `无法安全读取操作记录：${error.message}`,
          };
        }
      }),
    begin: (operation) =>
      serialize(async () => {
        const state = await readState();
        if (
          state.active ||
          state.migrationRequired ||
          (await safeFile(lockPath))
        )
          throw new Error("已有未完成操作，需要先核查恢复状态");
        const lock = await fs.open(lockPath, "wx", 0o600);
        try {
          await lock.writeFile(operation.id);
          await lock.sync();
        } finally {
          await lock.close();
        }
        state.active = copy(operation);
        await writeState(state);
      }),
    finish: (id, result, uncertain = false) =>
      serialize(async () => {
        const state = await readState();
        if (!state.active || state.active.id !== id)
          throw new Error("操作记录与当前任务不匹配");
        const counts = {};
        for (const item of result?.results || [])
          counts[item.status] = (counts[item.status] || 0) + 1;
        const status = uncertain
          ? "unknown"
          : result?.cancelled
            ? "cancelled"
            : "finished";
        state.history = [
          historyEvent(state.active, status, counts),
          ...state.history,
        ].slice(0, 50);
        state.active = uncertain ? { ...state.active, phase: "unknown" } : null;
        await writeState(state);
        if (!uncertain) await archiveLock();
      }),
    acknowledge: () =>
      serialize(async () => {
        const state = await readState();
        state.history = [
          historyEvent(state.active, "acknowledged"),
          ...state.history,
        ].slice(0, 50);
        state.active = null;
        state.migrationRequired = false;
        await writeState(state);
        await archiveLock();
      }),
  };
}

function createMemoryOperationStore() {
  let active = null,
    history = [];
  return {
    snapshot: async () => ({
      required: Boolean(active),
      corrupt: false,
      active: copy(active),
      history: copy(history),
      reason: active ? "上次维护结果未知，需要核查" : "",
    }),
    begin: async (operation) => {
      if (active) throw new Error("已有未完成操作");
      active = copy(operation);
    },
    finish: async (id, result, uncertain = false) => {
      if (active?.id !== id) throw new Error("操作不匹配");
      history = [
        {
          id,
          kind: active.kind,
          at: new Date().toISOString(),
          status: uncertain ? "unknown" : "finished",
          count: active.count,
        },
        ...history,
      ].slice(0, 50);
      if (!uncertain) active = null;
    },
    acknowledge: async () => {
      active = null;
    },
  };
}
module.exports = { createOperationStore, createMemoryOperationStore };
