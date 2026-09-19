# Windows / Mac full review and parity work

Status: **in progress**. This document distinguishes observed facts, reproducible defects, platform differences, and unverified behavior. A green test run is not a claim of complete safety or Mac parity.

## Baselines and evidence

- Windows release: `v0.2.0-windows-core`, commit `4e1d6958e9f5e92d8d82574f352da852915fd103`. Published EXE SHA-256: `6ce19c0a10e95bb016d765bf63ac6aa20b7d534c253725c6e3bc7bfdb58590ba`.
- Current changes: isolated `codex/windows-review`; application, cleanup, and status workers use separate worktrees based on the same commit. Published 0.2.0 and the read-only archive are not overwritten.
- Mac comparison target: version 1.14.0 (259). Feature evidence comes from that version's resources, not assumptions about the open-source CLI.
- Actual installed-window verification is **pending**. [Official feature descriptions and screenshots](https://mole.fit/) are secondary references, not proof of a particular installation's runtime behavior.
- Local installation/signature details remain private. Functional comparison does not establish a security endorsement; no Mac binary, licensing behavior, or system configuration is changed or reused.

## Feature and experience comparison

| Area | Installed Mac evidence | Windows 0.2.0 baseline | Work / honest boundary |
|---|---|---|---|
| Navigation | Five tools: Clean, Software, Optimize, Analyze, Status | Six sidebar entries, extra overview | Align the five core workflows; keep the GUI concise, original, and Windows-appropriate |
| Cleanup discovery | Categories for apps, browsers, developer tools, logs, AI/communication/design, system and other storage | Only old Temp and CrashDumps files, 500-item cap | Add documented Windows cache catalogs, ownership/in-use checks, grouping, explicit partial results and continuation |
| Cleanup review | Recommended/all/none, protected items, cloud/running warnings | Manual flat selection, text whitelist only | Add group review, selection tools, exclusions UI, progress/cancel and outcome summaries |
| Cleanup writes | Trash or permanent mode; explicit review | Trash only | Keep recoverable default; do not label Trash bytes as immediately freed disk space |
| Software | Installed applications, filters/sorts, running interception, official uninstall restrictions, separate sensitive data review | Registry/Appx query and official uninstall; flat list | Harden identity and batch execution, expose running/unsupported reasons and better list controls; no guessed shared-data deletion |
| Updates / startup | Software update sources and login/background item management | Not implemented | Assess Windows-native equivalents separately; never silently install updates or disable startup/security services |
| Optimization | Many macOS-specific repair/maintenance tasks; conditional applicability | DNS + all-fixed-disk default optimization | Bind real volume identity, make scope/permissions explicit; add useful read-only health/startup checks instead of fake speed claims |
| Disk analysis | Treemap, drilldown, Finder actions and confirmed Trash context action | Read-only map/list/drilldown | Add server-bound, explicit file Trash review; keep system/secret/cloud boundaries and document unsupported directory cases |
| Monitoring | CPU/memory/GPU/disk/network/battery, processes and explanations | CPU/memory/network/volumes/uptime | Add real process and disk IO readings, hardware information only where reliably available, explicit unavailable reasons |
| Diagnostics / history | Operation logs, diagnostics, permissions and failure explanations | Raw JSONL log, no recovery UI | Add durable operation journal, restart recovery, status/progress/history and actionable diagnostics |
| Hardware / menu tools | Apple-specific fans/battery helpers, Bluetooth/mobile battery, menubar utilities | Not implemented | Platform/vendor-specific; do not emulate readings or change hardware controls without a supported interface |

## Reproduced security findings

| Severity | Finding in 0.2.0 | Required verification |
|---|---|---|
| P1 | Unknown/abandoned write lock disappears on restart or crash | Persist pre-operation state, fail closed on startup, explicit recovery acknowledgement; crash/restart tests |
| P1 | Native application uninstall batch continues after an unknown result | First unknown outcome must stop all subsequent native launches; native two-item fixture |
| P2 | Audit append follows links and lacks durable state/incomplete-record recovery | Reject links/hardlinks/reparse paths, synchronize writes, validate stored state; corruption/link tests |
| P2 | IPC sender accepts remote file hosts and URL fragments | Exact canonical local URL validation; malicious-host/fragment/encoding tests |
| P2 | White-list decoding replaces malformed UTF-8 and may silently lose a protection rule | Strict decoding with invalid/truncated/oversized inputs failing closed |
| Release | No Authenticode signature and default Electron runtime fuses | Harden runtime and verify packaged settings; keep unsigned preview clearly labelled unless a valid signing certificate is supplied |

Further application, volume identity, cancellation, package integrity and UI-state findings are tracked with the implementation and regression tests. No real user files, installed applications, caches, hardware settings, or Mac maintenance actions are used as destructive test fixtures.

## Completion gates

- Reproduce and resolve confirmed in-scope defects; record remaining platform/external limitations without claiming parity.
- Verify each implemented workflow and its negative paths, not merely isolated helpers.
- Windows-native queries and disposable write fixtures; fixture ownership checks must remain strict.
- Re-test development and packaged applications, runtime fuses/asset verification, restart recovery and UI layouts.
- Match final release artifacts, source commit and SHA-256. Do not replace the previous release.
- Complete installed Mac visual comparison when the unlocked desktop is available, or report that specific evidence gap explicitly.
