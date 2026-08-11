import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fetchOsmBuildings } from "@geolibre/utility-network";
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

describe("fetchOsmBuildings", () => {
  it("sends a way[\"building\"] Overpass filter", async (t) => {
    let capturedBody: string | undefined;
    t.mock.method(globalThis, "fetch", async (_url: string, init?: RequestInit) => {
      capturedBody = init?.body as string;
      return new Response(JSON.stringify({ elements: [] }), { status: 200 });
    });

    await fetchOsmBuildings(AREA);

    assert.ok(capturedBody, "expected a request body");
    const decoded = decodeURIComponent(capturedBody!.replace(/^data=/, ""));
    assert.match(decoded, /way\["building"\]\(poly:"/);
  });

  it("parses closed ways into Polygon features, closing an unclosed ring", async (t) => {
    t.mock.method(globalThis, "fetch", async () =>
      new Response(
        JSON.stringify({
          elements: [
            {
              type: "way",
              id: 1,
              tags: { building: "house" },
              // Already closed (first === last).
              geometry: [
                { lat: 49.85, lon: -97.2 },
                { lat: 49.85, lon: -97.199 },
                { lat: 49.851, lon: -97.199 },
                { lat: 49.85, lon: -97.2 },
              ],
            },
            {
              type: "way",
              id: 2,
              tags: { building: "yes" },
              // Not closed — fetchOsmBuildings must close the ring itself.
              geometry: [
                { lat: 49.855, lon: -97.195 },
                { lat: 49.855, lon: -97.194 },
                { lat: 49.856, lon: -97.194 },
              ],
            },
            // Too few vertices to form a polygon — must be skipped.
            {
              type: "way",
              id: 3,
              tags: { building: "yes" },
              geometry: [
                { lat: 49.86, lon: -97.19 },
                { lat: 49.86, lon: -97.191 },
              ],
            },
            // No geometry at all (e.g. a relation member) — must be skipped.
            { type: "way", id: 4, tags: { building: "yes" } },
          ],
        }),
        { status: 200 },
      ),
    );

    const buildings = await fetchOsmBuildings(AREA);

    assert.equal(buildings.features.length, 2);
    assert.equal(buildings.features[0].properties.building, "house");
    const ring0 = buildings.features[0].geometry.coordinates[0];
    assert.deepEqual(ring0[0], ring0[ring0.length - 1]);

    assert.equal(buildings.features[1].properties.building, "yes");
    const ring1 = buildings.features[1].geometry.coordinates[0];
    assert.equal(ring1.length, 4);
    assert.deepEqual(ring1[0], ring1[ring1.length - 1]);
  });

  it("throws on a non-retryable non-OK response", async (t) => {
    t.mock.method(globalThis, "fetch", async () =>
      new Response("bad request", { status: 400, statusText: "Bad Request" }),
    );
    await assert.rejects(() => fetchOsmBuildings(AREA), /400/);
  });

  it("throws after exhausting retries on a persistent 429", async (t) => {
    t.mock.method(globalThis, "fetch", async () =>
      new Response("rate limited", { status: 429, statusText: "Too Many Requests" }),
    );
    await assert.rejects(
      () => fetchOsmBuildings(AREA, { retryDelaysMs: [0, 0] }),
      /429/,
    );
  });
});
