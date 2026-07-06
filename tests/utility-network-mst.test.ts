import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildMinimumSpanningTree } from "@geolibre/utility-network";

describe("buildMinimumSpanningTree", () => {
  it("returns no edges for zero or one node", () => {
    assert.deepEqual(buildMinimumSpanningTree(0, () => 0), []);
    assert.deepEqual(buildMinimumSpanningTree(1, () => 0), []);
  });

  it("connects two nodes with a single edge", () => {
    const edges = buildMinimumSpanningTree(2, (a, b) => Math.abs(a - b) * 10);
    assert.deepEqual(edges, [{ from: 0, to: 1, weight: 10 }]);
  });

  it("produces n-1 edges that reach every node exactly once", () => {
    // A 1D line of nodes at positions 0, 1, 2, ..., 9; distance is the gap.
    const positions = [0, 5, 1, 9, 2, 8, 3, 7, 4, 6];
    const dist = (a: number, b: number) => Math.abs(positions[a] - positions[b]);
    const edges = buildMinimumSpanningTree(positions.length, dist);

    assert.equal(edges.length, positions.length - 1);
    const reached = new Set<number>([0]);
    for (const edge of edges) {
      assert.ok(reached.has(edge.from), `edge.from (${edge.from}) must already be in the tree`);
      reached.add(edge.to);
    }
    assert.equal(reached.size, positions.length);
  });

  it("picks the globally cheapest tree, not just nearest-neighbor chaining", () => {
    // Node 0 is a hub equidistant (1) from nodes 1 and 2, which are far (100)
    // from each other. The MST must use the hub for both spokes (total 2),
    // never the direct far edge (which would make a worse tree).
    const dist = (a: number, b: number) => {
      const key = [a, b].sort().join("-");
      const distances: Record<string, number> = {
        "0-1": 1,
        "0-2": 1,
        "1-2": 100,
      };
      return distances[key];
    };
    const edges = buildMinimumSpanningTree(3, dist);
    const totalWeight = edges.reduce((sum, e) => sum + e.weight, 0);
    assert.equal(totalWeight, 2);
    for (const edge of edges) {
      assert.notEqual([edge.from, edge.to].sort().join("-"), "1-2");
    }
  });
});
