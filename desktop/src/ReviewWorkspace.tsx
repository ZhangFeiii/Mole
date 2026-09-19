import { useEffect, useMemo, useState } from "react";
import type {
  MaintenancePlan,
  MaintenanceResult,
  MaintenanceProgress,
  ProtectedItem,
} from "./maintenanceTypes";
import { Icon } from "./Icon";
import { bytes } from "./utils";
import {
  itemBytes,
  reviewItems,
  selectionFor,
  remainingPlanSeconds,
  type ItemFilter,
} from "./maintenanceModel";

type ReviewKind = "cleanup" | "applications" | "optimize";
const content = {
  cleanup: {
    title: "让空间回到你手中。",
    subtitle: "按标准缓存位置分类审查，不扫描文档目录、登录资料或项目目录。",
    scan: "扫描可清理缓存",
    action: "移入回收站",
    empty: "当前批次没有符合规则的缓存。",
    note: "回收站清空前可恢复，也不保证立即释放磁盘空间。云端占位文件、链接、使用中项目和受保护内容不自动处理。",
  },
  applications: {
    title: "软件去留，由你决定。",
    subtitle: "按名称、大小和运行状态整理软件，执行前重新验证官方卸载程序。",
    scan: "扫描已安装软件",
    action: "卸载所选软件",
    empty: "当前筛选下没有软件。",
    note: "卸载可能删除软件数据，无法通过回收站恢复。系统组件和共享运行时受保护，不猜测删除共享目录或个人资料。",
  },
  optimize: {
    title: "有依据地维护电脑。",
    subtitle: "检查每一项维护的适用条件与影响，再决定执行哪些操作。",
    scan: "检查维护选项",
    action: "执行所选维护",
    empty: "当前环境没有适用的维护项。",
    note: "不承诺提速，不清理注册表，不强制释放内存，不关闭安全服务。管理员任务会明确提示，不静默提权。",
  },
};
export const resultLabels: Record<string, string> = {
  success: "完成",
  completed: "完成",
  recycled: "已回收",
  skipped: "未执行",
  failed: "失败",
  error: "失败",
  unknown: "结果未知",
  cancelled: "已取消",
  unsupported: "不适用",
  blocked: "受保护",
  rejected: "已拒绝",
  "permission-denied": "权限不足",
  "reboot-required": "需要重启",
  "uac-cancelled": "已取消授权",
  "not-found": "已不存在",
  "identity-changed": "对象已变化",
};

export function ReviewWorkspace({
  kind,
  supported,
  active = true,
}: {
  kind: ReviewKind;
  supported: boolean;
  active?: boolean;
}) {
  const bridge = window.mole;
  const text = content[kind];
  const [plan, setPlan] = useState<MaintenancePlan>();
  const [selected, setSelected] = useState<string[]>([]);
  const [result, setResult] = useState<MaintenanceResult>();
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<MaintenanceProgress | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<ItemFilter>("all");
  const [sort, setSort] = useState(kind === "applications" ? "name" : "size");
  const [group, setGroup] = useState("");
  const [clock, setClock] = useState(Date.now());
  const [protectedItems, setProtectedItems] = useState<ProtectedItem[] | null>(
    null,
  );
  useEffect(() => {
    if (!bridge) return;
    return bridge.onMaintenanceProgress((event) => {
      if (event.kind === kind)
        setProgress(event.phase === "idle" ? null : event);
    });
  }, [bridge, kind]);
  useEffect(() => {
    if (!active || !bridge) return;
    let live = true;
    bridge
      .maintenanceWorkspace(kind)
      .then((view) => {
        if (!live) return;
        if (view.plan) setPlan(view.plan);
        if (view.result) {
          setResult(view.result);
          setPlan(undefined);
          setSelected([]);
        }
        if (view.error) setError(view.error);
        setProgress(view.operation || null);
      })
      .catch(() => {});
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [active, bridge, kind]);
  const visible = useMemo(
    () => reviewItems(plan?.items || [], query, filter, sort, group),
    [plan, query, filter, sort, group],
  );
  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const selectedBytes = (plan?.items || [])
    .filter((item) => selectedSet.has(item.id))
    .reduce((sum, item) => sum + itemBytes(item), 0);
  const hiddenSelected = selected.filter(
    (id) => !visible.some((item) => item.id === id),
  ).length;
  const seconds = remainingPlanSeconds(plan?.expiresAt, clock);
  const running = busy || Boolean(progress);
  const pageGroups = useMemo(() => {
    const groups = new Map(
      (plan?.groups || []).map((value) => [
        value.id,
        { id: value.id, name: value.name, count: 0, bytes: 0 },
      ]),
    );
    for (const item of plan?.items || []) {
      const id = item.groupId || item.category || "other";
      if (!groups.has(id))
        groups.set(id, {
          id,
          name: item.groupName || (id === "other" ? "其他项目" : id),
          count: 0,
          bytes: 0,
        });
      const value = groups.get(id)!;
      value.count++;
      value.bytes += itemBytes(item);
    }
    return [...groups.values()].filter((value) => value.count > 0);
  }, [plan]);
  async function preview(cursor?: string) {
    if (!bridge || running) return;
    setBusy(true);
    setError("");
    setNotice("");
    setSelected([]);
    setPlan(undefined);
    setResult(undefined);
    setGroup("");
    try {
      const value = await bridge.maintenancePreview(
        kind,
        cursor ? { cursor } : undefined,
      );
      if ("cancelled" in value) setNotice("扫描已停止，没有修改任何文件。");
      else {
        setPlan(value);
        setClock(Date.now());
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }
  async function execute() {
    if (!bridge || !plan || !selected.length || running || seconds <= 0) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const value = await bridge.maintenanceExecute(kind, plan.id, selected);
      setResult(value);
      if (!value.cancelled) {
        setPlan(undefined);
        setSelected([]);
      }
    } catch (e) {
      setError((e as Error).message);
      setPlan(undefined);
      setSelected([]);
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }
  async function stop() {
    try {
      await bridge?.maintenanceCancel(kind);
      setNotice(
        "已请求停止。已启动的 Windows 操作不能撤销，未开始的项目会跳过。",
      );
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function protect(id: string) {
    if (!bridge || !plan || running) return;
    try {
      await bridge.protect(plan.id, id);
      setPlan(undefined);
      setSelected([]);
      setNotice("已加入保护。请重新扫描，受保护内容不会再进入清理计划。");
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function viewProtection() {
    try {
      setProtectedItems(await bridge!.protectedItems());
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function removeProtection(id: string) {
    try {
      const value = await bridge!.unprotect(id);
      if (!value.cancelled) {
        setProtectedItems(await bridge!.protectedItems());
        setPlan(undefined);
        setSelected([]);
      }
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <section className="maintenance-page">
      <div className="page-heading">
        <div>
          <div className="eyebrow">
            {kind === "cleanup"
              ? "CLEAN"
              : kind === "applications"
                ? "SOFTWARE"
                : "OPTIMIZE"}
          </div>
          <h1>{text.title}</h1>
          <p>{text.subtitle}</p>
        </div>
        <Icon
          name={
            kind === "cleanup"
              ? "spark"
              : kind === "applications"
                ? "grid"
                : "cpu"
          }
          size={28}
        />
      </div>
      <ol className="review-steps" aria-label="操作流程">
        <li className={!plan && !result ? "current" : ""}>1 扫描</li>
        <li className={plan ? "current" : ""}>2 审查与选择</li>
        <li className={progress?.phase === "execute" ? "current" : ""}>
          3 确认执行
        </li>
        <li className={result ? "current" : ""}>4 查看结果</li>
      </ol>
      <p className="review-policy">
        <Icon name="shield" size={16} />
        {text.note}
      </p>
      {!supported && (
        <div className="notice warning">
          Windows 写入功能在此平台不可用；你仍可使用分析和状态。
        </div>
      )}
      <div className="maintenance-toolbar">
        <button
          className="primary-button"
          onClick={() => void preview()}
          disabled={!supported || running}
        >
          <Icon name="search" size={16} />
          {running ? "正在处理…" : text.scan}
        </button>
        <div className="review-secondary-actions">
          {running && (
            <button className="button secondary" onClick={() => void stop()}>
              停止后续操作
            </button>
          )}
          {kind === "cleanup" && (
            <button
              className="text-button"
              disabled={!supported || running}
              onClick={() => void viewProtection()}
            >
              保护项
            </button>
          )}
          {kind === "applications" && (
            <>
              <button
                className="text-button"
                disabled={!supported}
                onClick={() =>
                  void bridge
                    ?.systemPage("startup")
                    .catch((e) => setError(e.message))
                }
              >
                Windows 启动项
              </button>
              <button
                className="text-button"
                disabled={!supported}
                onClick={() =>
                  void bridge
                    ?.systemPage("applications")
                    .catch((e) => setError(e.message))
                }
              >
                系统软件管理
              </button>
            </>
          )}
        </div>
      </div>
      {progress && (
        <div className="review-progress" role="status">
          <span className="live-dot" />
          <span>
            {progress.phase === "confirm"
              ? "等待原生确认"
              : progress.phase === "preview"
                ? "正在扫描和检查保护规则"
                : "正在执行"}
            {progress.currentName && " · " + progress.currentName}
          </span>
          <strong>
            {progress.total != null
              ? (progress.completed || 0) + " / " + progress.total
              : progress.visited != null
                ? progress.visited + " 项已检查"
                : ""}
          </strong>
        </div>
      )}
      {notice && (
        <div className="notice" role="status">
          {notice}
        </div>
      )}
      {error && (
        <div className="notice error" role="alert">
          {error}
        </div>
      )}
      {protectedItems && (
        <section className="files-panel protection-panel">
          <div className="files-toolbar">
            <h2>自定义保护</h2>
            <button
              className="text-button"
              onClick={() => setProtectedItems(null)}
            >
              收起
            </button>
          </div>
          {protectedItems.length ? (
            protectedItems.map((item) => (
              <div className="protection-row" key={item.id}>
                <span>{item.path}</span>
                <button
                  className="text-button"
                  disabled={running}
                  onClick={() => void removeProtection(item.id)}
                >
                  取消此项保护
                </button>
              </div>
            ))
          ) : (
            <p className="empty-inline">
              暂无自定义项。内置系统与资料保护始终生效。
            </p>
          )}
        </section>
      )}
      {plan && (
        <>
          <div className="review-summary">
            <div>
              <strong>{plan.items.length}</strong>
              <span>当前批次项目</span>
            </div>
            <div>
              <strong>
                {plan.items.filter((item) => item.enabled === true).length}
              </strong>
              <span>可选择</span>
            </div>
            {kind === "cleanup" && (
              <div>
                <strong>
                  {bytes(
                    plan.items.reduce((sum, item) => sum + itemBytes(item), 0),
                  )}
                </strong>
                <span>本批文件逻辑大小</span>
              </div>
            )}
            <div>
              <strong>
                {Math.floor(seconds / 60)}:
                {String(seconds % 60).padStart(2, "0")}
              </strong>
              <span>预览剩余有效时间</span>
            </div>
          </div>
          {(plan.partial || plan.hasMore) && (
            <div className="notice warning">
              {plan.hasMore
                ? "本批扫描已结束，仍有后续批次。查看下一批会清空当前选择。"
                : "本次扫描已结束，部分范围因保护或读取限制未纳入。"}
              此结果不代表所有缓存或全部可回收空间。
            </div>
          )}
          {plan.warnings?.length ? (
            <details className="metric-warnings">
              <summary>扫描说明与跳过原因 · {plan.warnings.length} 条</summary>
              {plan.warnings.map((warning, index) => (
                <p key={index}>{warning}</p>
              ))}
            </details>
          ) : null}
          <section className="files-panel">
            {kind !== "optimize" && (
              <div className="files-toolbar review-filters">
                <input
                  aria-label="筛选维护项目"
                  placeholder={
                    kind === "applications"
                      ? "搜索软件或发布者"
                      : "搜索名称或路径"
                  }
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
                <select
                  aria-label="筛选可用性"
                  value={filter}
                  onChange={(event) =>
                    setFilter(event.target.value as ItemFilter)
                  }
                >
                  <option value="all">全部项目</option>
                  <option value="available">可操作</option>
                  <option value="blocked">受保护 / 不适用</option>
                  {kind === "applications" && (
                    <option value="running">运行中</option>
                  )}
                </select>
                <select
                  aria-label="维护列表排序"
                  value={sort}
                  onChange={(event) => setSort(event.target.value)}
                >
                  <option value="size">按大小</option>
                  <option value="name">按名称</option>
                </select>
                {kind === "cleanup" && pageGroups.length > 1 && (
                  <select
                    aria-label="清理类别"
                    value={group}
                    onChange={(event) => setGroup(event.target.value)}
                  >
                    <option value="">所有类别</option>
                    {pageGroups.map((value) => (
                      <option key={value.id} value={value.id}>
                        {value.name} · {value.count}
                      </option>
                    ))}
                  </select>
                )}
              </div>
            )}
            <div className="selection-presets">
              <span>预览清单 · {plan.items.length} 项</span>
              {kind === "cleanup" && (
                <button
                  className="text-button"
                  disabled={running}
                  onClick={() =>
                    setSelected(selectionFor(visible, "recommended"))
                  }
                >
                  推荐项
                </button>
              )}
              {kind !== "optimize" && (
                <button
                  className="text-button"
                  disabled={running}
                  onClick={() => setSelected(selectionFor(visible, "all"))}
                >
                  选择当前筛选
                </button>
              )}
              <button
                className="text-button"
                disabled={running || !selected.length}
                onClick={() => setSelected([])}
              >
                清空选择
              </button>
            </div>
            <div className="maintenance-items">
              {visible.length ? (
                visible.map((item) => (
                  <div
                    key={item.id}
                    className={
                      "maintenance-item " +
                      (item.enabled === true ? "" : "disabled")
                    }
                  >
                    <input
                      id={"item-" + item.id}
                      type="checkbox"
                      aria-label={"选择 " + item.name}
                      checked={selectedSet.has(item.id)}
                      disabled={
                        running || seconds <= 0 || item.enabled !== true
                      }
                      onChange={(event) =>
                        setSelected((previous) =>
                          event.target.checked
                            ? [...previous, item.id]
                            : previous.filter((id) => id !== item.id),
                        )
                      }
                    />
                    <div>
                      <label htmlFor={"item-" + item.id}>
                        <strong>{item.name}</strong>
                      </label>
                      {item.description && item.description !== item.name && (
                        <p>{item.description}</p>
                      )}
                      {item.impact && <p>{item.impact}</p>}
                      {(item.publisher || item.version) && (
                        <small>
                          {[item.publisher, item.version]
                            .filter(Boolean)
                            .join(" · ")}
                        </small>
                      )}
                      {item.groupName && <small>{item.groupName}</small>}
                      {item.running && (
                        <p className="maintenance-reason">
                          运行中：
                          {item.knownProcessNames?.join("、") || "请先退出应用"}
                        </p>
                      )}
                      {item.reason && (
                        <p className="maintenance-reason">{item.reason}</p>
                      )}
                    </div>
                    <span className="maintenance-meta">
                      {(item.size ?? item.sizeBytes) != null &&
                        bytes(itemBytes(item))}
                      {(item.requiresAdmin || item.requiresElevation) && (
                        <small>管理员权限</small>
                      )}
                      {kind === "cleanup" && item.path && (
                        <button
                          className="text-button"
                          disabled={running}
                          onClick={() => void protect(item.id)}
                          aria-label={"保护 " + item.name}
                        >
                          永不清理
                        </button>
                      )}
                    </span>
                  </div>
                ))
              ) : (
                <p className="empty-inline">{text.empty}</p>
              )}
            </div>
            <div className="maintenance-footer">
              <div>
                <strong>已选择 {selected.length} 项</strong>
                {kind === "cleanup" && " · " + bytes(selectedBytes)}
                {hiddenSelected > 0 && (
                  <small>其中 {hiddenSelected} 项在当前筛选之外</small>
                )}
              </div>
              <button
                className="primary-button"
                disabled={running || !selected.length || seconds <= 0}
                onClick={() => void execute()}
              >
                {seconds <= 0 ? "预览已过期，请重新扫描" : text.action}
              </button>
            </div>
          </section>
          {plan.nextCursor && (
            <button
              className="button secondary next-batch"
              disabled={running}
              onClick={() => void preview(plan.nextCursor!)}
            >
              继续扫描下一批（清空本批选择）
            </button>
          )}
        </>
      )}
      {result && (
        <section className="maintenance-results" aria-live="polite">
          <h2>{result.cancelled ? "已取消，没有执行操作。" : "操作结果"}</h2>
          {result.summary && (
            <div className="review-summary">
              <div>
                <strong>{result.summary.completed}</strong>
                <span>完成</span>
              </div>
              <div>
                <strong>{result.summary.skipped}</strong>
                <span>未执行</span>
              </div>
              <div>
                <strong>{result.summary.failed}</strong>
                <span>失败</span>
              </div>
              <div>
                <strong>{result.summary.unknown}</strong>
                <span>结果未知</span>
              </div>
            </div>
          )}
          {result.summary?.bytesMoved != null && (
            <p className="subtle">
              移入回收站的文件大小 {bytes(result.summary.bytesMoved)}
              ，不是已释放空间。
            </p>
          )}
          {result.results.map((item, index) => (
            <div className="maintenance-result" key={item.id + "-" + index}>
              <strong>{item.name || item.id}</strong>
              <span className={"result-" + item.status}>
                {resultLabels[item.status] || item.status}
              </span>
              <p>{item.message}</p>
              {item.drives?.map((drive) => (
                <p key={drive.driveLetter}>
                  {drive.driveLetter} ·{" "}
                  {resultLabels[drive.status] || drive.status} · {drive.message}
                </p>
              ))}
            </div>
          ))}
          {result.warnings?.map((warning, index) => (
            <div className="notice warning" key={index}>
              {warning}
            </div>
          ))}
          <p className="footnote">
            结果会保留，切换工具不会丢失。操作记录保存在本机；下次执行前需重新扫描。
          </p>
        </section>
      )}
    </section>
  );
}
