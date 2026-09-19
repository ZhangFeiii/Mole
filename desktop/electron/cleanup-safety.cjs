const fs = require("node:fs/promises");
const path = require("node:path");
const { spawn } = require("node:child_process");

const UNSAFE_ATTRIBUTES = 0x400 | 0x1000 | 0x40000 | 0x400000;
const normalize = (value) =>
  path.resolve(value).replaceAll("\\", "/").toLowerCase();
function within(root, target) {
  const a = normalize(root),
    b = normalize(target);
  return b === a || b.startsWith(a.replace(/\/$/, "") + "/");
}
function chainOf(target) {
  const result = [];
  for (let p = path.resolve(target); ; p = path.dirname(p)) {
    result.push(p);
    if (p === path.dirname(p)) break;
  }
  return result.reverse();
}
function fingerprint(s) {
  return [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs, s.mode, s.nlink]
    .map(String)
    .join(":");
}
function directoryIdentity(s) {
  return [s.dev, s.ino, s.mode].map(String).join(":");
}

async function callNative(executable, command, request, signal) {
  if (
    !path.isAbsolute(executable || "") ||
    !["inspect", "activity"].includes(command)
  )
    throw new Error("缺少固定路径的只读原生采集器");
  if (signal?.aborted) throw new Error("读取已取消");
  const payload = request ? JSON.stringify(request) : "";
  if (Buffer.byteLength(payload) > 2 * 1024 * 1024)
    throw new Error("原生请求超过上限");
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [command], {
      windowsHide: true,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    let output = "",
      stderr = "",
      done = false;
    function finish(error, value) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      error ? reject(error) : resolve(value);
    }
    function abort() {
      child.kill();
      finish(new Error("原生读取已取消"));
    }
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error("原生读取超时，未执行任何清理"));
    }, 10000);
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (Buffer.byteLength(output) > 2 * 1024 * 1024) {
        child.kill();
        finish(new Error("原生响应超过上限"));
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-2000);
    });
    child.on("error", (error) => finish(error));
    child.stdin.on("error", (error) => finish(error));
    child.on("close", (code) => {
      if (code !== 0) return finish(new Error(stderr || "原生采集器失败"));
      try {
        const result = JSON.parse(output);
        if (result.platform !== "windows")
          throw new Error("Windows 原生状态不可用");
        finish(null, result);
      } catch (error) {
        finish(error);
      }
    });
    child.stdin.end(payload);
  });
}
const createNativeInspector = (executable) => async (paths, signal) => {
  if (!Array.isArray(paths) || !paths.length || paths.length > 2048)
    throw new Error("属性请求数量无效");
  const result = await callNative(executable, "inspect", { paths }, signal);
  if (!Array.isArray(result.items)) throw new Error("原生属性响应不完整");
  return result.items;
};
const createNativeActivity = (executable) => async (signal) => {
  const result = await callNative(executable, "activity", null, signal);
  if (
    result.ok === true &&
    (!Array.isArray(result.names) || result.names.length === 0)
  )
    throw new Error("进程快照不完整，不能假定程序已退出");
  return result;
};

function requireSafeAttributes(
  row,
  directory,
  { allowInUse = false, allowReadonly = false } = {},
) {
  if (row?.error)
    throw Object.assign(new Error(`原生属性不可确认：${row.error}`), {
      code: row.code === "notFound" ? "ENOENT" : "E_NATIVE_UNSAFE",
    });
  if (
    !row ||
    row.error ||
    !Number.isSafeInteger(row.attributes) ||
    row.attributes < 0 ||
    row.attributes > 0xffffffff
  )
    throw new Error("原生属性不可确认");
  if (row.attributes & UNSAFE_ATTRIBUTES)
    throw new Error("链接、目录联接或云端占位文件受保护");
  if (!directory && !allowReadonly && row.attributes & (0x1 | 0x4))
    throw new Error("只读或系统属性文件受保护");
  if (Boolean(row.attributes & 0x10) !== directory)
    throw new Error("文件类型已变化");
  if (!directory && !allowInUse && row.inUse !== false)
    throw new Error(
      row.inUse === true ? "文件正在被使用" : "文件占用状态不可确认",
    );
}
function createInspector(inspectAttributes) {
  return async (paths, signal) => {
    const requested = [...new Set(paths)];
    if (!requested.length) return new Map();
    const rows = await inspectAttributes(requested, signal);
    if (!Array.isArray(rows) || rows.length !== requested.length)
      throw new Error("原生属性响应不完整");
    const wanted = new Set(requested),
      map = new Map();
    for (const row of rows) {
      if (!row || !wanted.has(row.path) || map.has(row.path))
        throw new Error("原生属性响应含未知或重复路径");
      map.set(row.path, row);
    }
    return map;
  };
}
async function directorySnapshot(directory, inspect, signal) {
  if (!path.isAbsolute(directory) || /^(\\\\|\/\/)/.test(directory))
    throw new Error("只支持明确的本地目录");
  const chain = chainOf(directory),
    attrs = await inspect(chain, signal),
    saved = [];
  for (const p of chain) {
    requireSafeAttributes(attrs.get(p), true);
    const s = await fs.lstat(p, { bigint: true });
    if (!s.isDirectory() || s.isSymbolicLink())
      throw new Error("目录祖先不再是普通目录");
    saved.push({ path: p, identity: directoryIdentity(s) });
  }
  if (normalize(await fs.realpath(directory)) !== normalize(directory))
    throw new Error("目录发生重定向");
  return saved;
}

// A non-regex wildcard matcher avoids exponential regexp backtracking from a
// damaged protection file. PowerShell '*' and '?' may cross path separators.
function globMatch(pattern, value) {
  let p = 0,
    v = 0,
    star = -1,
    mark = 0;
  while (v < value.length) {
    if (pattern[p] === "?" || pattern[p] === value[v]) {
      p++;
      v++;
    } else if (pattern[p] === "*") {
      star = p++;
      mark = v;
    } else if (star >= 0) {
      p = star + 1;
      v = ++mark;
    } else return false;
  }
  while (pattern[p] === "*") p++;
  return p === pattern.length;
}
function compileWhitelist(lines, variables) {
  const entries = lines.filter(
    (line) => line.trim() && !line.trim().startsWith("#"),
  );
  if (entries.length > 256) throw new Error("保护白名单项目过多");
  return entries.map((line) => {
    let value = line.trim();
    if (value.length > 4096) throw new Error("白名单模式过长");
    value = value.replace(
      /%([A-Za-z_][\w]*)%|\$env:([A-Za-z_][\w]*)/gi,
      (_m, a, b) => {
        const replacement = variables[(a || b).toUpperCase()];
        if (!replacement) throw new Error("白名单含未知环境变量，已停止清理");
        return replacement;
      },
    );
    if (value.startsWith("~")) value = variables.USERPROFILE + value.slice(1);
    if (/[\[\]`\x00\ufffd]/.test(value))
      throw new Error("白名单含暂不支持或损坏的模式");
    value = value
      .replaceAll("\\", "/")
      .replace(/\*+/g, "*")
      .replace(/\/$/, "")
      .toLowerCase();
    return {
      test(input) {
        const text = input.replaceAll("\\", "/").toLowerCase();
        if (!/[?*]/.test(value))
          return text === value || text.startsWith(value + "/");
        return globMatch(value, text) || globMatch(value + "/*", text);
      },
    };
  });
}
function decodeProtectionText(raw) {
  try {
    if (raw[0] === 0xff && raw[1] === 0xfe)
      return new TextDecoder("utf-16le", { fatal: true }).decode(
        raw.subarray(2),
      );
    if (raw[0] === 0xfe && raw[1] === 0xff)
      return new TextDecoder("utf-16be", { fatal: true }).decode(
        raw.subarray(2),
      );
    return new TextDecoder("utf-8", { fatal: true }).decode(raw);
  } catch {
    throw new Error("保护白名单编码损坏，已停止清理");
  }
}
async function readLegacyWhitelist(filename, variables, inspect, signal) {
  try {
    const native = await inspect([filename], signal);
    requireSafeAttributes(native.get(filename), false, {
      allowInUse: true,
      allowReadonly: true,
    });
    const s = await fs.lstat(filename, { bigint: true });
    if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1n || s.size > 65536n)
      throw new Error("白名单不是可读取的普通小文件");
    await directorySnapshot(path.dirname(filename), inspect, signal);
    const h = await fs.open(filename, "r");
    try {
      const bound = await h.stat({ bigint: true });
      if (fingerprint(bound) !== fingerprint(s))
        throw new Error("白名单在读取前变化");
      const raw = await h.readFile();
      if (raw.length > 65536) throw new Error("白名单超过大小上限");
      const after = await h.stat({ bigint: true });
      if (fingerprint(after) !== fingerprint(bound))
        throw new Error("白名单在读取中变化");
      return compileWhitelist(
        decodeProtectionText(raw).split(/\r?\n/),
        variables,
      );
    } finally {
      await h.close();
    }
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw new Error(`无法安全读取保护白名单：${error.message}`);
  }
}

const PROTECTED_COMPONENTS = new Set([
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
  "autorecover",
  "autosave",
  "backup",
  "backups",
]);
const PROFILE_COMPONENTS = new Set([
  "cookies",
  "history",
  "login data",
  "preferences",
  "bookmarks",
  "web data",
  "sessions",
  "local storage",
  "indexeddb",
  "service worker",
  "globalstorage",
  "workspacestorage",
  "user",
]);
const SENSITIVE_NAME = /^~(?:\$|wr)|\.(?:key|pem|pfx|p12|kdbx)(?:\.|$)/i;
const DOCUMENT_NAME =
  /\.(?:docx?|xlsx?|pptx?|pdf|psd|ai|db|sqlite3?|txt|md|zip|7z|rar)(?:\.|$)/i;
function protectedFile(root, target, rules, { explicit = false } = {}) {
  if (!within(root.path, target) || normalize(root.path) === normalize(target))
    return "不在授权文件范围中";
  const name = path.basename(target),
    parts = path
      .relative(root.path, target)
      .split(/[\\/]/)
      .map((p) => p.toLowerCase());
  if (parts.some((p) => PROTECTED_COMPONENTS.has(p))) return "内置保护目录";
  if (SENSITIVE_NAME.test(name)) return "密钥、凭据或恢复文件受保护";
  if (!explicit && root.kind !== "cache" && DOCUMENT_NAME.test(name))
    return "个人文档或资料文件受保护";
  if (!explicit && parts.some((p) => PROFILE_COMPONENTS.has(p)))
    return "浏览器或应用资料受保护";
  if (
    rules.some((rule) => rule.test(path.resolve(target).replaceAll("\\", "/")))
  )
    return "已设置保护规则";
  if (explicit) {
    const absoluteParts = path
      .resolve(target)
      .split(/[\\/]/)
      .map((p) => p.toLowerCase());
    if (
      absoluteParts.some((p) =>
        [
          "windows",
          "program files",
          "program files (x86)",
          "programdata",
          "appdata",
          "system volume information",
          "$recycle.bin",
          "recovery",
          ...PROTECTED_COMPONENTS,
        ].includes(p),
      )
    )
      return "系统、应用资料或敏感目录不支持分析页回收";
  }
  return null;
}
module.exports = {
  normalize,
  within,
  chainOf,
  fingerprint,
  directoryIdentity,
  createNativeInspector,
  createNativeActivity,
  createInspector,
  requireSafeAttributes,
  directorySnapshot,
  compileWhitelist,
  decodeProtectionText,
  readLegacyWhitelist,
  protectedFile,
};
