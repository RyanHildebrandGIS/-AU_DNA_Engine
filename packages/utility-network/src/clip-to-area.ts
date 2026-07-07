import booleanPointInPolygon from "@turf/boolean-point-in-polygon";
import { lineString } from "@turf/helpers";
import lineIntersect from "@turf/line-intersect";
import type { Feature, LineString, MultiPolygon, Polygon, Position } from "geojson";

/** Every ring (outer + holes, across every polygon of a MultiPolygon) as a
 * plain LineString, used to find where a road crosses the area boundary. */
function boundaryRings(area: Feature<Polygon | MultiPolygon>): Feature<LineString>[] {
  const polygons =
    area.geometry.type === "Polygon"
      ? [area.geometry.coordinates]
      : area.geometry.coordinates;
  const rings: Feature<LineString>[] = [];
  for (const rings_ of polygons) {
    for (const ring of rings_) rings.push(lineString(ring));
  }
  return rings;
}

function squaredDistance(a: Position, b: Position): number {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  return dx * dx + dy * dy;
}

/** The area-boundary crossing point of segment a->b nearest to `a` (there may
 * be more than one if the boundary is complex; the nearest to the segment's
 * start is the correct split point when walking forward along the line). */
function findCrossing(
  a: Position,
  b: Position,
  boundaries: Feature<LineString>[],
): Position | null {
  const segment = lineString([a, b]);
  let best: Position | null = null;
  let bestDistance = Infinity;
  for (const boundary of boundaries) {
    const intersections = lineIntersect(segment, boundary);
    for (const feature of intersections.features) {
      const candidate = feature.geometry.coordinates as Position;
      const d = squaredDistance(a, candidate);
      if (d < bestDistance) {
        bestDistance = d;
        best = candidate;
      }
    }
  }
  return best;
}

/**
 * Splits a road LineString's coordinates into the sub-lines that fall inside
 * `area`, dropping everything outside — so a fetched OSM way that continues
 * past the user's drawn project-area boundary doesn't extend the generated
 * mainline past it too. Vertices exactly on the boundary count as inside
 * (matches `@turf/boolean-point-in-polygon`'s default).
 *
 * Known simplification: a segment that dips outside and back in within a
 * single pair of vertices without either endpoint going outside (a very
 * sharp concave notch cutting across one long segment) is not detected —
 * vertex-level in/out testing only, not per-segment boundary counting.
 */
export function clipLineToArea(
  coords: Position[],
  area: Feature<Polygon | MultiPolygon>,
): Position[][] {
  if (coords.length < 2) return [];
  const boundaries = boundaryRings(area);
  const isInside = (point: Position): boolean =>
    booleanPointInPolygon(point, area);

  const segments: Position[][] = [];
  let current: Position[] = [];
  let prevInside = isInside(coords[0]);
  if (prevInside) current.push(coords[0]);

  for (let i = 1; i < coords.length; i++) {
    const a = coords[i - 1];
    const b = coords[i];
    const bInside = isInside(b);

    if (prevInside && bInside) {
      current.push(b);
    } else if (prevInside && !bInside) {
      const crossing = findCrossing(a, b, boundaries);
      if (crossing) current.push(crossing);
      if (current.length > 1) segments.push(current);
      current = [];
    } else if (!prevInside && bInside) {
      const crossing = findCrossing(a, b, boundaries);
      current = crossing ? [crossing, b] : [b];
    }
    // !prevInside && !bInside: still outside, nothing to record.

    prevInside = bInside;
  }
  if (current.length > 1) segments.push(current);
  return segments;
}
