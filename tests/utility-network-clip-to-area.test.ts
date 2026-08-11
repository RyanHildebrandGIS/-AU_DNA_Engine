import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { clipLineToArea } from "@geolibre/utility-network";
import type { Feature, Polygon } from "geojson";

const SQUARE: Feature<Polygon> = {
  type: "Feature",
  properties: {},
  geometry: {
    type: "Polygon",
    coordinates: [
      [
        [0, 0],
        [0, 1],
        [1, 1],
        [1, 0],
        [0, 0],
      ],
    ],
  },
};

describe("clipLineToArea", () => {
  it("keeps a line fully inside the area unchanged", () => {
    const result = clipLineToArea(
      [
        [0.2, 0.2],
        [0.8, 0.8],
      ],
      SQUARE,
    );
    assert.deepEqual(result, [
      [
        [0.2, 0.2],
        [0.8, 0.8],
      ],
    ]);
  });

  it("drops a line fully outside the area", () => {
    const result = clipLineToArea(
      [
        [2, 2],
        [3, 3],
      ],
      SQUARE,
    );
    assert.deepEqual(result, []);
  });

  it("cuts a line off at the boundary when it exits the area", () => {
    const result = clipLineToArea(
      [
        [0.5, 0.5],
        [1.5, 0.5],
      ],
      SQUARE,
    );
    assert.equal(result.length, 1);
    const [segment] = result;
    assert.deepEqual(segment[0], [0.5, 0.5]);
    // Exits through x=1.
    assert.ok(Math.abs(segment[segment.length - 1][0] - 1) < 1e-9);
  });

  it("produces two sub-lines when a road passes through the area (outside -> inside -> outside)", () => {
    const result = clipLineToArea(
      [
        [-0.5, 0.5],
        [0.5, 0.5],
        [1.5, 0.5],
      ],
      SQUARE,
    );
    assert.equal(result.length, 1, "expected a single continuous inside segment");
    const [segment] = result;
    assert.ok(Math.abs(segment[0][0] - 0) < 1e-9);
    assert.deepEqual(segment[1], [0.5, 0.5]);
    assert.ok(Math.abs(segment[2][0] - 1) < 1e-9);
  });

  it("produces two separate sub-lines for a road that leaves and re-enters the area", () => {
    const result = clipLineToArea(
      [
        [0.2, 0.2],
        [0.2, 1.5], // exits north
        [0.8, 1.5],
        [0.8, 0.2], // re-enters and continues south
      ],
      SQUARE,
    );
    assert.equal(result.length, 2);
  });
});
