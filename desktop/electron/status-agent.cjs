const { spawn } = require("node:child_process");
const { createInterface } = require("node:readline");

// A single read-only collector owns its sampling caches for the window's
// lifetime. Re-spawning per frame loses disk deltas and repeats slow GPU probes.
function startStatusCollector(
  executable,
  { spawnProcess = spawn, timeoutMs = 20000 } = {},
) {
  const child = spawnProcess(executable, ["status-stream"], {
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const lines = createInterface({ input: child.stdout });
  let last,
    failure,
    cancelled = false,
    stderr = "",
    lastAt = Date.now();
  const waiting = new Set();
  function stop(error) {
    if (failure || cancelled) return;
    failure = error;
    clearInterval(timer);
    for (const item of waiting) item.reject(error);
    waiting.clear();
    child.kill();
  }
  const timer = setInterval(
    () => {
      if (Date.now() - lastAt > timeoutMs)
        stop(new Error("系统采样已超时，正在重新连接；旧读数可能已经过期"));
    },
    Math.min(1000, timeoutMs),
  );
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk).slice(-2000);
  });
  lines.on("line", (line) => {
    try {
      if (line.length > 4 * 1024 * 1024)
        throw new Error("系统采样响应超过大小上限");
      const value = JSON.parse(line);
      if (
        !Number.isFinite(value.collectedAt) ||
        !Array.isArray(value.volumes) ||
        !Array.isArray(value.warnings)
      )
        throw new Error("系统采样格式无效");
      last = value;
      lastAt = Date.now();
      for (const item of waiting) item.resolve(last);
      waiting.clear();
    } catch (error) {
      stop(error);
    }
  });
  child.once("error", (error) => stop(error));
  child.once("close", (code) => {
    clearInterval(timer);
    lines.close();
    if (!cancelled && !failure)
      stop(new Error(stderr || "系统采集器已停止 (" + code + ")"));
  });
  return {
    child,
    get failed() {
      return Boolean(failure || cancelled);
    },
    snapshot() {
      if (failure || cancelled)
        return Promise.reject(failure || new Error("系统采集器已停止"));
      if (last && Date.now() - lastAt <= timeoutMs)
        return Promise.resolve(last);
      return new Promise((resolve, reject) => waiting.add({ resolve, reject }));
    },
    cancel() {
      if (cancelled) return;
      cancelled = true;
      clearInterval(timer);
      child.kill();
      lines.close();
      for (const item of waiting) item.reject(new Error("系统采集器已停止"));
      waiting.clear();
    },
  };
}
module.exports = { startStatusCollector };
