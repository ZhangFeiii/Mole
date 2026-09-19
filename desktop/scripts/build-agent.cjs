const { mkdirSync, readdirSync, copyFileSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const desktop = path.resolve(__dirname, "..");
const target =
  process.env.GOOS ||
  (process.platform === "win32" ? "windows" : process.platform);
const output = path.join(
  desktop,
  "resources",
  `desktop-agent${target === "windows" ? ".exe" : ""}`,
);
mkdirSync(path.dirname(output), { recursive: true });
const flags = target === "windows" ? "-s -w -H=windowsgui" : "-s -w";
const result = spawnSync(
  process.env.MOLE_GO || "go",
  [
    "build",
    "-trimpath",
    "-ldflags",
    flags,
    "-o",
    output,
    "./cmd/desktop-agent",
  ],
  { cwd: path.resolve(desktop, ".."), stdio: "inherit", env: process.env },
);
if (result.error) {
  console.error(
    `Go build failed: ${result.error.message}. Install Go 1.24+ or set MOLE_GO.`,
  );
  process.exit(1);
}
if (result.status !== 0) process.exit(result.status ?? 1);
// Include upstream/runtime license texts with the binary, not just repository links.
const licenses = path.join(desktop, "resources", "licenses");
mkdirSync(licenses, { recursive: true });
copyFileSync(
  path.join(desktop, "..", "LICENSE"),
  path.join(licenses, "Mole-MIT.txt"),
);
for (const pkg of ["react", "react-dom", "scheduler"])
  copyFileSync(
    path.join(desktop, "node_modules", pkg, "LICENSE"),
    path.join(licenses, `${pkg}-MIT.txt`),
  );
const go = process.env.MOLE_GO || "go";
const cwd = path.resolve(desktop, "..");
const goroot = spawnSync(go, ["env", "GOROOT"], {
  cwd,
  encoding: "utf8",
  env: process.env,
});
if (goroot.status !== 0) throw new Error("Cannot locate Go runtime license");
copyFileSync(
  path.join(goroot.stdout.trim(), "LICENSE"),
  path.join(licenses, "Go-BSD.txt"),
);
const modules = spawnSync(
  go,
  [
    "list",
    "-deps",
    "-f",
    "{{if .Module}}{{.Module.Path}}|{{.Module.Dir}}{{end}}",
    "./cmd/desktop-agent",
  ],
  { cwd, encoding: "utf8", env: process.env },
);
if (modules.status !== 0)
  throw new Error(`Cannot enumerate Go licenses: ${modules.stderr}`);
for (const line of new Set(modules.stdout.split(/\r?\n/).filter(Boolean))) {
  const [name, directory] = line.split("|");
  if (!directory) continue;
  const files = readdirSync(directory).filter((file) =>
    /^(LICENSE|COPYING|NOTICE)(\.|$)/i.test(file),
  );
  if (!files.length) throw new Error(`Missing license for ${name}`);
  for (const file of files)
    copyFileSync(
      path.join(directory, file),
      path.join(licenses, `${name.replaceAll("/", "_")}-${file}`),
    );
}
console.log(`Built read-only collector: ${output}`);
