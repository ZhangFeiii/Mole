import type { MaintenanceItem } from "./maintenanceTypes";

export type ItemFilter = "all" | "available" | "blocked" | "running";
export function itemBytes(item: MaintenanceItem): number {
  return item.size ?? item.sizeBytes ?? 0;
}
export function recommended(item: MaintenanceItem): boolean {
  return (
    item.enabled === true &&
    (item.recommended === true || item.recommendation === "recommended")
  );
}
export function reviewItems(
  items: MaintenanceItem[],
  query: string,
  filter: ItemFilter,
  sort: string,
  group = "",
): MaintenanceItem[] {
  const search = query.trim().toLowerCase();
  return items
    .filter((item) => {
      if (filter === "available" && item.enabled !== true) return false;
      if (filter === "blocked" && item.enabled === true) return false;
      if (filter === "running" && item.running !== true) return false;
      if (group && (item.groupId || item.category || "") !== group)
        return false;
      return [
        item.name,
        item.description,
        item.publisher,
        item.groupName,
        item.path,
      ].some((value) => value?.toLowerCase().includes(search));
    })
    .sort((a, b) =>
      sort === "size"
        ? itemBytes(b) - itemBytes(a) || a.name.localeCompare(b.name)
        : a.name.localeCompare(b.name, "zh-CN"),
    );
}
export function selectionFor(
  items: MaintenanceItem[],
  preset: "all" | "recommended" | "none",
): string[] {
  if (preset === "none") return [];
  return items
    .filter(
      (item) =>
        item.enabled === true &&
        (preset !== "recommended" || recommended(item)),
    )
    .slice(0, 500)
    .map((item) => item.id);
}
export function remainingPlanSeconds(
  expiresAt: string | number | undefined,
  now: number,
): number {
  const value =
    typeof expiresAt === "number" ? expiresAt : Date.parse(expiresAt || "");
  return Number.isFinite(value)
    ? Math.max(0, Math.ceil((value - now) / 1000))
    : 0;
}
