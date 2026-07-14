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
import { anchorOffsetLine } from "./anchor-offset-line";
import { clipLineToArea } from "./clip-to-area";
import { connectBuildingsToLines } from "./connect-services";
import { fetchOsmBuildings } from "./fetch-buildings";
import { fetchOsmRoads } from "./fetch-roads";
import { perpendicularOffsetPoint } from "./offset-junction";
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

/** Coarse stages of {@link generateNetwork}, for driving a progress UI —
 * real checkpoints, not a fabricated percentage. */
export type GenerateNetworkStage = "fetching" | "building" | "done";

export interface GenerateNetworkProgressEvent {
  stage: GenerateNetworkStage;
  /** Present only alongside a retried Overpass request (see
   * `OverpassFetchOptions.onRetry`) — surfaces transient upstream failures
   * (429/502/503/504) so a loading UI can say "retrying" instead of stalling
   * silently while the retry backoff runs. */
  retry?: { attempt: number; maxAttempts: number; status: number };
}

export type GenerateNetworkProgressCallback = (
  event: GenerateNetworkProgressEvent,
) => void;

export interface GeneratedNetwork {
  junctions: FeatureCollection<
    Point,
    {
      id: string;
      utilityType: string;
      junctionType: string;
      /** Which offset main this junction sits on. Omitted for service-tap
       * junctions (`junctionsAtServiceTaps`), which already sit on whichever
       * main they tap and don't need a separate side label. */
      side?: "left" | "right";
    }
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
  /** True if one or more buildings could not be connected without crossing a
   * different building's footprint, and were skipped rather than drawn
   * through a neighboring property. */
  servicesBlocked: boolean;
  /** Count of buildings skipped for that reason. */
  servicesBlockedCount: number;
}

const DEFAULT_MAX_JUNCTIONS = 500;
const DEFAULT_OFFSET_METERS = 3;
const DEFAULT_SIDE: NetworkSide = "right";
const DEFAULT_MODE: NetworkCoverage = "mainline";
/**
 * Junctions (valves/manholes/vaults/etc.) sit in the pipe, not painted on
 * the pavement — a marker must never land on the road centerline. This is
 * also the floor for the mainline's own offset: matches the ~10 ft (~3 m)
 * minimum main-to-road/main separation cited in the municipal design
 * standards this tool follows (see docs/utility-network.md, "Design
 * standards"). A user-configured `offsetMeters` below this is clamped up to
 * it — for both the mainline and its junctions, so they always stay
 * consistent with each other rather than landing at two different
 * distances from the road.
 */
export const MIN_OFFSET_METERS = 3;

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
 *
 * `onProgress` reports real checkpoints (fetching -> building -> done) plus
 * retry notifications when the public Overpass server returns a transient
 * 429/502/503/504 — enough to drive a genuine progress UI without inventing
 * a fake percentage.
 */
export async function generateNetwork(
  area: Feature<Polygon | MultiPolygon>,
  source: Feature<Point>,
  options: GenerateNetworkOptions,
  fetchOptions?: OverpassFetchOptions,
  onProgress?: GenerateNetworkProgressCallback,
): Promise<GeneratedNetwork> {
  onProgress?.({ stage: "fetching" });
  const fetchOptionsWithProgress: OverpassFetchOptions = {
    ...fetchOptions,
    onRetry: (attempt, maxAttempts, status) => {
      fetchOptions?.onRetry?.(attempt, maxAttempts, status);
      onProgress?.({ stage: "fetching", retry: { attempt, maxAttempts, status } });
    },
  };
  const [roads, buildings] = await Promise.all([
    fetchOsmRoads(area, fetchOptionsWithProgress),
    options.mode === "mainlineAndServices"
      ? fetchOsmBuildings(area, fetchOptionsWithProgress)
      : Promise.resolve(undefined),
  ]);
  onProgress?.({ stage: "building" });
  const result = generateNetworkFromRoads(area, source, roads, options, buildings);
  onProgress?.({ stage: "done" });
  return result;
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
  const offsetMeters = Math.max(
    options.offsetMeters ?? DEFAULT_OFFSET_METERS,
    MIN_OFFSET_METERS,
  );
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

  const junctionType = junctionTypeLabel(options.utilityType);
  const sides: Array<"left" | "right"> =
    side === "both" ? ["left", "right"] : [side];

  // Real junctions (valves/manholes/vaults/etc.) sit in the pipe, not on the
  // pavement — every node's anchor position is offset off the centerline by
  // `offsetMeters`, same as the mainline itself (see MIN_OFFSET_METERS). The
  // direction comes from ONE of the node's incident chains (whichever reaches
  // it first, in `chains` order — deterministic, see the chain-building loop
  // above); every other chain touching the same node on the same side reuses
  // that exact cached point instead of computing its own, which is what
  // makes the lines actually meet the junction dot precisely rather than
  // each drifting to its own natural offset. This is the same
  // "connectivity over independent per-line visual fidelity" tradeoff
  // `anchorOffsetLine` already makes (see its doc comment) — now applied one
  // level up, at the node instead of the line.
  const chainsByNode = new Map<number, Chain[]>();
  for (const chain of chains) {
    for (const node of [chain.startNode, chain.endNode]) {
      let list = chainsByNode.get(node);
      if (!list) {
        list = [];
        chainsByNode.set(node, list);
      }
      list.push(chain);
    }
  }
  const offsetAnchorCache = new Map<string, Position>();
  const offsetAnchorForNode = (node: number, s: "left" | "right"): Position => {
    const cacheKey = `${node}:${s}`;
    const cached = offsetAnchorCache.get(cacheKey);
    if (cached) return cached;

    const truePosition = graph.nodes[node];
    const [referenceChain] = chainsByNode.get(node) ?? [];
    if (!referenceChain) {
      // Not actually a chain endpoint — shouldn't happen given how
      // junctionNodes/chains are derived, but fall back to the unoffset
      // point rather than throwing.
      offsetAnchorCache.set(cacheKey, truePosition);
      return truePosition;
    }
    // The segment defining the local road direction at this node, always in
    // the chain's own start->end traversal order (matching how the whole
    // chain is offset by @turf/line-offset below) regardless of whether this
    // node is that chain's start or its end.
    const { coords } = referenceChain;
    const [segmentStart, segmentEnd] =
      node === referenceChain.startNode
        ? [coords[0], coords[1]]
        : [coords[coords.length - 2], coords[coords.length - 1]];
    const anchor = perpendicularOffsetPoint(
      truePosition,
      segmentStart,
      segmentEnd,
      s,
      offsetMeters,
    );
    offsetAnchorCache.set(cacheKey, anchor);
    return anchor;
  };

  const junctionFeatures = junctionNodes.flatMap((node, i) =>
    sides.map((s) =>
      point(offsetAnchorForNode(node, s), {
        id: `junction-${i + 1}-${s}`,
        utilityType: options.utilityType,
        junctionType,
        side: s,
      }),
    ),
  );

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
      // Anchor both ends to this node's offset anchor position (off the
      // centerline, never on it) rather than the raw offset line's own
      // endpoints. Without this, two chains sharing a node would each be
      // offset independently, leaving a visible gap between them right at
      // the junction instead of meeting there. anchorOffsetLine also trims
      // away any overshoot line-offset produces at a sharp bend and
      // guarantees the result never self-intersects — see its doc comment.
      const anchoredCoords = anchorOffsetLine(
        offset,
        offsetAnchorForNode(chain.startNode, s),
        offsetAnchorForNode(chain.endNode, s),
      );
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
  const {
    services,
    tapPoints,
    truncated: servicesTruncated,
    blockedByOtherBuilding: servicesBlocked,
    blockedCount: servicesBlockedCount,
  } =
    mode === "mainlineAndServices" && buildings
      ? connectBuildingsToLines(buildings, lines, options.maxServices)
      : {
          services: featureCollection<LineString, { id: string }>([]),
          tapPoints: [] as Feature<Point>[],
          truncated: false,
          blockedByOtherBuilding: false,
          blockedCount: 0,
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
    servicesBlocked,
    servicesBlockedCount,
  };
}
