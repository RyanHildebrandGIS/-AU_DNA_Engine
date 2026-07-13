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
    // Restricted to drivable highway classes (no footway/path/cycleway/etc.)
    // via a regex value filter, not a bare ["highway"] presence filter.
    assert.match(decoded, /way\["highway"~"\^\(.*residential.*\)\$"\]\(poly:"/);
    assert.doesNotMatch(decoded, /footway|cycleway|\bpath\b|steps/);
    // Overpass poly: filter is "lat lon" pairs — the first ring vertex is
    // [-97.2, 49.85] in [lon, lat], so it must appear as "49.85 -97.2".
    assert.match(decoded, /49\.85 -97\.2/);
  });

  it("allows every real drivable street class, including smaller residential-scale and unpaved rural roads", async (t) => {
    // Regression guard: users reported smaller/older streets not getting
    // drawn. The allowlist was already fine for residential/living_street/
    // service/unclassified; `track` and `road` were the actual gap (common
    // tags on older rural roads never reclassified after initial mapping) —
    // this pins the full expected set down so a future edit can't
    // accidentally narrow the filter and reintroduce that symptom.
    let capturedBody: string | undefined;
    t.mock.method(globalThis, "fetch", async (_url: string, init?: RequestInit) => {
      capturedBody = init?.body as string;
      return new Response(JSON.stringify({ elements: [] }), { status: 200 });
    });

    await fetchOsmRoads(AREA);

    const decoded = decodeURIComponent(capturedBody!.replace(/^data=/, ""));
    for (const drivableClass of [
      "motorway",
      "trunk",
      "primary",
      "secondary",
      "tertiary",
      "unclassified",
      "residential",
      "living_street",
      "service",
      "track",
      "road",
    ]) {
      assert.ok(
        decoded.includes(drivableClass),
        `expected the highway filter to include "${drivableClass}"`,
      );
    }
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

  it("throws on a non-retryable non-OK response", async (t) => {
    t.mock.method(globalThis, "fetch", async () =>
      new Response("bad request", { status: 400, statusText: "Bad Request" }),
    );
    await assert.rejects(() => fetchOsmRoads(AREA), /400/);
  });

  it("throws after exhausting retries on a persistent 429", async (t) => {
    t.mock.method(globalThis, "fetch", async () =>
      new Response("rate limited", { status: 429, statusText: "Too Many Requests" }),
    );
    await assert.rejects(
      () => fetchOsmRoads(AREA, { retryDelaysMs: [0, 0] }),
      /429/,
    );
  });
});
