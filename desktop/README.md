# Mole Desktop — Windows 受控维护版

基于 tw93/Mole Windows 分支的独立社区桌面应用，保留 MIT 许可。不是商业 Mac GUI 的移植包，不包含它的素材或授权补丁。原上游 PowerShell CLI 与桌面版是独立入口，本桌面版不直接调用上游的一键清理脚本。

## 核心能力

| 功能 | 提供 | 边界 |
|---|---|---|
| 垃圾清理 | 当前用户缓存预览，按文件选择并移入回收站 | 不永久删除、不清空回收站、不把扫描结果当删除清单 |
| 软件管理 | Win32/当前用户 Store 软件清单，调用官方卸载程序 | 保护系统组件、驱动及运行时；拒绝危险命令；不猜测删除残留 |
| 系统状态 | CPU、内存、磁盘、网络速率、运行时长、目录分析 | 真实数据，不编造健康分或不可用的温度/风扇指标 |
| 性能维护 | 单项选择的 Windows 原生维护 | 权限与支持情况明确；不承诺提速，不改安全服务/注册表/电源策略 |

默认没有勾选。每次写入都经过 **预览 → 手动选择 → 原生确认框（默认取消）→ 结果**。
预览限时 5 分钟，主进程与各服务都校验项目 ID；只执行预览中的项目，一次一个维护任务。执行前重新检查安全条件，失败不冒充成功。

## Windows 下载与运行

在本 fork 的 [Windows Desktop Core 构建](https://github.com/ZhangFeiii/Mole/actions/workflows/desktop.yml) 选择 `codex/windows-core` 分支的成功运行，下载 `Mole-Desktop-Core-Windows-x64` artifact。
解压后运行 `Mole-Desktop-0.2.0-win-x64.exe`，用 `SHA256SUMS.txt` 核验完整性。

目标 Windows 10/11 x64，自带 Go 采集器与维护脚本，无需安装开发工具。维护使用系统自带 Windows PowerShell 5.1；脚本执行策略仅作用于该子进程，不改全局策略、不启动网络脚本。

普通用户即可分析、监控和清理自己的缓存。某些卸载程序显示 Windows UAC；需管理员权限的维护项目会提示或保持不可选。**不要关闭 SmartScreen、杀毒或系统防护。** 预览包未代码签名，不等于生产安全认证。macOS 开发运行仅开放读取能力，不会清理 Mac。

## 数据与安全

- 渲染器无 Node 权限，启用 sandbox/contextIsolation；IPC 校验窗口、主框架与本地 URL。禁止网页网络请求、新窗口与导航。
- Go 采集器只有 status/scan，没有删除或通用 shell。扫描通过目录句柄约束，跳过链接/目录联接、云占位文件、其他卷及特殊文件，部分结果明确标注。
- 软件/优化脚本由主进程固定白名单选择，使用固定系统 PowerShell 路径；数据通过 stdin JSON 传递，不插入命令表达式。渲染器不能传脚本路径或任意命令。
- 清理只用回收站，失败不改成永久删除。**卸载不能通过回收站恢复，请先备份软件数据。**
- 审计日志位于 Electron userData/maintenance-logs 的每日 JSONL 文件（Windows 通常在 %APPDATA%/Mole Desktop）。执行前无法写日志就不执行。日志留在本机，可能含软件名、缓存路径和错误信息，不应随意公开。
- 日志和 Electron 配置/缓存会写磁盘；“只读分析”指分析目标，不代表应用没有任何文件写入。
- 不提供遥测、自动更新、永久删除、残留擦除、启动项改写、结束进程或常驻管理员服务。

目录统计是逻辑大小，不是可回收空间。硬链接、稀疏文件、压缩和权限会造成与系统容量不同。最多扫描 2,000,000 项、128 层、30 分钟，列表保留当前层最大 200 项及大文件最大 100 项，截断标注部分结果。

## 构建与验证

需要 Node.js 24+、Go 1.27.1。Go 不在 PATH 时将 MOLE_GO 指向其完整路径。

```sh
# 仓库根目录
go test -race ./internal/desktop ./cmd/desktop-agent
go vet ./internal/desktop ./cmd/desktop-agent

cd desktop
npm ci
npm run build
npm test
npm run test:e2e
# Windows 主机打包
npm run package:win
```

CI 验证 Go、计划授权与取消、原生 Windows 查询、Electron GUI，并在打包后再次运行 GUI，确认随包采集器与 PowerShell 脚本位置。真实写操作的自动测试只能操作自行创建的临时夹具，不能卸载已有软件或清理真实缓存。

这是受控功能预览，不能据 CI 通过就声称 Windows 硬件、OneDrive、目录联接竞态、杀毒和第三方卸载器均安全。日常使用前仍需 Windows 实机/虚拟机试用，维护效果也需结合实际瓶颈判断。

## 协作与归档

- 只读基线：codex/windows-gui-readonly，由原任务独立归档，保留其发布包与标签不变。
- 整体集成、构建与测试：codex/windows-core，独立 worktree。
- 软件模块：codex/windows-applications；维护模块：codex/windows-optimize；垃圾清理由 codex/windows-cleanup 提供。
- 各模块持有自己的文件，只在集成分支汇总发布，不修改其他 agent 的工作区。
