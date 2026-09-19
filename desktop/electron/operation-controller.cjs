const { randomUUID } = require("node:crypto");
const {
  createOperationStore,
  createMemoryOperationStore,
} = require("./operation-store.cjs");

const kinds = ["cleanup", "applications", "optimize", "files"];
const titles = {
  cleanup: "将所选缓存移入回收站",
  applications: "卸载所选软件",
  optimize: "执行所选维护操作",
  files: "将所选文件移入回收站",
};
const MAX_SELECTION = 500;
function publicOptions(kind, options = {}) {
  if (!options || typeof options !== "object" || Array.isArray(options))
    throw new Error("无效的扫描参数");
  const allowed =
    kind === "cleanup" ? ["cursor"] : kind === "files" ? ["selectionIds"] : [];
  if (Object.keys(options).some((key) => !allowed.includes(key)))
    throw new Error("不支持的扫描参数");
  if (
    options.cursor != null &&
    (typeof options.cursor !== "string" || options.cursor.length > 4096)
  )
    throw new Error("无效的继续扫描标识");
  if (
    options.selectionIds != null &&
    (!Array.isArray(options.selectionIds) ||
      !options.selectionIds.length ||
      options.selectionIds.length > MAX_SELECTION ||
      options.selectionIds.some(
        (id) => typeof id !== "string" || id.length > 100,
      ))
  )
    throw new Error("无效的文件选择");
  return structuredClone(options);
}
function createMaintenanceController({
  services,
  confirm,
  audit,
  journal = createMemoryOperationStore(),
  platform = process.platform,
  now = Date.now,
  onChange = () => {},
  onRecovery = async () => {},
}) {
  const plans = new Map(),
    views = new Map();
  let active,
    uncertain = false;
  function checkKind(kind, writing = true) {
    if (!kinds.includes(kind) || !services[kind])
      throw new Error("Unsupported maintenance operation");
    if (writing && platform !== "win32")
      throw new Error("写入功能仅在 Windows 可用；当前系统保留只读分析和监控");
  }
  function emit(job, extra = {}) {
    const event = {
      id: job.id,
      kind: job.kind,
      phase: job.phase,
      cancelled: job.controller.signal.aborted,
      ...extra,
    };
    job.progress = event;
    try {
      onChange(structuredClone(event));
    } catch {
      /* UI lifetime cannot control task safety. */
    }
  }
  function beginJob(kind, phase) {
    if (active) throw new Error("已有维护操作正在进行，请等待完成");
    const job = {
      id: randomUUID(),
      kind,
      phase,
      controller: new AbortController(),
      startedAt: now(),
      persisted: false,
      nativeStarted: false,
      abandoned: false,
    };
    active = job;
    emit(job);
    return job;
  }
  function progress(job, data = {}) {
    if (active !== job) return;
    const safe = {};
    for (const key of [
      "completed",
      "total",
      "visited",
      "files",
      "items",
      "bytes",
      "found",
      "scanned",
    ])
      if (Number.isFinite(data[key]) && data[key] >= 0) safe[key] = data[key];
    for (const key of ["currentName", "category", "message"])
      if (typeof data[key] === "string") safe[key] = data[key].slice(0, 300);
    if (now() - (job.lastProgress || 0) < 100 && safe.completed !== safe.total)
      return;
    job.lastProgress = now();
    emit(job, safe);
  }
  function view(kind) {
    return structuredClone({
      ...(views.get(kind) || {}),
      operation: active?.kind === kind ? active.progress : null,
    });
  }
  function unknownResult(selected, message) {
    return {
      results: selected.map((item) => ({
        id: item.id,
        name: item.name,
        status: "unknown",
        message,
      })),
      warnings: [],
    };
  }
  function validResult(result, ids) {
    return (
      result &&
      Array.isArray(result.results) &&
      result.results.length === ids.length &&
      result.results.every(
        (item) =>
          item &&
          ids.includes(item.id) &&
          typeof item.status === "string" &&
          item.status,
      ) &&
      new Set(result.results.map((item) => item.id)).size === ids.length
    );
  }
  return {
    isExecuting: () => Boolean(active && active.phase !== "preview"),
    isBusy: () => Boolean(active),
    workspace(kind) {
      checkKind(kind, false);
      return view(kind);
    },
    async state() {
      const recovery = await journal.snapshot();
      return { recovery, operation: active?.progress || null };
    },
    cancel(kind) {
      if (!active || (kind && active.kind !== kind)) return false;
      active.controller.abort();
      services[active.kind]?.cancel?.();
      emit(active, {
        message:
          active.phase === "preview"
            ? "正在停止扫描"
            : "已请求停止后续项目；当前系统操作不能撤销",
      });
      return true;
    },
    async acknowledgeRecovery() {
      if (active) throw new Error("当前任务尚未结束");
      const job = beginJob("recovery", "confirm");
      try {
        const recovery = await journal.snapshot();
        if (recovery.corrupt)
          throw new Error(recovery.reason + "；不能自动覆盖损坏的记录");
        if (!recovery.required && !uncertain) return recovery;
        const approved = await confirm({
          kind: "recovery",
          title: "确认已经核查上次任务",
          items: [],
          detail:
            "请先检查 Windows 任务管理器、卸载向导、文件位置与回收站，确认没有仍在执行的维护。继续只解除保护锁，不会重试旧操作。",
        });
        if (!approved || job.abandoned || job.controller.signal.aborted)
          return { ...recovery, cancelled: true };
        await onRecovery();
        await audit({
          event: "recovery-acknowledged",
          operationId: recovery.active?.id,
        });
        await journal.acknowledge();
        uncertain = false;
        plans.clear();
        views.clear();
        return journal.snapshot();
      } finally {
        emit(job, { phase: "idle" });
        if (active === job) active = undefined;
      }
    },
    async abandon() {
      if (!active) return;
      const job = active;
      job.abandoned = true;
      job.controller.abort();
      services[job.kind]?.cancel?.();
      if (job.persisted) {
        uncertain = true;
        await journal.finish(job.id, { results: [] }, true);
      }
      await audit({
        event: "abandoned",
        kind: job.kind,
        operationId: job.id,
        message: "用户明确选择退出；已启动的原生操作可能继续，结果未知",
      });
    },
    async preview(kind, options) {
      checkKind(kind);
      const parameters = publicOptions(kind, options);
      const job = beginJob(kind, "preview");
      plans.delete(kind);
      views.set(kind, {});
      try {
        const plan = await services[kind].preview({
          ...parameters,
          signal: job.controller.signal,
          onProgress: (data) => progress(job, data),
        });
        if (job.controller.signal.aborted || plan?.cancelled)
          return { cancelled: true };
        if (
          !plan ||
          typeof plan.id !== "string" ||
          !Array.isArray(plan.items) ||
          plan.items.some((item) => !item || typeof item.id !== "string") ||
          new Set(plan.items.map((item) => item.id)).size !== plan.items.length
        )
          throw new Error("Invalid maintenance plan");
        const parsedExpiry =
          typeof plan.expiresAt === "number"
            ? plan.expiresAt
            : Date.parse(plan.expiresAt);
        const expires = Math.min(
          now() + 5 * 60000,
          Number.isFinite(parsedExpiry) ? parsedExpiry : Infinity,
        );
        if (expires <= now()) throw new Error("扫描结果已经过期，请重新扫描");
        const snapshot = structuredClone({ ...plan, expiresAt: expires });
        plans.set(kind, { plan: snapshot, expires });
        views.set(kind, { plan: snapshot });
        return structuredClone(snapshot);
      } catch (error) {
        if (job.controller.signal.aborted) return { cancelled: true };
        views.set(kind, { error: error.message });
        throw error;
      } finally {
        emit(job, { phase: "idle" });
        if (active === job) active = undefined;
      }
    },
    async protect(planId, itemId) {
      checkKind("cleanup");
      if (active) throw new Error("请等待当前任务结束");
      const saved = plans.get("cleanup");
      if (
        !saved ||
        saved.plan.id !== planId ||
        now() >= saved.expires ||
        !saved.plan.items.some((item) => item.id === itemId)
      )
        throw new Error("预览已变化，请重新扫描");
      if (typeof services.cleanup.protect !== "function")
        throw new Error("当前清理服务不支持自定义保护");
      const job = beginJob("protection", "execute");
      try {
        const result = await services.cleanup.protect(planId, itemId);
        plans.delete("cleanup");
        views.delete("cleanup");
        return result;
      } finally {
        emit(job, { phase: "idle" });
        if (active === job) active = undefined;
      }
    },
    async listProtected() {
      checkKind("cleanup");
      return services.cleanup.listProtected?.() || [];
    },
    async removeProtection(id) {
      checkKind("cleanup");
      if (active) throw new Error("请等待当前任务结束");
      const job = beginJob("protection", "confirm");
      try {
        if (typeof id !== "string" || id.length > 100)
          throw new Error("无效的保护项标识");
        const all = await services.cleanup.listProtected();
        const item = all.find((value) => value.id === id);
        if (!item) throw new Error("保护项不存在");
        if (
          !(await confirm({
            kind: "protection",
            title: "取消此项自定义保护",
            items: [{ name: item.path || item.name }],
            detail:
              "这不会删除文件；此项会在下次扫描时重新按清理规则评估。内置保护不会改变。",
          }))
        )
          return { cancelled: true };
        if (job.controller.signal.aborted || job.abandoned)
          return { cancelled: true };
        await services.cleanup.removeProtected(id);
        plans.delete("cleanup");
        views.delete("cleanup");
        return { removed: true };
      } finally {
        emit(job, { phase: "idle" });
        if (active === job) active = undefined;
      }
    },
    async execute(kind, planId, selectedIds) {
      checkKind(kind);
      if (active) throw new Error("已有维护操作正在进行，请等待完成");
      if (uncertain)
        throw new Error(
          "上次操作结果未知，请先核查并解除恢复保护，不要重复执行",
        );
      if (
        typeof planId !== "string" ||
        !Array.isArray(selectedIds) ||
        !selectedIds.length ||
        selectedIds.length > MAX_SELECTION ||
        selectedIds.some((id) => typeof id !== "string") ||
        new Set(selectedIds).size !== selectedIds.length
      )
        throw new Error("请选择有效且不重复的预览项目");
      const saved = plans.get(kind);
      if (!saved || saved.plan.id !== planId || now() >= saved.expires)
        throw new Error("预览已过期，请重新扫描");
      const selected = selectedIds.map((id) =>
        saved.plan.items.find((item) => item.id === id),
      );
      if (selected.some((item) => !item || item.enabled !== true))
        throw new Error("包含不允许执行的项目");
      const job = beginJob(kind, "confirm");
      let result;
      try {
        const recovery = await journal.snapshot();
        if (recovery.required) {
          uncertain = true;
          throw new Error(recovery.reason || "需要先核查上次任务");
        }
        if (job.abandoned || job.controller.signal.aborted)
          return { cancelled: true, results: [] };
        const approved = await confirm({
          title: titles[kind],
          items: selected,
          kind,
        });
        if (!approved || job.abandoned || job.controller.signal.aborted)
          return { cancelled: true, results: [] };
        if (now() >= saved.expires) throw new Error("预览已过期，请重新扫描");
        plans.delete(kind);
        await journal.begin({
          id: job.id,
          planId,
          kind,
          phase: "running",
          startedAt: new Date().toISOString(),
          count: selected.length,
          names: selected
            .slice(0, 10)
            .map((item) => String(item.name || "").slice(0, 200)),
        });
        job.persisted = true;
        await audit({
          event: "started",
          operationId: job.id,
          kind,
          planId,
          selected: selected.map(({ id, name }) => ({ id, name })),
        });
        if (job.abandoned || job.controller.signal.aborted) {
          result = {
            cancelled: true,
            results: selected.map((item) => ({
              id: item.id,
              name: item.name,
              status: "skipped",
              message: "执行前已取消",
            })),
          };
        } else {
          job.phase = "execute";
          job.nativeStarted = true;
          emit(job, { completed: 0, total: selected.length });
          try {
            result = await services[kind].execute(planId, selectedIds, {
              signal: job.controller.signal,
              onProgress: (data) => progress(job, data),
            });
          } catch (error) {
            result = unknownResult(
              selected,
              "执行器异常中断，结果无法确认：" + error.message,
            );
          }
        }
        if (!validResult(result, selectedIds))
          result = unknownResult(
            selected,
            "执行器未返回完整有效的逐项结果，请检查系统状态，不要立即重试",
          );
        const succeeded = new Set([
          "success",
          "completed",
          "recycled",
          "reboot-required",
        ]);
        const failures = new Set(["failed", "error"]);
        result.summary = {
          requested: selected.length,
          completed: result.results.filter((item) => succeeded.has(item.status))
            .length,
          failed: result.results.filter((item) => failures.has(item.status))
            .length,
          unknown: result.results.filter((item) => item.status === "unknown")
            .length,
          skipped: result.results.filter(
            (item) =>
              !succeeded.has(item.status) &&
              !failures.has(item.status) &&
              item.status !== "unknown",
          ).length,
          bytesMoved:
            kind === "cleanup" || kind === "files"
              ? result.results
                  .filter((item) => succeeded.has(item.status))
                  .reduce(
                    (total, item) =>
                      total +
                      (selected.find((original) => original.id === item.id)
                        ?.size || 0),
                    0,
                  )
              : null,
        };
        const unknown =
          job.abandoned ||
          result.results.some((item) => item.status === "unknown");
        uncertain ||= unknown;
        if (unknown)
          result.warnings = [
            ...(result.warnings || []),
            "已锁定后续写入，退出或重启也不会解除。请在“操作记录与恢复”中核查后明确解除保护。",
          ];
        try {
          await audit({
            event: "finished",
            operationId: job.id,
            kind,
            planId,
            result,
          });
          await journal.finish(job.id, result, unknown);
        } catch (error) {
          uncertain = true;
          result.warnings = [
            ...(result.warnings || []),
            "结果记录未能可靠保存，已保持恢复锁：" + error.message,
          ];
        }
        views.set(kind, { result: structuredClone(result) });
        return result;
      } catch (error) {
        if (job.persisted && !job.nativeStarted && !job.abandoned) {
          try {
            await journal.finish(
              job.id,
              { cancelled: true, results: [] },
              false,
            );
          } catch {
            uncertain = true;
          }
        }
        views.set(kind, { error: error.message });
        throw error;
      } finally {
        emit(job, { phase: "idle" });
        if (active === job) active = undefined;
      }
    },
  };
}
function createAuditLog(directory, options = {}) {
  const storage = createOperationStore({ directory, ...options });
  return (event) => storage.appendAudit(event);
}
module.exports = { createMaintenanceController, createAuditLog };
