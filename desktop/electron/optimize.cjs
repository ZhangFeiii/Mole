const { randomUUID } = require("node:crypto");

// The main-process runner resolves this allowlisted name to windows/optimize.ps1.
const SCRIPT_NAME = "optimize";
const PLAN_TTL_MS = 5 * 60 * 1000;
const PROBE_TIMEOUT_MS = 15 * 1000;
const DNS_TIMEOUT_MS = 30 * 1000;
const DISK_TIMEOUT_MS = 30 * 60 * 1000;

const OPERATIONS = Object.freeze({
  DNS: "dns-cache",
  DISKS: "optimize-disks",
});

const NATIVE_OPERATIONS = Object.freeze({
  PROBE: "probe",
  DNS: "flush-dns",
  DISKS: "optimize-disks",
});

const OPERATION_NAMES = Object.freeze({
  [OPERATIONS.DNS]: "刷新 DNS 缓存",
  [OPERATIONS.DISKS]: "优化本地磁盘",
});

function assertRunner(runPowerShell) {
  if (typeof runPowerShell !== "function")
    throw new TypeError("runPowerShell 必须是函数");
}

function parseNativeResult(value) {
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      throw new Error("PowerShell 返回的数据不是有效 JSON");
    }
  }
  if (!value || typeof value !== "object")
    throw new Error("PowerShell 返回了无效结果");
  return value;
}

function cleanMessage(value, fallback) {
  if (typeof value === "string" && value.trim()) return value.trim();
  return fallback;
}

function normalizeDrive(drive) {
  if (typeof drive === "string") {
    const match = /^([a-z]):?$/i.exec(drive.trim());
    return match ? `${match[1].toUpperCase()}:` : null;
  }
  if (!drive || typeof drive !== "object") return null;
  const value = drive.driveLetter ?? drive.letter ?? drive.deviceId;
  return normalizeDrive(value);
}

function normalizeDrives(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const drives = [];
  for (const drive of value) {
    const normalized = normalizeDrive(drive);
    if (normalized && !seen.has(normalized)) {
      seen.add(normalized);
      drives.push(normalized);
    }
  }
  return drives.sort();
}

function normalizeProbe(value) {
  const result = parseNativeResult(value);
  return {
    ok: result.ok !== false,
    isAdmin: result.isAdmin === true,
    dnsAvailable: result.dnsAvailable === true || result.hasDnsCommand === true,
    optimizeAvailable:
      result.optimizeAvailable === true || result.hasOptimizeCommand === true,
    drives: normalizeDrives(result.drives || result.volumes),
    message: cleanMessage(result.message, "未能读取 Windows 维护能力"),
    errorCode:
      typeof result.errorCode === "string" ? result.errorCode : undefined,
  };
}

function isNativeSuccess(result) {
  return result && result.ok === true;
}

function classifyFailure(error, fallback = "操作失败") {
  const message = cleanMessage(error?.message ?? error, fallback);
  const code =
    typeof error?.errorCode === "string"
      ? error.errorCode
      : typeof error?.code === "string"
        ? error.code
        : "";
  if (code === "OUTCOME_UNKNOWN" || code === "unknown")
    return {
      status: "unknown",
      message: `${message}；操作结果未知，请检查系统状态后再决定是否重试`,
    };
  if (
    code === "permission-denied" ||
    /权限|管理员|administrator|access is denied|拒绝访问/i.test(message)
  )
    return { status: "permission-denied", message };
  if (
    code === "unsupported" ||
    /不支持|不可用|not supported|not available/i.test(message)
  )
    return { status: "unsupported", message };
  return { status: "failed", message };
}

function makeItem(id, values = {}) {
  return {
    id,
    name: OPERATION_NAMES[id],
    description: values.description,
    enabled: values.enabled === true,
    ...(values.reason ? { reason: values.reason } : {}),
    ...(values.requiresAdmin ? { requiresAdmin: true } : {}),
    ...(values.impact ? { impact: values.impact } : {}),
    ...(values.targets ? { targets: values.targets } : {}),
  };
}

function unsupportedItem(id, reason) {
  return makeItem(id, {
    enabled: false,
    reason,
    requiresAdmin: id === OPERATIONS.DISKS,
    description:
      id === OPERATIONS.DNS
        ? "清除 Windows DNS 客户端缓存；不会删除用户文件。"
        : "按 Windows 默认策略优化固定本地磁盘；SSD 通常执行 TRIM，HDD 可能执行碎片整理。",
    impact: "当前环境不满足安全条件；不会执行维护操作。",
  });
}

function createOptimizeService({
  runPowerShell,
  platform = process.platform,
} = {}) {
  assertRunner(runPowerShell);

  const plans = new Map();

  function removeExpired(now = Date.now()) {
    for (const [id, plan] of plans) {
      if (plan.expiresAtMs <= now) plans.delete(id);
    }
  }

  async function callNative(operation, request, timeoutMs) {
    const value = await runPowerShell(
      SCRIPT_NAME,
      { operation, ...request },
      { timeoutMs },
    );
    return parseNativeResult(value);
  }

  function makeUnsupportedPlan(now, reason) {
    const id = randomUUID();
    const expiresAtMs = now + PLAN_TTL_MS;
    const plan = {
      id,
      createdAtMs: now,
      expiresAtMs,
      probe: null,
      items: [
        unsupportedItem(OPERATIONS.DNS, reason),
        unsupportedItem(OPERATIONS.DISKS, reason),
      ],
    };
    plans.set(id, plan);
    return formatPlan(plan, []);
  }

  function formatPlan(plan, warnings) {
    return {
      id: plan.id,
      createdAt: new Date(plan.createdAtMs).toISOString(),
      expiresAt: new Date(plan.expiresAtMs).toISOString(),
      items: plan.items.map((item) => ({
        ...item,
        ...(Array.isArray(item.targets) ? { targets: [...item.targets] } : {}),
      })),
      warnings: [...warnings],
    };
  }

  function buildWindowsItems(probe) {
    const probeFailure = !probe.ok;
    const dnsReason = probeFailure
      ? probe.message
      : !probe.dnsAvailable
        ? "Windows DnsClient 模块不可用"
        : undefined;
    const diskReason = probeFailure
      ? probe.message
      : !probe.optimizeAvailable
        ? "Windows Storage 模块不可用"
        : probe.drives.length === 0
          ? "未检测到固定本地磁盘"
          : !probe.isAdmin
            ? "需要以管理员权限运行应用；不会自动提权"
            : undefined;
    const diskTargets =
      probe.drives.length > 0 ? probe.drives.join(", ") : "无";
    return [
      makeItem(OPERATIONS.DNS, {
        enabled: !dnsReason,
        reason: dnsReason,
        description: "清除 Windows DNS 客户端缓存；不会删除用户文件。",
        impact: "正在进行的域名解析可能需要重新建立，通常很快完成。",
      }),
      makeItem(OPERATIONS.DISKS, {
        enabled: !diskReason,
        reason: diskReason,
        requiresAdmin: true,
        targets: probe.drives,
        description: `仅对本次预览列出的固定本地磁盘（${diskTargets}）调用 Windows 默认优化策略；SSD 通常执行 TRIM，HDD 可能执行分析/碎片整理。`,
        impact:
          "可能占用磁盘与 CPU，持续时间取决于磁盘类型和容量；不会删除文件、修改服务或改变电源设置。",
      }),
    ];
  }

  async function preview() {
    const now = Date.now();
    removeExpired(now);
    if (platform !== "win32")
      return makeUnsupportedPlan(now, "维护操作仅支持 Windows");

    let probe;
    const warnings = [];
    try {
      probe = normalizeProbe(
        await callNative(NATIVE_OPERATIONS.PROBE, {}, PROBE_TIMEOUT_MS),
      );
      if (!probe.ok) warnings.push(probe.message);
    } catch (error) {
      probe = {
        ok: false,
        isAdmin: false,
        dnsAvailable: false,
        optimizeAvailable: false,
        drives: [],
        message: cleanMessage(
          error?.message ?? error,
          "无法读取 Windows 维护能力",
        ),
      };
      warnings.push(`无法读取 Windows 维护能力：${probe.message}`);
    }

    const id = randomUUID();
    const plan = {
      id,
      createdAtMs: now,
      expiresAtMs: now + PLAN_TTL_MS,
      probe,
      items: buildWindowsItems(probe),
    };
    plans.set(id, plan);
    return formatPlan(plan, warnings);
  }

  function createResult(id, name, status, message, extra = {}) {
    return { id, name, status, message, ...extra };
  }

  function statusFromNative(result, fallbackMessage) {
    if (isNativeSuccess(result))
      return {
        status: "completed",
        message: cleanMessage(result.message, fallbackMessage),
      };
    return classifyFailure(
      {
        errorCode: result?.errorCode,
        message: result?.message,
      },
      fallbackMessage,
    );
  }

  async function execute(planId, selectedIds) {
    const now = Date.now();
    removeExpired(now);
    if (typeof planId !== "string" || !plans.has(planId))
      throw new Error("优化预览不存在或已过期，请重新预览");
    if (!Array.isArray(selectedIds))
      throw new TypeError("selectedIds 必须是数组");

    const plan = plans.get(planId);
    if (selectedIds.length === 0) throw new Error("至少选择一项维护操作");
    if (selectedIds.some((id) => typeof id !== "string" || !id.trim()))
      throw new TypeError("selectedIds 只能包含非空字符串 ID");
    if (new Set(selectedIds).size !== selectedIds.length)
      throw new Error("selectedIds 不得重复");
    const selected = [...selectedIds];
    const selectedItems = selected.map((id) => {
      const item = plan.items.find((candidate) => candidate.id === id);
      if (!item) throw new Error("所选操作不在此预览计划中");
      return item;
    });
    plans.delete(planId);
    const results = [];

    if (platform !== "win32") {
      for (const id of selected) {
        const item = plan.items.find((candidate) => candidate.id === id);
        results.push(
          createResult(
            id,
            item?.name || "未知操作",
            "unsupported",
            "维护操作仅支持 Windows",
          ),
        );
      }
      return { planId, results, warnings: [] };
    }

    // A failed probe or a disabled item must never become executable merely
    // because the machine changes after preview. Return before the second
    // native probe so no maintenance command can run for this selection.
    if (!plan.probe || plan.probe.ok !== true) {
      const message = `预览时安全检查失败：${
        plan.probe?.message || "无法确认 Windows 维护能力"
      }；请重新预览`;
      for (const item of selectedItems)
        results.push(createResult(item.id, item.name, "failed", message));
      return {
        planId,
        results,
        warnings: ["未执行维护操作：预览安全检查失败"],
      };
    }
    const disabledItems = selectedItems.filter((item) => !item.enabled);
    if (disabledItems.length > 0) {
      const disabledIds = new Set(disabledItems.map((item) => item.id));
      for (const item of selectedItems) {
        if (disabledIds.has(item.id)) {
          const status =
            item.requiresAdmin &&
            /权限|管理员|administrator/i.test(item.reason || "")
              ? "permission-denied"
              : "unsupported";
          results.push(
            createResult(
              item.id,
              item.name,
              status,
              item.reason || "该操作未通过预览安全检查；请重新预览",
            ),
          );
        } else {
          results.push(
            createResult(
              item.id,
              item.name,
              "failed",
              "所选计划包含未启用操作，未执行任何维护操作；请重新预览",
            ),
          );
        }
      }
      return {
        planId,
        results,
        warnings: ["未执行维护操作：所选计划包含未启用操作"],
      };
    }

    let probe;
    try {
      probe = normalizeProbe(
        await callNative(NATIVE_OPERATIONS.PROBE, {}, PROBE_TIMEOUT_MS),
      );
    } catch (error) {
      const failure = classifyFailure(error, "无法重新检查安全条件");
      for (const id of selected) {
        const item = plan.items.find((candidate) => candidate.id === id);
        results.push(
          createResult(
            id,
            item?.name || "未知操作",
            failure.status,
            failure.message,
          ),
        );
      }
      return {
        planId,
        results,
        warnings: ["未执行维护操作：安全条件检查失败"],
      };
    }
    if (probe.ok !== true) {
      const message = `无法确认当前 Windows 维护能力：${probe.message}；未执行任何维护操作`;
      for (const item of selectedItems)
        results.push(createResult(item.id, item.name, "failed", message));
      return {
        planId,
        results,
        warnings: ["未执行维护操作：当前安全条件检查失败"],
      };
    }

    for (const id of selected) {
      const item = plan.items.find((candidate) => candidate.id === id);
      if (results.some((result) => result.status === "unknown")) {
        results.push(
          createResult(
            id,
            item?.name || "维护操作",
            "skipped",
            "前一项维护结果未知，未继续执行；请先检查 Windows 状态",
          ),
        );
        continue;
      }
      if (!item) {
        results.push(
          createResult(id, "未知操作", "unsupported", "操作不在此预览计划中"),
        );
        continue;
      }
      if (id === OPERATIONS.DNS) {
        if (!probe.dnsAvailable) {
          results.push(
            createResult(
              id,
              item.name,
              "unsupported",
              "Windows DnsClient 模块不可用",
            ),
          );
          continue;
        }
        try {
          const native = await callNative(
            NATIVE_OPERATIONS.DNS,
            {},
            DNS_TIMEOUT_MS,
          );
          const status = statusFromNative(native, "DNS 缓存刷新完成");
          results.push(
            createResult(id, item.name, status.status, status.message),
          );
        } catch (error) {
          const failure = classifyFailure(error, "刷新 DNS 缓存失败");
          results.push(
            createResult(id, item.name, failure.status, failure.message),
          );
        }
        continue;
      }

      if (id === OPERATIONS.DISKS) {
        if (!probe.optimizeAvailable || probe.drives.length === 0) {
          results.push(
            createResult(
              id,
              item.name,
              "unsupported",
              "Windows Storage 模块不可用或未检测到固定本地磁盘",
            ),
          );
          continue;
        }
        if (!probe.isAdmin) {
          results.push(
            createResult(
              id,
              item.name,
              "permission-denied",
              "需要以管理员权限运行应用；不会自动提权",
            ),
          );
          continue;
        }
        const plannedTargets = normalizeDrives(item.targets);
        const currentTargets = probe.drives;
        const currentSet = new Set(currentTargets);
        const plannedSet = new Set(plannedTargets);
        const targets = plannedTargets.filter((target) =>
          currentSet.has(target),
        );
        const skippedTargets = plannedTargets.filter(
          (target) => !currentSet.has(target),
        );
        const unlistedCurrentTargets = currentTargets.filter(
          (target) => !plannedSet.has(target),
        );
        if (targets.length === 0) {
          results.push(
            createResult(
              id,
              item.name,
              "unsupported",
              "预览中的固定本地磁盘已变化，未执行任何磁盘优化；请重新预览",
              {
                skippedTargets,
                unlistedCurrentTargets,
              },
            ),
          );
          continue;
        }
        try {
          const native = await callNative(
            NATIVE_OPERATIONS.DISKS,
            { driveLetters: targets },
            DISK_TIMEOUT_MS,
          );
          const status = statusFromNative(native, "本地磁盘优化完成");
          const targetWarning =
            skippedTargets.length > 0 || unlistedCurrentTargets.length > 0
              ? `；目标已变化，仅执行预览目标与当前固定本地盘的交集（${targets.join(", ")}），跳过变化目标；请重新预览`
              : "";
          results.push(
            createResult(
              id,
              item.name,
              status.status,
              `${status.message}${targetWarning}`,
              {
                ...(Array.isArray(native?.drives)
                  ? { drives: native.drives }
                  : {}),
                targets,
                ...(skippedTargets.length > 0 ? { skippedTargets } : {}),
                ...(unlistedCurrentTargets.length > 0
                  ? { unlistedCurrentTargets }
                  : {}),
              },
            ),
          );
        } catch (error) {
          const failure = classifyFailure(error, "本地磁盘优化失败");
          results.push(
            createResult(id, item.name, failure.status, failure.message),
          );
        }
        continue;
      }
      results.push(createResult(id, item.name, "unsupported", "操作不受支持"));
    }

    return { planId, results, warnings: [] };
  }

  return Object.freeze({ preview, execute });
}

module.exports = {
  createOptimizeService,
  OPERATIONS,
  NATIVE_OPERATIONS,
  PLAN_TTL_MS,
};
