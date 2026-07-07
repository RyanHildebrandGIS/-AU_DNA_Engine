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
import { clipLineToArea } from "./clip-to-area";
import { connectBuildingsToLines } from "./connect-services";
import { fetchOsmBuildings } from "./fetch-buildings";
import { fetchOsmRoads } from "./fetch-roads";
import type { OverpassFetchOptions } from "./overpass-client";
import {
  buildRoadGraph,
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
  /** Also add a junction marker at every service's tap point on the mainline. Only applies when mode is "mainlineAndServices". Defaults to false. */
  junctionsAtServiceTaps?: boolean;
}

export interface GeneratedNetwork {
  junctions: FeatureCollection<
    Point,
    { id: string; utilityType: string; junctionType: string }
  >;
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
 * Standard industry name for a junction structure, by utility domain — e.g.
 * a water main junction is a "Valve", a sewer one a "Manhole". A simple
 * utility-based lookup for now, not a rules-driven pick between e.g. a
 * dead-end and a real intersection (see docs/utility-network.md); applied to
 * every junction feature, including service-tap junctions.
 */
const JUNCTION_TYPE_LABELS: Record<string, string> = {
  water: "Valve",
  sewer: "Manhole",
  stormwater: "Catch Basin",
  electric: "Vault",
  fiber: "Handhole",
};
const DEFAULT_JUNCTION_TYPE_LABEL = "Junction";

function junctionTypeLabel(utilityType: string): string {
  return JUNCTION_TYPE_LABELS[utilityType] ?? DEFAULT_JUNCTION_TYPE_LABEL;
}

/**
 * Generates a road-following utility network inside `area`: junctions spaced
 * `spacingKm` apart along real road centerlines (fetched from OpenStreetMap
 * via Overpass, then clipped to `area` so the network never extends past the
 * drawn boundary), connected back to `source` by a shortest-path tree over
 * the real road graph, then offset `offsetMeters` to one or both sides of the
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
  area: Feature<Polygon | MultiPolygon>,
  source: Feature<Point>,
  roads: FeatureCollection<LineString>,
  options: GenerateNetworkOptions,
  buildings?: FeatureCollection<Polygon>,
): GeneratedNetwork {
  if (!Number.isFinite(options.spacingKm) || options.spacingKm <= 0) {
    throw new Error("spacingKm must be a positive number");
  }
  const maxJunctions = options.maxJunctions ?? DEFAULT_MAX_JUNCTIONS;
  const offsetMeters = options.offsetMeters ?? DEFAULT_OFFSET_METERS;
  const side = options.side ?? DEFAULT_SIDE;

  // Fetched OSM ways commonly continue past the drawn project-area boundary
  // (Overpass's poly: filter matches any way that intersects the area, not
  // just the part inside it) — clip every road to the area first so the
  // whole downstream network (graph, junctions, chains) never extends past
  // what the user actually drew.
  const clippedRoads: FeatureCollection<LineString> = {
    type: "FeatureCollection",
    features: roads.features.flatMap((feature) =>
      clipLineToArea(feature.geometry.coordinates, area).map((coords) =>
        lineString(coords, feature.properties ?? {}),
      ),
    ),
  };
  if (clippedRoads.features.length === 0) {
    throw new Error("No roads found in this project area");
  }

  const graph = buildRoadGraph(clippedRoads);
  const rootNode = snapToNearestNode(graph, source.geometry.coordinates);
  const tree = shortestPathTree(graph, rootNode);

  // Full branching structure of the network reachable from the source —
  // every node's tree children, not just the ones on a path to a
  // spacing-based candidate junction. This is what lets a junction marker
  // land on every real intersection/dead-end, not only the ones a spacing
  // candidate happened to snap to (previously: a mainline could visibly
  // split at a real intersection with no junction dot there at all).
  const childrenOf = new Map<number, Set<number>>();
  for (let node = 0; node < graph.nodes.length; node++) {
    if (node === rootNode || tree.distanceKm[node] === Infinity) continue;
    const parent = tree.parent[node];
    let children = childrenOf.get(parent);
    if (!children) {
      children = new Set();
      childrenOf.set(parent, children);
    }
    children.add(node);
  }

  // Real intersections (>1 child) and dead-ends (0 children) always deserve
  // a junction marker — they're structurally where pipes actually join or
  // terminate, regardless of spacing.
  const branchNodes = [...childrenOf.entries()]
    .filter(([node, children]) => node !== rootNode && children.size !== 1)
    .map(([node]) => node);

  const candidateNodes = placeJunctionsAlongRoads(clippedRoads, options.spacingKm)
    .map((coord) => snapToNearestNode(graph, coord))
    .filter((node) => node !== rootNode && tree.distanceKm[node] !== Infinity);

  const requiredNodes = new Set(branchNodes);
  const allCandidates = [...new Set([...branchNodes, ...candidateNodes])];

  const truncated = allCandidates.length > maxJunctions;
  let junctionNodes = allCandidates;
  if (truncated) {
    // Real intersections are required, not optional — if the cap forces a
    // choice, drop spacing-only candidates first.
    const required = allCandidates.filter((node) => requiredNodes.has(node));
    const optional = allCandidates.filter((node) => !requiredNodes.has(node));
    junctionNodes = [...required, ...optional].slice(0, maxJunctions);
  }

  const junctionNodeSet = new Set(junctionNodes);
  // A node ends a continuous chain (rather than just passing through) when
  // it's a junction, or the real road network branches there (more than one
  // child) or dead-ends there (no children) — every other node just carries
  // the chain's geometry through it without splitting the line. Checked
  // independently of junctionNodeSet so a real branch still splits the line
  // even if maxJunctions truncated its marker away.
  const isDecisionPoint = (node: number): boolean =>
    node === rootNode ||
    junctionNodeSet.has(node) ||
    (childrenOf.get(node)?.size ?? 0) !== 1;

  // Walk every continuous chain of road segments between two decision
  // points, collecting every vertex along the way, so line-offset gets the
  // whole path at once — offsetting a single 2-point edge at a time left
  // gaps at every intermediate road vertex on any curving or multi-segment
  // road, not just at real junctions. Each chain remembers its two endpoint
  // node indices (not just coordinates) so the offset line built from it can
  // be anchored back to the true junction locations below.
  interface Chain {
    coords: Position[];
    startNode: number;
    endNode: number;
  }
  const chains: Chain[] = [];
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
      chains.push({ coords, startNode: start, endNode: current });
      toExpand.push(current);
    }
  }

  // Junction markers stay at their true on-road location (unshifted); the
  // connecting lines are offset from the centerline in the middle of each
  // chain, but anchor back to this same true location at both ends (see the
  // line-building loop below) so every line actually touches its junctions.
  const junctionType = junctionTypeLabel(options.utilityType);
  const junctionFeatures = junctionNodes.map((node, i) =>
    point(graph.nodes[node], {
      id: `junction-${i + 1}`,
      utilityType: options.utilityType,
      junctionType,
    }),
  );

  const sides: Array<"left" | "right"> =
    side === "both" ? ["left", "right"] : [side];
  const lineFeatures: Feature<
    LineString,
    { id: string; utilityType: string; length_km: number; side: "left" | "right" }
  >[] = [];
  let lineId = 1;
  for (const chain of chains) {
    const centerline = lineString(chain.coords);
    const lengthKm = length(centerline, { units: "kilometers" });
    for (const s of sides) {
      const offset = lineOffset(centerline, s === "left" ? offsetMeters : -offsetMeters, {
        units: "meters",
      });
      // Anchor both ends back to the true (unoffset) junction/decision-point
      // location. Without this, the offset line runs parallel to the
      // centerline the whole way, never actually touching the junction
      // marker (which stays at the true on-road point) — and two chains
      // sharing a node would each be offset independently, leaving a visible
      // gap between them right at the junction instead of meeting there.
      const anchoredCoords: Position[] = [
        graph.nodes[chain.startNode],
        ...(offset.geometry.coordinates as Position[]),
        graph.nodes[chain.endNode],
      ];
      lineFeatures.push({
        type: "Feature",
        properties: {
          id: `line-${lineId++}`,
          utilityType: options.utilityType,
          length_km: Number(lengthKm.toFixed(4)),
          side: s,
        },
        geometry: { type: "LineString", coordinates: anchoredCoords },
      });
    }
  }

  const lines = featureCollection(lineFeatures);
  const mode = options.mode ?? DEFAULT_MODE;
  const { services, tapPoints, truncated: servicesTruncated } =
    mode === "mainlineAndServices" && buildings
      ? connectBuildingsToLines(buildings, lines, options.maxServices)
      : {
          services: featureCollection<LineString, { id: string }>([]),
          tapPoints: [] as Feature<Point>[],
          truncated: false,
        };

  // Optional: a service's tap point is a real fitting on the main, so it can
  // get its own junction marker too, distinct from the road-spacing/branch
  // junctions above.
  const allJunctionFeatures =
    mode === "mainlineAndServices" && options.junctionsAtServiceTaps
      ? [
          ...junctionFeatures,
          ...tapPoints.map((tapPoint, i) =>
            point(tapPoint.geometry.coordinates, {
              id: `service-junction-${i + 1}`,
              utilityType: options.utilityType,
              junctionType,
            }),
          ),
        ]
      : junctionFeatures;

  return {
    junctions: featureCollection(allJunctionFeatures),
    lines,
    services,
    truncated,
    servicesTruncated,
  };
}
