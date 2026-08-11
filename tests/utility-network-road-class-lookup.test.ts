import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RoadClassLookup } from "@geolibre/utility-network";
import type { FeatureCollection, LineString } from "geojson";

const ROADS: FeatureCollection<LineString> = {
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      properties: { highway: "residential" },
      geometry: { type: "LineString", coordinates: [[0, 0], [0.001, 0], [0.002, 0]] },
    },
    {
      type: "Feature",
      properties: { highway: "primary" },
      geometry: { type: "LineString", coordinates: [[0.002, 0], [0.002, 0.001]] },
    },
    {
      type: "Feature",
      properties: {},
      geometry: { type: "LineString", coordinates: [[1, 1], [1.001, 1]] },
    },
  ],
};

describe("RoadClassLookup", () => {
  it("looks up a segment's highway class regardless of coordinate order", () => {
    const lookup = new RoadClassLookup(ROADS);
    assert.equal(lookup.segmentClass([0, 0], [0.001, 0]), "residential");
    // Reversed order must still match — segments are undirected.
    assert.equal(lookup.segmentClass([0.001, 0], [0, 0]), "residential");
  });

  it("distinguishes segments from different roads at a shared node", () => {
    const lookup = new RoadClassLookup(ROADS);
    assert.equal(lookup.segmentClass([0.002, 0], [0.001, 0]), "residential");
    assert.equal(lookup.segmentClass([0.002, 0], [0.002, 0.001]), "primary");
  });

  it("defaults to 'unclassified' for a feature with no highway property", () => {
    const lookup = new RoadClassLookup(ROADS);
    assert.equal(lookup.segmentClass([1, 1], [1.001, 1]), "unclassified");
  });

  it("returns undefined for a segment that doesn't exist in the data", () => {
    const lookup = new RoadClassLookup(ROADS);
    assert.equal(lookup.segmentClass([5, 5], [6, 6]), undefined);
  });
});
