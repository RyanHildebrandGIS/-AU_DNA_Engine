import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { perpendicularOffsetPoint } from "@geolibre/utility-network";
import distance from "@turf/distance";

describe("perpendicularOffsetPoint", () => {
  it("offsets to the same side @turf/line-offset calls 'left' for a positive offset", () => {
    // A line heading due north (increasing latitude): @turf/line-offset's
    // positive-distance ("left" in this codebase) side lands at increasing
    // longitude (east) — verified empirically against the raw turf call
    // during development; this pins that convention down as a regression
    // guard, since getting it backwards would put junctions on the wrong
    // side of the road from the lines they connect to.
    const from: [number, number] = [0, 0];
    const to: [number, number] = [0, 0.01];

    const left = perpendicularOffsetPoint(from, from, to, "left", 20);
    const right = perpendicularOffsetPoint(from, from, to, "right", 20);

    assert.ok(left[0] > from[0], "left should move east (increasing longitude)");
    assert.ok(right[0] < from[0], "right should move west (decreasing longitude)");
    // Neither should drift north/south for a due-north reference line.
    assert.ok(Math.abs(left[1] - from[1]) < 1e-9);
    assert.ok(Math.abs(right[1] - from[1]) < 1e-9);
  });

  it("offsets by exactly the requested distance in meters", () => {
    const from: [number, number] = [-97.2, 49.85];
    const to: [number, number] = [-97.2, 49.851];
    const offset = perpendicularOffsetPoint(from, from, to, "right", 15);
    const meters = distance(from, offset, { units: "kilometers" }) * 1000;
    assert.ok(Math.abs(meters - 15) < 0.01, `expected ~15m, got ${meters}m`);
  });

  it("offsets the given origin, using a separate segment purely for direction", () => {
    // origin != segmentStart: this is the "anchoring a chain's end" case,
    // where the origin is the chain's last vertex but the direction must
    // come from the segment arriving there (segmentStart -> segmentEnd),
    // not from a segment starting at the origin itself.
    const origin: [number, number] = [0, 0.01];
    const segmentStart: [number, number] = [0, 0];
    const segmentEnd: [number, number] = [0, 0.01];

    const offset = perpendicularOffsetPoint(origin, segmentStart, segmentEnd, "left", 20);
    const meters = distance(origin, offset, { units: "kilometers" }) * 1000;
    assert.ok(Math.abs(meters - 20) < 0.01);
    // Still offsets east for "left" on a due-north segment, same as the
    // origin-equals-segmentStart case.
    assert.ok(offset[0] > origin[0]);
    assert.ok(Math.abs(offset[1] - origin[1]) < 1e-9);
  });
});
