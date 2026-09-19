const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const S = require("./cleanup-safety.cjs");
const { createProtectionStore } = require("./cleanup-protection.cjs");

const TTL = 5 * 60000,
  DAY = 86400000,
  MAX_ITEMS = 500;
function createSafeTrashEngine({
  home,
  executable,
  trashItem,
  authorizeSelection,
  inspectAttributes,
  readActivity,
  platform = process.platform,
  env = process.env,
  now = Date.now,
  protectionDirectory,
  testWhitelistPath,
  trashTimeoutMs = 45000,
} = {}) {
  const hasHome =
    typeof home === "string" &&
    path.isAbsolute(home) &&
    !/^(\\\\|\/\/)/.test(home);
  const userHome = hasHome ? path.resolve(home) : undefined;
  const local = userHome ? path.join(userHome, "AppData", "Local") : undefined;
  const inspect = S.createInspector(
    inspectAttributes || S.createNativeInspector(executable),
  );
  const activity = readActivity || S.createNativeActivity(executable);
  const protections = userHome
    ? createProtectionStore({
        directory:
          protectionDirectory ||
          path.join(userHome, ".config", "mole", "desktop-protection"),
        inspect,
        now,
      })
    : undefined;
  const plans = new Map();
  let busy = false,
    closed = false,
    cancelled = false,
    uncertain = false;
  const variables = {
    ...Object.fromEntries(
      Object.entries(env).map(([k, v]) => [k.toUpperCase(), v]),
    ),
    USERPROFILE: userHome,
    LOCALAPPDATA: local,
    APPDATA: userHome ? path.join(userHome, "AppData", "Roaming") : undefined,
  };
  function assertReady() {
    if (platform !== "win32") throw new Error("文件回收仅在 Windows 可用");
    if (!hasHome) throw new Error("需要主进程提供已确认的用户目录");
    if (closed) throw new Error("回收服务已关闭");
    if (busy) throw new Error("已有回收操作正在进行");
    if (uncertain)
      throw Object.assign(new Error("上次原生回收结果未知，已锁定后续写入"), {
        code: "OUTCOME_UNKNOWN",
      });
  }
  function checkCancelled(signal) {
    if (closed || cancelled || signal?.aborted)
      throw new Error("操作已取消，未继续处理剩余项目");
  }
  async function loadRules(signal) {
    const defaults = [
      path.join(local, "Microsoft", "Windows", "Explorer"),
      path.join(local, "Microsoft", "Windows", "Fonts"),
      path.join(local, "Packages", "*"),
      path.join(local, "JetBrains"),
      path.join(variables.APPDATA, "Microsoft", "Windows", "Recent"),
      ...[
        ".vscode/extensions",
        ".nuget",
        ".cargo",
        ".rustup",
        ".m2/repository",
        ".gradle/caches/modules-2/files-*",
        ".ollama/models",
      ].map((p) => path.join(userHome, p)),
    ];
    const legacy = await S.readLegacyWhitelist(
      testWhitelistPath ||
        path.join(userHome, ".config", "mole", "whitelist.txt"),
      variables,
      inspect,
      signal,
    );
    const persisted = await protections.list();
    return [
      ...[path.join(userHome, ".config", "mole"), protectionDirectory]
        .filter(Boolean)
        .map((root) => ({ test: (value) => S.within(root, value) })),
      ...S.compileWhitelist(defaults, variables),
      ...legacy,
      ...persisted.map((item) => ({
        test: (value) => S.normalize(value) === S.normalize(item.path),
      })),
    ];
  }
  async function ownerState(root, signal) {
    if (!root.processNames?.length) return { idle: true, reason: "" };
    let snapshot;
    try {
      snapshot = await activity(signal);
    } catch (error) {
      return { idle: false, reason: `无法确认程序状态：${error.message}` };
    }
    if (
      !snapshot ||
      snapshot.platform !== "windows" ||
      snapshot.ok !== true ||
      !Array.isArray(snapshot.names) ||
      snapshot.names.some((n) => typeof n !== "string" || !n)
    )
      return { idle: false, reason: "程序活动信息不完整，已跳过此缓存" };
    const names = new Set(snapshot.names.map((n) => n.toLowerCase()));
    const owners = root.processNames.filter((n) => names.has(n.toLowerCase()));
    return owners.length
      ? {
          idle: false,
          reason: `${owners.join("、")} 正在运行，请退出后重新预览`,
        }
      : { idle: true, reason: "" };
  }
  function ageEligible(root, target, stat, explicit) {
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.nlink !== 1n ||
      stat.ino === 0n ||
      stat.size < 0n ||
      stat.size > BigInt(Number.MAX_SAFE_INTEGER)
    )
      return false;
    if (explicit) return true;
    if (
      root.extensions &&
      !root.extensions.includes(path.extname(target).toLowerCase())
    )
      return false;
    const cutoff = now() - (root.daysOld ?? 7) * DAY;
    return Number(stat.mtimeMs) < cutoff && Number(stat.ctimeMs) < cutoff;
  }
  async function describe(
    root,
    target,
    { rules, chain, native, signal, explicit = false, origin } = {},
  ) {
    const id = randomUUID();
    const item = {
      id,
      name: path.basename(target),
      path: target,
      description: `${root.name} · ${path.relative(root.path, target)}`,
      enabled: false,
      category: root.id,
      groupId: root.groupId || root.id,
      groupName: root.groupName || root.name,
      recommended: false,
      recommendation: "protected",
      reason: "",
      source: root.source || "",
    };
    let saved;
    try {
      checkCancelled(signal);
      if (!path.isAbsolute(target) || !S.within(root.path, target))
        throw new Error("目标不在授权根内");
      const attrs = native || (await inspect([target], signal));
      const nativeRow = attrs.get(target);
      S.requireSafeAttributes(nativeRow, Boolean(nativeRow?.attributes & 0x10));
      const stat = await fs.lstat(target, { bigint: true });
      item.size = Number(stat.size);
      if (stat.isDirectory()) {
        item.protectedFolder = true;
        throw new Error(
          "protectedFolder：本版仅回收普通文件，不连带移动未审查的子目录",
        );
      }
      S.requireSafeAttributes(attrs.get(target), false);
      const currentRules = rules || (await loadRules(signal));
      const protectedReason = S.protectedFile(root, target, currentRules, {
        explicit,
      });
      if (protectedReason) throw new Error(protectedReason);
      if (root.enabled === false || root.kind === "protected")
        throw new Error(root.reason || "此类别由系统管理，不直接删除");
      if (!ageEligible(root, target, stat, explicit))
        throw new Error(
          explicit
            ? "文件类型、身份或硬链接状态受保护"
            : "近期变化、非缓存类型或硬链接文件已保留",
        );
      if (origin) {
        if (
          typeof origin.identity !== "string" ||
          origin.identity !== S.fingerprint(stat)
        )
          throw new Error("文件与扫描时身份不一致或缺少身份信息，请重新扫描");
        if (origin.size !== undefined && origin.size !== Number(stat.size))
          throw new Error("文件大小已变化");
      }
      const ancestors =
        chain ||
        (await S.directorySnapshot(path.dirname(target), inspect, signal));
      if (S.normalize(await fs.realpath(target)) !== S.normalize(target))
        throw new Error("文件路径发生重定向");
      item.enabled = true;
      item.recommended = root.recommendation === "recommended" && !explicit;
      item.recommendation = item.recommended ? "recommended" : "manual";
      item.reason = root.reason || "仅在确认后移入回收站";
      saved = {
        item: structuredClone(item),
        root: structuredClone(root),
        identity: S.fingerprint(stat),
        chain: structuredClone(ancestors),
        explicit,
      };
    } catch (error) {
      item.reason = error.message;
    }
    return { item, saved };
  }
  function createPlan(descriptions, extra = {}) {
    if (descriptions.length > MAX_ITEMS)
      throw new Error("当前页超过回收计划上限");
    plans.clear();
    const created = now(),
      id = randomUUID();
    const saved = new Map();
    for (const d of descriptions) if (d.saved) saved.set(d.item.id, d.saved);
    plans.set(id, {
      expires: created + TTL,
      items: saved,
      publicItems: descriptions.map((d) => structuredClone(d.item)),
    });
    return {
      id,
      createdAt: new Date(created).toISOString(),
      expiresAt: new Date(created + TTL).toISOString(),
      items: descriptions.map((d) => structuredClone(d.item)),
      warnings: [],
      ...extra,
    };
  }
  async function preview(selectionIds, { signal, onProgress } = {}) {
    assertReady();
    if (typeof authorizeSelection !== "function")
      throw new Error("分析回收未配置主进程授权解析器");
    if (
      !Array.isArray(selectionIds) ||
      !selectionIds.length ||
      selectionIds.length > MAX_ITEMS ||
      selectionIds.some((id) => typeof id !== "string") ||
      new Set(selectionIds).size !== selectionIds.length
    )
      throw new Error("请选择唯一的扫描项目 ID");
    busy = true;
    cancelled = false;
    try {
      const snapshots = await authorizeSelection([...selectionIds]);
      if (
        !Array.isArray(snapshots) ||
        snapshots.length !== selectionIds.length ||
        snapshots.some((s) => !s || !selectionIds.includes(s.id)) ||
        new Set(snapshots.map((s) => s.id)).size !== snapshots.length
      )
        throw new Error("授权快照不完整");
      const descriptions = [],
        rules = await loadRules(signal);
      for (const snapshot of snapshots) {
        checkCancelled(signal);
        if (
          typeof snapshot.root !== "string" ||
          !path.isAbsolute(snapshot.root) ||
          typeof snapshot.path !== "string"
        )
          throw new Error("主进程授权快照路径无效");
        const root = {
          id: "analysis",
          groupId: "analysis",
          groupName: "手选文件",
          name: "分析页明确选择",
          path: snapshot.root,
          kind: "manual",
          extensions: null,
          recommendation: "manual",
          processNames: [],
        };
        const d = await describe(root, snapshot.path, {
          rules,
          signal,
          explicit: true,
          origin: snapshot,
        });
        descriptions.push(d);
        onProgress?.({
          phase: "preview",
          visited: descriptions.length,
          total: selectionIds.length,
        });
      }
      checkCancelled(signal);
      return createPlan(descriptions, {
        warnings: [
          "仅普通文件可回收；目录、系统/应用资料及密钥保持保护。不会永久删除。",
        ],
      });
    } finally {
      busy = false;
    }
  }
  async function safeTrash(saved, rules, expires, signal) {
    checkCancelled(signal);
    const reason = S.protectedFile(saved.root, saved.item.path, rules, {
      explicit: saved.explicit,
    });
    if (reason) throw new Error(reason);
    const owner = await ownerState(saved.root, signal);
    if (!owner.idle) throw new Error(owner.reason);
    const chain = await S.directorySnapshot(
      path.dirname(saved.item.path),
      inspect,
      signal,
    );
    if (
      chain.length !== saved.chain.length ||
      chain.some(
        (entry, i) =>
          entry.path !== saved.chain[i].path ||
          entry.identity !== saved.chain[i].identity,
      )
    )
      throw new Error("目录身份已变化，请重新预览");
    const attrs = await inspect([saved.item.path], signal);
    S.requireSafeAttributes(attrs.get(saved.item.path), false);
    const stat = await fs.lstat(saved.item.path, { bigint: true });
    if (
      !ageEligible(saved.root, saved.item.path, stat, saved.explicit) ||
      S.fingerprint(stat) !== saved.identity
    )
      throw new Error("文件在预览后发生变化");
    if (
      S.normalize(await fs.realpath(saved.item.path)) !==
      S.normalize(saved.item.path)
    )
      throw new Error("文件发生重定向");
    const final = await fs.lstat(saved.item.path, { bigint: true });
    if (S.fingerprint(final) !== saved.identity)
      throw new Error("文件在执行前发生变化");
    checkCancelled(signal);
    if (now() >= expires) throw new Error("计划已过期");
    let timer;
    try {
      await Promise.race([
        Promise.resolve().then(() => {
          checkCancelled(signal);
          return trashItem(saved.item.path);
        }),
        new Promise((_resolve, reject) => {
          timer = setTimeout(
            () =>
              reject(
                Object.assign(new Error("原生回收超时，结果未知"), {
                  code: "OUTCOME_UNKNOWN",
                }),
              ),
            trashTimeoutMs,
          );
        }),
      ]);
    } catch (error) {
      if (error.code === "OUTCOME_UNKNOWN") throw error;
      try {
        const after = await fs.lstat(saved.item.path, { bigint: true });
        if (S.fingerprint(after) !== saved.identity) throw new Error("changed");
      } catch {
        throw Object.assign(new Error("系统未确认成功且原文件状态已变化"), {
          code: "OUTCOME_UNKNOWN",
        });
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
  async function execute(planId, selectedIds, { signal, onProgress } = {}) {
    assertReady();
    const plan = plans.get(planId);
    if (!plan || now() >= plan.expires)
      throw new Error("计划已过期，请重新预览");
    if (
      !Array.isArray(selectedIds) ||
      !selectedIds.length ||
      selectedIds.length > MAX_ITEMS ||
      selectedIds.some((id) => typeof id !== "string" || !plan.items.has(id)) ||
      new Set(selectedIds).size !== selectedIds.length
    )
      throw new Error("只能执行当前计划中已授权的唯一 ID");
    if (typeof trashItem !== "function")
      throw new Error("未配置系统回收站，拒绝执行");
    plans.delete(planId);
    busy = true;
    cancelled = false;
    const results = [],
      warnings = [];
    try {
      for (const id of selectedIds) {
        const saved = plan.items.get(id),
          record = {
            id,
            name: saved.item.name,
            status: "skipped",
            message: "",
          };
        if (closed || cancelled || signal?.aborted || uncertain) {
          record.message = "已取消或前项结果未知，未执行";
          results.push(record);
          continue;
        }
        if (now() >= plan.expires) {
          record.message = "计划已过期，未继续执行";
          results.push(record);
          continue;
        }
        if (env.MOLE_DRY_RUN === "1" || env.MO_DRY_RUN === "1") {
          record.message = "Dry-run：不修改文件";
          results.push(record);
          continue;
        }
        try {
          await safeTrash(saved, await loadRules(signal), plan.expires, signal);
          record.status = "success";
          record.message = "已移入回收站，可在 Windows 回收站恢复";
        } catch (error) {
          if (error.code === "OUTCOME_UNKNOWN") {
            uncertain = true;
            record.status = "unknown";
          } else record.status = "failed";
          record.message = `${error.message}；未改用永久删除`;
        }
        results.push(record);
        try {
          onProgress?.({
            phase: "execute",
            completed: results.length,
            total: selectedIds.length,
            result: record,
          });
        } catch {
          cancelled = true;
          warnings.push("进度通道已关闭，停止剩余项目");
        }
      }
      if (uncertain)
        warnings.push(
          "原生结果未知，停止批次并锁定后续写入；必须通过主进程持久化审计流程核对，不要重试。",
        );
      return {
        results,
        warnings,
        cancelled: cancelled || signal?.aborted || closed || false,
      };
    } finally {
      busy = false;
    }
  }
  async function protect(planId, itemId) {
    assertReady();
    const plan = plans.get(planId),
      saved = plan?.items.get(itemId);
    if (!plan || now() >= plan.expires || !saved)
      throw new Error("只能保护当前计划中的文件 ID");
    busy = true;
    try {
      const record = await protections.addAuthorized(
        saved.item.path,
        saved.explicit ? "analysis" : "cleanup",
      );
      plan.items.delete(itemId);
      return record;
    } finally {
      busy = false;
    }
  }
  return {
    preview,
    execute,
    protect,
    async listProtected() {
      assertReady();
      return protections.list();
    },
    async removeProtected(id) {
      assertReady();
      busy = true;
      try {
        return await protections.remove(id);
      } finally {
        busy = false;
      }
    },
    cancel() {
      cancelled = true;
    },
    close() {
      closed = true;
      cancelled = true;
      plans.clear();
    },
    // Trusted backend composition only; these are not renderer IPC methods.
    context: {
      home: userHome,
      local,
      inspect,
      loadRules,
      ownerState,
      describe,
      createPlan,
      assertReady,
      checkCancelled,
      resetCancellation() {
        cancelled = false;
      },
      now,
      MAX_ITEMS,
    },
  };
}
module.exports = { createSafeTrashEngine, fingerprint: S.fingerprint };
