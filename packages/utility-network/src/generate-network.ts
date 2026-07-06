import distance from "@turf/distance";
import { featureCollection, lineString, point } from "@turf/helpers";
import lineOffset from "@turf/line-offset";
import type {
  Feature,
  FeatureCollection,
  LineString,
  MultiPolygon,
  Point,
  Polygon,
} from "geojson";
import { fetchOsmRoads, type FetchOsmRoadsOptions } from "./fetch-roads";
import {
  buildRoadGraph,
  pathToRoot,
  placeJunctionsAlongRoads,
  shortestPathTree,
  snapToNearestNode,
} from "./road-graph";

export type NetworkSide = "left" | "right" | "both";

export interface GenerateNetworkOptions {
  /** Utility domain, carried through as a feature property (e.g. "water"). Layout is not yet domain-specific — see docs/utility-network.md. */
  utilityType: string;
  /** Target spacing between candidate junctions along each road, in kilometers. */
  spacingKm: number;
  /** Safety cap on generated junctions. Defaults to 500. */
  maxJunctions?: number;
  /** Perpendicular offset from the road centerline, in meters. Defaults to 3. */
  offsetMeters?: number;
  /** Which side of the road centerline to offset to. "both" generates a parallel line on each side. Defaults to "right". */
  side?: NetworkSide;
}

export interface GeneratedNetwork {
  junctions: FeatureCollection<Point, { id: string; utilityType: string }>;
  lines: FeatureCollection<
    LineString,
    { id: string; utilityType: string; length_km: number; side: "left" | "right" }
  >;
  /** True if the candidate junction count exceeded maxJunctions and was truncated. */
  truncated: boolean;
}

const DEFAULT_MAX_JUNCTIONS = 500;
const DEFAULT_OFFSET_METERS = 3;
const DEFAULT_SIDE: NetworkSide = "right";

/**
 * Generates a road-following utility network inside `area`: junctions spaced
 * `spacingKm` apart along real road centerlines (fetched from OpenStreetMap
 * via Overpass), connected back to `source` by a shortest-path tree over the
 * real road graph, then offset `offsetMeters` to one or both sides of the
 * centerline. No domain rules yet (pipe sizing, slope, valve placement) — see
 * docs/utility-network.md.
 *
 * Async: this fetches road data over the network. For a pure, synchronous,
 * unit-testable version that takes already-fetched road data, use
 * {@link generateNetworkFromRoads} directly.
 */
export async function generateNetwork(
  area: Feature<Polygon | MultiPolygon>,
  source: Feature<Point>,
  options: GenerateNetworkOptions,
  fetchOptions?: FetchOsmRoadsOptions,
): Promise<GeneratedNetwork> {
  const roads = await fetchOsmRoads(area, fetchOptions);
  return generateNetworkFromRoads(area, source, roads, options);
}

/**
 * Pure, synchronous core of {@link generateNetwork}: given already-fetched
 * road data, builds the network. See that function's doc comment for the
 * overall algorithm; this is the testable half with no network calls.
 */
export function generateNetworkFromRoads(
  _area: Feature<Polygon | MultiPolygon>,
  source: Feature<Point>,
  roads: FeatureCollection<LineString>,
  options: GenerateNetworkOptions,
): GeneratedNetwork {
  if (!Number.isFinite(options.spacingKm) || options.spacingKm <= 0) {
    throw new Error("spacingKm must be a positive number");
  }
  if (roads.features.length === 0) {
    throw new Error("No roads found in this project area");
  }
  const maxJunctions = options.maxJunctions ?? DEFAULT_MAX_JUNCTIONS;
  const offsetMeters = options.offsetMeters ?? DEFAULT_OFFSET_METERS;
  const side = options.side ?? DEFAULT_SIDE;

  const graph = buildRoadGraph(roads);
  const rootNode = snapToNearestNode(graph, source.geometry.coordinates);

  const candidateNodes = placeJunctionsAlongRoads(roads, options.spacingKm).map(
    (coord) => snapToNearestNode(graph, coord),
  );
  let junctionNodes = [...new Set(candidateNodes)].filter(
    (node) => node !== rootNode,
  );

  const truncated = junctionNodes.length > maxJunctions;
  if (truncated) junctionNodes = junctionNodes.slice(0, maxJunctions);

  const tree = shortestPathTree(graph, rootNode);
  junctionNodes = junctionNodes.filter(
    (node) => tree.distanceKm[node] !== Infinity,
  );

  // Union of every edge along every junction's path back to the source, so
  // shared trunk segments are emitted once rather than once per junction.
  const usedEdges = new Map<string, [number, number]>();
  for (const junctionNode of junctionNodes) {
    const path = pathToRoot(tree, junctionNode);
    for (let i = 0; i < path.length - 1; i++) {
      const [a, b] = [path[i], path[i + 1]];
      const key = a < b ? `${a}-${b}` : `${b}-${a}`;
      usedEdges.set(key, [a, b]);
    }
  }

  // Junction markers stay at their true on-road location (unshifted); only
  // the connecting lines are offset from the centerline — offsetting the
  // junction points themselves would need projecting onto the offset line,
  // out of scope for this pass (docs/utility-network.md).
  const junctionFeatures = junctionNodes.map((node, i) =>
    point(graph.nodes[node], {
      id: `junction-${i + 1}`,
      utilityType: options.utilityType,
    }),
  );

  const sides: Array<"left" | "right"> =
    side === "both" ? ["left", "right"] : [side];
  const lineFeatures: Feature<
    LineString,
    { id: string; utilityType: string; length_km: number; side: "left" | "right" }
  >[] = [];
  let lineId = 1;
  for (const [a, b] of usedEdges.values()) {
    const centerline = lineString([graph.nodes[a], graph.nodes[b]]);
    const lengthKm = distance(graph.nodes[a], graph.nodes[b], {
      units: "kilometers",
    });
    for (const s of sides) {
      const offset = lineOffset(centerline, s === "left" ? offsetMeters : -offsetMeters, {
        units: "meters",
      });
      lineFeatures.push({
        type: "Feature",
        properties: {
          id: `line-${lineId++}`,
          utilityType: options.utilityType,
          length_km: Number(lengthKm.toFixed(4)),
          side: s,
        },
        geometry: offset.geometry,
      });
    }
  }

  return {
    junctions: featureCollection(junctionFeatures),
    lines: featureCollection(lineFeatures),
    truncated,
  };
}
