const fs = require("node:fs/promises");
const path = require("node:path");

const kinds = Object.freeze(["cleanup", "applications", "optimize"]);
const titles = Object.freeze({
  cleanup: "将所选缓存移入回收站",
  applications: "卸载所选软件",
  optimize: "执行所选维护操作",
});

function createMaintenanceController({
  services,
  confirm,
  audit,
  platform = process.platform,
  now = Date.now,
}) {
  const plans = new Map();
  let busy = false;
  let executing = false;
  let uncertain = false;
  let activeOperation;
  function checkKind(kind) {
    if (!kinds.includes(kind))
      throw new Error("Unsupported maintenance operation");
    if (platform !== "win32")
      throw new Error("写入功能仅在 Windows 可用；当前系统保留只读分析和监控");
  }
  return {
    isExecuting: () => executing,
    async abandon() {
      if (!activeOperation) return;
      activeOperation.abandoned = true;
      uncertain = true;
      services[activeOperation.kind].cancel?.();
      await audit({
        event: "abandoned",
        kind: activeOperation.kind,
        planId: activeOperation.planId,
        message: "用户明确选择退出；已启动的原生操作可能继续，结果未知",
      });
    },
    async preview(kind) {
      checkKind(kind);
      if (busy) throw new Error("已有维护操作正在进行");
      busy = true;
      try {
        const plan = await services[kind].preview();
        if (!plan || typeof plan.id !== "string" || !Array.isArray(plan.items))
          throw new Error("Invalid maintenance plan");
        if (
          plan.items.some((item) => !item || typeof item.id !== "string") ||
          new Set(plan.items.map((item) => item.id)).size !== plan.items.length
        )
          throw new Error("Invalid maintenance items");
        plans.set(kind, {
          plan: structuredClone(plan),
          expires: now() + 5 * 60 * 1000,
        });
        return plan;
      } finally {
        busy = false;
      }
    },
    async execute(kind, planId, selectedIds) {
      checkKind(kind);
      if (busy) throw new Error("已有维护操作正在进行，请等待完成");
      if (uncertain)
        throw new Error(
          "上次操作结果未知，请先检查 Windows 中的运行状态，再重启应用后继续。不要重复执行尚未结束的操作。",
        );
      if (
        typeof planId !== "string" ||
        !Array.isArray(selectedIds) ||
        selectedIds.length === 0 ||
        selectedIds.length > 1000 ||
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
      busy = true;
      executing = true;
      const operation = { kind, planId, abandoned: false };
      activeOperation = operation;
      try {
        const approved = await confirm({
          title: titles[kind],
          items: selected,
          kind,
        });
        if (!approved || operation.abandoned)
          return { cancelled: true, results: [] };
        if (now() >= saved.expires) throw new Error("预览已过期，请重新扫描");
        // Consume before calling native code: repeated clicks cannot replay a plan.
        plans.delete(kind);
        await audit({
          event: "started",
          kind,
          planId,
          selected: selected.map(({ id, name }) => ({ id, name })),
        });
        if (operation.abandoned) return { cancelled: true, results: [] };
        let result;
        try {
          result = await services[kind].execute(planId, selectedIds);
        } catch (error) {
          if (error.code === "OUTCOME_UNKNOWN") uncertain = true;
          try {
            await audit({
              event: "failed",
              kind,
              planId,
              message: error.message,
            });
          } catch {
            /* Preserve the execution failure. */
          }
          throw error;
        }
        if (
          !result ||
          !Array.isArray(result.results) ||
          result.results.length !== selectedIds.length ||
          result.results.some(
            (item) =>
              !item ||
              !selectedIds.includes(item.id) ||
              typeof item.status !== "string" ||
              !item.status,
          ) ||
          new Set(result.results.map((item) => item.id)).size !==
            result.results.length
        ) {
          result = {
            results: selected.map((item) => ({
              id: item.id,
              name: item.name,
              status: "unknown",
              message:
                "原生操作未返回完整有效的逐项结果，请检查 Windows 状态，不要立即重复执行",
            })),
            warnings: [],
          };
        }
        if (result.results.some((item) => item.status === "unknown")) {
          uncertain = true;
          result = {
            ...result,
            warnings: [
              ...(result.warnings || []),
              "有操作结果未知，已锁定后续写入。请先在 Windows 检查是否仍在执行，再重启应用。",
            ],
          };
        }
        try {
          await audit({ event: "finished", kind, planId, result });
        } catch {
          result = {
            ...result,
            warnings: [
              ...(result.warnings || []),
              "操作已返回，但结果日志写入失败；请保留当前界面结果。",
            ],
          };
        }
        return result;
      } finally {
        busy = false;
        executing = false;
        activeOperation = undefined;
      }
    },
  };
}

function createAuditLog(directory) {
  return async (event) => {
    await fs.mkdir(directory, { recursive: true });
    const date = new Date();
    await fs.appendFile(
      path.join(
        directory,
        `maintenance-${date.toISOString().slice(0, 10)}.jsonl`,
      ),
      JSON.stringify({ at: date.toISOString(), ...event }) + "\n",
      { mode: 0o600 },
    );
  };
}
module.exports = { createMaintenanceController, createAuditLog };
