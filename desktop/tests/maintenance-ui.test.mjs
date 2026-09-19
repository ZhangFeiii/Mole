import { test } from "node:test";
import assert from "node:assert/strict";
import {
  reviewItems,
  selectionFor,
  remainingPlanSeconds,
} from "../src/maintenanceModel.ts";
const items = [
  {
    id: "safe",
    name: "Cache",
    enabled: true,
    size: 20,
    groupId: "browser",
    recommended: true,
  },
  { id: "review", name: "Log", enabled: true, size: 40, groupId: "logs" },
  { id: "system", name: "System", enabled: false, running: true, size: 100 },
];
test("review selection presets never select blocked or hidden items", () => {
  assert.deepEqual(selectionFor(items, "recommended"), ["safe"]);
  assert.deepEqual(selectionFor(items, "all"), ["safe", "review"]);
  assert.deepEqual(selectionFor(items, "none"), []);
  const visible = reviewItems(items, "", "all", "size", "browser");
  assert.deepEqual(selectionFor(visible, "all"), ["safe"]);
});
test("software filters and sorting expose running/protected status accurately", () => {
  assert.deepEqual(
    reviewItems(items, "", "available", "size").map((x) => x.id),
    ["review", "safe"],
  );
  assert.deepEqual(
    reviewItems(items, "", "running", "name").map((x) => x.id),
    ["system"],
  );
  assert.equal(reviewItems(items, "missing", "all", "name").length, 0);
});
test("expired previews cannot masquerade as fresh client selections", () => {
  assert.equal(remainingPlanSeconds(1000, 1000), 0);
  assert.equal(remainingPlanSeconds(3000, 1000), 2);
  assert.equal(remainingPlanSeconds(undefined, 1000), 0);
});
