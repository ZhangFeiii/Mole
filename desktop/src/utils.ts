import type { Entry, Metrics } from "./types";

export function bytes(value: number | null | undefined, digits = 1): string {
  if (value == null || !Number.isFinite(value)) return "—";
  if (value === 0) return "0 B";
  const exponent = Math.min(
    4,
    Math.max(0, Math.floor(Math.log(Math.abs(value)) / Math.log(1024))),
  );
  return `${(value / 1024 ** exponent).toLocaleString("zh-CN", { maximumFractionDigits: exponent ? digits : 0 })} ${["B", "KiB", "MiB", "GiB", "TiB"][exponent]}`;
}
export const percent = (n: number | null | undefined) =>
  n == null ? "—" : `${n.toFixed(1)}%`;
export function duration(seconds: number) {
  if (seconds >= 86400)
    return `${Math.floor(seconds / 86400)} 天 ${Math.floor((seconds % 86400) / 3600)} 小时`;
  if (seconds >= 3600)
    return `${Math.floor(seconds / 3600)} 小时 ${Math.floor((seconds % 3600) / 60)} 分`;
  return `${Math.floor(seconds / 60)} 分钟`;
}
export function basename(path: string) {
  return (
    path
      .replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .pop() || path
  );
}
export function rates(
  previous: Metrics | undefined,
  current: Metrics | undefined,
) {
  if (!previous || !current || current.collectedAt <= previous.collectedAt)
    return { sent: null, received: null };
  const seconds = (current.collectedAt - previous.collectedAt) / 1000;
  const delta = (a: number | null, b: number | null) =>
    a == null || b == null || b < a ? null : (b - a) / seconds;
  return {
    sent: delta(previous.networkSent, current.networkSent),
    received: delta(previous.networkReceived, current.networkReceived),
  };
}

export interface Tile {
  entry: Entry;
  x: number;
  y: number;
  width: number;
  height: number;
  index: number;
}
// Binary partitioning preserves exact area ratios; small/unlisted entries are
// represented by one explicit Other block, not silently dropped from the map.
export function treemap(entries: Entry[], total: number): Tile[] {
  const selected = entries.filter((e) => e.size > 0).slice(0, 12);
  const remainder = Math.max(
    0,
    total - selected.reduce((sum, e) => sum + e.size, 0),
  );
  if (remainder)
    selected.push({
      name: "其他项目",
      path: "",
      size: remainder,
      directory: false,
      modified: "",
    });
  const result: Tile[] = [];
  function split(
    items: Entry[],
    x: number,
    y: number,
    width: number,
    height: number,
  ) {
    if (!items.length) return;
    if (items.length === 1) {
      result.push({
        entry: items[0],
        x,
        y,
        width,
        height,
        index: result.length,
      });
      return;
    }
    const sum = items.reduce((s, e) => s + e.size, 0);
    let index = 1;
    let left = items[0].size;
    while (
      index < items.length - 1 &&
      Math.abs(left + items[index].size - sum / 2) < Math.abs(left - sum / 2)
    )
      left += items[index++].size;
    const ratio = left / sum;
    if (width >= height) {
      split(items.slice(0, index), x, y, width * ratio, height);
      split(
        items.slice(index),
        x + width * ratio,
        y,
        width * (1 - ratio),
        height,
      );
    } else {
      split(items.slice(0, index), x, y, width, height * ratio);
      split(
        items.slice(index),
        x,
        y + height * ratio,
        width,
        height * (1 - ratio),
      );
    }
  }
  split(selected, 0, 0, 100, 100);
  return result;
}
