const path = require("node:path");
const fs = require("node:fs/promises");

function isWithin(root, target) {
  const relative = path.relative(root, target);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`))
  );
}

async function authorizePath(value, roots) {
  if (
    typeof value !== "string" ||
    !path.isAbsolute(value) ||
    value.includes("\0") ||
    value.length > 32767
  )
    throw new Error("无效的本地路径");
  // UNC and device namespaces can access networks/devices and are outside phase 1.
  if (process.platform === "win32" && /^(\\\\|\/\/)/.test(value))
    throw new Error("暂不支持网络或设备路径");
  const canonical = await fs.realpath(value);
  if (!roots.some((root) => isWithin(root, canonical)))
    throw new Error("请先通过“选择文件夹”授权此目录");
  return canonical;
}

function trustedSender(event, contents, expectedURL) {
  if (
    !event ||
    !contents ||
    event.sender !== contents ||
    event.senderFrame !== contents.mainFrame
  )
    return false;
  try {
    const actual = new URL(event.senderFrame.url);
    const expected = new URL(expectedURL);
    return (
      actual.protocol === "file:" &&
      expected.protocol === "file:" &&
      !actual.host &&
      !actual.username &&
      !actual.password &&
      !actual.search &&
      !actual.hash &&
      actual.href === expected.href &&
      event.senderFrame.url === expected.href
    );
  } catch {
    return false;
  }
}

module.exports = { isWithin, authorizePath, trustedSender };
