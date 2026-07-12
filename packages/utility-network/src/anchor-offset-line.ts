import { lineString, point } from "@turf/helpers";
import kinks from "@turf/kinks";
import length from "@turf/length";
import lineSliceAlong from "@turf/line-slice-along";
import nearestPointOnLine from "@turf/nearest-point-on-line";
import type { Feature, LineString, Position } from "geojson";

/**
 * Builds the final coordinates for one offset chain: the raw offset geometry
 * trimmed to the portion between where it lands closest to `trueStart` and
 * `trueEnd`, then anchored to those exact true (unoffset) junction/source
 * locations at both ends.
 *
 * `@turf/line-offset` on a multi-vertex chain can overshoot past a sharp bend
 * — a known limitation of naive polyline offsetting via mitered joins, worse
 * the sharper the turn — placing the offset line's own endpoint behind or
 * past where the true junction actually is. Naively prepending/appending the
 * true endpoint to that raw geometry (the original approach) could then
 * create a self-intersecting spike right next to the junction: the lead-in
 * segment doubles back across the overshoot instead of connecting cleanly.
 *
 * Trimming to the span between the two nearest-point projections removes
 * that overshoot in the common case. As a final guarantee — regardless of
 * what shape `line-offset` produces — the trimmed result is checked with
 * `@turf/kinks`; if it still self-intersects, this falls back to a plain
 * straight line between the two true endpoints, which by construction (a
 * single segment) can never self-intersect. Lines must never self-intersect
 * even at the cost of losing the offset's visual detail in that rare case.
 */
export function anchorOffsetLine(
  offsetLine: Feature<LineString>,
  trueStart: Position,
  trueEnd: Position,
): Position[] {
  const straightFallback: Position[] = [trueStart, trueEnd];
  const totalKm = length(offsetLine, { units: "kilometers" });
  // A degenerate (zero-length, e.g. coincident-point) input line-offset
  // returns NaN coordinates and a NaN length, not exactly 0 — guard against
  // both rather than just `=== 0`.
  if (!(totalKm > 0)) return straightFallback;

  const startProjection = nearestPointOnLine(offsetLine, point(trueStart), {
    units: "kilometers",
  });
  const endProjection = nearestPointOnLine(offsetLine, point(trueEnd), {
    units: "kilometers",
  });
  const startLocation = Math.min(
    startProjection.properties.location,
    endProjection.properties.location,
  );
  const endLocation = Math.max(
    startProjection.properties.location,
    endProjection.properties.location,
  );
  if (endLocation <= startLocation) return straightFallback;

  const trimmed = lineSliceAlong(offsetLine, startLocation, endLocation, {
    units: "kilometers",
  });
  const candidate: Position[] = [
    trueStart,
    ...(trimmed.geometry.coordinates as Position[]),
    trueEnd,
  ];

  if (candidate.length < 3) return candidate;
  const selfIntersects = kinks(lineString(candidate)).features.length > 0;
  return selfIntersects ? straightFallback : candidate;
}
