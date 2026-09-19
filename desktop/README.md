# Mole Desktop — 只读 Windows GUI

基于 [tw93/Mole 的 Windows 分支](https://github.com/tw93/Mole/tree/windows) 的独立社区桌面界面。
保留上游 MIT 许可；不是官方 Mac GUI 的移植包，也不包含商业版素材或授权补丁。

## 第一阶段的范围

- **概览**：真实 CPU、内存、本地磁盘容量与文件夹分析入口。
- **磁盘分析**：选择本地目录，递归统计逻辑大小，查看面积图、当前层占用、递归大文件；支持筛选、排序、下钻、返回、停止扫描与在文件管理器中定位。
- **系统状态**：实时 CPU、内存趋势、网络速率、主机和系统信息。
- 不提供清理、卸载、优化、启动项编辑、结束进程、提权、遥测或自动更新。

不使用演示数据代替本机结果。截图测试使用实际创建的合成文件；运行应用时读取的是你的电脑。

## 下载与启动（Windows）

在本 fork 的 **Actions → Read-only Desktop** 中选择最近通过的运行，下载
`Mole-Desktop-Windows-x64` artifact，解压后打开 `Mole-Desktop-0.1.0-win-x64.exe`。
`SHA256SUMS.txt` 可核对完整性。无需安装 Go、Node、Git 或 PowerShell 模块。

目前目标是 Windows 10/11 x64，普通用户运行。开发预览包尚未代码签名，Windows 可能显示
SmartScreen 提示；请核对来源与 SHA-256，**不要关闭系统防护或以管理员身份运行**。
便携启动器会解压运行文件，Electron 会写自己的用户配置/缓存；“只读”指扫描目标与系统设置，
并不声称整个应用进程完全没有磁盘写入。

## 数据和安全边界

1. 只读采集器仅支持 `status` 和 `scan ABSOLUTE_DIRECTORY`，没有通用命令执行接口。
2. GUI 只能扫描用户主目录或通过原生选择器明确授权的目录；IPC 校验来源窗口、主框架及本地页面。
3. 渲染器开启 sandbox/contextIsolation，关闭 Node 集成，网络请求与新窗口均被阻止。
4. 扫描只读取目录项和文件元数据，不打开文件内容；使用 Go `os.Root` 的目录句柄约束避免链接交换越界。
5. 跳过符号链接、Windows reparse points/目录联接、offline/recall 占位文件、特殊文件和其他卷。
   Windows 网络盘/UNC 路径不在第一阶段支持范围内。某些已本地缓存的 OneDrive 文件也可能因此被跳过。
6. 权限不足、变化中的文件、取消、深度/数量上限都会显示为**部分结果**。不静默提权。
7. 最多访问 2,000,000 项、128 层目录，单次扫描最多 30 分钟；列表保留当前层最大的 200 项和递归最大的 100 个文件。
   这些限制不会让截断统计冒充完整扫描。云盘、杀毒软件和设备驱动可能影响取消响应时间。
8. 显示的是**逻辑大小**，不是物理分配/可回收空间。硬链接按路径计数；稀疏文件、压缩、权限、APFS/NTFS 元数据
   都可能导致它与系统已用容量不同。“大文件”不意味着可以删除。
9. 网络速率由两次接口计数差值计算；首次采样/计数回退显示未知，VPN/虚拟网卡可能重复计数。
   失败读数显示缺失或明确警告，不伪造健康分、温度、风扇转速。

## 架构

```text
desktop/src                 React / TypeScript 界面（没有 Node 权限）
  ↕ 限定 IPC
desktop/electron            Electron 主进程、原生目录选择器、路径授权
  ↕ stdout JSON / 固定参数，无 shell
cmd/desktop-agent           scan / status 两个只读命令
internal/desktop            目录扫描、平台跳过策略、gopsutil 系统采集
```

Go 系统采集沿用 Windows 上游的 gopsutil 依赖与采集结构。扫描逻辑重新实现：上游终端版包含
删除流程且目录大小是浅层估算，不适合直接接入这个只读 GUI。原有 CLI 文件保持不变。

## 开发和验证

需要 Node.js 24+、Go 1.27.1（CI 固定版本；`os.Root` 最低要求 Go 1.24）。

```sh
cd desktop
npm ci
npm run dev
```

Go 不在 PATH 时设置 `MOLE_GO` 为 go 可执行文件完整路径。macOS 可运行开发预览用于界面验证；
该预览不代表 Windows 硬件兼容性已全部验证。不要在工程根目录运行上游清理命令来验证 GUI。

```sh
# 仓库根目录：只读后端测试和静态检查
go test -race ./internal/desktop ./cmd/desktop-agent
go vet ./internal/desktop ./cmd/desktop-agent

# desktop 目录：构建、IPC/后端集成、真实 Electron 窗口测试
npm run build
npm test
npm run test:e2e

# 在 Windows 构建便携包
npm run package:win
```

Windows CI 会运行原有 Go 工具测试、新只读后端测试、真实 Electron UI 测试，并生成便携 EXE、
SHA-256 与测试截图。测试覆盖真实字节统计、中文/特殊字符路径、链接/目录联接、取消、范围限制、
文件内容不变、空目录、目录选择/下钻/返回/筛选以及 IPC 路径越界拒绝。

发布前还应在你的 Windows 实机验证磁盘权限、OneDrive、外置盘、高 DPI 与 SmartScreen 体验。
该版本是第一阶段开发预览，不承诺生产级全盘清理安全，也未接入任何清理功能。

## 后续里程碑

按用户要求，先验证并冻结只读版：固定 Git 标签、GitHub Release 和 Windows 便携包。
随后在独立分支实现写入版的受控清理：预览清单、手动勾选、明确确认、移入回收站、操作记录。
只读版本的标签和发布包保持不变；写入版不默认提供永久删除或系统级优化。
