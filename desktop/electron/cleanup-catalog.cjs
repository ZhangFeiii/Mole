const path = require("node:path");

const SOURCES = Object.freeze({
  WINDOWS_PATHS:
    "https://learn.microsoft.com/en-us/windows/deployment/usmt/usmt-recognized-environment-variables",
  WINDOWS_CRASH_DUMPS:
    "https://learn.microsoft.com/en-us/windows/win32/wer/wer-settings",
  CHROMIUM:
    "https://chromium.googlesource.com/chromium/src/+/HEAD/docs/user_data_dir.md",
  CHROMIUM_PROFILE_CACHE:
    "https://chromium.googlesource.com/chromium/src/+/HEAD/chrome/browser/net/profile_network_context_service.cc",
  CHROMIUM_CACHE_DIRNAME:
    "https://chromium.googlesource.com/chromium/src/%2B/68.0.3423.2/chrome/common/chrome_constants.cc",
  CHROMIUM_CACHE_DATA:
    "https://chromium.googlesource.com/chromium/src/+/HEAD/content/browser/network_service_instance_impl.h",
  CHROMIUM_CODE_CACHE:
    "https://chromium.googlesource.com/chromium/src/+/HEAD/content/browser/storage_partition_impl.cc",
  FIREFOX:
    "https://github.com/mozilla-firefox/firefox/blob/main/netwerk/docs/cache2/doc.md",
  VSCODE:
    "https://github.com/microsoft/vscode/blob/main/src/vs/platform/environment/node/userDataPath.ts",
  VSCODE_LOGS:
    "https://github.com/microsoft/vscode/blob/main/src/vs/platform/environment/common/environmentService.ts",
  VSCODE_CACHED_DATA:
    "https://github.com/microsoft/vscode/blob/1.27.2/src/vs/platform/environment/node/environmentService.ts",
  NPM: "https://docs.npmjs.com/cli/v11/commands/npm-cache/",
  PIP: "https://pip.pypa.io/en/stable/topics/caching/",
  PYTHON_WINDOWS: "https://docs.python.org/3.14/using/windows.html",
  DIRECTX_SHADER:
    "https://microsoft.github.io/DirectX-Specs/d3d/ShaderCache.html",
  AMD_SHADER:
    "https://gpuopen.com/gdc-presentations/2024/GDC2024_AMD_Ryzen_Processor_Software_Optimization.pdf",
});

// Group metadata is deliberately data-only. It is not a list of directories
// and does not cause filesystem access when this module is loaded.
const GROUPS = Object.freeze({
  TEMP: Object.freeze({ id: "temp", name: "Windows 临时文件" }),
  CRASH_DUMPS: Object.freeze({ id: "crash-dumps", name: "Windows 崩溃转储" }),
  BROWSER: Object.freeze({ id: "browser", name: "浏览器缓存" }),
  VSCODE: Object.freeze({ id: "vscode", name: "VS Code 缓存" }),
  NPM: Object.freeze({ id: "npm", name: "npm 缓存" }),
  PIP: Object.freeze({ id: "pip", name: "pip 缓存" }),
  SHADER: Object.freeze({ id: "shader", name: "Windows 着色器缓存" }),
});

const TEMP_EXTENSIONS = Object.freeze([
  ".tmp",
  ".temp",
  ".log",
  ".dmp",
  ".etl",
  ".cache",
]);

const PROCESS_NAMES = Object.freeze({
  CHROME: Object.freeze(["chrome.exe"]),
  EDGE: Object.freeze(["msedge.exe"]),
  FIREFOX: Object.freeze(["firefox.exe"]),
  VSCODE: Object.freeze(["Code.exe"]),
  VSCODE_INSIDERS: Object.freeze(["Code - Insiders.exe"]),
  NPM: Object.freeze(["node.exe"]),
  PIP: Object.freeze([
    "python.exe",
    "pythonw.exe",
    "python3.exe",
    "python3.14.exe",
    "pip.exe",
  ]),
});

const LOCATION_TOKEN = Symbol("mole.cleanup-catalog.location");

function pathContext(home) {
  if (typeof home !== "string" || home.length === 0)
    throw new TypeError("home must be a non-empty absolute path");
  if (home.includes("\0")) throw new TypeError("home contains a NUL byte");
  if (/%[^%]+%/.test(home) || /\$env:/i.test(home))
    throw new TypeError("home must not contain environment-variable syntax");

  // Production receives a canonical Windows home. POSIX absolute paths are
  // also accepted so tests can use an isolated temporary fixture without
  // touching a real Windows profile.
  const isWindowsDrive = /^[A-Za-z]:[\\/]/.test(home);
  const api = isWindowsDrive ? path.win32 : path.posix;
  const isUnc = /^(?:\\\\|\/\/)/.test(home);
  if (isUnc || !api.isAbsolute(home))
    throw new TypeError("home must be a local absolute path, not UNC/relative");

  // Do not silently resolve a caller-provided traversal before constructing
  // roots. The main process is responsible for supplying a trusted home.
  const segments = home.split(/[\\/]+/);
  if (segments.includes("..") || segments.includes("."))
    throw new TypeError("home must not contain dot path segments");

  const normalizedHome = api.normalize(home);
  const local = api.join(normalizedHome, "AppData", "Local");
  const roaming = api.join(normalizedHome, "AppData", "Roaming");
  return Object.freeze({
    api,
    home: normalizedHome,
    local,
    roaming,
    join: (...parts) => api.join(...parts),
  });
}

function copyArray(value) {
  return value == null ? null : Object.freeze([...value]);
}

function root(definition) {
  return Object.freeze({
    id: definition.id,
    groupId: definition.groupId,
    name: definition.name,
    path: definition.path,
    kind: definition.kind,
    extensions: copyArray(definition.extensions),
    daysOld: definition.daysOld,
    recommendation: definition.recommendation,
    reason: definition.reason,
    processNames: Object.freeze([...definition.processNames]),
    source: definition.source,
    enabled: definition.enabled,
  });
}

function staticRoots(home) {
  const context = pathContext(home);
  const { join, local } = context;
  return Object.freeze([
    root({
      id: "windows-temp",
      groupId: GROUPS.TEMP.id,
      name: "旧临时文件",
      path: join(local, "Temp"),
      kind: "temp",
      extensions: TEMP_EXTENSIONS,
      daysOld: 7,
      recommendation: "recommended",
      reason:
        "仅列出可信用户 AppData/Local/Temp 中已知临时扩展名且超过 7 天的文件；目录本身不删除。",
      processNames: [],
      source: SOURCES.WINDOWS_PATHS,
      enabled: true,
    }),
    root({
      id: "windows-crash-dumps",
      groupId: GROUPS.CRASH_DUMPS.id,
      name: "旧崩溃转储",
      path: join(local, "CrashDumps"),
      kind: "log",
      extensions: [".dmp"],
      daysOld: 7,
      recommendation: "recommended",
      reason:
        "Windows 默认用户崩溃转储目录；仅列出超过 7 天的 .dmp，保留目录并由执行器再次检查占用和属性。",
      processNames: [],
      source: SOURCES.WINDOWS_CRASH_DUMPS,
      enabled: true,
    }),
    root({
      id: "windows-d3ds-cache",
      groupId: GROUPS.SHADER.id,
      name: "DirectX 系统着色器缓存（仅保护）",
      path: join(local, "D3DSCache"),
      kind: "protected",
      extensions: null,
      daysOld: 0,
      recommendation: "protected",
      reason:
        "D3DSCache 由 Windows/DirectX 管理；应用不得手动删除工作目录外的系统管理 shader cache，本目录只作为受保护识别项。",
      processNames: [],
      source: `${SOURCES.DIRECTX_SHADER} ${SOURCES.AMD_SHADER}`,
      enabled: false,
    }),
  ]);
}

function makeLocation(context, definition) {
  const location = {
    id: definition.id,
    groupId: definition.groupId,
    name: definition.name,
    path: definition.path,
    profileKind: definition.profileKind,
    processNames: Object.freeze([...definition.processNames]),
    source: definition.source,
    enabled: true,
  };
  Object.defineProperty(location, LOCATION_TOKEN, {
    configurable: false,
    enumerable: false,
    writable: false,
    value: Object.freeze({
      ...definition,
      path: definition.path,
      join: context.join,
    }),
  });
  return Object.freeze(location);
}

function profileLocations(home) {
  const context = pathContext(home);
  const { join, local, roaming } = context;
  return Object.freeze([
    makeLocation(context, {
      id: "chrome",
      groupId: GROUPS.BROWSER.id,
      name: "Google Chrome",
      path: join(local, "Google", "Chrome", "User Data"),
      profileKind: "chromium",
      processNames: PROCESS_NAMES.CHROME,
      source: `${SOURCES.CHROMIUM} ${SOURCES.CHROMIUM_PROFILE_CACHE} ${SOURCES.CHROMIUM_CACHE_DIRNAME} ${SOURCES.CHROMIUM_CACHE_DATA} ${SOURCES.CHROMIUM_CODE_CACHE}`,
    }),
    makeLocation(context, {
      id: "edge",
      groupId: GROUPS.BROWSER.id,
      name: "Microsoft Edge",
      path: join(local, "Microsoft", "Edge", "User Data"),
      profileKind: "chromium",
      processNames: PROCESS_NAMES.EDGE,
      source: `${SOURCES.CHROMIUM} ${SOURCES.CHROMIUM_PROFILE_CACHE} ${SOURCES.CHROMIUM_CACHE_DIRNAME} ${SOURCES.CHROMIUM_CACHE_DATA} ${SOURCES.CHROMIUM_CODE_CACHE}`,
    }),
    makeLocation(context, {
      id: "firefox",
      groupId: GROUPS.BROWSER.id,
      name: "Mozilla Firefox",
      path: join(local, "Mozilla", "Firefox", "Profiles"),
      profileKind: "firefox",
      processNames: PROCESS_NAMES.FIREFOX,
      source: SOURCES.FIREFOX,
    }),
    makeLocation(context, {
      id: "vscode",
      groupId: GROUPS.VSCODE.id,
      name: "Visual Studio Code",
      path: join(roaming, "Code"),
      profileKind: "fixed",
      processNames: PROCESS_NAMES.VSCODE,
      source: SOURCES.VSCODE,
    }),
    makeLocation(context, {
      id: "vscode-insiders",
      groupId: GROUPS.VSCODE.id,
      name: "Visual Studio Code Insiders",
      path: join(roaming, "Code - Insiders"),
      profileKind: "fixed",
      processNames: PROCESS_NAMES.VSCODE_INSIDERS,
      source: SOURCES.VSCODE,
    }),
    makeLocation(context, {
      id: "npm",
      groupId: GROUPS.NPM.id,
      name: "npm",
      path: join(local, "npm-cache"),
      profileKind: "fixed",
      processNames: PROCESS_NAMES.NPM,
      source: SOURCES.NPM,
    }),
    makeLocation(context, {
      id: "pip",
      groupId: GROUPS.PIP.id,
      name: "pip",
      path: join(local, "pip", "Cache"),
      profileKind: "fixed",
      processNames: PROCESS_NAMES.PIP,
      source: `${SOURCES.PIP} ${SOURCES.PYTHON_WINDOWS}`,
    }),
  ]);
}

function assertLocation(location) {
  const token = location && location[LOCATION_TOKEN];
  if (
    !token ||
    typeof location.path !== "string" ||
    location.path !== token.path
  )
    throw new TypeError(
      "location must be an entry returned by profileLocations",
    );
  if (
    location.id !== token.id ||
    location.groupId !== token.groupId ||
    location.profileKind !== token.profileKind
  )
    throw new TypeError("location metadata was modified");
  return token;
}

function assertChromiumProfile(profileName) {
  if (
    typeof profileName !== "string" ||
    !/^(?:Default|Profile [0-9]+)$/.test(profileName)
  )
    throw new TypeError("Chromium profile must be Default or Profile N");
  return profileName;
}

function assertFirefoxProfile(profileName) {
  if (
    typeof profileName !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(profileName) ||
    profileName === "." ||
    profileName === ".."
  )
    throw new TypeError(
      "Firefox profile must be one registered directory name",
    );
  return profileName;
}

function profileSlug(profileName) {
  return profileName.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function cacheRoot({
  id,
  groupId,
  name,
  path: targetPath,
  processNames,
  source,
  reason,
  kind = "cache",
  daysOld = 1,
  recommendation = "recommended",
}) {
  return root({
    id,
    groupId,
    name,
    path: targetPath,
    kind,
    extensions: null,
    daysOld,
    recommendation,
    reason,
    processNames,
    source,
    enabled: recommendation !== "protected",
  });
}

function rootsForProfile(location, profileName) {
  const descriptor = assertLocation(location);
  const join = descriptor.join;
  const processNames = descriptor.processNames;

  if (descriptor.profileKind === "chromium") {
    const profile = assertChromiumProfile(profileName);
    const base = join(descriptor.path, profile);
    const slug = profileSlug(profile);
    return Object.freeze([
      cacheRoot({
        id: `${descriptor.id}-${slug}-cache-data`,
        groupId: descriptor.groupId,
        name: `${descriptor.name} ${profile} Cache_Data`,
        path: join(base, "Cache", "Cache_Data"),
        processNames,
        source: descriptor.source,
        reason:
          "Chromium 已知 profile cache/Cache_Data；只接受 Default 或 Profile N，不遍历 Service Worker、Cookies、History、Login Data 或 Local Storage。",
      }),
      cacheRoot({
        id: `${descriptor.id}-${slug}-code-cache`,
        groupId: descriptor.groupId,
        name: `${descriptor.name} ${profile} Code Cache`,
        path: join(base, "Code Cache"),
        processNames,
        source: descriptor.source,
        reason:
          "Chromium 已知 profile Code Cache；只接受 Default 或 Profile N，不把任意 AppData 子目录当作缓存。",
      }),
    ]);
  }

  if (descriptor.profileKind === "firefox") {
    const profile = assertFirefoxProfile(profileName);
    const slug = profileSlug(profile);
    return Object.freeze([
      cacheRoot({
        id: `${descriptor.id}-${slug}-cache2`,
        groupId: descriptor.groupId,
        name: `${descriptor.name} ${profile} cache2`,
        path: join(descriptor.path, profile, "cache2"),
        processNames,
        source: descriptor.source,
        reason:
          "Mozilla Firefox 注册的 Local profile cache2；不接受 Roaming 用户资料，也不遍历 profile 外的路径。",
      }),
    ]);
  }

  if (profileName != null && profileName !== "")
    throw new TypeError(
      "fixed application locations do not accept a profile name",
    );

  if (descriptor.id === "vscode" || descriptor.id === "vscode-insiders") {
    const slug = descriptor.id;
    return Object.freeze([
      cacheRoot({
        id: `${slug}-logs`,
        groupId: descriptor.groupId,
        name: `${descriptor.name} logs`,
        path: join(descriptor.path, "logs"),
        processNames,
        source: SOURCES.VSCODE_LOGS,
        kind: "log",
        daysOld: 7,
        reason:
          "VS Code 官方 user-data 目录中的会话 logs；仅列出 7 天以上日志，禁止 User/Backups/settings/globalStorage。",
      }),
      cacheRoot({
        id: `${slug}-cached-data`,
        groupId: descriptor.groupId,
        name: `${descriptor.name} CachedData`,
        path: join(descriptor.path, "CachedData"),
        processNames,
        source: `${SOURCES.VSCODE} ${SOURCES.VSCODE_CACHED_DATA}`,
        daysOld: 7,
        reason:
          "VS Code 官方 user-data 目录中的构建缓存 CachedData；仅列出 7 天以上缓存，禁止 User/Backups/settings/globalStorage。",
      }),
    ]);
  }

  if (descriptor.id === "npm") {
    return Object.freeze([
      cacheRoot({
        id: "npm-cacache",
        groupId: descriptor.groupId,
        name: "npm _cacache",
        path: join(descriptor.path, "_cacache"),
        processNames,
        source: descriptor.source,
        daysOld: 7,
        recommendation: "manual",
        reason:
          "npm 官方文档定义的 LocalAppData/npm-cache/_cacache 内容寻址缓存；npm 自身建议仅为回收磁盘空间清理，默认手动复核。",
      }),
    ]);
  }

  if (descriptor.id === "pip") {
    return Object.freeze(
      ["http", "http-v2", "wheels"].map((directory) =>
        cacheRoot({
          id: `pip-${directory}`,
          groupId: descriptor.groupId,
          name: `pip ${directory}`,
          path: join(descriptor.path, directory),
          processNames,
          source: descriptor.source,
          daysOld: 7,
          recommendation: "manual",
          reason:
            "pip 官方文档定义的 LocalAppData/pip/Cache 子目录；缓存结构可能随版本变化，默认手动复核。",
        }),
      ),
    );
  }

  throw new TypeError(`unsupported profile location: ${descriptor.id}`);
}

module.exports = {
  GROUPS,
  profileLocations,
  rootsForProfile,
  staticRoots,
};
