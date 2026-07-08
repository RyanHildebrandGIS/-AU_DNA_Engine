import booleanIntersects from "@turf/boolean-intersects";
import centroid from "@turf/centroid";
import { featureCollection, lineString } from "@turf/helpers";
import nearestPointOnLine from "@turf/nearest-point-on-line";
import type {
  Feature,
  FeatureCollection,
  LineString,
  Point,
  Polygon,
  Position,
} from "geojson";

export interface ConnectServicesResult {
  services: FeatureCollection<LineString, { id: string }>;
  /** Main-side tap point for each service, same order as `services.features`
   * — the point on the mainline each service connects to. Callers can turn
   * these into junction markers (see `junctionsAtServiceTaps` in
   * generate-network.ts) since a real tap is a real fitting on the main. */
  tapPoints: Feature<Point>[];
  truncated: boolean;
  /** True if one or more buildings had no straight-line connection to the
   * mainline that avoided crossing a different building's footprint, and
   * were skipped rather than drawn through a neighboring property. */
  blockedByOtherBuilding: boolean;
  /** Count of buildings skipped for that reason. */
  blockedCount: number;
}

const DEFAULT_MAX_SERVICES = 500;

/** How many of the nearest mainline candidates to try per building before
 * giving up. A real utility service almost always taps the nearest run; this
 * just gives a few next-closest alternatives a chance when the nearest one
 * would cut through a neighboring building. */
const MAX_CANDIDATE_LINES = 5;

/**
 * Connects each building footprint to the generated mainline: a service
 * line from the nearest point on the building's own footprint edge to the
 * nearest point on the mainline overall. This is a two-step nearest-point
 * approximation, not a true mutual-nearest solve (which would need to jointly
 * optimize both ends) — a deliberate simplification, see
 * docs/utility-network.md. Buildings beyond `maxServices` are dropped, same
 * truncation pattern as junctions.
 *
 * Real utility service laterals stay within the public right-of-way and the
 * customer's own lot — they never cut across a neighboring property. Without
 * parcel/lot-line data (only building footprints are available here), the
 * closest enforceable proxy for that rule is: a service line must never
 * cross a DIFFERENT building's footprint. For each building, the nearest few
 * mainline candidates (by straight-line distance) are tried in order, and the
 * first one whose service line doesn't cross another building's footprint is
 * used; if none of them qualify, the building is skipped and counted in
 * `blockedCount` rather than drawn through a neighbor's home.
 */
export function connectBuildingsToLines(
  buildings: FeatureCollection<Polygon>,
  lines: FeatureCollection<LineString>,
  maxServices: number = DEFAULT_MAX_SERVICES,
): ConnectServicesResult {
  const truncated = buildings.features.length > maxServices;
  const used = truncated
    ? buildings.features.slice(0, maxServices)
    : buildings.features;

  const services: Feature<LineString, { id: string }>[] = [];
  const tapPoints: Feature<Point>[] = [];
  let serviceId = 1;
  let blockedCount = 0;

  for (const building of used) {
    if (lines.features.length === 0) break;
    const anchor = centroid(building);

    // Rank every mainline feature by distance to the building, closest
    // first — the closest one is usually right, but a candidate gets
    // skipped below (in favor of the next-closest) if its straight path
    // would cross a neighboring building.
    const candidates = lines.features
      .map((line) => ({
        line,
        point: nearestPointOnLine(line, anchor, { units: "kilometers" }),
      }))
      .sort(
        (a, b) => a.point.properties.pointDistance - b.point.properties.pointDistance,
      )
      .slice(0, MAX_CANDIDATE_LINES);

    const ring = building.geometry.coordinates[0] as Position[];
    const buildingRing = lineString(ring);

    let connected = false;
    for (const candidate of candidates) {
      const mainPoint = candidate.point;
      // Nearest point on the building's own footprint edge to that tap
      // point — the building-side connection point.
      const buildingPoint = nearestPointOnLine(buildingRing, mainPoint, {
        units: "kilometers",
      });
      const coords: [Position, Position] = [
        mainPoint.geometry.coordinates,
        buildingPoint.geometry.coordinates,
      ];
      const candidateLine = lineString(coords);

      const crossesAnotherBuilding = buildings.features.some(
        (other) => other !== building && booleanIntersects(candidateLine, other),
      );
      if (crossesAnotherBuilding) continue;

      services.push(lineString(coords, { id: `service-${serviceId++}` }));
      tapPoints.push(mainPoint);
      connected = true;
      break;
    }

    if (!connected) blockedCount++;
  }

  return {
    services: featureCollection(services),
    tapPoints,
    truncated,
    blockedByOtherBuilding: blockedCount > 0,
    blockedCount,
  };
}
