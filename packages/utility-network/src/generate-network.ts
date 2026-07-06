import bboxFn from "@turf/bbox";
import centroid from "@turf/centroid";
import distance from "@turf/distance";
import pointGrid from "@turf/point-grid";
import { featureCollection, lineString } from "@turf/helpers";
import type {
  Feature,
  FeatureCollection,
  LineString,
  MultiPolygon,
  Point,
  Polygon,
  Position,
} from "geojson";
import { buildMinimumSpanningTree } from "./mst";

export interface GenerateNetworkOptions {
  /** Utility domain, carried through as a feature property (e.g. "water"). Layout is not yet domain-specific — see docs/utility-network.md. */
  utilityType: string;
  /** Target spacing between candidate junctions, in kilometers. */
  spacingKm: number;
  /** Safety cap on generated junctions. Defaults to 500. */
  maxJunctions?: number;
}

export interface GeneratedNetwork {
  junctions: FeatureCollection<Point, { id: string; utilityType: string }>;
  lines: FeatureCollection<LineString, { id: string; utilityType: string; length_km: number }>;
  /** True if the candidate junction count exceeded maxJunctions and was truncated. */
  truncated: boolean;
}

const DEFAULT_MAX_JUNCTIONS = 500;

/**
 * Generates a simple utility network inside `area`: a grid of junction points
 * spaced `spacingKm` apart (clipped to the polygon), connected back to
 * `source` by a minimum spanning tree over great-circle distance. This is a
 * deterministic first-pass layout — no road-network snapping or domain rules
 * (slope, voltage class, etc.) yet.
 */
export function generateNetwork(
  area: Feature<Polygon | MultiPolygon>,
  source: Feature<Point>,
  options: GenerateNetworkOptions,
): GeneratedNetwork {
  if (!Number.isFinite(options.spacingKm) || options.spacingKm <= 0) {
    throw new Error("spacingKm must be a positive number");
  }
  const maxJunctions = options.maxJunctions ?? DEFAULT_MAX_JUNCTIONS;

  const grid = pointGrid(bboxFn(area), options.spacingKm, {
    units: "kilometers",
    mask: area,
  });

  let junctionCoords: Position[] = grid.features.map(
    (feature) => feature.geometry.coordinates,
  );
  if (junctionCoords.length === 0) {
    // The polygon is smaller than the requested spacing, so no grid point
    // landed inside it. Fall back to the centroid so callers still get a
    // one-junction network instead of an empty result.
    junctionCoords = [centroid(area).geometry.coordinates];
  }

  const truncated = junctionCoords.length > maxJunctions;
  if (truncated) junctionCoords = junctionCoords.slice(0, maxJunctions);

  const nodeCoords: Position[] = [source.geometry.coordinates, ...junctionCoords];
  const edges = buildMinimumSpanningTree(nodeCoords.length, (a, b) =>
    distance(nodeCoords[a], nodeCoords[b], { units: "kilometers" }),
  );

  const junctionFeatures: Feature<Point, { id: string; utilityType: string }>[] =
    junctionCoords.map((coord, i) => ({
      type: "Feature",
      properties: { id: `junction-${i + 1}`, utilityType: options.utilityType },
      geometry: { type: "Point", coordinates: coord },
    }));

  const lineFeatures = edges.map((edge, i) =>
    lineString(
      [nodeCoords[edge.from], nodeCoords[edge.to]],
      {
        id: `line-${i + 1}`,
        utilityType: options.utilityType,
        length_km: Number(edge.weight.toFixed(4)),
      },
    ),
  );

  return {
    junctions: featureCollection(junctionFeatures),
    lines: featureCollection(lineFeatures),
    truncated,
  };
}
