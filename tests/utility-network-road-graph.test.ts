import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildRoadGraph,
  pathToRoot,
  placeJunctionsAlongRoads,
  shortestPathTree,
  snapToNearestNode,
} from "@geolibre/utility-network";
import type { FeatureCollection, LineString } from "geojson";

// A simple 3x3 street grid: three horizontal roads (y=0, 0.005, 0.01) and
// three vertical roads (x=0, 0.005, 0.01), each explicitly passing through
// every intersection vertex — mirroring how real OSM ways share coordinates
// at intersections (buildRoadGraph merges nodes by coordinate, not by
// detecting geometric crossings).
const XS = [0, 0.005, 0.01];
const YS = [0, 0.005, 0.01];
const GRID_ROADS: FeatureCollection<LineString> = {
  type: "FeatureCollection",
  features: [
    ...YS.map((y) => ({
      type: "Feature" as const,
      properties: { highway: "residential" },
      geometry: {
        type: "LineString" as const,
        coordinates: XS.map((x) => [x, y]),
      },
    })),
    ...XS.map((x) => ({
      type: "Feature" as const,
      properties: { highway: "residential" },
      geometry: {
        type: "LineString" as const,
        coordinates: YS.map((y) => [x, y]),
      },
    })),
  ],
};

describe("buildRoadGraph", () => {
  it("merges shared intersection vertices into single nodes", () => {
    const graph = buildRoadGraph(GRID_ROADS);
    // 3x3 grid of distinct intersections, not 6 lines x 3 vertices = 18.
    assert.equal(graph.nodes.length, 9);
  });

  it("gives every interior node 4 neighbors and every corner 2", () => {
    const graph = buildRoadGraph(GRID_ROADS);
    const centerIndex = graph.nodes.findIndex(
      ([x, y]) => x === 0.005 && y === 0.005,
    );
    assert.equal(graph.adjacency[centerIndex].length, 4);
    const cornerIndex = graph.nodes.findIndex(([x, y]) => x === 0 && y === 0);
    assert.equal(graph.adjacency[cornerIndex].length, 2);
  });
});

describe("placeJunctionsAlongRoads", () => {
  it("places at least one point per road, all on the road network", () => {
    const points = placeJunctionsAlongRoads(GRID_ROADS, 0.05);
    assert.ok(points.length >= GRID_ROADS.features.length);
    // A small epsilon absorbs floating-point noise from turf's along()
    // walking distance-along a line, not an exact bounds check.
    const eps = 1e-6;
    for (const [x, y] of points) {
      assert.ok(x >= -eps && x <= 0.01 + eps);
      assert.ok(y >= -eps && y <= 0.01 + eps);
    }
  });
});

describe("snapToNearestNode", () => {
  it("snaps to the closest graph node", () => {
    const graph = buildRoadGraph(GRID_ROADS);
    const nearest = snapToNearestNode(graph, [0.0049, 0.0049]);
    assert.deepEqual(graph.nodes[nearest], [0.005, 0.005]);
  });
});

describe("shortestPathTree with a loop street", () => {
  // A "horseshoe" residential loop: a short spur off a through road splits
  // into two arms that reconnect at a far node, forming a cycle. This pins
  // down expected (not buggy) behavior — every node on the loop is still
  // reachable and gets a tree parent, but exactly one edge of the cycle
  // (the one not on either side's shortest path) is never used by any
  // path back to the root, since a shortest-path tree cannot include every
  // edge of a loop by definition. Real utility mains are laid out the same
  // way: branching off a source, not duplicated around a loop.
  const THROUGH_ROAD: FeatureCollection<LineString> = {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: { highway: "residential" },
        geometry: {
          type: "LineString",
          coordinates: [[0, 0], [0.005, 0], [0.01, 0]],
        },
      },
      // Two arms of the loop, off the through road at (0.005, 0), meeting at
      // the far node (0.005, 0.004).
      {
        type: "Feature",
        properties: { highway: "residential" },
        geometry: {
          type: "LineString",
          coordinates: [[0.005, 0], [0.003, 0.002], [0.005, 0.004]],
        },
      },
      {
        type: "Feature",
        properties: { highway: "residential" },
        geometry: {
          type: "LineString",
          coordinates: [[0.005, 0], [0.007, 0.002], [0.005, 0.004]],
        },
      },
    ],
  };

  it("reaches every node on the loop, even though one closing edge goes unused", () => {
    const graph = buildRoadGraph(THROUGH_ROAD);
    const root = graph.nodes.findIndex(([x, y]) => x === 0 && y === 0);
    const tree = shortestPathTree(graph, root);

    for (let i = 0; i < graph.nodes.length; i++) {
      assert.notEqual(
        tree.distanceKm[i],
        Infinity,
        `node ${i} (${graph.nodes[i]}) on the loop should still be reachable`,
      );
    }

    // The far node where both arms meet is reached via whichever arm is
    // shorter (they're symmetric here, so either is valid) — but its
    // parent can only be one of the two neighboring loop nodes, not both,
    // since a tree allows exactly one parent per node.
    const farNode = graph.nodes.findIndex(
      ([x, y]) => x === 0.005 && y === 0.004,
    );
    const farNodeNeighbors = graph.adjacency[farNode].map((e) => e.to);
    const parentIsALoopNeighbor = farNodeNeighbors.includes(
      tree.parent[farNode],
    );
    assert.ok(parentIsALoopNeighbor);
  });
});

describe("shortestPathTree + pathToRoot", () => {
  it("reaches every node in a fully-connected grid", () => {
    const graph = buildRoadGraph(GRID_ROADS);
    const root = graph.nodes.findIndex(([x, y]) => x === 0 && y === 0);
    const tree = shortestPathTree(graph, root);
    for (let i = 0; i < graph.nodes.length; i++) {
      assert.notEqual(tree.distanceKm[i], Infinity, `node ${i} should be reachable`);
    }
    assert.equal(tree.distanceKm[root], 0);
  });

  it("reconstructs a path from root to a far node via intermediate nodes", () => {
    const graph = buildRoadGraph(GRID_ROADS);
    const root = graph.nodes.findIndex(([x, y]) => x === 0 && y === 0);
    const farNode = graph.nodes.findIndex(([x, y]) => x === 0.01 && y === 0.01);
    const tree = shortestPathTree(graph, root);
    const path = pathToRoot(tree, farNode);

    assert.equal(path[0], root);
    assert.equal(path[path.length - 1], farNode);
    assert.ok(path.length >= 3, "the far corner is at least 2 edges away");
    // Every consecutive pair in the path must be an actual graph edge.
    for (let i = 0; i < path.length - 1; i++) {
      const neighbors = graph.adjacency[path[i]].map((e) => e.to);
      assert.ok(neighbors.includes(path[i + 1]));
    }
  });

  it("returns an empty path for an unreachable node", () => {
    const graph = buildRoadGraph(GRID_ROADS);
    // Add an isolated node with no edges by constructing a graph directly.
    const isolatedGraph = {
      nodes: [...graph.nodes, [1, 1] as [number, number]],
      adjacency: [...graph.adjacency, []],
    };
    const tree = shortestPathTree(isolatedGraph, 0);
    assert.deepEqual(pathToRoot(tree, isolatedGraph.nodes.length - 1), []);
  });
});
