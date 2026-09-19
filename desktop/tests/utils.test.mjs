import { test } from "node:test";
import assert from "node:assert/strict";
import { bytes, percent, rates, treemap } from "../src/utils.ts";

test("unknown measurements are not formatted as zero", () => {
  assert.equal(bytes(null), "—");
  assert.equal(bytes(undefined), "—");
  assert.equal(bytes(0), "0 B");
  assert.equal(bytes(1024), "1 KiB");
  assert.equal(percent(null), "—");
});

test("network rate needs distinct snapshots and rejects counter reset", () => {
  const a = { collectedAt: 1000, networkSent: 10, networkReceived: 20 };
  const b = { collectedAt: 2000, networkSent: 110, networkReceived: 220 };
  assert.deepEqual(rates(a, b), { sent: 100, received: 200 });
  assert.deepEqual(rates(undefined, b), { sent: null, received: null });
  assert.deepEqual(rates(b, a), { sent: null, received: null });
  assert.deepEqual(rates(b, { ...a, collectedAt: 3000 }), {
    sent: null,
    received: null,
  });
});

test("treemap areas represent bytes, including unlisted remainder", () => {
  const entries = [
    { name: "A", path: "A", size: 60 },
    { name: "B", path: "B", size: 30 },
  ];
  const tiles = treemap(entries, 100);
  assert.equal(tiles.length, 3);
  for (const tile of tiles)
    assert.ok(
      Math.abs((tile.width * tile.height) / 100 - tile.entry.size) < 0.00001,
    );
  assert.ok(
    Math.abs(
      tiles.reduce((sum, tile) => sum + tile.width * tile.height, 0) - 10000,
    ) < 0.00001,
  );
  assert.deepEqual(treemap([], 0), []);
});
