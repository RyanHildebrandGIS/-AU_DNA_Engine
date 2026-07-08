import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  generateNetwork,
  generateNetworkFromRoads,
} from "@geolibre/utility-network";
import type {
  Feature,
  FeatureCollection,
  LineString,
  Point,
  Polygon,
} from "geojson";

const AREA: Feature<Polygon> = {
  type: "Feature",
  properties: {},
  geometry: {
    type: "Polygon",
    coordinates: [
      [
        [-0.001, -0.001],
        [-0.001, 0.011],
        [0.011, 0.011],
        [0.011, -0.001],
        [-0.001, -0.001],
      ],
    ],
  },
};

function sourcePoint(coords: [number, number]): Feature<Point> {
  return { type: "Feature", properties: {}, geometry: { type: "Point", coordinates: coords } };
}

// Same 3x3 street grid as utility-network-road-graph.test.ts.
const XS = [0, 0.005, 0.01];
const YS = [0, 0.005, 0.01];
const GRID_ROADS: FeatureCollection<LineString> = {
  type: "FeatureCollection",
  features: [
    ...YS.map((y) => ({
      type: "Feature" as const,
      properties: { highway: "residential" },
      geometry: { type: "LineString" as const, coordinates: XS.map((x) => [x, y]) },
    })),
    ...XS.map((x) => ({
      type: "Feature" as const,
      properties: { highway: "residential" },
      geometry: { type: "LineString" as const, coordinates: YS.map((y) => [x, y]) },
    })),
  ],
};

const SOURCE = sourcePoint([0, 0]);

describe("generateNetworkFromRoads", () => {
  it("generates junctions along roads connected to the source", () => {
    const result = generateNetworkFromRoads(AREA, SOURCE, GRID_ROADS, {
      utilityType: "water",
      spacingKm: 0.3,
    });

    assert.ok(result.junctions.features.length > 0, "expected at least one junction");
    assert.equal(result.truncated, false);
    for (const junction of result.junctions.features) {
      assert.equal(junction.properties.utilityType, "water");
      assert.equal(junction.properties.junctionType, "Valve");
    }
    for (const line of result.lines.features) {
      assert.equal(line.geometry.type, "LineString");
      assert.ok(line.properties.length_km >= 0);
      assert.equal(line.properties.side, "right");
    }
  });

  it("gives every utility type its standard junction name", () => {
    const expected: Record<string, string> = {
      water: "Valve",
      sewer: "Manhole",
      stormwater: "Catch Basin",
      electric: "Vault",
      fiber: "Handhole",
    };
    for (const [utilityType, label] of Object.entries(expected)) {
      const result = generateNetworkFromRoads(AREA, SOURCE, GRID_ROADS, {
        utilityType,
        spacingKm: 0.3,
      });
      assert.ok(result.junctions.features.length > 0);
      for (const junction of result.junctions.features) {
        assert.equal(junction.properties.junctionType, label);
      }
    }
  });

  it('falls back to a generic "Junction" label for an unrecognized utility type', () => {
    const result = generateNetworkFromRoads(AREA, SOURCE, GRID_ROADS, {
      utilityType: "gas",
      spacingKm: 0.3,
    });
    assert.ok(result.junctions.features.length > 0);
    for (const junction of result.junctions.features) {
      assert.equal(junction.properties.junctionType, "Junction");
    }
  });

  it("defaults to a 3m offset to the right, shifting lines off the centerline", () => {
    const result = generateNetworkFromRoads(AREA, SOURCE, GRID_ROADS, {
      utilityType: "water",
      spacingKm: 0.3,
    });
    for (const line of result.lines.features) {
      // The line's endpoints are deliberately anchored back to the true
      // (on-grid) junction location — see the connectivity fix below — so
      // only an INTERIOR coordinate proves the line was actually offset,
      // not left running exactly on the centerline for its whole length.
      assert.ok(
        line.geometry.coordinates.length > 2,
        "expected at least one interior (offset) coordinate between the anchored endpoints",
      );
      const [lon, lat] = line.geometry.coordinates[1];
      const onGridLattice =
        Math.abs(lon % 0.005) < 1e-9 && Math.abs(lat % 0.005) < 1e-9;
      assert.ok(!onGridLattice, "the interior of the line should not sit exactly on the raw grid");
    }
  });

  it("anchors every line's endpoints to the true (unoffset) junction/decision-point location", () => {
    // Real connectivity requirement: a line must actually touch the
    // junction markers at both ends, not just run parallel nearby — and two
    // chains sharing a node must meet at the exact same coordinate.
    const result = generateNetworkFromRoads(AREA, SOURCE, GRID_ROADS, {
      utilityType: "water",
      spacingKm: 0.3,
    });
    const junctionCoordKeys = new Set(
      result.junctions.features.map((f) => f.geometry.coordinates.join(",")),
    );
    // The source/root node also anchors lines but has no junction marker of
    // its own — SOURCE is [0, 0], the road grid's own origin vertex.
    junctionCoordKeys.add("0,0");
    for (const line of result.lines.features) {
      const first = line.geometry.coordinates[0];
      const last = line.geometry.coordinates[line.geometry.coordinates.length - 1];
      assert.ok(
        junctionCoordKeys.has(first.join(",")),
        `line start ${first} should exactly match a junction or the source`,
      );
      assert.ok(
        junctionCoordKeys.has(last.join(",")),
        `line end ${last} should exactly match a junction or the source`,
      );
    }
  });

  it('"both" produces two lines (one per side) for every edge "left"/"right" produces one for', () => {
    const right = generateNetworkFromRoads(AREA, SOURCE, GRID_ROADS, {
      utilityType: "water",
      spacingKm: 0.3,
      side: "right",
    });
    const both = generateNetworkFromRoads(AREA, SOURCE, GRID_ROADS, {
      utilityType: "water",
      spacingKm: 0.3,
      side: "both",
    });
    assert.equal(both.lines.features.length, right.lines.features.length * 2);
    const sides = new Set(both.lines.features.map((f) => f.properties.side));
    assert.deepEqual(sides, new Set(["left", "right"]));
  });

  it("keeps a multi-vertex road as one continuous line instead of one per graph edge", () => {
    // A single straight road with 5 vertices (4 graph edges) and no
    // intersections along the way — everything between the source (at the
    // road's far end) and the one junction (at the road's start, the only
    // spacing candidate given a spacing larger than the road) is a plain
    // pass-through chain, so it should come back as ONE line spanning all 5
    // vertices, not fragmented into 4 separate 2-point segments (the bug:
    // offsetting each tiny edge independently left visible gaps at every
    // original road vertex, not just at real junctions).
    const straightRoad: FeatureCollection<LineString> = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: { highway: "residential" },
          geometry: {
            type: "LineString",
            coordinates: [
              [0, 0],
              [0.001, 0],
              [0.002, 0],
              [0.003, 0],
              [0.004, 0],
            ],
          },
        },
      ],
    };
    const result = generateNetworkFromRoads(
      AREA,
      sourcePoint([0.004, 0]),
      straightRoad,
      {
        utilityType: "water",
        // Larger than the road's ~0.44km length: placeJunctionsAlongRoads
        // only samples distance 0 along the road (its start vertex), giving
        // exactly one junction candidate distinct from the source.
        spacingKm: 1,
      },
    );
    assert.equal(result.junctions.features.length, 1);
    assert.equal(result.lines.features.length, 1);
    // 5 offset vertices plus the 2 anchored (true, unoffset) endpoints.
    assert.equal(result.lines.features[0].geometry.coordinates.length, 7);
  });

  it("truncates and reports it when junctions exceed maxJunctions", () => {
    const result = generateNetworkFromRoads(AREA, SOURCE, GRID_ROADS, {
      utilityType: "electric",
      spacingKm: 0.1,
      maxJunctions: 2,
    });
    assert.equal(result.junctions.features.length, 2);
    assert.equal(result.truncated, true);
  });

  it("rejects a non-positive spacing", () => {
    assert.throws(() =>
      generateNetworkFromRoads(AREA, SOURCE, GRID_ROADS, {
        utilityType: "water",
        spacingKm: 0,
      }),
    );
    assert.throws(() =>
      generateNetworkFromRoads(AREA, SOURCE, GRID_ROADS, {
        utilityType: "water",
        spacingKm: Number.NaN,
      }),
    );
  });

  it("throws a clear error when no roads are given", () => {
    const empty: FeatureCollection<LineString> = { type: "FeatureCollection", features: [] };
    assert.throws(
      () =>
        generateNetworkFromRoads(AREA, SOURCE, empty, {
          utilityType: "water",
          spacingKm: 0.3,
        }),
      /No roads found/,
    );
  });

  it("places a junction at a real intersection even when spacing skips over it", () => {
    // A plus-shaped intersection at (0.005, 0.005), shared by a horizontal
    // and a vertical road. spacingKm is set far larger than either road's
    // length, so placeJunctionsAlongRoads only ever samples each road's very
    // first vertex — the real intersection is never a spacing candidate,
    // yet it's a genuine 4-way branch and must still get a junction marker
    // (previously: the mainline visibly split there with no junction dot).
    const crossRoads: FeatureCollection<LineString> = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: { highway: "residential" },
          geometry: {
            type: "LineString",
            coordinates: [
              [0, 0.005],
              [0.005, 0.005],
              [0.01, 0.005],
            ],
          },
        },
        {
          type: "Feature",
          properties: { highway: "residential" },
          geometry: {
            type: "LineString",
            coordinates: [
              [0.005, 0],
              [0.005, 0.005],
              [0.005, 0.01],
            ],
          },
        },
      ],
    };
    const result = generateNetworkFromRoads(
      AREA,
      sourcePoint([0, 0.005]),
      crossRoads,
      { utilityType: "water", spacingKm: 10 },
    );
    const hasJunctionAtIntersection = result.junctions.features.some(
      (f) =>
        Math.abs(f.geometry.coordinates[0] - 0.005) < 1e-9 &&
        Math.abs(f.geometry.coordinates[1] - 0.005) < 1e-9,
    );
    assert.ok(
      hasJunctionAtIntersection,
      "expected a junction marker at the real 4-way intersection",
    );
  });

  it("clips generated lines to the drawn area, even when roads extend past it", () => {
    const smallArea: Feature<Polygon> = {
      type: "Feature",
      properties: {},
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [-0.001, -0.001],
            [-0.001, 0.006],
            [0.006, 0.006],
            [0.006, -0.001],
            [-0.001, -0.001],
          ],
        ],
      },
    };
    const result = generateNetworkFromRoads(smallArea, SOURCE, GRID_ROADS, {
      utilityType: "water",
      spacingKm: 0.3,
    });
    assert.ok(result.lines.features.length > 0);
    for (const line of result.lines.features) {
      for (const [lon, lat] of line.geometry.coordinates) {
        assert.ok(lon <= 0.006 + 1e-4, `lon ${lon} should not exceed the drawn area`);
        assert.ok(lat <= 0.006 + 1e-4, `lat ${lat} should not exceed the drawn area`);
      }
    }
  });
});

describe("generateNetworkFromRoads services mode", () => {
  it("defaults to no service connections", () => {
    const result = generateNetworkFromRoads(AREA, SOURCE, GRID_ROADS, {
      utilityType: "water",
      spacingKm: 0.3,
    });
    assert.equal(result.services.features.length, 0);
    assert.equal(result.servicesTruncated, false);
    assert.equal(result.servicesBlocked, false);
    assert.equal(result.servicesBlockedCount, 0);
  });

  it("connects buildings to the mainline when mode is mainlineAndServices", () => {
    const mainlineOnly = generateNetworkFromRoads(AREA, SOURCE, GRID_ROADS, {
      utilityType: "water",
      spacingKm: 0.3,
    });
    const [lon, lat] = mainlineOnly.lines.features[0].geometry.coordinates[0];
    const building: Feature<Polygon> = {
      type: "Feature",
      properties: {},
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [lon + 0.0001, lat + 0.0001],
            [lon + 0.0002, lat + 0.0001],
            [lon + 0.0002, lat + 0.0002],
            [lon + 0.0001, lat + 0.0002],
            [lon + 0.0001, lat + 0.0001],
          ],
        ],
      },
    };
    const buildings: FeatureCollection<Polygon> = {
      type: "FeatureCollection",
      features: [building],
    };

    const result = generateNetworkFromRoads(
      AREA,
      SOURCE,
      GRID_ROADS,
      { utilityType: "water", spacingKm: 0.3, mode: "mainlineAndServices" },
      buildings,
    );

    assert.equal(result.services.features.length, 1);
    assert.equal(result.servicesTruncated, false);
  });

  it("adds a junction marker at each service tap point when junctionsAtServiceTaps is set", () => {
    const mainlineOnly = generateNetworkFromRoads(AREA, SOURCE, GRID_ROADS, {
      utilityType: "water",
      spacingKm: 0.3,
    });
    const [lon, lat] = mainlineOnly.lines.features[0].geometry.coordinates[0];
    const building: Feature<Polygon> = {
      type: "Feature",
      properties: {},
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [lon + 0.0001, lat + 0.0001],
            [lon + 0.0002, lat + 0.0001],
            [lon + 0.0002, lat + 0.0002],
            [lon + 0.0001, lat + 0.0002],
            [lon + 0.0001, lat + 0.0001],
          ],
        ],
      },
    };
    const buildings: FeatureCollection<Polygon> = {
      type: "FeatureCollection",
      features: [building],
    };
    const withoutOption = generateNetworkFromRoads(
      AREA,
      SOURCE,
      GRID_ROADS,
      { utilityType: "water", spacingKm: 0.3, mode: "mainlineAndServices" },
      buildings,
    );
    const withOption = generateNetworkFromRoads(
      AREA,
      SOURCE,
      GRID_ROADS,
      {
        utilityType: "water",
        spacingKm: 0.3,
        mode: "mainlineAndServices",
        junctionsAtServiceTaps: true,
      },
      buildings,
    );
    assert.equal(
      withOption.junctions.features.length,
      withoutOption.junctions.features.length + 1,
    );
    const serviceJunction = withOption.junctions.features.find((f) =>
      f.properties.id.startsWith("service-junction-"),
    );
    assert.ok(serviceJunction, "expected a service-junction feature");
    assert.equal(serviceJunction!.properties.junctionType, "Valve");
  });
});

describe("generateNetwork (async wrapper)", () => {
  it("fetches roads then delegates to generateNetworkFromRoads", async (t) => {
    const fetchMock = t.mock.method(globalThis, "fetch", async () =>
      new Response(
        JSON.stringify({
          elements: GRID_ROADS.features.map((f, i) => ({
            type: "way",
            id: i,
            tags: { highway: "residential" },
            geometry: f.geometry.coordinates.map(([lon, lat]) => ({ lon, lat })),
          })),
        }),
        { status: 200 },
      ),
    );

    const result = await generateNetwork(AREA, SOURCE, {
      utilityType: "sewer",
      spacingKm: 0.3,
    });

    assert.equal(fetchMock.mock.calls.length, 1);
    assert.ok(result.junctions.features.length > 0);
  });

  it("also fetches buildings when mode is mainlineAndServices", async (t) => {
    const fetchMock = t.mock.method(
      globalThis,
      "fetch",
      async (_url: string, init?: RequestInit) => {
        const body = decodeURIComponent(
          (init?.body as string).replace(/^data=/, ""),
        );
        if (body.includes('["building"]')) {
          return new Response(JSON.stringify({ elements: [] }), { status: 200 });
        }
        return new Response(
          JSON.stringify({
            elements: GRID_ROADS.features.map((f, i) => ({
              type: "way",
              id: i,
              tags: { highway: "residential" },
              geometry: f.geometry.coordinates.map(([lon, lat]) => ({ lon, lat })),
            })),
          }),
          { status: 200 },
        );
      },
    );

    const result = await generateNetwork(AREA, SOURCE, {
      utilityType: "sewer",
      spacingKm: 0.3,
      mode: "mainlineAndServices",
    });

    assert.equal(fetchMock.mock.calls.length, 2);
    assert.equal(result.services.features.length, 0);
  });

  it("reports fetching -> building -> done via onProgress", async (t) => {
    t.mock.method(globalThis, "fetch", async () =>
      new Response(
        JSON.stringify({
          elements: GRID_ROADS.features.map((f, i) => ({
            type: "way",
            id: i,
            tags: { highway: "residential" },
            geometry: f.geometry.coordinates.map(([lon, lat]) => ({ lon, lat })),
          })),
        }),
        { status: 200 },
      ),
    );

    const events: { stage: string; retry?: unknown }[] = [];
    await generateNetwork(
      AREA,
      SOURCE,
      { utilityType: "water", spacingKm: 0.3 },
      undefined,
      (event) => events.push(event),
    );

    assert.deepEqual(
      events.map((e) => e.stage),
      ["fetching", "building", "done"],
    );
  });

  it("reports a retry event through onProgress when Overpass returns a transient error", async (t) => {
    let calls = 0;
    t.mock.method(globalThis, "fetch", async () => {
      calls++;
      if (calls < 2) {
        return new Response("bad gateway", { status: 502, statusText: "Bad Gateway" });
      }
      return new Response(
        JSON.stringify({
          elements: GRID_ROADS.features.map((f, i) => ({
            type: "way",
            id: i,
            tags: { highway: "residential" },
            geometry: f.geometry.coordinates.map(([lon, lat]) => ({ lon, lat })),
          })),
        }),
        { status: 200 },
      );
    });

    const events: { stage: string; retry?: { attempt: number; maxAttempts: number; status: number } }[] = [];
    await generateNetwork(
      AREA,
      SOURCE,
      { utilityType: "water", spacingKm: 0.3 },
      { retryDelaysMs: [0, 0] },
      (event) => events.push(event),
    );

    const retryEvent = events.find((e) => e.retry);
    assert.ok(retryEvent, "expected a retry event");
    assert.deepEqual(retryEvent!.retry, { attempt: 1, maxAttempts: 3, status: 502 });
  });
});
