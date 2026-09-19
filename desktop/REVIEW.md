# Windows / Mac full review and parity work

Status: **review completed for the 0.3.0 controlled Windows preview**. Code commit `fc94c3dae52ca4fef1f475b3bf6983c532c5920b` passed [Windows acceptance run 35444938482](https://github.com/ZhangFeiii/Mole/actions/runs/35444938482), including the actual portable launcher. This document distinguishes observed facts, reproducible defects, platform differences, and unverified behavior. A green test run is not a claim of complete safety or full Mac parity.

## Baselines and evidence

- Windows release: `v0.2.0-windows-core`, commit `4e1d6958e9f5e92d8d82574f352da852915fd103`. Published EXE SHA-256: `6ce19c0a10e95bb016d765bf63ac6aa20b7d534c253725c6e3bc7bfdb58590ba`.
- Current changes: isolated `codex/windows-review`; application, cleanup, and status workers use separate worktrees based on the same commit. Published 0.2.0 and the read-only archive are not overwritten.
- Mac comparison target: version 1.14.0 (259). Feature evidence comes from that version's resources, not assumptions about the open-source CLI.
- Installed-window verification completed on 2026-09-19 for Mac 1.14.0 (259): the five navigation pages, software list/sort/search/update/startup controls, analysis treemap and status/process layout were viewed directly. Cleanup and optimization were observed at their landing pages; their execution buttons were not pressed. The original software tab was restored afterward. [Official feature descriptions](https://mole.fit/) are secondary references, not a substitute for this observation.
- Local installation/signature details remain private. Functional comparison does not establish a security endorsement; no Mac binary, licensing behavior, or system configuration is changed or reused.

## Feature and experience comparison

| Area | Installed Mac evidence | Windows 0.2.0 baseline | Current implementation / honest boundary |
|---|---|---|---|
| Navigation | Five tools: Clean, Software, Optimize, Analyze, Status | Six sidebar entries, extra overview | Five aligned workflows; overview is secondary, GUI remains original and Windows-appropriate |
| Cleanup discovery | Categories for apps, browsers, developer tools, logs, AI/communication/design, system and other storage | Only old Temp and CrashDumps files, 500-item cap | Documented Windows cache catalogs, ownership/in-use checks, grouping, explicit partial results and continuation; not all Mac cache families |
| Cleanup review | Recommended/all/none, protected items, cloud/running warnings | Manual flat selection, text whitelist only | Group review, selection tools, exclusions UI, progress/cancel and outcome summaries |
| Cleanup writes | Trash or permanent mode; explicit review | Trash only | Keep recoverable default; do not label Trash bytes as immediately freed disk space |
| Software | Installed applications, filters/sorts, running interception, official uninstall restrictions, separate sensitive data review | Registry/Appx query and official uninstall; flat list | Hardened identity and batch execution, running/unsupported reasons and better list controls; no guessed shared-data deletion |
| Updates / startup | Software update sources and login/background item management | Not implemented | Fixed Windows Settings links only; no silent update installation or startup/security-service modification |
| Optimization | Many macOS-specific repair/maintenance tasks; conditional applicability | DNS + all-fixed-disk default optimization | DNS plus real volume-identity-bound native maintenance; scope/permissions explicit, no unproved speed claims or fabricated health grade |
| Disk analysis | Treemap, drilldown, Finder actions and confirmed Trash context action | Read-only map/list/drilldown | Server-bound, explicit file Trash review; system/secret/cloud boundaries retained, directory recycling not implemented |
| Monitoring | CPU/memory/GPU/disk/network/battery, processes and explanations | CPU/memory/network/volumes/uptime | Real process and disk IO readings; hardware data only where reliably available, explicit unavailable reasons |
| Diagnostics / history | Operation logs, diagnostics, permissions and failure explanations | Raw JSONL log, no recovery UI | Durable operation journal, restart recovery, status/progress/history and actionable diagnostics |
| Hardware / menu tools | Apple-specific fans/battery helpers, Bluetooth/mobile battery, menubar utilities | Not implemented | Platform/vendor-specific; do not emulate readings or change hardware controls without a supported interface |

The live Mac interface uses a compact top segmented navigation, translucent dark surfaces and animated planet artwork. Windows keeps the same five workflow categories and review/selection structure, but uses an original light sidebar/card layout without copying those assets. The two-action maintenance page has no redundant search/size-sort controls; the sidebar remains fully visible at 980×680. This is workflow alignment, not a pixel-identical skin or a claim that the remaining Mac-only features were ported. No private installed-software inventory or machine readings are included in this repository.

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

## Implemented corrections and verification status

- Durable pre-operation journal and safe audit append; unknown outcomes survive restart. Acknowledged recovery rebuilds in-memory services, clears old scan/plan IDs, and excludes concurrent protection or preview operations.
- Native uninstall queues stop after an unknown result. MSI commands must name the previewed product; EXE paths and content fingerprints, running applications, Appx restrictions and runtime protections are checked separately.
- Strict whitelist decoding, native ancestor-first path inspection, an open-handle sharing probe, persistent exact exclusions, and shared file-recycle authorization. A native Windows fixture caught and corrected the original attribute-only probe: metadata-only opens do not test data-sharing conflicts.
- Volume GUID plus serial and mount letter are bound to the preview. The actual `Optimize-Volume` invocation is covered by a PowerShell mock fixture, including changed-letter rejection; this is not evidence of real disk optimization performance.
- Five primary pages; previews, selections and results persist across navigation. Status has real process/disk I/O fields and optional hardware readings, never synthetic fallback values. Contrast and current-navigation checks supplement screenshots.
- Recovery also revokes hidden-page selections, not only backend plans. Source E2E exercises the actual recovery buttons, cancellation and the resulting page reset; source and hardened-package test entry points are explicitly separate.
- Monitoring overhead: the unused per-process state query launched one external `ps` per PID on Darwin. Removing it preserved the two-second cadence; an eight-frame local check consumed 1.26 CPU seconds over 14.3 wall seconds (about 9% of one core), with about 21 MiB RSS. This is development-host evidence, not a Windows performance claim; Windows uses native process APIs and did not have that `ps` fork path.
- Hardened Electron fuses, embedded ASAR integrity and fixed-asset SHA-256 verification. A separate renderer-only packaged test does not turn Node inspector support back on.
- Delivery testing additionally launches the actual portable EXE, not only `win-unpacked`. It exposed a legitimate-page IPC rejection. A local Electron fixture using spaces, Unicode, `%` and `#` reproduced the failure: `loadFile`'s legacy serialization differed from the pinned `pathToFileURL` entrypoint. Loading that exact pinned URL fixes the reproduced case while leaving sender/frame/host/query/fragment/encoding guards unchanged. The [Electron implementation](https://github.com/electron/electron/blob/v44.4.3/lib/browser/api/web-contents.ts#L243-L259) explains the serialization difference; this is not a claim that every ordinary Windows path fails.
- Dependency scan on 2026-09-19: npm audit reported no known advisories. Windows-target `govulncheck` initially reported no reachable vulnerable symbols but identified imported `golang.org/x/sys/windows` advisory [GO-2026-5024](https://pkg.go.dev/vuln/GO-2026-5024). Upgrading x/sys to v0.44.0 raised the Go module minimum to 1.25; a subsequent scan reported no vulnerabilities. Builds use Go 1.27.1.
- Local Go race/vet and desktop build pass. Windows native Node tests: 127 passed, 3 skipped; two package tests then ran separately and both passed, leaving one Windows file-symlink fixture skipped for host privilege limitations. All 9 Windows GUI tests passed. The actual portable EXE self-extracted, successfully called bootstrap IPC and previewed the five pages. Details and artifact checksums are in [VALIDATION.md](VALIDATION.md).

## Remaining boundaries

- The portable preview is unsigned unless the explicit certificate gate produces and validates Authenticode. Checksums/fuses are not publisher identity, protected installation ACLs, or a safety certification.
- Windows Trash and third-party process launch remain path-based. Preflight and last-moment identity checks reduce exposure but do not atomically bind a file object across malicious same-account replacement. Fixed scripts and collectors have the same verify-to-launch deployment assumption.
- Vendor uninstallers are external programs, not sandboxed or made reversible by this UI. Uninstall data loss remains possible and requires user review/backup.
- Whole-folder recycle, automatic leftover removal, native software updates/startup editing, Apple-specific hardware/menubar features and many Mac cache families are intentionally outside this preview. Windows Settings links are navigation conveniences, not implementations of those features.
- Real hardware TRIM/defrag, diverse GPUs/batteries, OneDrive configurations and vendor installers require separate hands-on acceptance. The installed Mac pages were visually compared without running Mac maintenance; no claim of full feature parity or a pixel-identical interface is made.

## Completion gates

- Reproduce and resolve confirmed in-scope defects; record remaining platform/external limitations without claiming parity.
- Verify each implemented workflow and its negative paths, not merely isolated helpers.
- Windows-native queries and disposable write fixtures; fixture ownership checks must remain strict.
- Re-test development and packaged applications, runtime fuses/asset verification, restart recovery and UI layouts.
- Match final release artifacts, source commit and SHA-256. Do not replace the previous release.
- Installed Mac page comparison is complete; keep its private inventory/screenshots out of public release artifacts and distinguish observed layouts from unexecuted Mac maintenance behavior.
