import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fetchTigerwebRoads } from "@geolibre/utility-network";
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

describe("fetchTigerwebRoads", () => {
  it("only queries layers whose name matches /road/i", async (t) => {
    const capturedUrls: string[] = [];
    let call = 0;
    t.mock.method(globalThis, "fetch", async (url: string) => {
      call += 1;
      capturedUrls.push(url);
      if (call === 1) {
        return new Response(
          JSON.stringify({ layers: [{ id: 5, name: "Roads" }, { id: 6, name: "Rails" }] }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ type: "FeatureCollection", features: [] }), {
        status: 200,
      });
    });

    await fetchTigerwebRoads(AREA);

    assert.equal(capturedUrls.length, 2);
    assert.ok(capturedUrls[1].includes("/5/query"));
  });

  it("maps MTFCC codes to highway classes and drops unrecognized/short geometries", async (t) => {
    let call = 0;
    t.mock.method(globalThis, "fetch", async () => {
      call += 1;
      if (call === 1) {
        return new Response(
          JSON.stringify({ layers: [{ id: 5, name: "Roads" }] }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          type: "FeatureCollection",
          features: [
            {
              type: "Feature",
              properties: { MTFCC: "S1400" },
              geometry: { type: "LineString", coordinates: [[-97.2, 49.85], [-97.19, 49.86]] },
            },
            {
              type: "Feature",
              properties: { MTFCC: "S1100" },
              geometry: { type: "LineString", coordinates: [[-97.2, 49.85], [-97.19, 49.86]] },
            },
            // Unrecognized MTFCC — must be dropped.
            {
              type: "Feature",
              properties: { MTFCC: "S9999" },
              geometry: { type: "LineString", coordinates: [[-97.2, 49.85], [-97.19, 49.86]] },
            },
            // Fewer than 2 coordinates — must be dropped.
            {
              type: "Feature",
              properties: { MTFCC: "S1400" },
              geometry: { type: "LineString", coordinates: [[-97.2, 49.85]] },
            },
          ],
        }),
        { status: 200 },
      );
    });

    const roads = await fetchTigerwebRoads(AREA);

    assert.equal(roads.features.length, 2);
    const highways = roads.features.map((f) => f.properties.highway).sort();
    assert.deepEqual(highways, ["primary", "residential"]);
  });

  it("throws when no layer name matches /road/i", async (t) => {
    t.mock.method(
      globalThis,
      "fetch",
      async () =>
        new Response(JSON.stringify({ layers: [{ id: 1, name: "Rails" }] }), { status: 200 }),
    );
    await assert.rejects(() => fetchTigerwebRoads(AREA), /road/i);
  });
});
