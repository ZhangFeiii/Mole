import { useEffect, useRef, useState } from "react";
import type { Bootstrap, Entry, Metrics, ScanResult } from "./types";
import { Icon, type IconName } from "./Icon";
import { bytes, duration, percent, rates, treemap } from "./utils";

type Page = "overview" | "analyze" | "status";
type ScanState =
  | "idle"
  | "running"
  | "cancelling"
  | "complete"
  | "cancelled"
  | "error";
const pageNames = { overview: "概览", analyze: "磁盘分析", status: "系统状态" };
const skipNames: Record<string, string> = {
  link: "链接 / 目录联接",
  cloud: "云端占位文件",
  volume: "其他卷",
  permission: "权限不足",
  changed: "扫描期间已变更",
  unreadable: "无法读取",
  special: "特殊文件",
  depth: "目录过深",
};

function Sparkline({
  values,
  color = "#418a78",
  large = false,
}: {
  values: (number | null)[];
  color?: string;
  large?: boolean;
}) {
  const available = values.filter((v): v is number => v != null);
  if (available.length < 2)
    return (
      <div className={`chart-wait ${large ? "large" : ""}`}>
        等待更多实时采样
      </div>
    );
  const width = 320,
    height = large ? 126 : 45;
  const points = available
    .map(
      (v, i) =>
        `${(i * width) / (available.length - 1)},${height - 4 - (Math.min(100, Math.max(0, v)) / 100) * (height - 8)}`,
    )
    .join(" ");
  return (
    <svg
      className={`sparkline ${large ? "large" : ""}`}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      aria-label="最近实时采样趋势"
    >
      <path
        d={`M0 ${height} L${points.replaceAll(" ", " L")} L${width} ${height}Z`}
        fill={color}
        opacity=".075"
      />
      <polyline
        points={points}
        fill="none"
        stroke={color}
        strokeWidth="2"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

function MetricCard({
  icon,
  label,
  value,
  detail,
  values,
  color,
}: {
  icon: IconName;
  label: string;
  value: string;
  detail: string;
  values?: (number | null)[];
  color?: string;
}) {
  return (
    <section className="metric-card">
      <div className="metric-heading">
        <span className="metric-icon" style={{ color }}>
          <Icon name={icon} size={18} />
        </span>
        <span>{label}</span>
        <span className="live-dot" />
      </div>
      <div className="metric-value">{value}</div>
      <div className="metric-detail">{detail}</div>
      {values && <Sparkline values={values} color={color} />}
    </section>
  );
}

function Planet({ small = false }: { small?: boolean }) {
  return (
    <div className={`planet-scene ${small ? "small" : ""}`} aria-hidden="true">
      <div className="orbit orbit-one" />
      <div className="orbit orbit-two" />
      <div className="planet">
        <div className="continent one" />
        <div className="continent two" />
        <div className="planet-shade" />
      </div>
      <span className="star star-one" />
      <span className="star star-two" />
      <span className="satellite" />
    </div>
  );
}

export function App() {
  const bridge = window.mole;
  const [page, setPage] = useState<Page>("overview");
  const [boot, setBoot] = useState<Bootstrap>();
  const [metrics, setMetrics] = useState<Metrics>();
  const [history, setHistory] = useState<Metrics[]>([]);
  const [statusError, setStatusError] = useState("");
  const [error, setError] = useState("");
  const [selected, setSelected] = useState("");
  const [scanState, setScanState] = useState<ScanState>("idle");
  const [result, setResult] = useState<ScanResult>();
  const [progress, setProgress] = useState<ScanResult>();
  const [trail, setTrail] = useState<string[]>([]);
  const [tab, setTab] = useState<"entries" | "files">("entries");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState("size");
  const [limit, setLimit] = useState(30);
  const job = useRef<string | null>(null);
  const latestProgress = useRef<ScanResult | undefined>(undefined);
  const busy = scanState === "running" || scanState === "cancelling";

  useEffect(() => {
    if (!bridge) return;
    let live = true;
    bridge
      .bootstrap()
      .then((data) => {
        if (live) {
          setBoot(data);
          setSelected(data.home);
        }
      })
      .catch((e) => {
        if (live) setError(String(e.message));
      });
    const unsubscribe = bridge.onProgress((event) => {
      if (event.id === job.current) {
        latestProgress.current = event.data;
        setProgress(event.data);
      }
    });
    return () => {
      live = false;
      unsubscribe();
    };
  }, [bridge]);

  useEffect(() => {
    if (!bridge) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try {
        const data = await bridge!.status();
        if (!disposed) {
          setMetrics(data);
          setStatusError("");
          setHistory((previous) =>
            previous.at(-1)?.collectedAt === data.collectedAt
              ? previous
              : [...previous.slice(-39), data],
          );
        }
      } catch (e) {
        if (!disposed) setStatusError((e as Error).message);
      }
      if (!disposed) timer = setTimeout(refresh, 2500);
    }
    void refresh();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [bridge]);

  useEffect(() => {
    setLimit(30);
  }, [tab, query, sort, result]);

  async function choose() {
    if (!bridge || busy) return;
    try {
      const path = await bridge.chooseDirectory();
      if (path) {
        setSelected(path);
        setResult(undefined);
        setProgress(undefined);
        setTrail([]);
        setScanState("idle");
        setPage("analyze");
        setError("");
      }
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function scan(root = selected, nextTrail = trail) {
    if (!bridge || !root || job.current) return;
    const id = crypto.randomUUID();
    job.current = id;
    latestProgress.current = undefined;
    setPage("analyze");
    setSelected(root);
    setTrail(nextTrail);
    setScanState("running");
    setResult(undefined);
    setProgress(undefined);
    setError("");
    setQuery("");
    try {
      const data = await bridge.scan(root, id);
      if (job.current !== id) return;
      if ("root" in data) {
        setResult(data);
        setScanState(data.cancelled ? "cancelled" : "complete");
      } else {
        const partial = latestProgress.current as ScanResult | undefined;
        if (partial) setResult({ ...partial, partial: true, cancelled: true });
        setScanState("cancelled");
      }
    } catch (e) {
      if (job.current === id) {
        setError((e as Error).message);
        setScanState("error");
      }
    } finally {
      if (job.current === id) job.current = null;
    }
  }

  async function cancel() {
    if (!bridge || !job.current) return;
    setScanState("cancelling");
    try {
      await bridge.cancel(job.current);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function reveal(path: string) {
    try {
      await bridge?.reveal(path);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  function drill(entry: Entry) {
    if (entry.directory && !busy) void scan(entry.path, [...trail, selected]);
  }
  function back() {
    const previous = trail.at(-1);
    if (previous && !busy) void scan(previous, trail.slice(0, -1));
  }

  if (!bridge)
    return (
      <main className="fatal">
        <Icon name="shield" size={40} />
        <h1>请在 Mole Desktop 应用中打开</h1>
        <p>浏览器没有本机读取权限。本界面不会用演示数据代替真实系统信息。</p>
        <p>在 desktop 目录运行 npm run dev，或打开 Windows 便携应用。</p>
      </main>
    );

  const disk = metrics?.volumes[0];
  const network = rates(history.at(-2), history.at(-1));
  const data = busy ? progress : result;
  const tiles = result ? treemap(result.entries, result.bytes) : [];
  const sourceEntries =
    tab === "entries" ? (result?.entries ?? []) : (result?.largeFiles ?? []);
  const entries = [...sourceEntries]
    .filter((e) =>
      `${e.name} ${e.path}`.toLowerCase().includes(query.toLowerCase()),
    )
    .sort((a, b) =>
      sort === "name"
        ? a.name.localeCompare(b.name, "zh-CN")
        : sort === "modified"
          ? b.modified.localeCompare(a.modified)
          : b.size - a.size,
    );
  const skipped = result
    ? Object.values(result.skipped).reduce((a, b) => a + b, 0)
    : 0;
  const cpuHistory = history.map((m) => m.cpuPercent);
  const memoryHistory = history.map((m) => m.memoryPercent);
  const memoryAvailable = metrics?.memoryPercent != null;
  const platformLabel =
    boot?.platform === "win32" ? "WINDOWS" : "macOS 开发预览";

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">
            <span />
            <i />
          </div>
          <div>
            <strong>
              Mole<span className="brand-dot">.</span>
            </strong>
            <small>DESKTOP</small>
          </div>
        </div>
        <div className="workspace-label">
          你的电脑 <span>01</span>
        </div>
        <nav aria-label="主导航">
          {(
            [
              ["overview", "grid"],
              ["analyze", "disk"],
              ["status", "activity"],
            ] as [Page, IconName][]
          ).map(([id, icon]) => (
            <button
              key={id}
              className={`nav-item ${page === id ? "active" : ""}`}
              onClick={() => setPage(id)}
              aria-current={page === id ? "page" : undefined}
            >
              <Icon name={icon} />
              <span>{pageNames[id]}</span>
              {page === id && <span className="nav-current" />}
            </button>
          ))}
        </nav>
        <div className="sidebar-divider" />
        <div className="workspace-label">后续阶段</div>
        <div className="nav-item unavailable" title="只读预览版不提供清理功能">
          <Icon name="spark" />
          <span>清理与优化</span>
          <Icon name="lock" size={13} />
        </div>
        <div className="sidebar-bottom">
          <div className="safety-note">
            <Icon name="shield" size={22} />
            <strong>只看，不改动</strong>
            <p>
              文件留在本机。
              <br />
              不删除，不上传，不提权。
            </p>
          </div>
          <div className="build-label">
            <span className="live-dot" /> {platformLabel}
            <span>v{boot?.version ?? "0.1.0"}</span>
          </div>
          <div className="fork-label">独立社区界面 · 非官方 GUI</div>
        </div>
      </aside>
      <main className="main-panel">
        <header className="topbar">
          <div className="breadcrumb">
            工作空间 <span>/</span>
            <strong>{pageNames[page]}</strong>
          </div>
          <div className="topbar-right">
            <span className="local-label">
              <span className="live-dot" /> 本地运行
            </span>
            <span className="readonly-badge">
              <Icon name="shield" size={14} /> 只读模式
            </span>
          </div>
        </header>
        <div className="page-content">
          {error && (
            <div role="alert" className="notice error">
              <Icon name="info" />
              <span>{error}</span>
              <button className="text-button" onClick={() => setError("")}>
                关闭
              </button>
            </div>
          )}
          {statusError && (
            <div role="alert" className="notice warning">
              <Icon name="info" />
              <span>
                系统信息暂时无法更新：{statusError}
                。正在自动重试；已有读数可能已过期。
              </span>
            </div>
          )}

          {page === "overview" && (
            <>
              <div className="page-heading">
                <div>
                  <div className="eyebrow">
                    A LITTLE SPACE. A LITTLE CLARITY.
                  </div>
                  <h1>看清空间，从容整理。</h1>
                  <p>你的磁盘与系统状态，尽在眼前。</p>
                </div>
                <span className="phase-label">
                  PREVIEW <strong>01</strong>
                </span>
              </div>
              <section className="hero">
                <div className="hero-copy">
                  <span className="hero-kicker">
                    <span /> 从了解你的磁盘开始
                  </span>
                  <h2>
                    给磁盘一点
                    <br />
                    呼吸的空间。
                  </h2>
                  <p>
                    找出空间都去了哪里。
                    <br />
                    先看清，再决定——这一次，我们只读取。
                  </p>
                  <button
                    className="hero-button"
                    onClick={() => void scan()}
                    disabled={!selected || busy}
                  >
                    分析我的文件 <Icon name="arrow" size={18} />
                  </button>
                  <button
                    className="hero-secondary"
                    onClick={() => void choose()}
                    disabled={busy}
                  >
                    选择其他文件夹
                  </button>
                </div>
                <Planet />
                <div className="hero-coordinate">
                  LOCAL EXPLORER <span>·</span> READ ONLY
                </div>
              </section>
              <div className="section-heading">
                <h2>此刻的电脑</h2>
                <button
                  className="text-button"
                  onClick={() => setPage("status")}
                >
                  查看系统状态 <Icon name="arrow" size={15} />
                </button>
              </div>
              <div className="metric-grid">
                <MetricCard
                  icon="cpu"
                  label="CPU 使用率"
                  value={percent(metrics?.cpuPercent)}
                  detail={`${metrics?.cores ?? "—"} 个逻辑核心 · 实时采样`}
                  values={cpuHistory}
                />
                <MetricCard
                  icon="memory"
                  label="内存使用"
                  value={bytes(memoryAvailable ? metrics?.memoryUsed : null)}
                  detail={`${bytes(memoryAvailable ? metrics?.memoryTotal : null)} 总内存`}
                  values={memoryHistory}
                  color="#7882bb"
                />
                <MetricCard
                  icon="disk"
                  label="磁盘可用空间"
                  value={bytes(disk?.free)}
                  detail={
                    disk
                      ? `${disk.path} · ${bytes(disk.total)} 总容量`
                      : "正在读取本地磁盘"
                  }
                />
              </div>
              <div className="section-heading">
                <h2>本地磁盘</h2>
                <span className="subtle">系统容量读数 · 非可清理空间</span>
              </div>
              <div className="volume-grid">
                {metrics?.volumes.map((v) => (
                  <section className="volume-card" key={v.path}>
                    <div className="volume-icon">
                      <Icon name="disk" size={25} />
                    </div>
                    <div className="volume-content">
                      <div className="volume-title">
                        <strong>{v.path === "/" ? "系统磁盘" : v.path}</strong>
                        <span>{v.filesystem.toUpperCase()}</span>
                      </div>
                      <div className="capacity-track">
                        <span
                          style={{ width: `${(v.used / v.total) * 100}%` }}
                        />
                      </div>
                      <div className="volume-legend">
                        <span>已用 {bytes(v.used)}</span>
                        <span>可用 {bytes(v.free)}</span>
                      </div>
                    </div>
                  </section>
                )) ?? <div className="loading-box">正在读取磁盘容量…</div>}
                {metrics && !metrics.volumes.length && (
                  <div className="loading-box">
                    未能读取本地磁盘容量。仍可选择文件夹分析。
                  </div>
                )}
              </div>
              <div className="footnote">
                <Icon name="shield" size={15} />{" "}
                本阶段仅分析与监控，不会修改你的文件或系统设置。
              </div>
            </>
          )}

          {page === "analyze" && (
            <>
              <div className="page-heading">
                <div>
                  <div className="eyebrow">DISK EXPLORER</div>
                  <h1>每一份空间，都有去处。</h1>
                  <p>按目录看占用，按大小找文件。全程只读。</p>
                </div>
                <button
                  className="button secondary"
                  onClick={() => void choose()}
                  disabled={busy}
                >
                  <Icon name="folder" size={17} /> 选择文件夹
                </button>
              </div>
              <div className="path-bar">
                <button
                  className="icon-button"
                  aria-label="返回上层扫描"
                  disabled={!trail.length || busy}
                  onClick={back}
                >
                  <Icon name="back" size={17} />
                </button>
                <Icon name="folder" size={19} />
                <span title={selected}>{selected || "正在加载默认目录…"}</span>
                {busy ? (
                  <button
                    className="button stop"
                    disabled={scanState === "cancelling"}
                    onClick={() => void cancel()}
                  >
                    <Icon name="stop" size={14} />
                    {scanState === "cancelling" ? "正在停止" : "停止扫描"}
                  </button>
                ) : (
                  <button
                    className="button primary"
                    onClick={() => void scan()}
                    disabled={!selected}
                  >
                    <Icon name={result ? "refresh" : "search"} size={16} />
                    {result ? "重新扫描" : "开始扫描"}
                  </button>
                )}
              </div>

              {busy && (
                <section className="scan-progress" role="status">
                  <div className="scan-progress-title">
                    <span className="spinner" />
                    <strong>
                      {scanState === "cancelling"
                        ? "正在停止扫描…"
                        : "正在读取文件元数据…"}
                    </strong>
                    <span>
                      {((progress?.elapsedMs ?? 0) / 1000).toFixed(1)} 秒
                    </span>
                  </div>
                  <div className="indeterminate-track">
                    <span />
                  </div>
                  <p>
                    已统计 {(progress?.files ?? 0).toLocaleString()} 个文件 ·{" "}
                    {bytes(progress?.bytes ?? 0)} · 不读取文件内容
                  </p>
                </section>
              )}
              {data && (
                <div className="scan-summary">
                  <div>
                    <span>已统计逻辑大小</span>
                    <strong data-testid="scan-bytes">
                      {bytes(data.bytes)}
                    </strong>
                  </div>
                  <div>
                    <span>文件</span>
                    <strong data-testid="scan-files">
                      {data.files.toLocaleString()}
                    </strong>
                  </div>
                  <div>
                    <span>子目录</span>
                    <strong>{data.directories.toLocaleString()}</strong>
                  </div>
                  <div>
                    <span>扫描状态</span>
                    <strong className="summary-state">
                      {busy
                        ? "读取中"
                        : scanState === "cancelled"
                          ? "已停止 · 部分结果"
                          : result?.partial
                            ? "完成 · 有跳过项目"
                            : "扫描完成"}
                      {!busy && (
                        <Icon
                          name={result?.partial ? "info" : "check"}
                          size={17}
                        />
                      )}
                    </strong>
                  </div>
                </div>
              )}
              {!busy && scanState === "cancelled" && (
                <div className="notice warning">
                  <Icon name="info" size={18} />
                  <span>
                    扫描已停止。以下仅保留停止前的统计，不代表整个目录；可重新扫描。
                  </span>
                </div>
              )}
              {!busy && result && (skipped > 0 || result.limitReached) && (
                <div className="notice warning">
                  <Icon name="info" size={18} />
                  <div>
                    <strong>这是一份不完整的统计</strong>
                    <p>
                      {Object.entries(result.skipped)
                        .map(
                          ([reason, count]) =>
                            `${skipNames[reason] ?? reason} ${count} 项`,
                        )
                        .join(" · ")}
                      {result.limitReached &&
                        " · 已达到扫描范围上限，请选择更小的目录。"}
                    </p>
                  </div>
                </div>
              )}

              {result && !busy && (
                <>
                  <div className="section-heading">
                    <h2>空间分布</h2>
                    <span className="subtle">
                      面积与逻辑大小成比例 · 点击文件夹深入查看
                    </span>
                  </div>
                  {tiles.length > 0 ? (
                    <div className="treemap" data-testid="treemap">
                      {tiles.map((tile) => (
                        <button
                          key={tile.entry.path || "other"}
                          className={`tree-tile tile-${tile.index % 6} ${tile.width < 10 || tile.height < 18 ? "compact" : ""}`}
                          aria-label={`${tile.entry.name} · ${bytes(tile.entry.size)}`}
                          style={{
                            left: `${tile.x}%`,
                            top: `${tile.y}%`,
                            width: `${tile.width}%`,
                            height: `${tile.height}%`,
                          }}
                          disabled={!tile.entry.directory}
                          title={`${tile.entry.name} · ${bytes(tile.entry.size)}`}
                          onClick={() => drill(tile.entry)}
                        >
                          <div>
                            <Icon
                              name={tile.entry.directory ? "folder" : "file"}
                              size={17}
                            />
                            <strong>{tile.entry.name}</strong>
                          </div>
                          <span>{bytes(tile.entry.size)}</span>
                        </button>
                      ))}
                    </div>
                  ) : (
                    <div className="empty-inline">
                      此目录没有已统计到的非空文件。
                    </div>
                  )}
                  <section className="files-panel">
                    <div className="files-toolbar">
                      <div
                        className="tabs"
                        role="tablist"
                        aria-label="分析结果"
                      >
                        <button
                          role="tab"
                          aria-selected={tab === "entries"}
                          className={tab === "entries" ? "selected" : ""}
                          onClick={() => setTab("entries")}
                        >
                          目录占用 <span>{result.entries.length}</span>
                        </button>
                        <button
                          role="tab"
                          aria-selected={tab === "files"}
                          className={tab === "files" ? "selected" : ""}
                          onClick={() => setTab("files")}
                        >
                          大文件 <span>{result.largeFiles.length}</span>
                        </button>
                      </div>
                      <label className="search-box">
                        <Icon name="search" size={16} />
                        <input
                          aria-label="筛选结果"
                          value={query}
                          placeholder="筛选名称或路径"
                          onChange={(e) => setQuery(e.target.value)}
                        />
                      </label>
                      <select
                        aria-label="排序方式"
                        value={sort}
                        onChange={(e) => setSort(e.target.value)}
                      >
                        <option value="size">按大小</option>
                        <option value="name">按名称</option>
                        <option value="modified">按修改时间</option>
                      </select>
                    </div>
                    <div className="file-table-wrap">
                      <table className="file-table">
                        <thead>
                          <tr>
                            <th>
                              {tab === "entries" ? "文件夹 / 文件" : "文件"}
                            </th>
                            <th>大小</th>
                            <th>占比</th>
                            <th>
                              <span className="sr-only">操作</span>
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {entries.slice(0, limit).map((entry) => (
                            <tr key={entry.path}>
                              <td>
                                <div className="file-name">
                                  <span
                                    className={`file-icon ${entry.directory ? "" : "document"}`}
                                  >
                                    <Icon
                                      name={entry.directory ? "folder" : "file"}
                                      size={19}
                                    />
                                  </span>
                                  <div>
                                    <button
                                      className="file-link"
                                      disabled={!entry.directory}
                                      onClick={() => drill(entry)}
                                      title={entry.path}
                                    >
                                      {entry.name}
                                      {entry.directory && (
                                        <Icon name="chevron" size={13} />
                                      )}
                                    </button>
                                    {tab === "files" && (
                                      <small title={entry.path}>
                                        {entry.path}
                                      </small>
                                    )}
                                  </div>
                                </div>
                              </td>
                              <td className="number">{bytes(entry.size)}</td>
                              <td>
                                <div className="share">
                                  <span
                                    style={{
                                      width: `${result.bytes ? (entry.size / result.bytes) * 100 : 0}%`,
                                    }}
                                  />
                                </div>
                                <span className="share-label">
                                  {result.bytes
                                    ? (
                                        (entry.size / result.bytes) *
                                        100
                                      ).toFixed(1)
                                    : "0"}
                                  %
                                </span>
                              </td>
                              <td>
                                <button
                                  className="icon-button reveal-button"
                                  aria-label={`定位 ${entry.name}`}
                                  title="在文件管理器中定位（不会打开文件）"
                                  onClick={() => void reveal(entry.path)}
                                >
                                  <Icon name="external" size={15} />
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    {!entries.length && (
                      <div className="empty-inline">
                        {query
                          ? "没有匹配的结果。试试其他关键词。"
                          : "这个目录里还没有可显示的文件。"}
                      </div>
                    )}
                    <div className="table-footer">
                      <span>
                        {tab === "entries"
                          ? `显示当前层最大的 ${result.entries.length} 项，共读取 ${result.entryCount} 项`
                          : `显示递归扫描中最大的 ${result.largeFiles.length} 个文件`}{" "}
                        · 逻辑大小
                      </span>
                      {entries.length > limit && (
                        <button
                          className="text-button"
                          onClick={() => setLimit((n) => n + 30)}
                        >
                          加载更多
                        </button>
                      )}
                    </div>
                  </section>
                  <p className="footnote">
                    <Icon name="info" size={15} />{" "}
                    逻辑大小不等于磁盘实际分配空间；硬链接按路径计数。没有将任何文件标为“可以删除”。
                  </p>
                </>
              )}
              {!result && !busy && (
                <section className="scan-empty">
                  <Planet small />
                  <h2>
                    {scanState === "error" ? "扫描未完成" : "先了解，再整理。"}
                  </h2>
                  <p>
                    {scanState === "error"
                      ? "请检查上方错误提示，选择可访问的本地文件夹后重试。"
                      : "选择一个文件夹，查看空间分布与最大的文件。"}
                  </p>
                  <div className="empty-assurances">
                    <span>
                      <Icon name="shield" size={15} /> 不修改文件
                    </span>
                    <span>
                      <Icon name="lock" size={15} /> 数据不离开本机
                    </span>
                  </div>
                </section>
              )}
            </>
          )}

          {page === "status" && (
            <>
              <div className="page-heading">
                <div>
                  <div className="eyebrow">SYSTEM PULSE</div>
                  <h1>每一次变化，都看得见。</h1>
                  <p>来自这台电脑的实时读数，没有估算的健康分。</p>
                </div>
                <span className="sampling">
                  <span className="live-dot" />
                  {metrics
                    ? `更新于 ${new Date(metrics.collectedAt).toLocaleTimeString("zh-CN")}`
                    : "首次采样中"}
                </span>
              </div>
              <div className="status-chart-grid">
                <section className="status-chart">
                  <div className="section-heading">
                    <h2>
                      <Icon name="cpu" size={18} /> CPU
                    </h2>
                    <span>{metrics?.cores ?? "—"} 核心</span>
                  </div>
                  <strong className="status-number">
                    {percent(metrics?.cpuPercent)}
                  </strong>
                  <p>{metrics?.cpuModel || "正在读取处理器信息"}</p>
                  <Sparkline large values={cpuHistory} />
                  <div className="chart-axis">
                    <span>最近 {history.length} 次采样</span>
                    <span>现在</span>
                  </div>
                </section>
                <section className="status-chart">
                  <div className="section-heading">
                    <h2>
                      <Icon name="memory" size={18} /> 内存
                    </h2>
                    <span>
                      {bytes(memoryAvailable ? metrics?.memoryTotal : null)}{" "}
                      总量
                    </span>
                  </div>
                  <strong className="status-number">
                    {percent(metrics?.memoryPercent)}
                  </strong>
                  <p>
                    已使用 {bytes(memoryAvailable ? metrics?.memoryUsed : null)}
                  </p>
                  <Sparkline large values={memoryHistory} color="#7882bb" />
                  <div className="chart-axis">
                    <span>最近 {history.length} 次采样</span>
                    <span>现在</span>
                  </div>
                </section>
              </div>
              <div className="section-heading">
                <h2>网络活动</h2>
                <span className="subtle">
                  网卡计数差值 · 首次采样不显示速率
                </span>
              </div>
              <div className="network-grid">
                <section className="network-card">
                  <span className="network-icon">
                    <Icon name="download" />
                  </span>
                  <div>
                    <span>接收</span>
                    <strong>
                      {bytes(network.received)}
                      <small> / 秒</small>
                    </strong>
                  </div>
                </section>
                <section className="network-card">
                  <span className="network-icon purple">
                    <Icon name="upload" />
                  </span>
                  <div>
                    <span>发送</span>
                    <strong>
                      {bytes(network.sent)}
                      <small> / 秒</small>
                    </strong>
                  </div>
                </section>
              </div>
              <section className="machine-panel">
                <div className="section-heading">
                  <h2>关于这台电脑</h2>
                  <Icon name="info" size={17} />
                </div>
                <dl>
                  <div>
                    <dt>设备名称</dt>
                    <dd>{metrics?.hostname || "—"}</dd>
                  </div>
                  <div>
                    <dt>操作系统</dt>
                    <dd>{metrics?.os || "—"}</dd>
                  </div>
                  <div>
                    <dt>持续运行</dt>
                    <dd>
                      {metrics?.hostname ? duration(metrics.uptime) : "—"}
                    </dd>
                  </div>
                  <div>
                    <dt>读取方式</dt>
                    <dd>本地 Go 采集器 · 普通用户权限</dd>
                  </div>
                </dl>
              </section>
              {metrics && metrics.warnings.length > 0 && (
                <details className="metric-warnings">
                  <summary>
                    有 {metrics.warnings.length} 项系统信息暂不可用
                  </summary>
                  {metrics.warnings.map((warning, i) => (
                    <p key={i}>{warning}</p>
                  ))}
                </details>
              )}
              <p className="footnote">
                <Icon name="info" size={15} /> 网络速率为接口汇总，VPN /
                虚拟网卡可能重复计数。温度与风扇读数未接入，不以零值代替。
              </p>
            </>
          )}
        </div>
        <footer className="app-footer">
          <span>
            Mole Desktop <span className="footer-dot">·</span> 基于 Mole Windows
            开源项目
          </span>
          <span>
            <Icon name="shield" size={12} /> 无删除权限接口
          </span>
        </footer>
      </main>
    </div>
  );
}
