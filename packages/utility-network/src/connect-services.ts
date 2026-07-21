import bearing from "@turf/bearing";
import booleanIntersects from "@turf/boolean-intersects";
import centroid from "@turf/centroid";
import destination from "@turf/destination";
import distance from "@turf/distance";
import { featureCollection, lineString, point } from "@turf/helpers";
import lineIntersect from "@turf/line-intersect";
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

/** How many of the nearest perpendicular candidates to try per building
 * before giving up. Real service laterals almost always tap the nearest
 * valid perpendicular run; this just gives a few next-closest alternatives a
 * chance when the nearest one would cut through a neighboring building. */
const MAX_CANDIDATES = 8;

interface PerpendicularCandidate {
  /** The point on the mainline segment where a line dropped perpendicular
   * from the building's anchor meets it. */
  foot: Position;
  perpendicularDistanceKm: number;
}

/**
 * The point on the infinite line through `segmentStart -> segmentEnd` where a
 * perpendicular dropped from `anchor` meets it, restricted to the *segment*
 * (not the infinite line) — `null` if that foot falls outside the segment's
 * span, meaning this exact segment can't offer a true 90° tap for this
 * building (the road doesn't run alongside it here). Uses bearing/distance/
 * destination (spherical) rather than naive lon/lat Euclidean math, matching
 * `offset-junction.ts`'s perpendicular-offset approach — real-world degrees
 * of longitude aren't equal in size to degrees of latitude except at the
 * equator, so a naive Euclidean projection would not actually be
 * perpendicular in real-world terms away from it.
 */
function perpendicularFootOnSegment(
  anchor: Position,
  segmentStart: Position,
  segmentEnd: Position,
): PerpendicularCandidate | null {
  const segmentLengthKm = distance(segmentStart, segmentEnd, { units: "kilometers" });
  if (segmentLengthKm === 0) return null;

  const distanceToAnchorKm = distance(segmentStart, anchor, { units: "kilometers" });
  if (distanceToAnchorKm === 0) return { foot: segmentStart, perpendicularDistanceKm: 0 };

  const segmentBearing = bearing(segmentStart, segmentEnd);
  const bearingToAnchor = bearing(segmentStart, anchor);
  const deltaRadians = ((bearingToAnchor - segmentBearing) * Math.PI) / 180;
  const alongSegmentKm = distanceToAnchorKm * Math.cos(deltaRadians);

  // Tiny tolerance for floating-point noise right at an endpoint — not a
  // license to extrapolate meaningfully past the segment.
  const EPSILON_KM = 1e-9;
  if (alongSegmentKm < -EPSILON_KM || alongSegmentKm > segmentLengthKm + EPSILON_KM) {
    return null;
  }
  const clampedAlongSegmentKm = Math.min(Math.max(alongSegmentKm, 0), segmentLengthKm);
  const foot = destination(segmentStart, clampedAlongSegmentKm, segmentBearing, {
    units: "kilometers",
  }).geometry.coordinates as Position;
  return { foot, perpendicularDistanceKm: distance(anchor, foot, { units: "kilometers" }) };
}

/** Every segment of every mainline feature that can offer a true
 * perpendicular tap for `anchor`, nearest first. */
function collectPerpendicularCandidates(
  anchor: Position,
  lines: FeatureCollection<LineString>,
): PerpendicularCandidate[] {
  const candidates: PerpendicularCandidate[] = [];
  for (const line of lines.features) {
    const coords = line.geometry.coordinates as Position[];
    for (let i = 0; i < coords.length - 1; i++) {
      const candidate = perpendicularFootOnSegment(anchor, coords[i], coords[i + 1]);
      if (candidate) candidates.push(candidate);
    }
  }
  return candidates.sort((a, b) => a.perpendicularDistanceKm - b.perpendicularDistanceKm);
}

/**
 * Where the straight ray from `foot` through `anchor` first crosses the
 * building's own footprint ring — the building-side endpoint that keeps the
 * *entire* service line collinear with the perpendicular tap (so the service
 * is a single straight 90°-off-the-main segment, not a tap that kinks partway
 * to reach the nearest footprint edge). Extends the ray a fixed distance past
 * `anchor` to comfortably clear any real building footprint's far side, and
 * returns whichever crossing lands nearest `foot` (the near edge). `null` if
 * the ray doesn't cross the ring at all (e.g. the building's centroid falls
 * outside its own footprint on an unusual concave shape) — the caller treats
 * this candidate as unusable and tries the next one.
 */
function buildingEdgeAlongRay(
  foot: Position,
  anchor: Position,
  buildingRing: Feature<LineString>,
): Position | null {
  const footToAnchorKm = distance(foot, anchor, { units: "kilometers" });
  if (footToAnchorKm === 0) return null;
  const rayBearing = bearing(foot, anchor);
  // 100m past the anchor is generous headroom past any real building
  // footprint's far edge relative to a typical service-lateral setback.
  const rayEndKm = footToAnchorKm + 0.1;
  const rayEnd = destination(foot, rayEndKm, rayBearing, { units: "kilometers" }).geometry
    .coordinates as Position;
  const ray = lineString([foot, rayEnd]);

  const hits = lineIntersect(ray, buildingRing).features;
  if (hits.length === 0) return null;

  let closest: Position | null = null;
  let closestDistanceKm = Infinity;
  for (const hit of hits) {
    const hitCoords = hit.geometry.coordinates as Position;
    const hitDistanceKm = distance(foot, hitCoords, { units: "kilometers" });
    if (hitDistanceKm < closestDistanceKm) {
      closestDistanceKm = hitDistanceKm;
      closest = hitCoords;
    }
  }
  return closest;
}

/**
 * Connects each building footprint to the generated mainline with a service
 * line that meets the main at a true 90° angle — a real service lateral taps
 * the main perpendicular to it, never at an arbitrary angle. For each
 * building, every mainline segment that can offer a valid perpendicular foot
 * (see `perpendicularFootOnSegment`) is a candidate, nearest first; the
 * building-side endpoint is found by extending that same perpendicular ray
 * until it meets the building's own footprint ring
 * (`buildingEdgeAlongRay`), keeping the whole line straight and perpendicular
 * end to end. A mainline vertex/corner that isn't directly abeam any
 * building (no segment's perpendicular foot lands near it) simply isn't a
 * candidate — this is deliberately stricter than a plain nearest-point
 * search, which could otherwise snap to a distant vertex at an arbitrary
 * angle. Buildings beyond `maxServices` are dropped, same truncation pattern
 * as junctions.
 *
 * Real utility service laterals stay within the public right-of-way and the
 * customer's own lot — they never cut across a neighboring property. Without
 * parcel/lot-line data (only building footprints are available here), the
 * closest enforceable proxy for that rule is: a service line must never
 * cross a DIFFERENT building's footprint. For each building, the nearest few
 * perpendicular candidates (by real perpendicular distance) are tried in
 * order, and the first one whose service line doesn't cross another
 * building's footprint is used; if none of them qualify, the building is
 * skipped and counted in `blockedCount` rather than drawn through a
 * neighbor's home.
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
    const anchor = centroid(building).geometry.coordinates;

    const candidates = collectPerpendicularCandidates(anchor, lines).slice(
      0,
      MAX_CANDIDATES,
    );

    const ring = building.geometry.coordinates[0] as Position[];
    const buildingRing = lineString(ring);

    let connected = false;
    for (const candidate of candidates) {
      const buildingPoint = buildingEdgeAlongRay(candidate.foot, anchor, buildingRing);
      if (!buildingPoint) continue;

      const coords: [Position, Position] = [candidate.foot, buildingPoint];
      const candidateLine = lineString(coords);

      const crossesAnotherBuilding = buildings.features.some(
        (other) => other !== building && booleanIntersects(candidateLine, other),
      );
      if (crossesAnotherBuilding) continue;

      services.push(lineString(coords, { id: `service-${serviceId++}` }));
      tapPoints.push(point(candidate.foot));
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
