import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { GeoLibreLayer } from "@geolibre/core";
import {
  deriveNetworkQuantities,
  utilityNetworkLayerMetadata,
} from "../apps/geolibre-desktop/src/lib/utility-network-layers";

function makeLayer(
  role: "junctions" | "lines" | "services",
  utilityType: string,
  features: GeoJSON.Feature[],
): GeoLibreLayer {
  return {
    id: `${role}-${utilityType}`,
    name: `${utilityType} ${role}`,
    type: "geojson",
    source: { type: "geojson" },
    visible: true,
    opacity: 1,
    style: {} as GeoLibreLayer["style"],
    metadata: utilityNetworkLayerMetadata(role, utilityType),
    geojson: { type: "FeatureCollection", features },
  };
}

describe("deriveNetworkQuantities", () => {
  it("counts junctions and services, and sums line length in meters", () => {
    const layers: GeoLibreLayer[] = [
      makeLayer("junctions", "water", [
        { type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [0, 0] } },
        { type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [1, 1] } },
      ]),
      makeLayer("lines", "water", [
        {
          type: "Feature",
          properties: { length_km: 0.5 },
          geometry: { type: "LineString", coordinates: [[0, 0], [0, 1]] },
        },
        {
          type: "Feature",
          properties: { length_km: 1.25 },
          geometry: { type: "LineString", coordinates: [[0, 0], [0, 1]] },
        },
      ]),
      makeLayer("services", "water", [
        { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: [[0, 0], [0, 1]] } },
      ]),
    ];

    const quantities = deriveNetworkQuantities(layers);
    assert.equal(quantities.length, 1);
    assert.deepEqual(quantities[0], {
      utilityType: "water",
      mainLengthMeters: 1750,
      junctionCount: 2,
      serviceCount: 1,
    });
  });

  it("keeps different utility types as separate entries", () => {
    const layers: GeoLibreLayer[] = [
      makeLayer("junctions", "water", [
        { type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [0, 0] } },
      ]),
      makeLayer("junctions", "sewer", [
        { type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [0, 0] } },
        { type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [1, 1] } },
      ]),
    ];
    const quantities = deriveNetworkQuantities(layers);
    assert.equal(quantities.length, 2);
    const water = quantities.find((q) => q.utilityType === "water");
    const sewer = quantities.find((q) => q.utilityType === "sewer");
    assert.equal(water?.junctionCount, 1);
    assert.equal(sewer?.junctionCount, 2);
  });

  it("ignores layers with no utilityNetworkRole metadata (e.g. Sketches or Add Data layers)", () => {
    const plainLayer: GeoLibreLayer = {
      id: "plain",
      name: "My imported layer",
      type: "geojson",
      source: { type: "geojson" },
      visible: true,
      opacity: 1,
      style: {} as GeoLibreLayer["style"],
      metadata: {},
      geojson: {
        type: "FeatureCollection",
        features: [
          { type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [0, 0] } },
        ],
      },
    };
    const quantities = deriveNetworkQuantities([plainLayer]);
    assert.deepEqual(quantities, []);
  });

  it("returns an empty array when there are no layers at all", () => {
    assert.deepEqual(deriveNetworkQuantities([]), []);
  });
});
