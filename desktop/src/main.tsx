import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";
import "./maintenance.css";

class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: string }
> {
  state = { error: "" };
  static getDerivedStateFromError(error: Error) {
    return { error: error.message };
  }
  render() {
    if (this.state.error)
      return (
        <main className="fatal">
          <h1>界面暂时无法显示</h1>
          <p>{this.state.error}</p>
          <p>
            界面错误无法确认后台操作结果。请先核查 Windows
            任务状态，勿重复执行；重新打开后查看操作记录与恢复。
          </p>
        </main>
      );
    return this.props.children;
  }
}
createRoot(document.getElementById("root")!).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>,
);
