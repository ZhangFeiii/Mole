import { useEffect, useRef, useState } from "react";
import type { RecoveryState, MaintenanceProgress } from "./maintenanceTypes";

const kinds: Record<string, string> = {
  cleanup: "清理",
  applications: "软件卸载",
  optimize: "系统维护",
  files: "文件回收",
  recovery: "恢复核查",
};
export function OperationPanel({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [state, setState] = useState<{
    recovery: RecoveryState;
    operation: MaintenanceProgress | null;
  }>();
  const [error, setError] = useState("");
  async function refresh() {
    try {
      setState(await window.mole!.maintenanceState());
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  }
  useEffect(() => {
    if (open) {
      dialog.current?.showModal();
      void refresh();
    } else dialog.current?.close();
  }, [open]);
  async function recover() {
    try {
      await window.mole!.maintenanceRecover();
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <dialog
      ref={dialog}
      className="operation-dialog"
      onCancel={onClose}
      onClose={onClose}
    >
      <div className="files-toolbar">
        <h2>操作记录与恢复</h2>
        <button className="text-button" onClick={onClose} autoFocus>
          关闭
        </button>
      </div>
      <div className="operation-dialog-body">
        <p className="subtle">
          记录只保存在本机，不上传。恢复核查不会重放旧操作。
        </p>
        {error && (
          <div className="notice error" role="alert">
            {error}
          </div>
        )}
        {state?.recovery.required && (
          <div className="notice warning">
            <div>
              <strong>写入保护锁已启用</strong>
              <p>{state.recovery.reason}</p>
              <p>
                先检查卸载向导、Windows
                任务管理器、文件位置和回收站，确认上次任务已停止。
              </p>
              <button
                className="button secondary"
                disabled={Boolean(state.operation) || state.recovery.corrupt}
                onClick={() => void recover()}
              >
                我已核查，申请解除保护
              </button>
            </div>
          </div>
        )}
        {state?.operation && (
          <div className="notice">
            当前任务：{kinds[state.operation.kind]} ·{" "}
            {state.operation.phase === "preview"
              ? "扫描中"
              : "等待确认或执行中"}
          </div>
        )}
        <div className="section-heading">
          <h3>最近记录</h3>
          <button className="text-button" onClick={() => void refresh()}>
            刷新
          </button>
        </div>
        {state?.recovery.history.length ? (
          state.recovery.history.map((item, index) => (
            <div className="history-row" key={item.id + "-" + index}>
              <div>
                <strong>{kinds[item.kind] || item.kind}</strong>
                <small>{new Date(item.at).toLocaleString("zh-CN")}</small>
              </div>
              <span>
                {item.status === "unknown"
                  ? "结果未知，需核查"
                  : item.status === "acknowledged"
                    ? "已人工核查"
                    : item.status === "cancelled"
                      ? "已取消"
                      : "已返回结果"}{" "}
                · {item.count} 项
              </span>
            </div>
          ))
        ) : (
          <p className="empty-inline">暂无操作记录。</p>
        )}
      </div>
    </dialog>
  );
}
