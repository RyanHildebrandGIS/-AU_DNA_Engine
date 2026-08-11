import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { anchorOffsetLine } from "@geolibre/utility-network";
import { lineString } from "@turf/helpers";
import kinks from "@turf/kinks";
import lineOffset from "@turf/line-offset";

describe("anchorOffsetLine", () => {
  it("anchors a simple straight offset line to the true endpoints", () => {
    const centerline = lineString([
      [0, 0],
      [0, 0.01],
    ]);
    const offset = lineOffset(centerline, 3, { units: "meters" });
    const trueStart = [0, 0];
    const trueEnd = [0, 0.01];

    const result = anchorOffsetLine(offset, trueStart, trueEnd);

    assert.deepEqual(result[0], trueStart);
    assert.deepEqual(result[result.length - 1], trueEnd);
    assert.equal(kinks(lineString(result)).features.length, 0);
  });

  it("never produces a self-intersecting line, even at a sharp bend where line-offset overshoots", () => {
    // A near-hairpin bend with a large offset relative to the short
    // segments — line-offset's mitered join overshoots badly here, and
    // naively prepending/appending the true endpoints to that raw geometry
    // does self-intersect (verified against this exact fixture).
    const centerline = lineString([
      [0, 0],
      [0.0003, 0.0003],
      [0.00005, 0.0005],
    ]);
    const offset = lineOffset(centerline, -50, { units: "meters" });
    const trueStart = [0, 0];
    const trueEnd = [0.00005, 0.0005];

    // Sanity-check the fixture: the naive (pre-fix) approach really does
    // self-intersect here, so this test is actually exercising the fix.
    const naive = [trueStart, ...(offset.geometry.coordinates as number[][]), trueEnd];
    assert.ok(
      kinks(lineString(naive)).features.length > 0,
      "expected the naive approach to self-intersect on this fixture",
    );

    const result = anchorOffsetLine(offset, trueStart, trueEnd);

    assert.deepEqual(result[0], trueStart);
    assert.deepEqual(result[result.length - 1], trueEnd);
    assert.equal(
      kinks(lineString(result)).features.length,
      0,
      "anchorOffsetLine must never return a self-intersecting line",
    );
  });

  it("falls back to a straight line when the offset line has zero length", () => {
    const centerline = lineString([
      [0, 0],
      [0, 0],
    ]);
    const offset = lineOffset(centerline, 3, { units: "meters" });
    const trueStart = [1, 1];
    const trueEnd = [2, 2];

    const result = anchorOffsetLine(offset, trueStart, trueEnd);

    assert.deepEqual(result, [trueStart, trueEnd]);
  });
});
