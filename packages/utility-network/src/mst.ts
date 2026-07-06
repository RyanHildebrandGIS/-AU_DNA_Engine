export interface MstEdge {
  from: number;
  to: number;
  weight: number;
}

/**
 * Prim's algorithm over an implicit complete graph: given `nodeCount` nodes
 * and a `distance` function, returns one edge per non-root node connecting it
 * to the tree, in attachment order. Node 0 is always the root (the caller
 * decides node order, e.g. putting a source/point-of-connection first so the
 * tree grows outward from it). Distance is assumed finite for every pair, so
 * the graph is always fully connected — there is no disconnected case.
 */
export function buildMinimumSpanningTree(
  nodeCount: number,
  distance: (a: number, b: number) => number,
): MstEdge[] {
  if (nodeCount < 2) return [];

  const inTree = new Array<boolean>(nodeCount).fill(false);
  const bestDist = new Array<number>(nodeCount).fill(Infinity);
  const bestFrom = new Array<number>(nodeCount).fill(-1);

  inTree[0] = true;
  for (let i = 1; i < nodeCount; i++) {
    bestDist[i] = distance(0, i);
    bestFrom[i] = 0;
  }

  const edges: MstEdge[] = [];
  for (let step = 1; step < nodeCount; step++) {
    let next = -1;
    for (let i = 0; i < nodeCount; i++) {
      if (!inTree[i] && (next === -1 || bestDist[i] < bestDist[next])) next = i;
    }
    inTree[next] = true;
    edges.push({ from: bestFrom[next], to: next, weight: bestDist[next] });

    for (let i = 0; i < nodeCount; i++) {
      if (inTree[i]) continue;
      const d = distance(next, i);
      if (d < bestDist[i]) {
        bestDist[i] = d;
        bestFrom[i] = next;
      }
    }
  }
  return edges;
}
