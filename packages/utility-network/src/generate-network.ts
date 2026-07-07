import { featureCollection, lineString, point } from "@turf/helpers";
import length from "@turf/length";
import lineOffset from "@turf/line-offset";
import type {
  Feature,
  FeatureCollection,
  LineString,
  MultiPolygon,
  Point,
  Polygon,
  Position,
} from "geojson";
import { connectBuildingsToLines } from "./connect-services";
import { fetchOsmBuildings } from "./fetch-buildings";
import { fetchOsmRoads } from "./fetch-roads";
import type { OverpassFetchOptions } from "./overpass-client";
import {
  buildRoadGraph,
  pathToRoot,
  placeJunctionsAlongRoads,
  shortestPathTree,
  snapToNearestNode,
} from "./road-graph";

export type NetworkSide = "left" | "right" | "both";
export type NetworkCoverage = "mainline" | "mainlineAndServices";

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
  /** "mainlineAndServices" also connects every building footprint in the area to the mainline. Defaults to "mainline". */
  mode?: NetworkCoverage;
  /** Safety cap on generated service connections. Defaults to 500. */
  maxServices?: number;
}

export interface GeneratedNetwork {
  junctions: FeatureCollection<Point, { id: string; utilityType: string }>;
  lines: FeatureCollection<
    LineString,
    { id: string; utilityType: string; length_km: number; side: "left" | "right" }
  >;
  /** Building-to-mainline service connections; empty unless mode is "mainlineAndServices". */
  services: FeatureCollection<LineString, { id: string }>;
  /** True if the candidate junction count exceeded maxJunctions and was truncated. */
  truncated: boolean;
  /** True if the building count exceeded maxServices and was truncated. */
  servicesTruncated: boolean;
}

const DEFAULT_MAX_JUNCTIONS = 500;
const DEFAULT_OFFSET_METERS = 3;
const DEFAULT_SIDE: NetworkSide = "right";
const DEFAULT_MODE: NetworkCoverage = "mainline";

/**
 * Generates a road-following utility network inside `area`: junctions spaced
 * `spacingKm` apart along real road centerlines (fetched from OpenStreetMap
 * via Overpass), connected back to `source` by a shortest-path tree over the
 * real road graph, then offset `offsetMeters` to one or both sides of the
 * centerline. When `mode` is "mainlineAndServices", also fetches OSM building
 * footprints and connects each one to the mainline. No domain rules yet (pipe
 * sizing, slope, valve placement) — see docs/utility-network.md.
 *
 * Async: this fetches road (and, in services mode, building) data over the
 * network. For a pure, synchronous, unit-testable version that takes
 * already-fetched data, use {@link generateNetworkFromRoads} directly.
 */
export async function generateNetwork(
  area: Feature<Polygon | MultiPolygon>,
  source: Feature<Point>,
  options: GenerateNetworkOptions,
  fetchOptions?: OverpassFetchOptions,
): Promise<GeneratedNetwork> {
  const [roads, buildings] = await Promise.all([
    fetchOsmRoads(area, fetchOptions),
    options.mode === "mainlineAndServices"
      ? fetchOsmBuildings(area, fetchOptions)
      : Promise.resolve(undefined),
  ]);
  return generateNetworkFromRoads(area, source, roads, options, buildings);
}

/**
 * Pure, synchronous core of {@link generateNetwork}: given already-fetched
 * road (and, in services mode, building) data, builds the network. See that
 * function's doc comment for the overall algorithm; this is the testable
 * half with no network calls.
 */
export function generateNetworkFromRoads(
  _area: Feature<Polygon | MultiPolygon>,
  source: Feature<Point>,
  roads: FeatureCollection<LineString>,
  options: GenerateNetworkOptions,
  buildings?: FeatureCollection<Polygon>,
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

  // Children (tree-parent -> child) restricted to nodes that actually lie on
  // some junction's path back to the source, so shared trunk sections are
  // walked once rather than once per junction.
  const childrenOf = new Map<number, Set<number>>();
  for (const junctionNode of junctionNodes) {
    const path = pathToRoot(tree, junctionNode);
    for (let i = 0; i < path.length - 1; i++) {
      const [parent, child] = [path[i], path[i + 1]];
      let children = childrenOf.get(parent);
      if (!children) {
        children = new Set();
        childrenOf.set(parent, children);
      }
      children.add(child);
    }
  }
  const junctionNodeSet = new Set(junctionNodes);
  // A node ends a continuous chain (rather than just passing through) when
  // it's a junction, or the real road network branches there (more than one
  // child) or dead-ends there (no children) — every other node just carries
  // the chain's geometry through it without splitting the line.
  const isDecisionPoint = (node: number): boolean =>
    node === rootNode ||
    junctionNodeSet.has(node) ||
    (childrenOf.get(node)?.size ?? 0) !== 1;

  // Walk every continuous chain of road segments between two decision
  // points, collecting every vertex along the way, so line-offset gets the
  // whole path at once — offsetting a single 2-point edge at a time left
  // gaps at every intermediate road vertex on any curving or multi-segment
  // road, not just at real junctions.
  const chains: Position[][] = [];
  const toExpand: number[] = [rootNode];
  const expanded = new Set<number>();
  while (toExpand.length > 0) {
    const start = toExpand.pop();
    if (start === undefined || expanded.has(start)) continue;
    expanded.add(start);
    for (const firstChild of childrenOf.get(start) ?? []) {
      const coords: Position[] = [graph.nodes[start], graph.nodes[firstChild]];
      let current = firstChild;
      while (!isDecisionPoint(current)) {
        const [next] = childrenOf.get(current) ?? [];
        coords.push(graph.nodes[next]);
        current = next;
      }
      chains.push(coords);
      toExpand.push(current);
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
  for (const coords of chains) {
    const centerline = lineString(coords);
    const lengthKm = length(centerline, { units: "kilometers" });
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

  const lines = featureCollection(lineFeatures);
  const mode = options.mode ?? DEFAULT_MODE;
  const { services, truncated: servicesTruncated } =
    mode === "mainlineAndServices" && buildings
      ? connectBuildingsToLines(buildings, lines, options.maxServices)
      : {
          services: featureCollection<LineString, { id: string }>([]),
          truncated: false,
        };

  return {
    junctions: featureCollection(junctionFeatures),
    lines,
    services,
    truncated,
    servicesTruncated,
  };
}
