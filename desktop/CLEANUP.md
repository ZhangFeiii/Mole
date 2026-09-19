# Windows 清理与手选文件回收：评审版

只读 `v0.1.0-readonly` 和写入预览 `v0.2.0-windows-core` 保持归档不变。本目录的新实现用于独立评审分支，尚须整合主进程与 Windows 原生 CI 验证。

## 模块与职责

- `cleanup-catalog.cjs`：纯数据目录表；官方默认路径、分类、年龄、进程守卫与来源，不遍历/删除。
- `cleanup.cjs`：有界扫描、进度、分页与缓存分类汇总。
- `safe-trash.cjs`：共享计划、逐项复核与回收站执行；没有永久删除后备逻辑。
- `cleanup-safety.cjs`：路径/对象/白名单/原生属性与进程活动的共同校验。
- `cleanup-protection.cjs`：精确路径“永不清理”持久记录，事务锁、原子发布与损坏拒绝。

目录表的精确源码出处和未覆盖范围见 [CLEANUP-CATALOG.md](CLEANUP-CATALOG.md)。不通扫 AppData/Downloads，不把 Service Worker、Cookie、历史、登录数据、用户配置、工作区资料或安装程序一律视为垃圾。

## 缓存服务 API

```js
const cleanup = createCleanupService({
  home, // Main: await fs.realpath(app.getPath('home'))
  executable, // Fixed packaged/dev desktop-agent binary path
  trashItem: (value) => shell.trashItem(value),
  protectionDirectory, // Optional fixed app-owned directory; shared by both services
});
const page = await cleanup.preview({ onProgress, signal });
const next = await cleanup.preview({
  cursor: page.nextCursor,
  onProgress,
  signal,
});
await cleanup.protect(page.id, itemId);
const protectedItems = await cleanup.listProtected();
await cleanup.removeProtected(protectedId);
const result = await cleanup.execute(page.id, selectedIds, {
  onProgress,
  signal,
});
```

`onProgress` / `signal` 只由主进程创建，不能直接采纳 renderer 传来的函数或对象。原有无参数 `preview()`、双参数 `execute()` 仍可使用。

### 页结果

- 原有 `{ id, createdAt, expiresAt, items, warnings }` 字段保持；时间为 ISO。
- `items`：仅当前页已验证的文件，包含 `groupId/groupName`、`recommended` boolean、`recommendation`、`reason`、`source`。**推荐不等于默认勾选**。
- `groups`：稳定分类 ID、名称、累计已观察 `observedFiles/observedBytes`、已验证 `count/bytes`、`recommendedCount`、保护数量、跳过原因、根状态。
- `summary`：累计 `visited/observedFiles/observedBytes/eligibleCount/eligibleBytes`、本页 `pageCount/pageBytes`、`complete`。
- `partial/hasMore/nextCursor`：明确说明不完整/后续页。数量是**观察到的量**，不是全量可清理空间，也不是移入回收站后立即释放的空间。
- 每页最多 500 个文件或约 10,000 项检查；单个目录按 256 项分批读取，不再永远截断在同一批文件。
- 下一页产生新计划并使旧页选择失效。主进程/UI 必须用新页替换当前页、清空旧选择，不能跨页提交旧 ID。
- 每次继续会重查程序活动、原生属性、祖先身份和保护规则。浏览器启动或目录变化后停止该根，返回明确部分结果。
- 继续令牌仅保存在当前服务内，5 分钟到期且单次消费。超时/取消关闭目录句柄。16 层深度和 256 个浏览器配置的硬边界会明确标为部分结果，不冒充完整扫描。

## “永不清理”

`protect(planId,itemId)` 只能从服务内部当前计划中解析路径，不接受 renderer 路径。持久化成功后立即从该计划移除执行资格。

`listProtected()` 返回自定义记录 `{ id,path,createdAt,source,removable:true }[]`。`removeProtected(id)` 只接受已存储的保护 ID；内置保护不在此列表内，不能移除。主进程应对移除保护给出明确确认并审计。

默认存储于可信 home 的 `.config/mole/desktop-protection/protected-paths.json`；也可由主进程固定到 app userData 子目录。**缓存和分析服务必须使用同一目录**。

读取/写入检查祖先、链接/reparse、对象身份及文件大小。写入使用独占事务锁、临时文件、文件 fsync 和同目录原子 rename；已有文件必须是可识别的普通文件。只清理自己创建且身份一致的事务文件，不清理未知残留。已成功发布且 fsync 的事务会保存完成回执与规则摘要：如果杀毒软件只阻止最后的锁文件移除，重启后可以验证回执并继续读取已提交规则，下一次写入仅在锁已无占用且身份相符时安全退役它。pending 和锁清理彼此隔离，前者失败不再阻止后者收尾。真正未完成、损坏编码/JSON、摘要不一致、意外消失的已观察记录仍停止清理，不猜测为空规则。这里不是防恶意同账户篡改的认证数据库，也不声称原子 rename 已证明断电后所有文件系统的目录项耐久性。

同时保留并在执行前重读上游 `~/.config/mole/whitelist.txt`。UTF-8、UTF-16LE/BE 严格解码，非法字节不再被替换字符静默吞掉。支持已知环境变量、绝对路径、`*`、`?`；未知格式失败关闭。通配匹配不使用可能指数回溯的用户正则。

## 分析页共享引擎

```js
const { createSafeTrashEngine, fingerprint } = require("./safe-trash.cjs");
const analysisTrash = createSafeTrashEngine({
  home,
  executable,
  protectionDirectory,
  trashItem: (value) => shell.trashItem(value),
  authorizeSelection: async (opaqueIds) => {
    // Resolve only from main's current scan snapshot / permitted picker root.
    // Do not construct these paths from renderer strings.
    return opaqueIds.map((id) => serverSnapshot.get(id));
  },
});
const plan = await analysisTrash.preview(selectedEntryIds, {
  onProgress,
  signal,
});
```

快照数组每项为 `{id,path,root,size,mtimeMs,identity}`。`identity` 必须由扫描结果交给 renderer **之前**在主进程捕获：`fingerprint(await fs.lstat(path,{bigint:true}))`，不能在用户请求回收时临时重算并冒充原快照。

只允许真实授权根内、身份仍一致的普通文件，可手选 Documents/Downloads/外置本地盘中的普通文档；目录返回 `protectedFolder` 与明确原因。系统目录、AppData、密钥/开发元数据目录、白名单、已设保护和正在使用/属性不明的文件不允许回收。这里不实现泛目录删除。

`preview/execute/protect/listProtected/removeProtected/cancel/close` 与缓存服务一致。导出的 `context` 仅用于可信后端组合，不得通过 preload/IPC 暴露。

## 原生只读命令

- `desktop-agent inspect`：stdin `{paths:[...]}`，2 MiB/2,048 路径上限。返回每条 `attributes/inUse/error/code`。Windows 每次查询目标前逐段预检父目录，遇 reparse/offline/recall/非目录立即停止，绝不继续探测后代；对普通文件使用只读属性、no-share、OPEN_NO_RECALL/OPEN_REPARSE_POINT 句柄探测占用，不读文件内容。失败不假装空闲；UNC/设备/网络盘不允许。Node 侧也先通过此原生检查，再执行 lstat/opendir，避免先跨不可信父链。
- `desktop-agent activity`：`{platform,ok,names,warnings}`。Windows Toolhelp32 只读完整进程名快照，失败禁用有关 owner cache；不运行 PowerShell。程序仍可能在快照后启动，所以执行前重查并同时检查每个文件是否占用。
- `desktop-agent status-stream`：固定 2 秒节拍，同一进程串行 Collect，单轮 context 8 秒，JSON 一行一帧，输出失败/中断即退出。不接受 renderer 间隔参数，不写磁盘；原 `status` 仍是单次读取。
- `desktop-agent platform-info`：无输入，`{platform,schema:1,systemDirectory}`。Windows 直接使用 `GetSystemDirectory`，不读 SystemRoot/Path 环境变量；非 Windows 的目录为空。主进程用它建立可信 PowerShell 路径。

## 执行与剩余限制

所有 `execute`（包括分析页）必须先经过主进程的本机确认、逐项清单和**持久 active-operation journal**。该统一流程由主集成负责；本模块的内存 unknown 锁不能替代跨重启恢复。

每次回收重新检查保护、owner、native 属性/占用、祖先 dev/ino/mode、文件 dev/ino/size/mtime/ctime/mode/nlink 和有效期。计划 5 分钟、单次消费、只允许精确 ID。结果为 success/failed/skipped/unknown。未知结果立即停批次、锁服务，主进程保持 journal 未决，不能通过重启静默解锁。

`cancel()` 停止未开始的项目。已开始的 OS Trash 不能承诺立即取消，45 秒无终态即报告 unknown，没有永久删除后备。Windows 的 Trash 是路径接口，最终检查与移动之间仍有极短 TOCTOU 窗口；这里不宣称解决恶意同账户并发替换的全部问题。

清理程序名按官方默认应用定义；任意改名/自定义 portable 或配置路径不是已覆盖的安装形态。系统管理 DirectX shader cache 明确只读保护，不违反官方规范手工删其文件。安装包不是默认垃圾；用户可在分析页明确选择普通安装文件回收。

## 验证

仅在自动创建的临时夹具中测试，模拟回收不等于 Windows 真实回收验收：

```sh
node --test desktop/tests/cleanup*.test.cjs
go test -race ./internal/desktop ./cmd/desktop-agent
go vet ./internal/desktop ./cmd/desktop-agent
```

回归包括旧版全部保护、损坏编码复现、真实目录表夹具（凭据/资料保留）、运行中跳过和执行时重查、分页完整遍历/过期/取消/目录变化、持久保护/移除/损坏/链接/锁、分析快照 ID 与替换检测、原生 in-use Windows 条件测试、流式采集不重叠与输出中断。

测试注入 `testRoots/testPageSize/testWorkLimit/testWhitelistPath/readActivity/inspectAttributes` 仅用于可信测试代码；不要通过 renderer 或生产环境变量打开。所有 inspector 测试 stub 应显式返回 `inUse:false` 或故障状态。Windows 集成应使用真实 collector 与真实 `shell.trashItem`，只移动专用夹具并校验旁边保护文件不变。
