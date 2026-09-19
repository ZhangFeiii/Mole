import { useState } from "react";
import type { Metrics } from "./types";
import { bytes, percent, duration } from "./utils";

export function StatusDetails({ metrics }: { metrics?: Metrics }) {
  const [mode, setMode] = useState<"cpu" | "memory">("cpu");
  const processes =
    (mode === "cpu"
      ? metrics?.processes?.topCpu
      : metrics?.processes?.topMemory) || [];
  return (
    <div className="status-details">
      <section className="files-panel">
        <div className="files-toolbar">
          <div>
            <h2>高占用进程</h2>
            <small className="subtle">
              只读采样 · 单核 CPU 上限为 100% · 最多 10 项
            </small>
          </div>
          <div className="tabs">
            <button
              aria-pressed={mode === "cpu"}
              onClick={() => setMode("cpu")}
            >
              按 CPU
            </button>
            <button
              aria-pressed={mode === "memory"}
              onClick={() => setMode("memory")}
            >
              按内存
            </button>
          </div>
        </div>
        <table className="process-table">
          <thead>
            <tr>
              <th>进程</th>
              <th>PID</th>
              <th>CPU</th>
              <th>内存</th>
            </tr>
          </thead>
          <tbody>
            {processes.map((item) => (
              <tr key={item.pid}>
                <td>{item.name || "名称不可读"}</td>
                <td>{item.pid}</td>
                <td>{percent(item.cpuPercent)}</td>
                <td>{bytes(item.memoryBytes)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!processes.length && (
          <p className="empty-inline">
            等待可用的进程样本；不会用模拟进程填充。
          </p>
        )}
      </section>
      <div className="hardware-grid">
        <section className="machine-panel">
          <h2>电池</h2>
          {metrics?.battery ? (
            <>
              <strong className="hardware-number">
                {percent(metrics.battery.percent)}
              </strong>
              <p>
                {metrics.battery.charging === true
                  ? "充电中"
                  : metrics.battery.charging === false
                    ? "未在充电"
                    : "充电状态不可用"}
              </p>
              {metrics.battery.timeRemainingSeconds != null && (
                <p>剩余时间 {duration(metrics.battery.timeRemainingSeconds)}</p>
              )}
            </>
          ) : (
            <p className="subtle">未检测到电池，或系统未提供可靠读数。</p>
          )}
        </section>
        <section className="machine-panel">
          <h2>GPU</h2>
          {metrics?.gpu?.length ? (
            metrics.gpu.map((gpu, index) => (
              <div key={index}>
                <strong>{gpu.name || "名称不可用"}</strong>
                <p>
                  使用率 {percent(gpu.utilizationPercent)} · 显存{" "}
                  {bytes(gpu.memoryBytes)}
                </p>
                <small className="subtle">{gpu.source}</small>
              </div>
            ))
          ) : (
            <p className="subtle">当前系统未提供 GPU 信息。</p>
          )}
        </section>
      </div>
      <section className="files-panel">
        <div className="files-toolbar">
          <h2>磁盘读写</h2>
          <span className="subtle">
            按设备显示，逻辑卷不直接相加 · 首帧速率为空
          </span>
        </div>
        <table className="process-table">
          <thead>
            <tr>
              <th>设备</th>
              <th>读取 / 秒</th>
              <th>写入 / 秒</th>
              <th>累计读取</th>
              <th>累计写入</th>
            </tr>
          </thead>
          <tbody>
            {metrics?.diskIO?.map((item) => (
              <tr key={item.name}>
                <td>{item.name}</td>
                <td>{bytes(item.readBytesPerSecond)}</td>
                <td>{bytes(item.writeBytesPerSecond)}</td>
                <td>{bytes(item.readBytes)}</td>
                <td>{bytes(item.writeBytes)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!metrics?.diskIO?.length && (
          <p className="empty-inline">磁盘 I/O 暂不可用。</p>
        )}
      </section>
      <p className="footnote">
        硬件利用率、温度和风扇接口因设备不同而异。未获得的读数明确显示为“—”；不会伪造健康分或自动结束进程。
      </p>
    </div>
  );
}
