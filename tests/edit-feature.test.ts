import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { removeFeatureById, replaceFeatureGeometry } from "../apps/geolibre-desktop/src/lib/edit-feature";
import type { FeatureCollection, LineString, Point } from "geojson";

const POINTS: FeatureCollection<Point, { id: string }> = {
  type: "FeatureCollection",
  features: [
    { type: "Feature", properties: { id: "junction-1" }, geometry: { type: "Point", coordinates: [0, 0] } },
    { type: "Feature", properties: { id: "junction-2" }, geometry: { type: "Point", coordinates: [1, 1] } },
  ],
};

const LINES: FeatureCollection<LineString, { id: string }> = {
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      properties: { id: "line-1" },
      geometry: { type: "LineString", coordinates: [[0, 0], [1, 1]] },
    },
  ],
};

describe("replaceFeatureGeometry", () => {
  it("replaces the matching feature's geometry and leaves others untouched", () => {
    const updated = replaceFeatureGeometry(POINTS, "junction-1", {
      type: "Point",
      coordinates: [5, 6],
    });

    const moved = updated.features.find((f) => f.properties?.id === "junction-1");
    const untouched = updated.features.find((f) => f.properties?.id === "junction-2");
    assert.deepEqual(moved?.geometry, { type: "Point", coordinates: [5, 6] });
    assert.deepEqual(untouched?.geometry, { type: "Point", coordinates: [1, 1] });
    // Original collection is not mutated.
    assert.deepEqual(POINTS.features[0].geometry, { type: "Point", coordinates: [0, 0] });
  });

  it("replaces a LineString's full coordinate list", () => {
    const updated = replaceFeatureGeometry(LINES, "line-1", {
      type: "LineString",
      coordinates: [[0, 0], [0.5, 0.6], [1, 1]],
    });

    assert.deepEqual(updated.features[0].geometry, {
      type: "LineString",
      coordinates: [[0, 0], [0.5, 0.6], [1, 1]],
    });
  });

  it("throws when the new geometry's type doesn't match the existing feature's", () => {
    assert.throws(
      () => replaceFeatureGeometry(LINES, "line-1", { type: "Point", coordinates: [0, 0] }),
      /is a LineString, not a Point/,
    );
  });

  it("throws for an unknown feature id", () => {
    assert.throws(
      () =>
        replaceFeatureGeometry(POINTS, "does-not-exist", {
          type: "Point",
          coordinates: [0, 0],
        }),
      /No feature with id "does-not-exist"/,
    );
  });
});

describe("removeFeatureById", () => {
  it("removes only the matching feature", () => {
    const updated = removeFeatureById(POINTS, "junction-1");

    assert.equal(updated.features.length, 1);
    assert.equal(updated.features[0].properties?.id, "junction-2");
    // Original collection is not mutated.
    assert.equal(POINTS.features.length, 2);
  });

  it("throws for an unknown feature id", () => {
    assert.throws(
      () => removeFeatureById(POINTS, "does-not-exist"),
      /No feature with id "does-not-exist"/,
    );
  });
});
