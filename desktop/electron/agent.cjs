const { spawn } = require("node:child_process");
const { createInterface } = require("node:readline");

// No generic command runner is exported. Arguments never pass through a shell.
function startAgent(executable, command, root, onMessage = () => {}) {
  if (!["scan", "status"].includes(command))
    throw new Error("Unsupported read-only command");
  if (command === "scan" && typeof root !== "string")
    throw new Error("Missing scan root");
  const child = spawn(
    executable,
    command === "scan" ? ["scan", root] : ["status"],
    { windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"] },
  );
  const lines = createInterface({ input: child.stdout });
  let result;
  let stderr = "";
  let cancelled = false;
  let parseError;
  let timedOut = false;
  const timeout = setTimeout(
    () => {
      timedOut = true;
      child.kill();
    },
    command === "status" ? 15000 : 31 * 60 * 1000,
  );
  child.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk.toString()).slice(-4000);
  });
  lines.on("line", (line) => {
    try {
      if (line.length > 4 * 1024 * 1024)
        throw new Error("Collector response is too large");
      const message = JSON.parse(line);
      if (command === "status") result = message;
      else if (message.type === "progress") onMessage(message.data);
      else if (message.type === "result") result = message.data;
      else throw new Error("Unknown collector response");
    } catch (error) {
      parseError = error;
      child.kill();
    }
  });
  const promise = new Promise((resolve, reject) => {
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(new Error(`无法启动只读采集器：${error.message}`));
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      lines.close();
      if (cancelled) return resolve({ cancelled: true });
      if (timedOut)
        return reject(new Error("读取超时，请选择较小的本地目录后重试"));
      if (parseError)
        return reject(new Error(`采集器数据无效：${parseError.message}`));
      if (code !== 0 || !result)
        return reject(new Error(stderr.trim() || `采集器退出 (${code})`));
      resolve(result);
    });
  });
  return {
    promise,
    child,
    cancel: () => {
      cancelled = true;
      child.kill();
    },
  };
}
module.exports = { startAgent };
