const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { randomUUID } = require("node:crypto");
const { spawn } = require("node:child_process");

const DAY = 86400000;
const TTL = 5 * 60000;
const MAX_ITEMS = 500;
const MAX_VISITED = 10000;
const UNSAFE_ATTRIBUTES = 0x400 | 0x1000 | 0x40000 | 0x400000;
const PROTECTED_NAMES = new Set([
  ".git",
  ".svn",
  ".hg",
  ".ssh",
  ".gnupg",
  ".aws",
  ".azure",
  ".kube",
  ".vscode",
  ".nuget",
  ".cargo",
  ".rustup",
  ".m2",
  ".ollama",
  "node_modules",
  "documents",
  "downloads",
  "desktop",
  "pictures",
  "videos",
  "music",
  "windows",
  "program files",
  "program files (x86)",
  "programdata",
  "recovery",
  "autorecover",
  "autosave",
  "backup",
  "backups",
]);
const TEMP_EXTENSIONS = [".tmp", ".temp", ".log", ".dmp", ".etl", ".cache"];

const normalized = (value) =>
  path.resolve(value).replaceAll("\\", "/").toLowerCase();
function within(root, target) {
  const a = normalized(root),
    b = normalized(target);
  return b === a || b.startsWith(a.replace(/\/$/, "") + "/");
}
function chainOf(target) {
  const result = [];
  for (let current = path.resolve(target); ; current = path.dirname(current)) {
    result.push(current);
    if (current === path.dirname(current)) break;
  }
  return result.reverse();
}
function fingerprint(stat) {
  return [
    stat.dev,
    stat.ino,
    stat.size,
    stat.mtimeNs,
    stat.ctimeNs,
    stat.mode,
    stat.nlink,
  ]
    .map(String)
    .join(":");
}
function directoryIdentity(stat) {
  return [stat.dev, stat.ino, stat.mode].map(String).join(":");
}

// The executable is provided by the trusted main process, not the renderer.
// A native Go probe avoids PowerShell/PATH/SystemRoot command resolution.
function createNativeInspector(executable) {
  return async (paths) => {
    if (!path.isAbsolute(executable || ""))
      throw new Error("缺少固定路径的原生属性采集器");
    const payload = JSON.stringify({ paths });
    if (paths.length > 2048 || Buffer.byteLength(payload) > 2 * 1024 * 1024)
      throw new Error("属性请求超过上限");
    return new Promise((resolve, reject) => {
      const child = spawn(executable, ["inspect"], {
        windowsHide: true,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      });
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      let output = "",
        stderr = "",
        done = false;
      const finish = (error, result) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(result);
      };
      const timer = setTimeout(() => {
        child.kill();
        finish(new Error("原生属性读取超时，未执行清理"));
      }, 10000);
      child.stdout.on("data", (chunk) => {
        output += chunk;
        if (Buffer.byteLength(output) > 2 * 1024 * 1024) {
          child.kill();
          finish(new Error("原生属性响应过大"));
        }
      });
      child.stderr.on("data", (chunk) => {
        stderr = (stderr + chunk).slice(-1000);
      });
      child.on("error", (error) => finish(error));
      child.stdin.on("error", (error) => finish(error));
      child.on("close", (code) => {
        if (code !== 0)
          return finish(new Error(stderr || "原生属性采集器失败"));
        try {
          const result = JSON.parse(output);
          if (result.platform !== "windows" || !Array.isArray(result.items))
            throw new Error("需要 Windows 原生属性，不能使用兼容估算");
          finish(null, result.items);
        } catch (error) {
          finish(error);
        }
      });
      child.stdin.end(payload);
    });
  };
}

function compileWhitelist(lines, variables) {
  return lines
    .filter((line) => line.trim() && !line.trim().startsWith("#"))
    .map((line) => {
      let value = line.trim();
      value = value.replace(
        /%([A-Za-z_][\w]*)%|\$env:([A-Za-z_][\w]*)/gi,
        (_match, a, b) => {
          const replacement = variables[(a || b).toUpperCase()];
          if (!replacement) throw new Error("白名单含未知环境变量，已停止清理");
          return replacement;
        },
      );
      if (value.startsWith("~")) value = variables.USERPROFILE + value.slice(1);
      // Preserve unsupported PowerShell glob syntax by refusing to clean, not by
      // silently interpreting a narrower protection rule.
      if (/[\[\]`\x00]/.test(value))
        throw new Error(
          "白名单含暂不支持的模式，已停止清理；支持绝对路径、* 和 ?",
        );
      value = value.replaceAll("\\", "/");
      const escaped = [...value]
        .map((char) =>
          char === "*"
            ? ".*"
            : char === "?"
              ? "."
              : char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
        )
        .join("");
      return new RegExp(`^${escaped.replace(/\/$/, "")}(?:/.*)?$`, "i");
    });
}

function createCleanupService({
  trashItem,
  executable,
  inspectAttributes,
  platform = process.platform,
  home = os.homedir(),
  env = process.env,
  now = Date.now,
  testRoots,
  testWhitelistPath,
  trashTimeoutMs = 45000,
} = {}) {
  const inspector = inspectAttributes || createNativeInspector(executable);
  const plans = new Map();
  let busy = false,
    cancelled = false,
    closed = false,
    uncertain = false;
  const userHome = path.resolve(home);
  const local = path.resolve(
    env.LOCALAPPDATA || path.join(userHome, "AppData", "Local"),
  );
  const variables = {
    ...Object.fromEntries(
      Object.entries(env).map(([k, v]) => [k.toUpperCase(), v]),
    ),
    USERPROFILE: userHome,
    LOCALAPPDATA: local,
  };
  const whitelistPath =
    testWhitelistPath ||
    path.join(userHome, ".config", "mole", "whitelist.txt");
  const roots = testRoots || [
    {
      id: "temp",
      name: "旧临时文件",
      path: path.join(local, "Temp"),
      extensions: TEMP_EXTENSIONS,
      daysOld: 7,
    },
    {
      id: "crash-dumps",
      name: "旧崩溃转储",
      path: path.join(local, "CrashDumps"),
      extensions: [".dmp"],
      daysOld: 7,
    },
  ];

  function assertReady() {
    if (platform !== "win32") throw new Error("垃圾清理仅在 Windows 可用");
    if (closed) throw new Error("清理服务已关闭");
    if (uncertain)
      throw Object.assign(
        new Error(
          "上次回收操作结果未知，已锁定清理；请先在文件管理器/回收站核对",
        ),
        { code: "OUTCOME_UNKNOWN" },
      );
    if (busy) throw new Error("已有清理操作正在进行");
    if (
      !testRoots &&
      (!within(userHome, local) || normalized(local) === normalized(userHome))
    )
      throw new Error("LocalAppData 不在当前用户目录中，已拒绝清理");
  }
  function checkCancelled() {
    if (closed || cancelled) throw new Error("清理已取消；未继续执行剩余项目");
  }

  async function inspect(paths) {
    const requested = [...new Set(paths)];
    const rows = await inspector(requested);
    if (!Array.isArray(rows) || rows.length !== requested.length)
      throw new Error("原生属性响应不完整，已拒绝清理");
    const map = new Map();
    for (const row of rows) {
      if (!row || !requested.includes(row.path) || map.has(row.path))
        throw new Error("原生属性响应含未知/重复路径");
      map.set(row.path, row);
    }
    return map;
  }
  function requireSafeAttributes(row, directory) {
    if (
      !row ||
      row.error ||
      !Number.isSafeInteger(row.attributes) ||
      row.attributes < 0 ||
      row.attributes > 0xffffffff
    )
      throw new Error("原生属性不可确认");
    if (row.attributes & UNSAFE_ATTRIBUTES)
      throw new Error("目录联接、重解析点或云端占位文件受保护");
    if (!directory && row.attributes & (0x1 | 0x4))
      throw new Error("只读或系统属性文件受保护");
    if (Boolean(row.attributes & 0x10) !== directory)
      throw new Error("文件类型已变化");
  }

  async function loadWhitelist() {
    const defaults = [
      path.join(local, "Microsoft", "Windows", "Explorer"),
      path.join(local, "Microsoft", "Windows", "Fonts"),
      path.join(local, "Packages", "*"),
      path.join(local, "JetBrains"),
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
    let lines = [];
    try {
      const stat = await fs.lstat(whitelistPath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536)
        throw new Error("白名单不是可读取的普通小文件");
      if (
        normalized(await fs.realpath(whitelistPath)) !==
        normalized(whitelistPath)
      )
        throw new Error("白名单不能经过目录联接");
      const raw = await fs.readFile(whitelistPath);
      if (raw.length > 65536) throw new Error("白名单超过大小上限");
      const text =
        raw[0] === 0xff && raw[1] === 0xfe
          ? raw.subarray(2).toString("utf16le")
          : raw.toString("utf8").replace(/^\uFEFF/, "");
      lines = text.split(/\r?\n/);
    } catch (error) {
      if (error.code !== "ENOENT")
        throw new Error(`无法安全读取保护白名单：${error.message}`);
    }
    return compileWhitelist([...defaults, ...lines], variables);
  }
  function protectedPath(root, target, whitelist) {
    if (
      !within(root.path, target) ||
      normalized(root.path) === normalized(target)
    )
      return true;
    const parts = path
      .relative(root.path, target)
      .split(/[\\/]/)
      .map((p) => p.toLowerCase());
    const name = path.basename(target);
    if (
      /^~(?:\$|wr)/i.test(name) ||
      /\.(?:docx?|xlsx?|pptx?|pdf|psd|ai|key|pem|pfx|p12|db|sqlite3?|kdbx|txt|md|zip|7z|rar)(?:\.|$)/i.test(
        name,
      )
    )
      return true;
    return (
      parts.some((p) => PROTECTED_NAMES.has(p)) ||
      whitelist.some((rule) =>
        rule.test(path.resolve(target).replaceAll("\\", "/")),
      )
    );
  }

  async function directorySnapshot(directory) {
    const chain = chainOf(directory);
    const attrs = await inspect(chain);
    const snapshots = [];
    for (const current of chain) {
      requireSafeAttributes(attrs.get(current), true);
      const stat = await fs.lstat(current, { bigint: true });
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new Error("目录祖先不再是普通目录");
      snapshots.push({ path: current, identity: directoryIdentity(stat) });
    }
    if (normalized(await fs.realpath(directory)) !== normalized(directory))
      throw new Error("目录存在重定向");
    return snapshots;
  }

  function eligible(root, target, stat) {
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.nlink !== 1n ||
      stat.ino === 0n ||
      stat.size > BigInt(Number.MAX_SAFE_INTEGER)
    )
      return false;
    const ext = path.extname(target).toLowerCase();
    const extensions = root.extensions || TEMP_EXTENSIONS;
    const cutoff = now() - (root.daysOld ?? 7) * DAY;
    return (
      extensions.includes(ext) &&
      Number(stat.mtimeMs) < cutoff &&
      Number(stat.ctimeMs) < cutoff
    );
  }

  async function preview() {
    assertReady();
    busy = true;
    cancelled = false;
    plans.clear();
    const items = [],
      internal = new Map(),
      warnings = [];
    let visited = 0,
      excluded = 0,
      limited = false;
    try {
      const whitelist = await loadWhitelist();
      for (const root of roots) {
        checkCancelled();
        if (!path.isAbsolute(root.path) || /^(\\\\|\/\/)/.test(root.path)) {
          warnings.push("非本地缓存根已跳过");
          continue;
        }
        try {
          const rootChain = await directorySnapshot(root.path);
          const queue = [{ directory: root.path, depth: 0 }];
          while (
            queue.length &&
            visited < MAX_VISITED &&
            items.length < MAX_ITEMS
          ) {
            checkCancelled();
            const { directory, depth } = queue.shift();
            if (depth > 16) {
              excluded++;
              continue;
            }
            if (
              directory !== root.path &&
              protectedPath(root, directory, whitelist)
            ) {
              excluded++;
              continue;
            }
            let chain;
            try {
              chain =
                directory === root.path
                  ? rootChain
                  : await directorySnapshot(directory);
            } catch {
              excluded++;
              continue;
            }
            const handle = await fs.opendir(directory, { bufferSize: 128 });
            const candidates = [];
            for await (const entry of handle) {
              if (visited++ >= MAX_VISITED || candidates.length >= 2048) {
                limited = true;
                break;
              }
              candidates.push(path.join(directory, entry.name));
            }
            if (!candidates.length) continue;
            let native;
            try {
              native = await inspect(candidates);
            } catch {
              excluded += candidates.length;
              continue;
            }
            for (const target of candidates) {
              checkCancelled();
              if (items.length >= MAX_ITEMS) break;
              if (protectedPath(root, target, whitelist)) {
                excluded++;
                continue;
              }
              try {
                const stat = await fs.lstat(target, { bigint: true });
                requireSafeAttributes(native.get(target), stat.isDirectory());
                if (stat.isDirectory()) {
                  queue.push({ directory: target, depth: depth + 1 });
                  continue;
                }
                if (!eligible(root, target, stat)) {
                  excluded++;
                  continue;
                }
                const id = randomUUID();
                const item = {
                  id,
                  name: path.basename(target),
                  description: `${root.name} · ${path.relative(root.path, target)} · 超过 ${root.daysOld ?? 7} 天未变更`,
                  enabled: true,
                  size: Number(stat.size),
                  path: target,
                  category: root.id,
                };
                items.push(item);
                internal.set(id, {
                  ...item,
                  root,
                  identity: fingerprint(stat),
                  chain,
                });
              } catch {
                excluded++;
              }
            }
          }
        } catch (error) {
          if (error.code !== "ENOENT")
            warnings.push(`${root.name}：${error.message}，已跳过`);
        }
      }
      checkCancelled();
      if (excluded)
        warnings.push(
          `保留或跳过 ${excluded} 项近期文件、白名单、非缓存文件、链接/云端占位或无法确认的项目。`,
        );
      if (limited || visited >= MAX_VISITED || items.length >= MAX_ITEMS)
        warnings.push(
          "已达到预览数量上限，仅列出本次确认过的项目；不会清理未列出的项目。",
        );
      warnings.push(
        "仅普通旧缓存文件可选择；不删除文件夹、不清空回收站，不把文件大小当作可立即释放空间。",
      );
      const createdAt = now();
      const plan = {
        id: randomUUID(),
        createdAt: new Date(createdAt).toISOString(),
        expiresAt: new Date(createdAt + TTL).toISOString(),
        items,
        warnings,
      };
      plans.set(plan.id, { expires: createdAt + TTL, items: internal });
      return plan;
    } finally {
      busy = false;
    }
  }

  // All mutation goes through this one guarded helper. There is deliberately
  // no unlink/rm/remove fallback when the OS recycle-bin operation fails.
  async function safeTrashItem(saved, whitelist, expires) {
    checkCancelled();
    if (protectedPath(saved.root, saved.path, whitelist))
      throw new Error("项目当前已被保护");
    const currentChain = await directorySnapshot(path.dirname(saved.path));
    if (
      currentChain.length !== saved.chain.length ||
      currentChain.some(
        (p, i) =>
          p.path !== saved.chain[i].path ||
          p.identity !== saved.chain[i].identity,
      )
    )
      throw new Error("目录身份已变化，请重新预览");
    const native = await inspect([saved.path]);
    requireSafeAttributes(native.get(saved.path), false);
    const stat = await fs.lstat(saved.path, { bigint: true });
    if (
      !eligible(saved.root, saved.path, stat) ||
      fingerprint(stat) !== saved.identity
    )
      throw new Error("文件已变化、仍在使用或不再满足清理条件");
    if (normalized(await fs.realpath(saved.path)) !== normalized(saved.path))
      throw new Error("文件路径发生重定向");
    checkCancelled();
    // Native Trash is path-based; revalidate immediately before calling it.
    const final = await fs.lstat(saved.path, { bigint: true });
    if (fingerprint(final) !== saved.identity)
      throw new Error("文件在执行前发生变化");
    checkCancelled();
    if (now() >= expires) throw new Error("计划已过期，请重新预览");
    let timer;
    try {
      await Promise.race([
        Promise.resolve().then(() => trashItem(saved.path)),
        new Promise((_resolve, reject) => {
          timer = setTimeout(
            () =>
              reject(
                Object.assign(
                  new Error(
                    "系统回收操作超时，文件是否已移动未知；没有发起任何永久删除",
                  ),
                  { code: "OUTCOME_UNKNOWN" },
                ),
              ),
            trashTimeoutMs,
          );
        }),
      ]);
    } catch (error) {
      if (error.code === "OUTCOME_UNKNOWN") throw error;
      // A rejected native call is not proof of non-mutation. If the original
      // object disappeared or changed, stop the batch with an unknown outcome.
      try {
        const after = await fs.lstat(saved.path, { bigint: true });
        if (fingerprint(after) !== saved.identity) throw new Error("changed");
      } catch {
        throw Object.assign(
          new Error("回收返回失败，但原文件状态已改变；请在回收站核对"),
          { code: "OUTCOME_UNKNOWN" },
        );
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async function execute(planId, selectedIds) {
    assertReady();
    const saved = plans.get(planId);
    if (!saved || now() >= saved.expires)
      throw new Error("清理预览已过期，请重新预览");
    if (
      !Array.isArray(selectedIds) ||
      !selectedIds.length ||
      selectedIds.length > MAX_ITEMS ||
      selectedIds.some(
        (id) => typeof id !== "string" || !saved.items.has(id),
      ) ||
      new Set(selectedIds).size !== selectedIds.length
    )
      throw new Error("只能执行当前计划中明确选择的唯一项目 ID");
    if (typeof trashItem !== "function")
      throw new Error("未提供系统回收站操作，已拒绝执行");
    const selected = selectedIds.map((id) => saved.items.get(id));
    plans.delete(planId);
    busy = true;
    cancelled = false;
    const results = [];
    try {
      for (const item of selected) {
        const record = {
          id: item.id,
          name: item.name,
          status: "skipped",
          message: "",
        };
        if (closed || cancelled || uncertain) {
          record.message = "操作已取消或前项结果未知，未执行此项";
          results.push(record);
          continue;
        }
        if (now() >= saved.expires) {
          record.message = "计划已过期，未继续执行";
          results.push(record);
          continue;
        }
        if (env.MOLE_DRY_RUN === "1" || env.MO_DRY_RUN === "1") {
          record.message = "Dry-run：仅预览，不修改文件";
          results.push(record);
          continue;
        }
        try {
          const whitelist = await loadWhitelist();
          await safeTrashItem(item, whitelist, saved.expires);
          record.status = "success";
          record.message = "已移入回收站，可在 Windows 回收站恢复";
        } catch (error) {
          if (error.code === "OUTCOME_UNKNOWN") {
            uncertain = true;
            record.status = "unknown";
          } else record.status = "failed";
          record.message = `未完成此项：${error.message}；未改用永久删除`;
        }
        results.push(record);
      }
      return {
        results,
        warnings: uncertain
          ? [
              "存在结果未知的回收操作，已停止后续项目并锁定本服务。请在文件管理器/回收站核对；不要重复执行。",
            ]
          : [],
      };
    } finally {
      busy = false;
    }
  }

  return {
    preview,
    execute,
    cancel() {
      cancelled = true;
    },
    close() {
      closed = true;
      cancelled = true;
      plans.clear();
    },
  };
}

module.exports = {
  createCleanupService,
  createNativeInspector,
  compileWhitelist,
};
