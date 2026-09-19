# Windows cleanup catalog

`electron/cleanup-catalog.cjs` is a fixed, read-only directory catalog for the
Windows desktop worker. It returns names and paths only. It never reads a
directory, stats a file, enumerates profiles, checks process state, deletes a
file, or invokes a command. The worker must do native attribute checks,
process guards, bounded traversal, paging, and the existing preview/selection/
recycle-bin flow.

## API

```js
const {
  GROUPS,
  staticRoots,
  profileLocations,
  rootsForProfile,
} = require("./electron/cleanup-catalog.cjs");

const fixed = staticRoots(trustedHome);
const locations = profileLocations(trustedHome);
const browserRoots = rootsForProfile(
  locations.find((location) => location.id === "chrome"),
  "Default",
);
```

`trustedHome` is supplied by the trusted main process (on Windows, the
canonical local user home). The module rejects relative paths, UNC/device
paths, dot traversal, and environment-variable strings. It constructs paths
only below that home’s `AppData/Local` or `AppData/Roaming`; it does not read
`LOCALAPPDATA`, `APPDATA`, `USERPROFILE`, `TEMP`, or a user-selected directory.
POSIX absolute homes are accepted only to make unit tests use isolated string
fixtures; production integration remains Windows-only.

Every root has this exact shape:

```text
{ id, groupId, name, path,
  kind: "cache" | "log" | "temp" | "protected",
  extensions: null | string[], daysOld,
  recommendation: "recommended" | "manual" | "protected",
  reason, processNames: string[], source, enabled }
```

The returned arrays and root records are frozen. `rootsForProfile` accepts only
the exact immutable location object returned by `profileLocations`; a copied
or edited descriptor is rejected. The profile argument is never used as a
path fragment without validation.

## Fixed roots

| Root | Age | Status | Process guard | Boundary |
| --- | ---: | --- | --- | --- |
| `AppData/Local/Temp` | 7 days | recommended | worker/native check | Known temporary extensions only: `.tmp`, `.temp`, `.log`, `.dmp`, `.etl`, `.cache`. The directory itself is never removed. |
| `AppData/Local/CrashDumps` | 7 days | recommended | worker/native check | `.dmp` only; old diagnostic evidence is still subject to the worker’s final checks. |
| `AppData/Local/D3DSCache` | n/a | protected/disabled | n/a | Identification only. It is not a cleanup candidate. |

The Temp and CrashDumps locations are documented by Microsoft as the typical
per-user local temporary path and the default Windows Error Reporting local
dump path respectively:

- [Recognized environment variables](https://learn.microsoft.com/en-us/windows/deployment/usmt/usmt-recognized-environment-variables)
- [WER settings](https://learn.microsoft.com/en-us/windows/win32/wer/wer-settings)

The DirectX specification describes D3DSCache as a Windows-managed,
process-local, versioned cache integrated with OS disk-cleanup policy. It says
applications must not manually delete a system-managed shader cache outside
their own working directory. The AMD GPUOpen presentation mentions the
`%LOCALAPPDATA%\D3DSCache` path as part of a cold-cache performance experiment,
but that is not a deletion authorization. Therefore this catalog marks it
`protected`, `enabled: false`, with no age threshold:

- [D3D12 Shader Cache APIs](https://microsoft.github.io/DirectX-Specs/d3d/ShaderCache.html)
- [AMD Ryzen Processor Software Optimization (GPUOpen PDF)](https://gpuopen.com/gdc-presentations/2024/GDC2024_AMD_Ryzen_Processor_Software_Optimization.pdf)

## Registered profile locations

`profileLocations(home)` returns only these fixed registrations. It does not
look for directories. A worker may enumerate children of a registered path
using bounded, native-checked traversal and then pass the child name to
`rootsForProfile`.

| ID | Registered path | Accepted profile / roots | Process guard |
| --- | --- | --- | --- |
| `chrome` | `AppData/Local/Google/Chrome/User Data` | `Default` or `Profile N`; `Cache/Cache_Data` and `Code Cache` only; age 1 day | `chrome.exe` |
| `edge` | `AppData/Local/Microsoft/Edge/User Data` | `Default` or `Profile N`; `Cache/Cache_Data` and `Code Cache` only; age 1 day | `msedge.exe` |
| `firefox` | `AppData/Local/Mozilla/Firefox/Profiles` | One registered child name; `cache2` only; age 1 day | `firefox.exe` |
| `vscode` | `AppData/Roaming/Code` | `logs` and `CachedData`; age 7 days | `Code.exe` |
| `vscode-insiders` | `AppData/Roaming/Code - Insiders` | `logs` and `CachedData`; age 7 days | `Code - Insiders.exe` |
| `npm` | `AppData/Local/npm-cache` | `_cacache`; age 7 days; manual | `node.exe` |
| `pip` | `AppData/Local/pip/Cache` | `http`, `http-v2`, `wheels`; age 7 days; manual | `python.exe`, `pythonw.exe`, `python3.exe`, `python3.14.exe`, `pip.exe` |

Chrome/Edge locations follow Chromium’s official user-data documentation,
which identifies the Windows local user-data roots and describes the profile
directory and cache directory relationship. The Chromium source also makes the
leaf names explicit: the profile network-context code appends
`chrome::kCacheDirname` for the HTTP cache, the constants source defines that
name as `Cache`, the network service defines `Cache_Data` as a child below the
HTTP cache path, and the storage-partition code appends `Code Cache` for the
generated-code cache. This catalog intentionally narrows that broad profile
data to exactly `Cache/Cache_Data` and `Code Cache`. It does **not** scan
`Service Worker`, `Cookies`, `History`, `Login Data`, `Local Storage`, or an
arbitrary `AppData` child:

- [Chromium User Data Directory](https://chromium.googlesource.com/chromium/src/+/HEAD/docs/user_data_dir.md)
- [Chromium profile HTTP-cache path](https://chromium.googlesource.com/chromium/src/+/HEAD/chrome/browser/net/profile_network_context_service.cc)
- [Chromium `kCacheDirname` constant](https://chromium.googlesource.com/chromium/src/%2B/68.0.3423.2/chrome/common/chrome_constants.cc)
- [Chromium `Cache_Data` directory definition](https://chromium.googlesource.com/chromium/src/+/HEAD/content/browser/network_service_instance_impl.h)
- [Chromium generated-code `Code Cache` path](https://chromium.googlesource.com/chromium/src/+/HEAD/content/browser/storage_partition_impl.cc)

Firefox uses the Local profile registration only. Mozilla’s cache2 design
stores disk-cache entries and its index below `<profile>/cache2`; the catalog
never uses the Roaming profile location and does not infer a profile from an
environment variable:

- [Firefox cache2 design](https://github.com/mozilla-firefox/firefox/blob/main/netwerk/docs/cache2/doc.md)

VS Code’s official source resolves the Windows user-data directory below the
product data folder and the current environment service joins logs below
`userDataPath/logs`. An official 1.27.2 source snapshot defines
`nodeCachedDataDir` as `userDataPath/CachedData/<commit>`; the catalog therefore
uses the fixed `CachedData` parent as the worker’s bounded root, without
guessing a commit child. The historical official Electron-main source also
shows a separate `Code Cache` path, but this catalog deliberately does not add
that or any other VS Code cache until its current Windows contract is verified.
Only `logs` and the existing `CachedData` root are included. It explicitly
excludes `Cache`, `GPUCache`, `Code Cache`, `User`, `Backups`, `settings`,
`globalStorage`, `workspaceStorage`, extensions, crash reports, and
service-worker data. A custom `--user-data-dir` or portable directory is not
discovered or accepted:

- [VS Code user-data path source](https://github.com/microsoft/vscode/blob/main/src/vs/platform/environment/node/userDataPath.ts)
- [VS Code current `logsHome` source](https://github.com/microsoft/vscode/blob/main/src/vs/platform/environment/common/environmentService.ts)
- [VS Code 1.27.2 `nodeCachedDataDir` source](https://github.com/microsoft/vscode/blob/1.27.2/src/vs/platform/environment/node/environmentService.ts)
- [VS Code 1.56.2 `Code Cache` source](https://github.com/microsoft/vscode/blob/1.56.2/src/vs/platform/environment/electron-main/environmentMainService.ts)
- [VS Code troubleshooting: log locations](https://github.com/microsoft/vscode/blob/main/src/vs/sessions/skills/troubleshoot/SKILL.md)

npm documents the Windows default cache as `%LocalAppData%\npm-cache` and its
opaque content-addressable cache as `_cacache`. npm notes that clearing is
normally unnecessary and should be for reclaiming disk space, so this group is
manual review only:

- [npm cache documentation](https://docs.npmjs.com/cli/v11/commands/npm-cache/)

pip documents `%LocalAppData%\pip\Cache`, the `http-v2` format (with older
`http`) and wheel caching. pip cautions that cache contents are an
implementation detail that may change, so all three pip roots are manual
review only. The Python Windows documentation confirms versioned aliases such
as `python3.14.exe`; this catalog includes that exact documented name in
addition to `python.exe`, `pythonw.exe`, `python3.exe`, and `pip.exe` for its
process guard. It does not infer arbitrary renamed executables, and it does
not claim that every installed Python minor version is covered; a future
versioned alias must be added explicitly after checking the corresponding
official documentation:

- [pip caching documentation](https://pip.pypa.io/en/stable/topics/caching/)
- [Python 3.14 Windows aliases](https://docs.python.org/3.14/using/windows.html)

The process names are full executable names, never substring or wildcard
guards. A worker must re-check the process state immediately before any
mutation and must skip/mark uncertain roots if a guarded process is running.
