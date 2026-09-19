const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { createSafeTrashEngine } = require("./safe-trash.cjs");
const S = require("./cleanup-safety.cjs");
const Catalog = require("./cleanup-catalog.cjs");
const TTL = 5 * 60000,
  PAGE_SIZE = 500,
  WORK_LIMIT = 10000;
const TEMP_EXTENSIONS = [".tmp", ".temp", ".log", ".dmp", ".etl", ".cache"];

// A bounded page resumes its live iterator instead of repeatedly scanning the
// first N files. Continuations are opaque, short-lived, and never contain paths.
function createCleanupService(options = {}) {
  const engine = createSafeTrashEngine(options),
    ctx = engine.context;
  const {
    env = process.env,
    testRoots,
    now = Date.now,
    testPageSize = PAGE_SIZE,
    testWorkLimit = WORK_LIMIT,
  } = options;
  const pageSize = Math.max(1, Math.min(PAGE_SIZE, testPageSize)),
    workLimit = Math.max(1, Math.min(WORK_LIMIT, testWorkLimit));
  const groupNames = new Map(
    Object.values(Catalog.GROUPS).map((g) => [g.id, g.name]),
  );
  const sessions = new Map();
  let busy = false,
    current,
    closing = false;
  function assertReady() {
    ctx.assertReady();
    if (busy) throw new Error("已有清理预览或操作正在进行");
    if (
      !testRoots &&
      env.LOCALAPPDATA != null &&
      (typeof env.LOCALAPPDATA !== "string" ||
        !path.isAbsolute(env.LOCALAPPDATA) ||
        S.normalize(env.LOCALAPPDATA) !== S.normalize(ctx.local))
    )
      throw new Error(
        "LocalAppData 与当前用户规范 AppData/Local 不一致，拒绝清理",
      );
  }
  function group(state, root) {
    const id = root.groupId || root.id,
      name = root.groupName || groupNames.get(id) || root.name;
    if (!state.groups.has(id))
      state.groups.set(id, {
        id,
        name,
        groupId: id,
        groupName: name,
        count: 0,
        bytes: 0,
        observedFiles: 0,
        observedBytes: 0,
        protectedCount: 0,
        recommendedCount: 0,
        recommended: false,
        partial: false,
        skipReasons: {},
        roots: [],
      });
    return state.groups.get(id);
  }
  function skip(state, g, reason, { incomplete = true, count = 1 } = {}) {
    g.protectedCount += count;
    g.skipReasons[reason] = (g.skipReasons[reason] || 0) + count;
    if (incomplete) {
      g.partial = true;
      state.incomplete = true;
    }
  }
  function summaries(state) {
    return [...state.groups.values()].map((g) => structuredClone(g));
  }
  function progress(state, force = false) {
    if (force || Date.now() - state.lastProgress > 200) {
      state.lastProgress = Date.now();
      state.onProgress?.({
        phase: "preview",
        visited: state.visited,
        observedFiles: state.observedFiles,
        observedBytes: state.observedBytes,
        eligibleCount: state.eligibleCount,
        eligibleBytes: state.eligibleBytes,
        groupId: state.groupId,
        groups: summaries(state),
      });
    }
  }
  function normalizeRoot(root) {
    return {
      ...root,
      groupId: root.groupId || root.id,
      groupName:
        root.groupName || groupNames.get(root.groupId || root.id) || root.name,
      kind: root.kind || "temp",
      extensions:
        root.extensions === undefined ? TEMP_EXTENSIONS : root.extensions,
      daysOld: root.daysOld ?? 7,
      recommendation: root.recommendation || "manual",
      processNames: root.processNames || [],
      enabled: root.enabled !== false,
    };
  }
  async function cancelSessions() {
    for (const state of new Set(sessions.values())) {
      clearTimeout(state.timer);
      state.abort.abort();
      try {
        await state.iterator?.return();
      } catch {}
    }
    sessions.clear();
  }
  async function* allRoots(state) {
    if (testRoots) {
      for (const root of testRoots) yield normalizeRoot(root);
      return;
    }
    for (const root of Catalog.staticRoots(ctx.home)) yield normalizeRoot(root);
    for (const location of Catalog.profileLocations(ctx.home)) {
      ctx.checkCancelled(state.abort.signal);
      if (location.profileKind === "fixed") {
        for (const root of Catalog.rootsForProfile(location))
          yield normalizeRoot(root);
        continue;
      }
      const g = group(state, {
        ...location,
        name: groupNames.get(location.groupId) || location.name,
      });
      try {
        const locationAttrs = await ctx.inspect(
          [location.path],
          state.abort.signal,
        );
        S.requireSafeAttributes(locationAttrs.get(location.path), true);
        await S.directorySnapshot(
          location.path,
          ctx.inspect,
          state.abort.signal,
        );
        const owner = await ctx.ownerState(location, state.abort.signal);
        if (!owner.idle) {
          skip(state, g, owner.reason);
          continue;
        }
        const directory = await fs.opendir(location.path, { bufferSize: 64 });
        let count = 0;
        for await (const entry of directory) {
          ctx.checkCancelled(state.abort.signal);
          state.visited++;
          if (++count > 256) {
            skip(state, g, "浏览器配置目录超过256项，未扫描剩余配置");
            break;
          }
          let roots;
          try {
            roots = Catalog.rootsForProfile(location, entry.name);
          } catch {
            continue;
          }
          if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
          for (const root of roots) yield normalizeRoot(root);
        }
      } catch (error) {
        if (state.abort.signal.aborted) throw error;
        if (error.code !== "ENOENT")
          skip(state, g, `无法安全发现配置：${error.message}`);
      }
    }
  }
  async function* walk(state, root, directory, depth) {
    ctx.checkCancelled(state.abort.signal);
    const g = group(state, root);
    if (depth > 16) {
      skip(state, g, "目录深度超过16层");
      yield null;
      return;
    }
    if (
      directory !== root.path &&
      S.protectedFile(root, directory, state.rules)
    ) {
      skip(state, g, "保护目录内部未读取，不估算其大小");
      yield null;
      return;
    }
    let chain;
    try {
      chain = await S.directorySnapshot(
        directory,
        ctx.inspect,
        state.abort.signal,
      );
    } catch (error) {
      skip(state, g, error.message);
      yield null;
      return;
    }
    const handle = await fs.opendir(directory, { bufferSize: 256 });
    try {
      while (true) {
        ctx.checkCancelled(state.abort.signal);
        const batch = [];
        for (let i = 0; i < 256; i++) {
          const entry = await handle.read();
          if (!entry) break;
          batch.push({ entry, target: path.join(directory, entry.name) });
        }
        if (!batch.length) break;
        let native,
          nativePage = state.pageGeneration;
        try {
          native = await ctx.inspect(
            batch.map((b) => b.target),
            state.abort.signal,
          );
        } catch (error) {
          skip(state, g, error.message, { count: batch.length });
          state.visited += batch.length;
          yield null;
          continue;
        }
        for (let index = 0; index < batch.length; index++) {
          const { entry, target } = batch[index];
          if (nativePage !== state.pageGeneration) {
            const owner = await ctx.ownerState(root, state.abort.signal);
            if (!owner.idle) {
              skip(state, g, owner.reason);
              return;
            }
            const currentChain = await S.directorySnapshot(
              directory,
              ctx.inspect,
              state.abort.signal,
            );
            if (
              currentChain.length !== chain.length ||
              currentChain.some((p, i) => p.identity !== chain[i].identity)
            ) {
              skip(state, g, "目录身份在分页期间变化，请重新扫描");
              return;
            }
            native = await ctx.inspect(
              batch.slice(index).map((b) => b.target),
              state.abort.signal,
            );
            nativePage = state.pageGeneration;
          }
          ctx.checkCancelled(state.abort.signal);
          state.visited++;
          if (entry.isDirectory()) {
            try {
              S.requireSafeAttributes(native.get(target), true);
            } catch (error) {
              skip(state, g, error.message);
              yield null;
              continue;
            }
            yield* walk(state, root, target, depth + 1);
            continue;
          }
          let stat;
          try {
            const row = native.get(target);
            S.requireSafeAttributes(row, Boolean(row?.attributes & 0x10));
            stat = await fs.lstat(target, { bigint: true });
          } catch (error) {
            skip(state, g, `文件无法读取：${error.message}`);
            yield null;
            continue;
          }
          if (stat.isFile() && stat.size <= BigInt(Number.MAX_SAFE_INTEGER)) {
            state.observedFiles++;
            state.observedBytes += Number(stat.size);
            g.observedFiles++;
            g.observedBytes += Number(stat.size);
          }
          const d = await ctx.describe(root, target, {
            rules: state.rules,
            chain,
            native,
            signal: state.abort.signal,
          });
          if (d.item.enabled) {
            g.count++;
            g.bytes += d.item.size;
            g.recommendedCount += d.item.recommended ? 1 : 0;
            g.recommended = g.recommendedCount > 0;
            state.eligibleCount++;
            state.eligibleBytes += d.item.size;
            yield d;
          } else {
            skip(state, g, d.item.reason, {
              incomplete:
                !stat.isFile() ||
                /无法|不可确认|变化|重定向/.test(d.item.reason),
            });
            yield null;
          }
          progress(state);
        }
      }
    } finally {
      await handle.close();
    }
  }
  async function* enumerate(state) {
    for await (const root of allRoots(state)) {
      ctx.checkCancelled(state.abort.signal);
      const g = group(state, root);
      state.groupId = g.id;
      const record = {
        id: root.id,
        name: root.name,
        path: root.path,
        status: "pending",
        reason: root.reason || "",
      };
      g.roots.push(record);
      progress(state, true);
      try {
        const rootAttrs = await ctx.inspect([root.path], state.abort.signal);
        S.requireSafeAttributes(rootAttrs.get(root.path), true);
        if (root.enabled === false || root.kind === "protected") {
          record.status = "protected";
          skip(state, g, root.reason || "系统管理目录不支持手工回收");
          continue;
        }
        const owner = await ctx.ownerState(root, state.abort.signal);
        if (!owner.idle) {
          record.status = "running";
          record.reason = owner.reason;
          skip(state, g, owner.reason);
          continue;
        }
        record.status = "scanning";
        yield* walk(state, root, root.path, 0);
        record.status = "scanned";
      } catch (error) {
        if (state.abort.signal.aborted) throw error;
        if (error.code === "ENOENT") record.status = "notFound";
        else {
          record.status = "unavailable";
          record.reason = error.message;
          skip(state, g, error.message);
        }
      }
    }
  }
  async function preview({ cursor, onProgress, signal } = {}) {
    assertReady();
    busy = true;
    ctx.resetCancellation();
    let state, abortListener;
    try {
      if (cursor !== undefined) {
        if (typeof cursor !== "string" || !sessions.has(cursor))
          throw new Error("继续扫描令牌无效或已过期");
        state = sessions.get(cursor);
        sessions.delete(cursor);
        clearTimeout(state.timer);
        if (now() >= state.expires)
          throw new Error("继续扫描已过期，请重新预览");
      } else {
        await cancelSessions();
        state = {
          abort: new AbortController(),
          groups: new Map(),
          visited: 0,
          observedFiles: 0,
          observedBytes: 0,
          eligibleCount: 0,
          eligibleBytes: 0,
          incomplete: false,
          lastProgress: 0,
        };
        state.iterator = enumerate(state);
      }
      current = state;
      state.pageGeneration = (state.pageGeneration || 0) + 1;
      state.onProgress = onProgress;
      abortListener = () => state.abort.abort();
      if (signal?.aborted) abortListener();
      signal?.addEventListener("abort", abortListener, { once: true });
      state.rules = await ctx.loadRules(state.abort.signal);
      const descriptions = [],
        start = state.visited;
      let done = false;
      while (
        descriptions.length < pageSize &&
        state.visited - start < workLimit
      ) {
        ctx.checkCancelled(state.abort.signal);
        const next = await state.iterator.next();
        if (next.done) {
          done = true;
          break;
        }
        if (next.value) descriptions.push(next.value);
        progress(state);
      }
      ctx.checkCancelled(state.abort.signal);
      const nextCursor = done ? undefined : randomUUID();
      if (nextCursor) {
        state.expires = now() + TTL;
        sessions.set(nextCursor, state);
        state.timer = setTimeout(() => {
          sessions.delete(nextCursor);
          state.abort.abort();
          void state.iterator.return().catch(() => {});
        }, TTL);
        state.timer.unref?.();
      }
      progress(state, true);
      return ctx.createPlan(descriptions, {
        groups: summaries(state),
        partial: !done || state.incomplete,
        hasMore: !done,
        nextCursor,
        summary: {
          visited: state.visited,
          observedFiles: state.observedFiles,
          observedBytes: state.observedBytes,
          eligibleCount: state.eligibleCount,
          eligibleBytes: state.eligibleBytes,
          pageCount: descriptions.length,
          pageBytes: descriptions.reduce((sum, d) => sum + d.item.size, 0),
          complete: done && !state.incomplete,
        },
        warnings: [
          ...(!done
            ? [
                "本页只是已验证的一部分，可继续扫描；不能把已观察大小视为全量可清理空间。",
              ]
            : []),
          ...(state.incomplete
            ? ["部分目录正在使用、受保护或无法确认，未计为可清理文件。"]
            : []),
          "只移入回收站；缓存重建/重新下载可能影响首次启动或离线使用。默认不勾选。",
        ],
      });
    } catch (error) {
      if (state) {
        state.abort.abort();
        try {
          await state.iterator?.return();
        } catch {}
      }
      throw error;
    } finally {
      signal?.removeEventListener("abort", abortListener);
      current = undefined;
      busy = false;
    }
  }
  const checked =
    (method) =>
    async (...args) => {
      assertReady();
      busy = true;
      try {
        return await engine[method](...args);
      } finally {
        busy = false;
      }
    };
  return {
    preview,
    execute: checked("execute"),
    protect: checked("protect"),
    listProtected: checked("listProtected"),
    removeProtected: checked("removeProtected"),
    cancel() {
      engine.cancel();
      current?.abort.abort();
      void cancelSessions();
    },
    close() {
      if (closing) return;
      closing = true;
      engine.close();
      current?.abort.abort();
      void cancelSessions();
    },
  };
}
module.exports = {
  createCleanupService,
  createNativeInspector: S.createNativeInspector,
  compileWhitelist: S.compileWhitelist,
};
