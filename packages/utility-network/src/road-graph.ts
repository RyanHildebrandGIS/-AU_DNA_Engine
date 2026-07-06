import along from "@turf/along";
import distance from "@turf/distance";
import length from "@turf/length";
import type { FeatureCollection, LineString, Position } from "geojson";

export interface RoadGraph {
  /** Node index -> coordinate. */
  nodes: Position[];
  /** Node index -> adjacent {to, weightKm} edges (undirected, stored both ways). */
  adjacency: Array<Array<{ to: number; weightKm: number }>>;
}

/** Coordinates within this many decimal degrees are treated as the same
 * intersection node (~0.1m at the equator) — merges shared way endpoints
 * without needing exact floating-point equality. */
const NODE_COORD_PRECISION = 6;

/**
 * Builds a sparse routing graph from fetched road LineStrings: every vertex
 * becomes a node (deduped by rounded coordinate so ways sharing an
 * intersection share a node), every consecutive vertex pair becomes an edge
 * weighted by real distance.
 */
export function buildRoadGraph(
  roads: FeatureCollection<LineString>,
): RoadGraph {
  const nodeIndexByKey = new Map<string, number>();
  const nodes: Position[] = [];
  const adjacency: Array<Array<{ to: number; weightKm: number }>> = [];

  const nodeFor = (coord: Position): number => {
    const key = `${coord[0].toFixed(NODE_COORD_PRECISION)},${coord[1].toFixed(NODE_COORD_PRECISION)}`;
    const existing = nodeIndexByKey.get(key);
    if (existing !== undefined) return existing;
    const index = nodes.length;
    nodeIndexByKey.set(key, index);
    nodes.push(coord);
    adjacency.push([]);
    return index;
  };

  for (const feature of roads.features) {
    const coords = feature.geometry.coordinates;
    for (let i = 0; i < coords.length - 1; i++) {
      const a = nodeFor(coords[i]);
      const b = nodeFor(coords[i + 1]);
      if (a === b) continue;
      const weightKm = distance(coords[i], coords[i + 1], {
        units: "kilometers",
      });
      adjacency[a].push({ to: b, weightKm });
      adjacency[b].push({ to: a, weightKm });
    }
  }

  return { nodes, adjacency };
}

/**
 * Candidate junction points spaced `spacingKm` apart along every road
 * (replaces the old raster point-grid). Short roads shorter than `spacingKm`
 * still get one junction at their start vertex, since the walk always
 * includes distance 0.
 */
export function placeJunctionsAlongRoads(
  roads: FeatureCollection<LineString>,
  spacingKm: number,
): Position[] {
  const points: Position[] = [];
  for (const feature of roads.features) {
    const totalKm = length(feature, { units: "kilometers" });
    for (let d = 0; d <= totalKm; d += spacingKm) {
      points.push(along(feature, d, { units: "kilometers" }).geometry.coordinates);
    }
  }
  return points;
}

/**
 * Nearest existing graph node to `point` (linear scan — road graphs from a
 * single drawn project area are small enough that this is fine without a
 * spatial index). Candidate junctions and the source point both snap to a
 * graph node this way rather than splitting the edge they fall nearest to —
 * a deliberate simplification (see docs/utility-network.md).
 */
export function snapToNearestNode(graph: RoadGraph, point: Position): number {
  let best = 0;
  let bestDistanceKm = Infinity;
  for (let i = 0; i < graph.nodes.length; i++) {
    const d = distance(point, graph.nodes[i], { units: "kilometers" });
    if (d < bestDistanceKm) {
      bestDistanceKm = d;
      best = i;
    }
  }
  return best;
}

export interface ShortestPathTree {
  /** Node index -> its parent in the tree, or -1 for the root/unreached. */
  parent: number[];
  /** Node index -> shortest real-road distance from the root, in km. */
  distanceKm: number[];
}

/**
 * Dijkstra's algorithm from `rootNode` over the real road graph (a simple
 * O(V^2) scan, not a heap — road graphs from one drawn project area are
 * small, and this mirrors the complexity class of the Prim's-MST it
 * replaces). The resulting parent pointers directly form a shortest-path
 * tree connecting every reachable node back to the root along real roads —
 * exactly what "connect every junction back to source via the road network"
 * needs, without a separate MST step.
 */
export function shortestPathTree(
  graph: RoadGraph,
  rootNode: number,
): ShortestPathTree {
  const n = graph.nodes.length;
  const visited = new Array<boolean>(n).fill(false);
  const distanceKm = new Array<number>(n).fill(Infinity);
  const parent = new Array<number>(n).fill(-1);
  distanceKm[rootNode] = 0;

  for (let step = 0; step < n; step++) {
    let u = -1;
    for (let i = 0; i < n; i++) {
      if (!visited[i] && (u === -1 || distanceKm[i] < distanceKm[u])) u = i;
    }
    if (u === -1 || distanceKm[u] === Infinity) break;
    visited[u] = true;
    for (const edge of graph.adjacency[u]) {
      const alt = distanceKm[u] + edge.weightKm;
      if (alt < distanceKm[edge.to]) {
        distanceKm[edge.to] = alt;
        parent[edge.to] = u;
      }
    }
  }

  return { parent, distanceKm };
}

/** Node indices from the tree's root to `node`, inclusive, by walking parent
 * pointers. Empty if `node` was never reached. */
export function pathToRoot(tree: ShortestPathTree, node: number): number[] {
  if (tree.distanceKm[node] === Infinity) return [];
  const path: number[] = [];
  for (let current = node; current !== -1; current = tree.parent[current]) {
    path.push(current);
  }
  return path.reverse();
}
