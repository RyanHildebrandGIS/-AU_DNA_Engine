import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { queryOverpassWays } from "@geolibre/utility-network";
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

describe("queryOverpassWays retry behavior", () => {
  it("retries a 502 and succeeds once the upstream recovers", async (t) => {
    let calls = 0;
    t.mock.method(globalThis, "fetch", async () => {
      calls++;
      if (calls < 2) {
        return new Response("bad gateway", { status: 502, statusText: "Bad Gateway" });
      }
      return new Response(JSON.stringify({ elements: [] }), { status: 200 });
    });

    const result = await queryOverpassWays(AREA, '["highway"]', {
      retryDelaysMs: [0, 0],
    });

    assert.equal(calls, 2);
    assert.deepEqual(result, []);
  });

  it("retries a 504 gateway timeout the same way", async (t) => {
    let calls = 0;
    t.mock.method(globalThis, "fetch", async () => {
      calls++;
      if (calls < 2) {
        return new Response("gateway timeout", {
          status: 504,
          statusText: "Gateway Timeout",
        });
      }
      return new Response(JSON.stringify({ elements: [] }), { status: 200 });
    });

    await queryOverpassWays(AREA, '["highway"]', { retryDelaysMs: [0, 0] });
    assert.equal(calls, 2);
  });

  it("retries a 503 and a 429 the same way", async (t) => {
    for (const status of [503, 429]) {
      let calls = 0;
      t.mock.method(globalThis, "fetch", async () => {
        calls++;
        if (calls < 2) {
          return new Response("unavailable", { status });
        }
        return new Response(JSON.stringify({ elements: [] }), { status: 200 });
      });
      await queryOverpassWays(AREA, '["highway"]', { retryDelaysMs: [0, 0] });
      assert.equal(calls, 2, `expected a retry for status ${status}`);
      t.mock.reset();
    }
  });

  it("does not retry a 400 (a bad query will not succeed on retry)", async (t) => {
    let calls = 0;
    t.mock.method(globalThis, "fetch", async () => {
      calls++;
      return new Response("bad request", { status: 400, statusText: "Bad Request" });
    });

    await assert.rejects(
      () => queryOverpassWays(AREA, '["highway"]', { retryDelaysMs: [0, 0] }),
      /400/,
    );
    assert.equal(calls, 1, "a non-retryable status should not be retried");
  });

  it("gives up after exhausting all attempts against a persistent 502", async (t) => {
    let calls = 0;
    t.mock.method(globalThis, "fetch", async () => {
      calls++;
      return new Response("bad gateway", { status: 502, statusText: "Bad Gateway" });
    });

    await assert.rejects(
      () => queryOverpassWays(AREA, '["highway"]', { retryDelaysMs: [0, 0] }),
      /502/,
    );
    assert.equal(calls, 3, "expected the initial request plus 2 retries");
  });

  it("calls onRetry with the attempt number, total attempts, and status", async (t) => {
    let calls = 0;
    t.mock.method(globalThis, "fetch", async () => {
      calls++;
      if (calls < 2) {
        return new Response("bad gateway", { status: 502, statusText: "Bad Gateway" });
      }
      return new Response(JSON.stringify({ elements: [] }), { status: 200 });
    });

    const retries: Array<{ attempt: number; maxAttempts: number; status: number }> = [];
    await queryOverpassWays(AREA, '["highway"]', {
      retryDelaysMs: [0, 0],
      onRetry: (attempt, maxAttempts, status) =>
        retries.push({ attempt, maxAttempts, status }),
    });

    assert.deepEqual(retries, [{ attempt: 1, maxAttempts: 3, status: 502 }]);
  });
});
