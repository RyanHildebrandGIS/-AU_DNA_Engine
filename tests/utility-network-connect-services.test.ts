import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { connectBuildingsToLines } from "@geolibre/utility-network";
import bearing from "@turf/bearing";
import { featureCollection, lineString, polygon } from "@turf/helpers";
import type { LineString, Polygon, Position } from "geojson";

/** Angle between two bearings, normalized to [0, 180]. */
function bearingDiff(a: number, b: number): number {
  const diff = Math.abs(a - b) % 360;
  return diff > 180 ? 360 - diff : diff;
}

// A straight mainline running north-south at x = 0.
const LINES = featureCollection<LineString, { id: string }>([
  lineString(
    [
      [0, 0],
      [0, 0.01],
    ],
    { id: "line-1" },
  ),
]);

// A small square building footprint just east of the mainline.
const BUILDING = polygon(
  [
    [
      [0.001, 0.004],
      [0.002, 0.004],
      [0.002, 0.005],
      [0.001, 0.005],
      [0.001, 0.004],
    ],
  ],
  { building: "yes" },
) as unknown as { type: "Feature"; properties: object; geometry: Polygon };

describe("connectBuildingsToLines", () => {
  it("connects a building's nearest footprint edge to the nearest point on the mainline", () => {
    const buildings = featureCollection([BUILDING]);
    const { services, tapPoints, truncated } = connectBuildingsToLines(buildings, LINES);

    assert.equal(truncated, false);
    assert.equal(services.features.length, 1);
    const [service] = services.features;
    const [mainEnd, buildingEnd] = service.geometry.coordinates;

    // The main-side end must land on the mainline (x === 0).
    assert.ok(Math.abs(mainEnd[0]) < 1e-9, `main-side endpoint should be on the line, got ${mainEnd}`);

    // The building-side end must land on the building's own footprint ring,
    // i.e. at x=0.001 or x=0.002 (the ring's vertical edges), not at the centroid.
    assert.ok(
      Math.abs(buildingEnd[0] - 0.001) < 1e-6 || Math.abs(buildingEnd[0] - 0.002) < 1e-6,
      `building-side endpoint should be on the footprint edge, got ${buildingEnd}`,
    );

    // tapPoints exposes the same main-side connection point, in service order.
    assert.equal(tapPoints.length, 1);
    assert.deepEqual(tapPoints[0].geometry.coordinates, mainEnd);
  });

  it("truncates beyond maxServices and reports it", () => {
    const buildings = featureCollection([BUILDING, BUILDING, BUILDING]);
    const { services, truncated } = connectBuildingsToLines(buildings, LINES, 2);

    assert.equal(truncated, true);
    assert.equal(services.features.length, 2);
  });

  it("returns no services when there are no mainline features", () => {
    const buildings = featureCollection([BUILDING]);
    const empty = featureCollection<LineString, { id: string }>([]);
    const { services, truncated } = connectBuildingsToLines(buildings, empty);

    assert.equal(truncated, false);
    assert.equal(services.features.length, 0);
  });

  describe("avoiding neighboring buildings", () => {
    // Building A sits directly between mainline LINE1 (x=0) and building B
    // (centered around x=0.003) — a straight service from LINE1 to B would
    // cut right through A. LINE2 (x=0.008) is farther from B overall, but its
    // straight path to B passes entirely east of A, so it's a valid fallback.
    const BUILDING_A = polygon(
      [
        [
          [0.0005, 0.0045],
          [0.0015, 0.0045],
          [0.0015, 0.0055],
          [0.0005, 0.0055],
          [0.0005, 0.0045],
        ],
      ],
      { building: "yes" },
    ) as unknown as { type: "Feature"; properties: object; geometry: Polygon };
    const BUILDING_B = polygon(
      [
        [
          [0.0025, 0.0045],
          [0.0035, 0.0045],
          [0.0035, 0.0055],
          [0.0025, 0.0055],
          [0.0025, 0.0045],
        ],
      ],
      { building: "yes" },
    ) as unknown as { type: "Feature"; properties: object; geometry: Polygon };
    const LINE1 = lineString(
      [
        [0, 0],
        [0, 0.01],
      ],
      { id: "line-1" },
    );
    const LINE2 = lineString(
      [
        [0.008, 0],
        [0.008, 0.01],
      ],
      { id: "line-2" },
    );

    it("falls back to the next-nearest mainline candidate when the nearest one would cross another building", () => {
      const buildings = featureCollection([BUILDING_A, BUILDING_B]);
      const lines = featureCollection<LineString, { id: string }>([LINE1, LINE2]);

      const { services, blockedByOtherBuilding, blockedCount } =
        connectBuildingsToLines(buildings, lines);

      assert.equal(blockedByOtherBuilding, false);
      assert.equal(blockedCount, 0);
      assert.equal(services.features.length, 2);
      // Building B's service must tap LINE2 (x=0.008), not LINE1 (x=0), since
      // LINE1's path would cross building A.
      const bService = services.features.find((f) =>
        f.geometry.coordinates.some((c) => Math.abs(c[0] - 0.008) < 1e-9),
      );
      assert.ok(bService, "expected building B's service to tap the x=0.008 line");
    });

    it("skips and reports a building when every mainline candidate would cross another building", () => {
      const buildings = featureCollection([BUILDING_A, BUILDING_B]);
      // Only LINE1 is available this time — building B's only path is
      // blocked by A, with no fallback line to try instead.
      const lines = featureCollection<LineString, { id: string }>([LINE1]);

      const { services, blockedByOtherBuilding, blockedCount } =
        connectBuildingsToLines(buildings, lines);

      assert.equal(blockedByOtherBuilding, true);
      assert.equal(blockedCount, 1);
      // Building A still connects fine; only B (blocked) is skipped.
      assert.equal(services.features.length, 1);
    });
  });

  it("meets the mainline at a true 90 degree angle, not an arbitrary nearest-point angle", () => {
    // The building sits diagonally offset from the line, not directly
    // abeam its midpoint — a plain nearest-point-on-line search would still
    // find *a* closest point, but only a perpendicular-constrained search
    // guarantees the connecting segment meets the line at exactly 90°.
    const lines = featureCollection<LineString, { id: string }>([
      lineString(
        [
          [0, 0],
          [0, 0.02],
        ],
        { id: "line-1" },
      ),
    ]);
    const building = polygon(
      [
        [
          [0.003, 0.012],
          [0.004, 0.012],
          [0.004, 0.013],
          [0.003, 0.013],
          [0.003, 0.012],
        ],
      ],
      { building: "yes" },
    ) as unknown as { type: "Feature"; properties: object; geometry: Polygon };

    const { services } = connectBuildingsToLines(featureCollection([building]), lines);
    assert.equal(services.features.length, 1);
    const [mainEnd, buildingEnd] = services.features[0].geometry.coordinates as [
      Position,
      Position,
    ];

    const serviceBearing = bearing(mainEnd, buildingEnd);
    const lineBearing = bearing([0, 0], [0, 0.02]);
    assert.ok(
      Math.abs(bearingDiff(serviceBearing, lineBearing) - 90) < 0.01,
      `expected the service to meet the main at 90°, got a ${bearingDiff(serviceBearing, lineBearing)}° angle`,
    );
  });

  it("skips a building rather than snapping to a distant vertex at an ugly angle", () => {
    // A short line segment that ends well before the building's latitude —
    // no point on this segment is directly abeam the building, so there is
    // no valid 90° tap. The old nearest-point-on-line approach would have
    // clamped to the segment's end vertex and drawn a long diagonal line;
    // the building must be skipped instead.
    const lines = featureCollection<LineString, { id: string }>([
      lineString(
        [
          [0, 0],
          [0, 0.005],
        ],
        { id: "line-1" },
      ),
    ]);
    const building = polygon(
      [
        [
          [0.001, 0.02],
          [0.002, 0.02],
          [0.002, 0.021],
          [0.001, 0.021],
          [0.001, 0.02],
        ],
      ],
      { building: "yes" },
    ) as unknown as { type: "Feature"; properties: object; geometry: Polygon };

    const { services, blockedByOtherBuilding, blockedCount } = connectBuildingsToLines(
      featureCollection([building]),
      lines,
    );

    assert.equal(services.features.length, 0);
    assert.equal(blockedByOtherBuilding, true);
    assert.equal(blockedCount, 1);
  });
});
