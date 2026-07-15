import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { listEsriLayers, queryEsriLayerByBbox } from "@geolibre/utility-network";

describe("listEsriLayers", () => {
  it("requests ?f=json and returns id/name pairs", async (t) => {
    let capturedUrl: string | undefined;
    t.mock.method(globalThis, "fetch", async (url: string) => {
      capturedUrl = url;
      return new Response(
        JSON.stringify({
          layers: [
            { id: 0, name: "Roads" },
            { id: 1, name: "Rails" },
          ],
        }),
        { status: 200 },
      );
    });

    const layers = await listEsriLayers("https://example.com/MapServer");

    assert.equal(capturedUrl, "https://example.com/MapServer?f=json");
    assert.deepEqual(layers, [
      { id: 0, name: "Roads" },
      { id: 1, name: "Rails" },
    ]);
  });

  it("throws on a non-OK response", async (t) => {
    t.mock.method(globalThis, "fetch", async () => new Response("nope", { status: 500 }));
    await assert.rejects(() => listEsriLayers("https://example.com/MapServer"), /500/);
  });

  it("throws when the response has no layers array", async (t) => {
    t.mock.method(
      globalThis,
      "fetch",
      async () => new Response(JSON.stringify({}), { status: 200 }),
    );
    await assert.rejects(
      () => listEsriLayers("https://example.com/MapServer"),
      /layers/,
    );
  });
});

describe("queryEsriLayerByBbox", () => {
  it("builds an envelope query with the given bbox and outFields", async (t) => {
    let capturedUrl: string | undefined;
    t.mock.method(globalThis, "fetch", async (url: string) => {
      capturedUrl = url;
      return new Response(
        JSON.stringify({ type: "FeatureCollection", features: [] }),
        { status: 200 },
      );
    });

    await queryEsriLayerByBbox(
      "https://example.com/MapServer",
      3,
      [-97.2, 49.85, -97.19, 49.86],
      ["MTFCC"],
    );

    assert.ok(capturedUrl?.startsWith("https://example.com/MapServer/3/query?"));
    const params = new URL(capturedUrl!).searchParams;
    assert.equal(params.get("geometry"), "-97.2,49.85,-97.19,49.86");
    assert.equal(params.get("geometryType"), "esriGeometryEnvelope");
    assert.equal(params.get("outFields"), "MTFCC");
    assert.equal(params.get("f"), "geojson");
  });

  it("filters out non-LineString features", async (t) => {
    t.mock.method(
      globalThis,
      "fetch",
      async () =>
        new Response(
          JSON.stringify({
            type: "FeatureCollection",
            features: [
              {
                type: "Feature",
                properties: { MTFCC: "S1400" },
                geometry: { type: "LineString", coordinates: [[0, 0], [1, 1]] },
              },
              {
                type: "Feature",
                properties: { MTFCC: "S1400" },
                geometry: { type: "Point", coordinates: [0, 0] },
              },
            ],
          }),
          { status: 200 },
        ),
    );

    const result = await queryEsriLayerByBbox(
      "https://example.com/MapServer",
      0,
      [0, 0, 1, 1],
      ["MTFCC"],
    );

    assert.equal(result.features.length, 1);
    assert.equal(result.features[0].geometry.type, "LineString");
  });

  it("throws on a non-OK response", async (t) => {
    t.mock.method(globalThis, "fetch", async () => new Response("nope", { status: 500 }));
    await assert.rejects(
      () => queryEsriLayerByBbox("https://example.com/MapServer", 0, [0, 0, 1, 1], ["MTFCC"]),
      /500/,
    );
  });

  it("throws when the response is not a GeoJSON FeatureCollection", async (t) => {
    t.mock.method(
      globalThis,
      "fetch",
      async () => new Response(JSON.stringify({ error: "bad request" }), { status: 200 }),
    );
    await assert.rejects(
      () => queryEsriLayerByBbox("https://example.com/MapServer", 0, [0, 0, 1, 1], ["MTFCC"]),
      /FeatureCollection/,
    );
  });
});
