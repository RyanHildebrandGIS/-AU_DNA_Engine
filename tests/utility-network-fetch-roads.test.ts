import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fetchOsmRoads } from "@geolibre/utility-network";
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

describe("fetchOsmRoads", () => {
  it("sends the polygon as an Overpass poly: filter with lat/lon order", async (t) => {
    let capturedBody: string | undefined;
    t.mock.method(globalThis, "fetch", async (_url: string, init?: RequestInit) => {
      capturedBody = init?.body as string;
      return new Response(JSON.stringify({ elements: [] }), { status: 200 });
    });

    await fetchOsmRoads(AREA);

    assert.ok(capturedBody, "expected a request body");
    const decoded = decodeURIComponent(capturedBody!.replace(/^data=/, ""));
    assert.match(decoded, /way\["highway"\]\(poly:"/);
    // Overpass poly: filter is "lat lon" pairs — the first ring vertex is
    // [-97.2, 49.85] in [lon, lat], so it must appear as "49.85 -97.2".
    assert.match(decoded, /49\.85 -97\.2/);
  });

  it("parses Overpass way elements with inline geometry into LineString features", async (t) => {
    t.mock.method(globalThis, "fetch", async () =>
      new Response(
        JSON.stringify({
          elements: [
            {
              type: "way",
              id: 1,
              tags: { highway: "residential" },
              geometry: [
                { lat: 49.85, lon: -97.2 },
                { lat: 49.855, lon: -97.195 },
              ],
            },
            // A way with no geometry (e.g. a relation member) must be skipped.
            { type: "way", id: 2, tags: { highway: "residential" } },
          ],
        }),
        { status: 200 },
      ),
    );

    const roads = await fetchOsmRoads(AREA);

    assert.equal(roads.features.length, 1);
    assert.equal(roads.features[0].properties.highway, "residential");
    assert.deepEqual(roads.features[0].geometry.coordinates, [
      [-97.2, 49.85],
      [-97.195, 49.855],
    ]);
  });

  it("throws on a non-OK response", async (t) => {
    t.mock.method(globalThis, "fetch", async () =>
      new Response("rate limited", { status: 429, statusText: "Too Many Requests" }),
    );
    await assert.rejects(() => fetchOsmRoads(AREA), /429/);
  });
});
