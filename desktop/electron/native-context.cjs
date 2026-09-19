const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const path = require("node:path");

async function getPlatformContext(
  executable,
  { run = promisify(execFile), platform = process.platform } = {},
) {
  if (platform !== "win32") return { platform, schema: 1, systemDirectory: "" };
  const result = await run(executable, ["platform-info"], {
    windowsHide: true,
    shell: false,
    timeout: 10000,
    maxBuffer: 65536,
    encoding: "utf8",
  });
  const info = JSON.parse(result.stdout);
  if (
    info.platform !== "windows" ||
    info.schema !== 1 ||
    typeof info.systemDirectory !== "string" ||
    !/^[A-Za-z]:\\[^:\0\r\n]+$/.test(info.systemDirectory) ||
    path.win32.basename(info.systemDirectory).toLowerCase() !== "system32"
  )
    throw new Error("无法从原生系统接口确认 Windows 系统目录");
  return info;
}
module.exports = { getPlatformContext };
