import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { detectCountryRoadSource, fetchRoadsForArea } from "@geolibre/utility-network";
import type { Feature, Polygon } from "geojson";

function squareAround(lon: number, lat: number, d = 0.01): Feature<Polygon> {
  return {
    type: "Feature",
    properties: {},
    geometry: {
      type: "Polygon",
      coordinates: [
        [
          [lon - d, lat - d],
          [lon - d, lat + d],
          [lon + d, lat + d],
          [lon + d, lat - d],
          [lon - d, lat - d],
        ],
      ],
    },
  };
}

describe("detectCountryRoadSource", () => {
  it("resolves a contiguous-US area to tigerweb", () => {
    assert.equal(detectCountryRoadSource(squareAround(-97.2, 39.5)), "tigerweb");
  });

  it("resolves an Alaska area to tigerweb", () => {
    assert.equal(detectCountryRoadSource(squareAround(-150, 63)), "tigerweb");
  });

  it("resolves a Hawaii area to tigerweb", () => {
    assert.equal(detectCountryRoadSource(squareAround(-157.8, 21.3)), "tigerweb");
  });

  it("resolves a Canadian area to nrn", () => {
    assert.equal(detectCountryRoadSource(squareAround(-97.15, 49.9)), "nrn");
  });

  it("resolves an area outside the US/Canada to null", () => {
    assert.equal(detectCountryRoadSource(squareAround(2.35, 48.85)), null);
  });
});

describe("fetchRoadsForArea", () => {
  it("uses fetchOsmRoads directly when roadSource is 'osm'", async (t) => {
    const capturedUrls: string[] = [];
    t.mock.method(globalThis, "fetch", async (url: string) => {
      capturedUrls.push(url);
      return new Response(JSON.stringify({ elements: [] }), { status: 200 });
    });

    await fetchRoadsForArea(squareAround(-97.2, 39.5), "osm");

    assert.equal(capturedUrls.length, 1);
    assert.ok(capturedUrls[0].includes("overpass"));
  });

  it("auto-resolves a US area to tigerweb and does not call OSM on success", async (t) => {
    const capturedUrls: string[] = [];
    t.mock.method(globalThis, "fetch", async (url: string) => {
      capturedUrls.push(url);
      if (url.includes("?f=json")) {
        return new Response(
          JSON.stringify({ layers: [{ id: 1, name: "Roads" }] }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ type: "FeatureCollection", features: [] }), {
        status: 200,
      });
    });

    const fallbackEvents: unknown[] = [];
    await fetchRoadsForArea(squareAround(-97.2, 39.5), "auto", {
      onSourceFallback: (event) => fallbackEvents.push(event),
    });

    assert.ok(capturedUrls.every((url) => !url.includes("overpass")));
    assert.equal(fallbackEvents.length, 0);
  });

  it("falls back to OSM and fires onSourceFallback when tigerweb fails", async (t) => {
    const capturedUrls: string[] = [];
    t.mock.method(globalThis, "fetch", async (url: string) => {
      capturedUrls.push(url);
      if (url.includes("?f=json")) {
        return new Response("server error", { status: 500 });
      }
      return new Response(JSON.stringify({ elements: [] }), { status: 200 });
    });

    const fallbackEvents: { attemptedSource: string }[] = [];
    const result = await fetchRoadsForArea(squareAround(-97.2, 39.5), "auto", {
      onSourceFallback: (event) => fallbackEvents.push(event),
    });

    assert.equal(fallbackEvents.length, 1);
    assert.equal(fallbackEvents[0].attemptedSource, "tigerweb");
    assert.ok(capturedUrls.some((url) => url.includes("overpass")));
    assert.deepEqual(result.features, []);
  });

  it("falls back to OSM and fires onSourceFallback when nrn fails", async (t) => {
    t.mock.method(globalThis, "fetch", async (url: string) => {
      if (url.includes("?f=json")) {
        return new Response("server error", { status: 500 });
      }
      return new Response(JSON.stringify({ elements: [] }), { status: 200 });
    });

    const fallbackEvents: { attemptedSource: string }[] = [];
    await fetchRoadsForArea(squareAround(-97.15, 49.9), "nrn", {
      onSourceFallback: (event) => fallbackEvents.push(event),
    });

    assert.equal(fallbackEvents.length, 1);
    assert.equal(fallbackEvents[0].attemptedSource, "nrn");
  });

  it("uses OSM directly (no fallback event) for an area outside the US/Canada under 'auto'", async (t) => {
    const capturedUrls: string[] = [];
    t.mock.method(globalThis, "fetch", async (url: string) => {
      capturedUrls.push(url);
      return new Response(JSON.stringify({ elements: [] }), { status: 200 });
    });

    const fallbackEvents: unknown[] = [];
    await fetchRoadsForArea(squareAround(2.35, 48.85), "auto", {
      onSourceFallback: (event) => fallbackEvents.push(event),
    });

    assert.equal(fallbackEvents.length, 0);
    assert.ok(capturedUrls.every((url) => url.includes("overpass")));
  });
});
