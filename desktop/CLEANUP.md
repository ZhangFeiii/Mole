# 受控清理模块交付

只读存档：[`v0.1.0-readonly`](https://github.com/ZhangFeiii/Mole/releases/tag/v0.1.0-readonly)，代码 `7732152`。
本模块用于独立写入分支；没有修改已发布的只读标签或 EXE。

## 接线 API

```js
const { createCleanupService } = require("./cleanup.cjs");
const cleanup = createCleanupService({
  // Canonical home is resolved by main: await fs.realpath(app.getPath('home')).
  home,
  // Use the fixed packaged/dev Go collector path already resolved by main.cjs.
  executable,
  trashItem: (value) => shell.trashItem(value),
});
const plan = await cleanup.preview();
// The controller must show a native confirmation dialog and write a started
// audit record before execute. The renderer supplies IDs, never paths.
const outcome = await cleanup.execute(plan.id, selectedIds);
```

- `preview()` 返回 `{id,createdAt,expiresAt,items,warnings}`，时间字段为 ISO 字符串。
- `items` 为 `{id,name,description,enabled,size,path,category}`；`path` 仅用于显示，不能用于执行参数。
- `execute(planId,selectedIds)` 返回 `{results:[{id,name,status,message}],warnings}`。
- `status` 为 `success` / `failed` / `skipped` / `unknown`。
- `cancel()` 仅停止尚未开始的项目；`close()` 永久关闭服务并清除未执行计划。
- 正在进行的 OS 回收调用不能保证可取消；最多等 45 秒后报告 `unknown`，锁住本服务且跳过剩余项目。
  controller 必须把 `unknown` 视作结果不确定并锁后续写入，不应静默重试。
- 计划仅 5 分钟有效、单次消费，精确到期即拒绝；执行开始、每项及回收前都会核对到期时间。

## 默认范围与保护

只在 Windows 启用，默认不接受用户任意指定清理目录：

- 用户根必须由可信主进程显式提供已规范化的 `app.getPath('home')`，不使用 `os.homedir()` 或环境变量推断。
- 生产缓存根固定为该用户目录下的 `AppData/Local`。`LOCALAPPDATA` 若被覆盖成 Documents、其他用户子目录或不同盘路径，直接拒绝预览和执行；它不能改变清理范围。目录联接/重解析点仍由原生属性与 realpath 校验拒绝。

- 当前用户 `%LOCALAPPDATA%/Temp`：超过 **7 天没有修改或元数据变更**的 `.tmp/.temp/.log/.dmp/.etl/.cache` 普通文件。
- 当前用户 `%LOCALAPPDATA%/CrashDumps`：超过 7 天的 `.dmp`。
- 不清理 Downloads、用户文档、浏览器资料、软件安装目录、注册表、系统缓存；不删除文件夹或清空回收站。
- 保留 `.git`、密钥/配置目录、备份/自动恢复目录、文档/密钥/数据库/压缩包扩展名（包括 `.docx.tmp` 等后缀）及上游默认白名单。
- 读取并在每项执行前重读 `~/.config/mole/whitelist.txt`。支持 UTF-8/UTF-16LE、注释、绝对路径、`*`、`?`、已知 `%VAR%`/`$env:VAR`。
  不支持的模式、读取失败或不可信重定向会停止清理，而不是忽略保护规则。
- 默认返回最多 500 个可选文件，最多检查 10,000 项/16 层/每目录 2,048 项，达到上限会警告；未列出的文件绝不清理。
- 文件大小为逻辑大小；移入回收站不承诺立即释放相同大小的磁盘空间。

## 原生属性与执行边界

新增 Go 命令：`desktop-agent inspect`。JSON 请求从 stdin 传入 `{paths:[...]}`，最多 2 MiB/2,048 路径。
响应包含 `platform` 和每个路径的 `attributes` 或 `error`，只读取元数据，不提供写文件/执行命令能力。
Windows 直接使用 `GetFileAttributes` / `GetDriveType`；不通过 PowerShell、PATH 或 SystemRoot 寻找可执行程序。
拒绝 UNC、设备命名空间、网络映射盘；非 Windows 不提供伪造属性。

每个候选与祖先都检查 native REPARSE_POINT/OFFLINE/RECALL 属性，普通文件另外保护 READONLY/SYSTEM 属性。
执行前再次检查祖先目录身份、路径 realpath、文件 dev/ino/size/mtime/ctime/mode/nlink、白名单和年龄。
所有修改集中在 `safeTrashItem` helper，只能调用注入的 OS `trashItem`；失败绝无永久删除后备逻辑。

**剩余限制：** `shell.trashItem` 是基于路径的 OS 操作，最后一次校验与系统移动之间仍存在极短的
TOCTOU 窗口。这里是面向普通用户非对抗环境的预览版，不宣称能消灭恶意并发替换造成的全部竞态。
应先用专用测试夹具验证；不要对被其他程序持续改写的目录批量执行。

## 测试与依赖注入

`node --test tests/cleanup.test.cjs` 覆盖普通夹具、白名单变化、文档保护、原生属性模拟、目录联接、
文件变化、单次计划、到期、回收失败无永久删除、取消以及超时未知结果锁。
普通跨平台测试的“回收站”是自动创建的临时文件夹，不等于 Windows 原生回收站验收。
Windows-only case 使用真实 Go 原生属性探针。

构造器仅供可信主进程/测试代码注入的选项：

```js
createCleanupService({
  trashItem: (value) => shell.trashItem(value),
  executable,
  platform: "win32",
  home: fixtureHome,
  env: {},
  testRoots: [
    {
      id: "fixture",
      name: "测试缓存",
      path: fixtureDirectory,
      extensions: [".tmp"],
      daysOld: 0,
    },
  ],
  testWhitelistPath: fixtureWhitelistPath,
});
```

主 agent 应在 Windows Electron E2E 中新建独立普通 `.tmp` 和受保护 `.docx`，使用上述测试根及真实
`shell.trashItem`，验证预览 → native 确认 → `.tmp` 不再位于原处，且 `.docx` 内容不变。
不要把这些测试选项、执行文件路径或清理根选择暴露给 renderer，也不要通过生产环境变量开启测试模式。
对结果未知和回收失败情况，必须保持失败状态，不使用 `fs.rm/unlink` 清场。
