"use strict";

const crypto = require("node:crypto");

// This is the only script name accepted by the application service.  The main
// process runner is expected to apply the same allow-list before it resolves
// the packaged PowerShell file.
// The runner's allow-list uses logical script names, not filesystem paths.
// It maps this name to the packaged desktop/windows/applications.ps1 file.
const APPLICATIONS_SCRIPT = "applications";
const PLAN_TTL_MS = 5 * 60 * 1000;
const MAX_PLANS = 8;
const QUERY_TIMEOUT_MS = 30 * 1000;
// Vendor uninstallers may show their own confirmation/UAC UI.  Keep the
// worker alive long enough to report its final exit code, while the plan is
// still consumed exactly once by the service.
const EXECUTE_TIMEOUT_MS = 10 * 60 * 1000;

const EXECUTION_STATUSES = new Set([
  "success",
  "reboot-required",
  "uac-cancelled",
  "unknown",
  "failed",
  "not-found",
  "identity-changed",
  "blocked",
  "rejected",
  "skipped",
]);

const PROTECTED_NAME_PATTERNS = [
  /^microsoft windows(?:$|\s)/i,
  /^windows feature experience pack$/i,
  /^microsoft edge(?:$| webview2)/i,
  /^windows security(?:$|\s)/i,
  /^microsoft visual c\+\+/i,
  /^microsoft \.net/i,
  /^\.net(?: desktop)? runtime/i,
  /^microsoft update health tools$/i,
  /^nvidia(?:$|\s).*driver/i,
  /^amd(?:$|\s).*software/i,
  /^intel(?:$|\s).*driver/i,
  /\bdriver\b/i,
  /^(?:powershell|python|node\.js|ruby|perl|php)(?:$|\s)/i,
  /^(?:windows terminal|windows subsystem for linux|wsl)(?:$|\s)/i,
];

const PROTECTED_APPX_NAMES = new Set([
  "Microsoft.WindowsStore",
  "Microsoft.DesktopAppInstaller",
  "Microsoft.Windows.ShellExperienceHost",
  "Microsoft.Windows.StartMenuExperienceHost",
  "MicrosoftWindows.Client.CBS",
  "MicrosoftWindows.UndockedDevKit",
  "Microsoft.XboxGameCallableUI",
]);

function makeError(message, code = "APPLICATIONS_ERROR") {
  const error = new Error(message);
  error.code = code;
  return error;
}

function safeText(value, limit = 4096) {
  if (value === undefined || value === null) return "";
  return String(value)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/[\r\n]+/g, " ")
    .slice(0, limit)
    .trim();
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function getNow(clock) {
  const value = typeof clock === "function" ? clock() : Date.now();
  if (value instanceof Date) return value.getTime();
  const number = Number(value);
  return Number.isFinite(number) ? number : Date.now();
}

function makePlanId() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return crypto.randomBytes(16).toString("hex");
}

function hashIdentity(value) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex")
    .slice(0, 24);
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function parseRunnerPayload(value) {
  if (Buffer.isBuffer(value)) value = value.toString("utf8");
  if (typeof value === "string") {
    const lines = value
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    if (lines.length !== 1)
      throw makeError("PowerShell 返回了多行或空响应", "INVALID_RESPONSE");
    try {
      value = JSON.parse(lines[0]);
    } catch (error) {
      throw makeError(
        `PowerShell 返回了无效 JSON：${error.message}`,
        "INVALID_RESPONSE",
      );
    }
  } else if (isRecord(value) && typeof value.stdout === "string") {
    return parseRunnerPayload(value.stdout);
  }
  if (!isRecord(value))
    throw makeError("PowerShell 返回格式无效", "INVALID_RESPONSE");
  if (value.ok === false) {
    const message = isRecord(value.error) ? value.error.message : value.error;
    throw makeError(
      safeText(message) || "PowerShell 操作失败",
      "POWERSHELL_ERROR",
    );
  }
  return value;
}

function normalizeWarnings(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((warning) => safeText(warning, 1000))
    .filter(Boolean)
    .slice(0, 32);
}

function normalizeKind(item) {
  const explicit = safeText(item.kind || item.source, 32).toLowerCase();
  if (explicit === "appx" || explicit === "uwp" || explicit === "windowsstore")
    return "appx";
  if (explicit === "win32" || explicit === "registry") return "win32";
  if (item.packageFullName || item.identity?.packageFullName) return "appx";
  return "win32";
}

function normalizeIdentity(item, kind) {
  const source = isRecord(item.identity) ? item.identity : item;
  const allowed =
    kind === "appx"
      ? [
          "packageFullName",
          "name",
          "publisher",
          "version",
          "packageFamilyName",
          "installLocation",
          "signatureKind",
          "isFramework",
          "isResourcePackage",
          "isPartiallyStaged",
          "isOptionalPackage",
          "isBundle",
          "nonRemovable",
          "packageStatus",
        ]
      : [
          "registryPath",
          "registryView",
          "scope",
          "displayName",
          "publisher",
          "version",
          "productCode",
          "uninstallHash",
          "installLocation",
          "systemComponent",
          "noRemove",
          "releaseType",
          "parentKeyName",
          "uninstallExecutableHash",
          "uninstallExecutableLength",
          "uninstallExecutableLastWriteUtc",
          "msiProductCode",
        ];
  const identity = {};
  for (const key of allowed) {
    if (Object.prototype.hasOwnProperty.call(source, key)) {
      if (typeof source[key] === "boolean") identity[key] = source[key];
      else identity[key] = safeText(source[key]);
    }
  }
  // A small opaque key is useful for test doubles and future registry views;
  // it is still kept inside the server-side plan and never treated as a path.
  if (!identity.registryPath && !identity.packageFullName && source.key) {
    const key = safeText(source.key, 4096);
    if (key) identity.key = key;
  }
  return identity;
}

function normalizeUninstall(item, kind) {
  if (kind === "appx") return null;
  const source = isRecord(item.uninstall) ? item.uninstall : null;
  if (!source) return null;
  const executable = safeText(
    source.executable || source.filePath || source.path,
    4096,
  );
  let argumentsValue = source.arguments;
  if (Array.isArray(argumentsValue)) {
    argumentsValue = argumentsValue.map((argument) => safeText(argument, 2048));
  } else {
    argumentsValue = safeText(argumentsValue, 8192);
  }
  if (!executable) return null;
  return { executable, arguments: argumentsValue };
}

function normalizeProcessNames(value) {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value
        .map((name) => safeText(name, 128))
        .filter((name) => /^[A-Za-z0-9._-]{1,128}$/.test(name)),
    ),
  ].slice(0, 16);
}

function hasDangerousUninstall(uninstall) {
  if (!uninstall) return false;
  const executable = uninstall.executable;
  const leaf = executable.split(/[\\/]/).pop();
  const isMsiExec = /^msiexec(?:\.exe)?$/i.test(leaf);
  if (!isMsiExec && !/^[A-Za-z]:[\\/]/.test(executable)) return true;
  if (/^(?:\\\\|\/\/|\\\\\?\\|\\\\\.\\)/.test(executable)) return true;
  const argumentsValue = Array.isArray(uninstall.arguments)
    ? uninstall.arguments.join(" ")
    : uninstall.arguments;
  const command = `${uninstall.executable} ${argumentsValue || ""}`;
  return (
    /[\u0000\r\n;&|<>`]/.test(command) ||
    /(?:^|[\\/\s])(?:cmd|cmd\.exe|powershell|powershell\.exe|pwsh|pwsh\.exe|mshta|mshta\.exe|wscript|wscript\.exe|cscript|cscript\.exe|rundll32|rundll32\.exe|regsvr32|regsvr32\.exe)(?:$|[\s])/i.test(
      command,
    ) ||
    /\.(?:bat|cmd|ps1|psm1|vbs|vbe|js|jse|hta|sh|bash)(?:$|[\s"'])/i.test(
      command,
    )
  );
}

function isProtected(item, kind) {
  const name = safeText(item.name);
  if (kind === "win32") {
    const identity = isRecord(item.identity) ? item.identity : {};
    if (/^(?:1|true|yes)$/i.test(safeText(identity.systemComponent)))
      return true;
    if (/^(?:1|true|yes)$/i.test(safeText(identity.noRemove))) return true;
    if (
      /^(?:update|security update|hotfix|component update|operating system|system)$/i.test(
        safeText(identity.releaseType),
      )
    )
      return true;
    if (safeText(identity.parentKeyName)) return true;
  }
  if (PROTECTED_NAME_PATTERNS.some((pattern) => pattern.test(name)))
    return true;
  if (kind === "appx") {
    const identity = isRecord(item.identity) ? item.identity : {};
    const appxName = safeText(identity.name || item.packageName || item.name);
    if (PROTECTED_APPX_NAMES.has(appxName)) return true;
    if (identity.isFramework === true || identity.isResourcePackage === true)
      return true;
    if (identity.isPartiallyStaged === true || identity.nonRemovable === true)
      return true;
    if (
      identity.packageStatus &&
      safeText(identity.packageStatus).toLowerCase() !== "ok"
    )
      return true;
    if (/^(?:Microsoft\.Windows|MicrosoftWindows\.)/i.test(appxName))
      return true;
    if (
      /^(?:microsoft\.(?:powershell|vclibs|net\.|ui\.xaml)|powershell|windows\.terminal|microsoft\.windows\wsl)/i.test(
        appxName,
      ) ||
      /(?:framework|runtime|driver|interpreter)/i.test(appxName)
    )
      return true;
    if (/\b(?:framework|resource)\b/i.test(safeText(item.description)))
      return true;
  }
  return (
    item.protected === true || item.system === true || item.driver === true
  );
}

function normalizeItem(raw, seenIds) {
  if (!isRecord(raw)) return null;
  const kind = normalizeKind(raw);
  const identity = normalizeIdentity(raw, kind);
  const uninstall = normalizeUninstall(raw, kind);
  const name = safeText(
    raw.name || raw.displayName || identity.displayName,
    512,
  );
  if (!name) return null;

  const suppliedId = safeText(raw.id, 128);
  const identityKey = { kind, identity, name };
  let id = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(suppliedId)
    ? suppliedId
    : `app-${hashIdentity(identityKey)}`;
  if (seenIds.has(id)) {
    const base = id.slice(0, 120);
    let suffix = 2;
    while (seenIds.has(`${base}-${suffix}`)) suffix += 1;
    id = `${base}-${suffix}`;
  }
  seenIds.add(id);

  const protectedItem = isProtected(
    { ...raw, name, identity, description: raw.description },
    kind,
  );
  const knownProcessNames = normalizeProcessNames(raw.knownProcessNames);
  const running = raw.running === true;
  const identityValid =
    kind === "appx"
      ? Boolean(identity.packageFullName)
      : Boolean(identity.registryPath || identity.key);
  const executableIdentityValid =
    kind === "appx" || Boolean(identity.uninstallExecutableHash);
  const uninstallValid = kind === "appx" || Boolean(uninstall);
  let enabled =
    raw.enabled === true &&
    identityValid &&
    executableIdentityValid &&
    uninstallValid;
  let reason = safeText(raw.reason, 1000);
  if (protectedItem) {
    enabled = false;
    reason = reason || "系统、运行时、驱动或框架项目受保护";
  } else if (running) {
    enabled = false;
    reason = reason || "软件正在运行，请先退出后再卸载";
  } else if (!identityValid) {
    enabled = false;
    reason = reason || "缺少可重新验证的软件身份";
  } else if (!uninstallValid) {
    enabled = false;
    reason = reason || "没有可安全解析的官方卸载程序";
  } else if (hasDangerousUninstall(uninstall)) {
    enabled = false;
    reason = "卸载程序包含不允许的脚本或 shell 组件";
  } else if (!executableIdentityValid) {
    enabled = false;
    reason = reason || "缺少卸载程序文件指纹，已停止卸载";
  } else if (!raw.enabled) {
    enabled = false;
    reason = reason || "PowerShell 未将此项目标记为可安全卸载";
  }

  const publicItem = {
    id,
    name,
    description: safeText(raw.description || raw.comments, 1000),
    publisher: safeText(raw.publisher || identity.publisher, 512),
    version: safeText(raw.version || identity.version, 256),
    enabled,
    kind,
    source: kind === "appx" ? "appx" : "registry",
  };
  for (const key of ["scope", "architecture", "installDate", "sizeBytes"]) {
    if (raw[key] === undefined || raw[key] === null) continue;
    if (key === "sizeBytes") {
      const size = Number(raw[key]);
      if (Number.isFinite(size) && size >= 0)
        publicItem[key] = Math.floor(size);
    } else {
      const value = safeText(raw[key], 512);
      if (value) publicItem[key] = value;
    }
  }
  if (raw.requiresElevation === true) publicItem.requiresElevation = true;
  if (typeof raw.running === "boolean") publicItem.running = running;
  if (Array.isArray(raw.knownProcessNames))
    publicItem.knownProcessNames = knownProcessNames;
  if (protectedItem) publicItem.protected = true;
  if (!enabled && reason) publicItem.reason = reason;

  return {
    publicItem,
    id,
    name,
    kind,
    identity,
    uninstall,
  };
}

function normalizeExecutionStatus(value) {
  const status = safeText(value, 64).toLowerCase();
  return EXECUTION_STATUSES.has(status) ? status : "failed";
}

function normalizeResult(raw, fallback, missingStatus = "unknown") {
  if (!isRecord(raw)) {
    return {
      id: fallback.id,
      name: fallback.name,
      status: missingStatus,
      message:
        missingStatus === "skipped"
          ? "前一项结果未知，未继续执行；请先检查 Windows 状态"
          : "原生卸载未返回完整逐项结果，结果未知；请先检查 Windows 状态",
    };
  }
  const source = isRecord(raw) ? raw : {};
  const result = {
    id: fallback.id,
    name: fallback.name,
    status: normalizeExecutionStatus(source.status),
    message: safeText(source.message, 2000) || "卸载程序未提供结果说明",
  };
  if (Number.isInteger(source.exitCode)) result.exitCode = source.exitCode;
  if (source.rebootRequired === true || result.status === "reboot-required")
    result.rebootRequired = true;
  return result;
}

function makeUnsupportedPlan(clock) {
  const createdAt = getNow(clock);
  return {
    id: makePlanId(),
    createdAt,
    expiresAt: createdAt + PLAN_TTL_MS,
    items: [],
    warnings: ["软件管理仅支持 Windows；当前平台不会执行 PowerShell 操作"],
  };
}

function createApplicationsService(options = {}) {
  const {
    runPowerShell,
    platform = process.platform,
    planTtlMs = PLAN_TTL_MS,
  } = options;
  const clock = options.now || options.clock || (() => Date.now());
  const plans = new Map();

  function prunePlans(now = getNow(clock)) {
    for (const [id, plan] of plans) {
      if (plan.expiresAt <= now) plans.delete(id);
    }
    while (plans.size > MAX_PLANS) {
      const oldest = plans.keys().next().value;
      if (oldest === undefined) break;
      plans.delete(oldest);
    }
  }

  async function invoke(request, timeoutMs) {
    if (typeof runPowerShell !== "function")
      throw makeError("未配置 Windows PowerShell 执行器", "RUNNER_MISSING");
    let response;
    try {
      response = await runPowerShell(APPLICATIONS_SCRIPT, request, {
        timeoutMs,
      });
    } catch (error) {
      const code =
        error?.code === "OUTCOME_UNKNOWN" ? "OUTCOME_UNKNOWN" : "RUNNER_FAILED";
      const wrapped = makeError(
        `Windows 软件服务不可用：${safeText(error?.message || error)}`,
        code,
      );
      throw wrapped;
    }
    try {
      return parseRunnerPayload(response);
    } catch (error) {
      // A broken/truncated response does not prove that a vendor process did
      // not start.  Preserve the conservative outcome for the controller.
      if (error.code === "INVALID_RESPONSE") {
        throw makeError(error.message, "OUTCOME_UNKNOWN");
      }
      throw error;
    }
  }

  async function preview() {
    if (platform !== "win32") return makeUnsupportedPlan(clock);
    const createdAt = getNow(clock);
    prunePlans(createdAt);
    const payload = await invoke({ action: "query" }, QUERY_TIMEOUT_MS);
    const seenIds = new Set();
    const privateItems = [];
    for (const raw of Array.isArray(payload.items) ? payload.items : []) {
      const item = normalizeItem(raw, seenIds);
      if (item) privateItems.push(item);
    }
    const id = makePlanId();
    const expiresAt =
      createdAt + Math.max(1000, Number(planTtlMs) || PLAN_TTL_MS);
    const plan = {
      id,
      createdAt,
      expiresAt,
      items: privateItems,
      executing: false,
    };
    plans.set(id, plan);
    prunePlans(createdAt);
    return {
      id,
      createdAt,
      expiresAt,
      items: privateItems.map((item) => cloneJson(item.publicItem)),
      warnings: normalizeWarnings(payload.warnings),
    };
  }

  async function execute(planId, selectedIds, options = {}) {
    if (platform !== "win32")
      throw makeError("当前平台不支持实际软件卸载", "UNSUPPORTED_PLATFORM");
    if (typeof planId !== "string" || !planId)
      throw makeError("无效的软件计划 ID", "INVALID_PLAN");
    if (!Array.isArray(selectedIds) || selectedIds.length === 0)
      throw makeError("selectedIds 必须是数组", "INVALID_SELECTION");
    const signal = isRecord(options) ? options.signal : undefined;
    const onProgress = isRecord(options) ? options.onProgress : undefined;
    const selectionSet = new Set();
    for (const id of selectedIds) {
      if (
        typeof id !== "string" ||
        id.length === 0 ||
        id.length > 128 ||
        id.trim() !== id ||
        /[\u0000-\u001f\u007f]/.test(id)
      )
        throw makeError("selectedIds 包含无效软件 ID", "INVALID_SELECTION");
      if (selectionSet.has(id))
        throw makeError("selectedIds 不允许重复软件 ID", "INVALID_SELECTION");
      selectionSet.add(id);
    }
    const now = getNow(clock);
    prunePlans(now);
    const plan = plans.get(planId);
    if (!plan) throw makeError("软件计划不存在或已过期", "PLAN_EXPIRED");
    if (plan.expiresAt <= now) {
      plans.delete(planId);
      throw makeError("软件计划已过期，请重新扫描", "PLAN_EXPIRED");
    }
    if (plan.executing) throw makeError("软件计划正在执行", "PLAN_BUSY");
    plan.executing = true;

    const ordered = [];
    const seen = new Set();
    const byId = new Map(plan.items.map((item) => [item.id, item]));
    const total = selectedIds.length;
    let completed = 0;

    async function reportProgress(currentName) {
      if (typeof onProgress !== "function") return;
      try {
        await onProgress({
          completed,
          total,
          currentName: safeText(currentName, 512),
        });
      } catch {
        // Progress is advisory.  A renderer callback must not interrupt the
        // server-side uninstall queue or change its safety outcome.
      }
    }

    function entryName(entry) {
      return entry.item?.name || entry.result?.name || entry.result?.id || "";
    }

    function skippedResult(entry, message) {
      const source = entry.item || entry.result || {};
      return {
        id: source.id,
        name: source.name || "",
        status: "skipped",
        message,
      };
    }

    try {
      for (const id of selectedIds) {
        if (!id || seen.has(id)) continue;
        seen.add(id);
        const item = byId.get(id);
        if (!item) {
          ordered.push({
            result: {
              id,
              name: "",
              status: "rejected",
              message: "软件 ID 不在当前计划中",
            },
          });
          continue;
        }
        if (!item.publicItem.enabled) {
          ordered.push({
            result: {
              id,
              name: item.name,
              status: "blocked",
              message: item.publicItem.reason || "该软件受保护或无法安全卸载",
            },
          });
          continue;
        }
        ordered.push({ item });
      }

      const results = [];
      const warnings = ordered.some((entry) => entry.item)
        ? []
        : ["没有可执行的软件项目"];
      let stopped = false;
      let stopReason = "";
      for (const entry of ordered) {
        const currentName = entryName(entry);
        await reportProgress(currentName);

        let result;
        if (entry.result) {
          // Rejected/protected entries never enter the native queue.  Preserve
          // their local explanation even when a later vendor result stops the
          // executable portion of the queue.
          result = entry.result;
        } else if (stopped || signal?.aborted) {
          result = skippedResult(
            entry,
            stopReason === "unknown"
              ? "前一项结果未知，未继续执行；请先检查 Windows 状态"
              : "用户已取消，尚未开始的软件未执行",
          );
        } else {
          const request = {
            action: "execute",
            planId,
            // Send one opaque identity at a time.  This keeps cancellation and
            // the unknown-outcome guard bounded to the currently running
            // official uninstaller instead of leaving a native batch behind.
            items: [
              {
                id: entry.item.id,
                kind: entry.item.kind,
                identity: cloneJson(entry.item.identity),
              },
            ],
          };
          try {
            const payload = await invoke(request, EXECUTE_TIMEOUT_MS);
            warnings.push(...normalizeWarnings(payload.warnings));
            const raw = Array.isArray(payload.results)
              ? payload.results.find(
                  (candidate) => safeText(candidate?.id, 128) === entry.item.id,
                )
              : undefined;
            // A missing single-item response cannot be associated with a
            // successful uninstall, so keep the conservative unknown state.
            result = normalizeResult(raw, entry.item, "unknown");
          } catch (error) {
            const message =
              safeText(error.message || error) || "卸载执行器失败";
            result = {
              id: entry.item.id,
              name: entry.item.name,
              status: error.code === "OUTCOME_UNKNOWN" ? "unknown" : "failed",
              message,
            };
            warnings.push(message);
          }
        }

        results.push(result);
        completed += 1;
        await reportProgress(currentName);

        // Abort never kills the current process.  It only causes the next
        // queued item to become skipped after this result is recorded.
        if (result.status === "unknown") {
          stopped = true;
          stopReason = "unknown";
        } else if (signal?.aborted) {
          stopped = true;
          if (!stopReason) stopReason = "cancel";
        }
      }
      return {
        planId,
        results,
        warnings: normalizeWarnings(warnings),
      };
    } finally {
      plan.executing = false;
      // A preview is a capability grant.  Consuming it after every execute
      // attempt prevents replay even when the vendor process reports an error.
      plans.delete(planId);
    }
  }

  return { preview, execute };
}

module.exports = {
  APPLICATIONS_SCRIPT,
  PLAN_TTL_MS,
  createApplicationsService,
};
