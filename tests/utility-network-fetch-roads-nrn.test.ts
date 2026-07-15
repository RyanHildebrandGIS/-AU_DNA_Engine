import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fetchNrnRoads } from "@geolibre/utility-network";
import type { Feature, Polygon } from "geojson";

const AREA: Feature<Polygon> = {
  type: "Feature",
  properties: {},
  geometry: {
    type: "Polygon",
    coordinates: [
      [
        [-97.2, 49.85],
        [-97.2, 49.86],
        [-97.19, 49.86],
        [-97.19, 49.85],
        [-97.2, 49.85],
      ],
    ],
  },
};

describe("fetchNrnRoads", () => {
  it("only queries layers whose name matches /road|highway|street|route/i", async (t) => {
    const capturedUrls: string[] = [];
    let call = 0;
    t.mock.method(globalThis, "fetch", async (url: string) => {
      call += 1;
      capturedUrls.push(url);
      if (call === 1) {
        return new Response(
          JSON.stringify({
            layers: [
              { id: 2, name: "Road Segments" },
              { id: 3, name: "Ferry Routes" },
              { id: 4, name: "Address Ranges" },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ type: "FeatureCollection", features: [] }), {
        status: 200,
      });
    });

    await fetchNrnRoads(AREA);

    // Layer list request + one query per matching layer (2 and 3, not 4).
    assert.equal(capturedUrls.length, 3);
    assert.ok(capturedUrls[1].includes("/2/query"));
    assert.ok(capturedUrls[2].includes("/3/query"));
  });

  it("classifies ROADCLASS by keyword and excludes rapid transit / ferry", async (t) => {
    let call = 0;
    t.mock.method(globalThis, "fetch", async () => {
      call += 1;
      if (call === 1) {
        return new Response(
          JSON.stringify({ layers: [{ id: 2, name: "Roads" }] }),
          { status: 200 },
        );
      }
      const coords = [[-97.2, 49.85], [-97.19, 49.86]];
      return new Response(
        JSON.stringify({
          type: "FeatureCollection",
          features: [
            {
              type: "Feature",
              properties: { ROADCLASS: "Freeway" },
              geometry: { type: "LineString", coordinates: coords },
            },
            {
              type: "Feature",
              properties: { ROADCLASS: "Expressway / Highway" },
              geometry: { type: "LineString", coordinates: coords },
            },
            {
              type: "Feature",
              properties: { ROADCLASS: "Arterial" },
              geometry: { type: "LineString", coordinates: coords },
            },
            {
              type: "Feature",
              properties: { ROADCLASS: "Collector" },
              geometry: { type: "LineString", coordinates: coords },
            },
            {
              type: "Feature",
              properties: { ROADCLASS: "Local / Street" },
              geometry: { type: "LineString", coordinates: coords },
            },
            {
              type: "Feature",
              properties: { ROADCLASS: "Alleyway / Lane" },
              geometry: { type: "LineString", coordinates: coords },
            },
            {
              type: "Feature",
              properties: { ROADCLASS: "Rapid Transit" },
              geometry: { type: "LineString", coordinates: coords },
            },
            {
              type: "Feature",
              properties: { ROADCLASS: "Ferry Connection" },
              geometry: { type: "LineString", coordinates: coords },
            },
            // Missing/unrecognized value — permissive default, not dropped.
            {
              type: "Feature",
              properties: {},
              geometry: { type: "LineString", coordinates: coords },
            },
          ],
        }),
        { status: 200 },
      );
    });

    const roads = await fetchNrnRoads(AREA);

    const highways = roads.features.map((f) => f.properties.highway).sort();
    assert.deepEqual(highways, [
      "motorway",
      "primary",
      "residential", // Local / Street
      "residential", // permissive default for missing ROADCLASS
      "secondary",
      "service",
      "trunk",
    ]);
  });

  it("throws when no layer name matches the expected keywords", async (t) => {
    t.mock.method(
      globalThis,
      "fetch",
      async () =>
        new Response(
          JSON.stringify({ layers: [{ id: 1, name: "Address Ranges" }] }),
          { status: 200 },
        ),
    );
    await assert.rejects(() => fetchNrnRoads(AREA), /road|highway|street|route/i);
  });
});
