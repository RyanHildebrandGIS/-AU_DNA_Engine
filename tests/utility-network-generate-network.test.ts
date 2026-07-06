import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { generateNetwork } from "@geolibre/utility-network";
import type { Feature, MultiPolygon, Point, Polygon } from "geojson";

// A roughly 111km x 111km square at the equator (1 degree per side), so a
// 20km grid spacing produces a handful of interior junctions.
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

function sourcePoint(coords: [number, number]): Feature<Point> {
  return { type: "Feature", properties: {}, geometry: { type: "Point", coordinates: coords } };
}

describe("generateNetwork", () => {
  it("generates junctions inside the polygon connected to the source by a tree", () => {
    const result = generateNetwork(SQUARE, sourcePoint([-0.05, 0.5]), {
      utilityType: "water",
      spacingKm: 20,
    });

    assert.ok(result.junctions.features.length > 1, "expected multiple junctions");
    assert.equal(result.truncated, false);
    // A tree connecting 1 source + N junctions has exactly N edges.
    assert.equal(result.lines.features.length, result.junctions.features.length);

    for (const junction of result.junctions.features) {
      const [lon, lat] = junction.geometry.coordinates;
      assert.ok(lon >= 0 && lon <= 1, "junction longitude must fall inside the square");
      assert.ok(lat >= 0 && lat <= 1, "junction latitude must fall inside the square");
      assert.equal(junction.properties.utilityType, "water");
    }

    for (const line of result.lines.features) {
      assert.equal(line.geometry.coordinates.length, 2);
      assert.ok(line.properties.length_km >= 0);
    }
  });

  it("falls back to the polygon centroid when the polygon is smaller than the spacing", () => {
    const tiny: Feature<Polygon> = {
      type: "Feature",
      properties: {},
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [0, 0],
            [0, 0.001],
            [0.001, 0.001],
            [0.001, 0],
            [0, 0],
          ],
        ],
      },
    };
    const result = generateNetwork(tiny, sourcePoint([1, 1]), {
      utilityType: "sewer",
      spacingKm: 20,
    });

    assert.equal(result.junctions.features.length, 1);
    assert.equal(result.lines.features.length, 1);
    assert.equal(result.truncated, false);
  });

  it("truncates and reports it when junctions exceed maxJunctions", () => {
    const result = generateNetwork(SQUARE, sourcePoint([-0.05, 0.5]), {
      utilityType: "electric",
      spacingKm: 5,
      maxJunctions: 3,
    });

    assert.equal(result.junctions.features.length, 3);
    assert.equal(result.lines.features.length, 3);
    assert.equal(result.truncated, true);
  });

  it("rejects a non-positive spacing", () => {
    assert.throws(() =>
      generateNetwork(SQUARE, sourcePoint([-0.05, 0.5]), {
        utilityType: "water",
        spacingKm: 0,
      }),
    );
    assert.throws(() =>
      generateNetwork(SQUARE, sourcePoint([-0.05, 0.5]), {
        utilityType: "water",
        spacingKm: Number.NaN,
      }),
    );
  });

  it("handles a MultiPolygon area", () => {
    const multi: Feature<MultiPolygon> = {
      type: "Feature",
      properties: {},
      geometry: {
        type: "MultiPolygon",
        coordinates: [SQUARE.geometry.coordinates],
      },
    };
    const result = generateNetwork(multi, sourcePoint([-0.05, 0.5]), {
      utilityType: "fiber",
      spacingKm: 20,
    });
    assert.ok(result.junctions.features.length > 0);
  });
});
