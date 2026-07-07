import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { connectBuildingsToLines } from "@geolibre/utility-network";
import { featureCollection, lineString, polygon } from "@turf/helpers";
import type { LineString, Polygon } from "geojson";

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
    const { services, truncated } = connectBuildingsToLines(buildings, LINES);

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
});
