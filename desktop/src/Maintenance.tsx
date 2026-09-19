import { useState } from "react";
import type {
  MaintenanceKind,
  MaintenancePlan,
  MaintenanceResult,
} from "./maintenanceTypes";
import { Icon } from "./Icon";
import { bytes } from "./utils";
import "./maintenance.css";

const content = {
  cleanup: {
    title: "让空间回到你手中。",
    subtitle: "仅扫描已审查的本机缓存。手动选择后移入回收站，不永久删除。",
    scan: "扫描可清理缓存",
    action: "清理所选项目",
    empty: "没有符合安全规则的可清理项目。",
    note: "不清空回收站，不处理文档、下载目录、目录联接或云端占位文件。回收站清空前可通过 Windows 恢复已移入的文件。",
  },
  applications: {
    title: "软件去留，由你决定。",
    subtitle:
      "查看已安装软件，调用其官方卸载程序；系统组件和危险卸载命令不开放执行。",
    scan: "扫描已安装软件",
    action: "卸载所选软件",
    empty: "没有发现可显示的软件。",
    note: "卸载可能删除软件数据，且不能通过回收站恢复。Mole 不删除共享目录或猜测残留；第三方卸载向导与 UAC 提示需由你确认。",
  },
  optimize: {
    title: "有依据地维护电脑。",
    subtitle: "查看受支持的 Windows 维护操作及影响，每一项都由你选择。",
    scan: "检查维护选项",
    action: "执行所选维护",
    empty: "当前环境没有可用的维护操作。",
    note: "维护并不保证提速。不清理注册表，不强制释放内存，不停用安全服务。磁盘维护按 Windows 默认策略处理，可能需要管理员权限。",
  },
};
const statuses: Record<string, string> = {
  success: "完成",
  completed: "完成",
  recycled: "已移入回收站",
  launched: "已启动，请完成系统向导",
  started: "已启动",
  failed: "失败",
  error: "失败",
  skipped: "已跳过",
  cancelled: "已取消",
  unsupported: "不支持",
  reboot_required: "需要重启",
  requires_admin: "需要管理员权限",
  "permission-denied": "权限不足",
  "reboot-required": "需要重启",
  "uac-cancelled": "已取消授权",
  "not-found": "项目已不存在",
  "identity-changed": "项目已变化，未执行",
  blocked: "受保护，未执行",
  rejected: "请求被拒绝",
  unknown: "结果未知，请检查系统状态",
};

export function Maintenance({
  kind,
  supported,
}: {
  kind: MaintenanceKind;
  supported: boolean;
}) {
  const copy = content[kind];
  const [plan, setPlan] = useState<MaintenancePlan>();
  const [selected, setSelected] = useState<string[]>([]);
  const [result, setResult] = useState<MaintenanceResult>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [started, setStarted] = useState(false);
  async function preview() {
    if (busy || !window.mole) return;
    setBusy(true);
    setError("");
    setPlan(undefined);
    setSelected([]);
    setResult(undefined);
    setStarted(false);
    try {
      setPlan(await window.mole.maintenancePreview(kind));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function execute() {
    if (busy || !window.mole || !plan) return;
    setBusy(true);
    setError("");
    setStarted(true);
    try {
      const outcome = await window.mole.maintenanceExecute(
        kind,
        plan.id,
        selected,
      );
      setResult(outcome);
      if (!outcome.cancelled) {
        setPlan(undefined);
        setSelected([]);
      }
    } catch (e) {
      setError((e as Error).message);
      setPlan(undefined);
      setSelected([]);
    } finally {
      setBusy(false);
      setStarted(false);
    }
  }
  const items =
    plan?.items.filter((item) =>
      `${item.name} ${item.publisher || ""} ${item.description || ""}`
        .toLowerCase()
        .includes(query.toLowerCase()),
    ) || [];
  const selectedBytes =
    plan?.items
      .filter((item) => selected.includes(item.id))
      .reduce((total, item) => total + (item.size || 0), 0) || 0;
  return (
    <section className="maintenance-page">
      <div className="page-heading">
        <div>
          <div className="eyebrow">PREVIEW. CHOOSE. CONFIRM.</div>
          <h1>{copy.title}</h1>
          <p>{copy.subtitle}</p>
        </div>
        <Icon name="shield" size={32} />
      </div>
      <div className="notice warning">
        <Icon name="info" />
        <p>{copy.note}</p>
      </div>
      {!supported && (
        <div className="notice warning" role="status">
          写入功能仅在 Windows 可用。macOS
          开发预览保留磁盘分析与系统监控，不会清理这台 Mac。
        </div>
      )}
      <div className="maintenance-toolbar">
        <button
          className="primary-button"
          onClick={() => void preview()}
          disabled={!supported || busy}
        >
          <Icon name="search" size={16} />
          {busy && !started ? "正在检查…" : copy.scan}
        </button>
        <span className="subtle">
          扫描仅预览 · 默认不勾选 · 计划 5 分钟内有效
        </span>
      </div>
      {error && (
        <div className="notice error" role="alert">
          {error}
        </div>
      )}
      {plan?.warnings?.map((warning, index) => (
        <div className="notice warning" key={index}>
          {warning}
        </div>
      ))}
      {plan && (
        <section className="files-panel">
          <div className="files-toolbar">
            <strong>预览清单 · {plan.items.length} 项</strong>
            <input
              aria-label="筛选维护项目"
              placeholder="筛选名称或发布者"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          {items.length ? (
            <div className="maintenance-items">
              {items.map((item) => (
                <label
                  key={item.id}
                  className={`maintenance-item ${item.enabled !== true ? "disabled" : ""}`}
                >
                  <input
                    type="checkbox"
                    aria-label={`选择 ${item.name}`}
                    checked={selected.includes(item.id)}
                    disabled={busy || item.enabled !== true}
                    onChange={(e) =>
                      setSelected((previous) =>
                        e.target.checked
                          ? [...previous, item.id]
                          : previous.filter((id) => id !== item.id),
                      )
                    }
                  />
                  <div>
                    <strong>{item.name}</strong>
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
                    {item.reason && (
                      <p className="maintenance-reason">{item.reason}</p>
                    )}
                  </div>
                  <span className="maintenance-meta">
                    {(item.size ?? item.sizeBytes) != null &&
                      bytes(item.size ?? item.sizeBytes)}
                    {(item.requiresAdmin || item.requiresElevation) && (
                      <small>管理员权限</small>
                    )}
                    {item.enabled !== true && <small>受保护 / 不可用</small>}
                  </span>
                </label>
              ))}
            </div>
          ) : (
            <div className="empty-inline">
              {plan.items.length ? "没有匹配的项目。" : copy.empty}
            </div>
          )}
          <div className="maintenance-footer">
            <span>
              已选择 {selected.length} 项
              {kind === "cleanup" && ` · ${bytes(selectedBytes)}`}
            </span>
            <button
              className="primary-button"
              disabled={busy || !selected.length}
              onClick={() => void execute()}
            >
              {started ? "等待确认或执行中…" : copy.action}
            </button>
          </div>
        </section>
      )}
      {result && (
        <section className="maintenance-results" aria-live="polite">
          <h2>{result.cancelled ? "已取消，没有执行操作。" : "操作结果"}</h2>
          {result.results.map((item, index) => (
            <div className="maintenance-result" key={`${item.id}-${index}`}>
              <strong>{item.name || item.id}</strong>
              <span>{statuses[item.status] || item.status}</span>
              <p>{item.message}</p>
              {item.drives?.map((drive) => (
                <p key={drive.driveLetter}>
                  {drive.driveLetter} · {statuses[drive.status] || drive.status}{" "}
                  · {drive.message}
                </p>
              ))}
            </div>
          ))}
          {result.warnings?.map((warning, index) => (
            <div className="notice warning" key={index}>
              {warning}
            </div>
          ))}
          {!result.cancelled && (
            <p className="subtle">
              请重新扫描确认当前状态。日志保存在本机应用数据目录的
              maintenance-logs 中，不上传。
            </p>
          )}
        </section>
      )}
    </section>
  );
}
