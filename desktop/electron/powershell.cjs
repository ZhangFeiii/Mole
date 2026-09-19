const { spawn } = require("node:child_process");
const path = require("node:path");

// Only bundled, reviewed scripts are executable. User data travels over stdin,
// never in a PowerShell expression, executable path, or command-line argument.
function createPowerShellRunner({
  scriptsDirectory,
  platform = process.platform,
  spawnProcess = spawn,
  systemRoot = process.env.SystemRoot,
} = {}) {
  return function runPowerShell(
    scriptName,
    request,
    { timeoutMs = 60000 } = {},
  ) {
    if (platform !== "win32")
      return Promise.reject(new Error("此操作仅支持 Windows"));
    if (!["applications", "optimize"].includes(scriptName))
      return Promise.reject(new Error("Unsupported maintenance script"));
    if (
      !systemRoot ||
      !/^[A-Za-z]:[\\/][^\r\n\0]+$/.test(systemRoot) ||
      /^(\\\\|\/\/)/.test(systemRoot)
    )
      return Promise.reject(new Error("Invalid Windows system directory"));
    if (
      typeof scriptsDirectory !== "string" ||
      !path.isAbsolute(scriptsDirectory)
    )
      return Promise.reject(new Error("Invalid bundled script directory"));
    const input = JSON.stringify(request);
    if (Buffer.byteLength(input) > 64 * 1024)
      return Promise.reject(new Error("Maintenance request is too large"));
    return new Promise((resolve, reject) => {
      const executable = path.win32.join(
        systemRoot,
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      );
      const child = spawnProcess(
        executable,
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          path.join(scriptsDirectory, `${scriptName}.ps1`),
        ],
        { shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
      );
      let stdout = "",
        stderr = "",
        failure;
      const writing =
        request?.action === "execute" ||
        ["flush-dns", "optimize-disks"].includes(request?.operation);
      function outcomeError(message) {
        const error = new Error(message);
        if (writing) error.code = "OUTCOME_UNKNOWN";
        return error;
      }
      const timer = setTimeout(() => {
        failure = outcomeError(
          "操作等待超时；已启动的系统维护或第三方卸载程序可能仍在运行，请先检查 Windows 状态",
        );
        child.kill();
      }, timeoutMs);
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString("utf8");
        if (Buffer.byteLength(stdout) > 8 * 1024 * 1024) {
          failure = outcomeError(
            "Maintenance response is too large; operation outcome is unknown",
          );
          child.kill();
        }
      });
      child.stderr.on("data", (chunk) => {
        stderr = (stderr + chunk.toString("utf8")).slice(-4000);
      });
      child.stdin.on("error", (error) => {
        failure = outcomeError(error.message);
      });
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(failure || error);
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        if (failure) return reject(failure);
        if (code !== 0) {
          let detail;
          try {
            const data = JSON.parse(stdout.replace(/^\uFEFF/, "").trim());
            detail = data.error?.message || data.message;
          } catch {
            /* stderr still contains parser/launch diagnostics. */
          }
          return reject(
            outcomeError(
              detail ||
                stderr.trim() ||
                `Windows 操作退出 (${code})，请检查系统状态`,
            ),
          );
        }
        try {
          resolve(JSON.parse(stdout.replace(/^\uFEFF/, "").trim()));
        } catch {
          reject(outcomeError("Windows 返回的数据不是有效 JSON"));
        }
      });
      child.stdin.end(input);
    });
  };
}
module.exports = { createPowerShellRunner };
