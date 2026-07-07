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
}

const DEFAULT_MAX_SERVICES = 500;

/**
 * Connects each building footprint to the generated mainline: a service
 * line from the nearest point on the building's own footprint edge to the
 * nearest point on the mainline overall. This is a two-step nearest-point
 * approximation, not a true mutual-nearest solve (which would need to jointly
 * optimize both ends) — a deliberate simplification, see
 * docs/utility-network.md. Buildings beyond `maxServices` are dropped, same
 * truncation pattern as junctions.
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
  for (const building of used) {
    if (lines.features.length === 0) break;
    const anchor = centroid(building);

    // Step 1: nearest point across every mainline feature to the building's
    // centroid — the main-side tap point. Naturally picks whichever offset
    // line (left/right, when side is "both") is physically closer.
    let mainPoint: Feature<Point> | null = null;
    let mainPointDistanceKm = Infinity;
    for (const line of lines.features) {
      const candidate = nearestPointOnLine(line, anchor, {
        units: "kilometers",
      });
      if (candidate.properties.pointDistance < mainPointDistanceKm) {
        mainPointDistanceKm = candidate.properties.pointDistance;
        mainPoint = candidate;
      }
    }
    if (!mainPoint) continue;

    // Step 2: nearest point on the building's own footprint edge to that tap
    // point — the building-side connection point.
    const ring = building.geometry.coordinates[0] as Position[];
    const buildingPoint = nearestPointOnLine(lineString(ring), mainPoint, {
      units: "kilometers",
    });

    services.push(
      lineString(
        [mainPoint.geometry.coordinates, buildingPoint.geometry.coordinates],
        { id: `service-${serviceId++}` },
      ),
    );
    tapPoints.push(mainPoint);
  }

  return { services: featureCollection(services), tapPoints, truncated };
}
