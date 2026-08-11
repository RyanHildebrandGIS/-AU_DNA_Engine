import bearing from "@turf/bearing";
import destination from "@turf/destination";
import type { Position } from "geojson";

/**
 * The point `meters` away from `origin`, perpendicular to the
 * `segmentStart -> segmentEnd` direction, on the given side — the same
 * "offset to one side of the road" operation `@turf/line-offset` performs
 * on a whole line, but for a single point. Used to place junction markers
 * (and chain endpoints) off the road centerline instead of on it: a
 * junction sitting exactly on the road is unrealistic (valves/manholes sit
 * in the pipe, not painted on the pavement) and was a real defect fixed
 * here, not a stylistic preference.
 *
 * `origin` and `segmentStart` are the same point in the common case (offset
 * a chain's own start vertex using its own first segment's direction). They
 * differ when anchoring a chain's *end*: the origin is the last vertex, but
 * the direction must still come from the segment arriving there
 * (`segmentStart` = second-to-last vertex, `segmentEnd` = last vertex) —
 * using the reverse direction (last -> second-to-last) would flip which
 * side is "left" and which is "right" relative to how `@turf/line-offset`
 * treats the rest of the chain, since `@turf/line-offset`'s left/right is
 * defined by the LineString's own vertex order (see the sign-convention
 * note below), not by which endpoint is being anchored.
 *
 * `side` must match `@turf/line-offset`'s own left/right convention exactly,
 * or a junction would land on the opposite side of the road from the line
 * it's supposed to sit on. Empirically verified (see
 * `tests/utility-network-offset-junction.test.ts`): for a line-offset call
 * of `lineOffset(line, +N)` (this codebase's "left"), the offset lands at
 * `bearing(segmentStart, segmentEnd) + 90`; `-N` ("right") lands at
 * `bearing(segmentStart, segmentEnd) - 90`.
 */
export function perpendicularOffsetPoint(
  origin: Position,
  segmentStart: Position,
  segmentEnd: Position,
  side: "left" | "right",
  meters: number,
): Position {
  const forwardBearing = bearing(segmentStart, segmentEnd);
  const perpendicularBearing =
    side === "left" ? forwardBearing + 90 : forwardBearing - 90;
  return destination(origin, meters, perpendicularBearing, { units: "meters" })
    .geometry.coordinates as Position;
}
