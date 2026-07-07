import type { Feature, MultiPolygon, Polygon, Position } from "geojson";

export const DEFAULT_OVERPASS_ENDPOINT =
  "https://overpass-api.de/api/interpreter";

export interface OverpassFetchOptions {
  /** Overpass API endpoint. Defaults to the public overpass-api.de instance. */
  endpoint?: string;
  signal?: AbortSignal;
  /**
   * Called before each retry of a transient upstream failure (429/502/503/504
   * — the public Overpass server is well known to intermittently return these
   * under load, and a plain retry after a short wait usually just succeeds).
   * `attempt` is 1-indexed and counts the retry itself (not the original
   * request), `maxAttempts` is the total request count including the first.
   */
  onRetry?: (attempt: number, maxAttempts: number, status: number) => void;
  /** Overrides the retry backoff delays in milliseconds. Defaults to
   * `DEFAULT_RETRY_DELAYS_MS`; tests pass near-zero delays so retry behavior
   * can be verified without real wall-clock waits. */
  retryDelaysMs?: number[];
}

/** Upstream/rate-limit statuses worth retrying — not 4xx client errors (a bad
 * query won't succeed on retry) or a hard 4xx auth failure. */
const RETRYABLE_STATUS_CODES = new Set([429, 502, 503, 504]);
const MAX_ATTEMPTS = 3;
export const DEFAULT_RETRY_DELAYS_MS = [800, 1600];

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface OverpassGeometryNode {
  lat: number;
  lon: number;
}

export interface OverpassWayElement {
  type: "way";
  id: number;
  tags?: Record<string, string>;
  geometry?: OverpassGeometryNode[];
}

interface OverpassResponse {
  elements?: Array<OverpassWayElement | { type: string }>;
}

/** The outer ring of a Polygon, or the largest-area polygon's outer ring of a
 * MultiPolygon — used to build the Overpass `poly:` filter. A drawn project
 * area is expected to be a single simple polygon; MultiPolygon support here
 * is a reasonable best-effort, not exhaustive multi-part clipping. */
function outerRing(area: Feature<Polygon | MultiPolygon>): Position[] {
  if (area.geometry.type === "Polygon") return area.geometry.coordinates[0];
  const rings = area.geometry.coordinates.map((polygon) => polygon[0]);
  return rings.reduce((largest, ring) =>
    ring.length > largest.length ? ring : largest,
  );
}

/** Overpass `poly:` filter coordinates are "lat lon" pairs, space-separated —
 * the opposite order from GeoJSON's [lon, lat]. */
function toOverpassPolyFilter(ring: Position[]): string {
  return ring.map(([lon, lat]) => `${lat} ${lon}`).join(" ");
}

/**
 * Queries the Overpass API for `way` elements matching `tagSelector` (e.g.
 * `["highway"]` or `["building"]`) within `area`, with inline geometry (`out
 * geom;`, no separate node-resolution pass). Shared by `fetchOsmRoads` and
 * `fetchOsmBuildings` — only the tag selector and how the raw way geometry
 * gets turned into a GeoJSON feature differ between them.
 *
 * Retries up to twice (three requests total) on a 429/502/503/504 response
 * with a short backoff — the public overpass-api.de instance intermittently
 * returns these under load, and simply asking again a moment later usually
 * succeeds (previously the user had to notice and manually click Generate
 * again to get the same effect).
 */
export async function queryOverpassWays(
  area: Feature<Polygon | MultiPolygon>,
  tagSelector: string,
  options: OverpassFetchOptions = {},
): Promise<OverpassWayElement[]> {
  const endpoint = options.endpoint?.trim() || DEFAULT_OVERPASS_ENDPOINT;
  const polyFilter = toOverpassPolyFilter(outerRing(area));
  const query = `[out:json][timeout:25];way${tagSelector}(poly:"${polyFilter}");out geom;`;

  const retryDelaysMs = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  let lastError: Error | undefined;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      options.onRetry?.(attempt, MAX_ATTEMPTS, lastError ? statusFromError(lastError) : 0);
      await delay(retryDelaysMs[attempt - 1] ?? retryDelaysMs.at(-1) ?? 0);
    }

    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `data=${encodeURIComponent(query)}`,
      signal: options.signal,
    });
    if (response.ok) {
      const data = (await response.json()) as OverpassResponse;
      return (data.elements ?? []).filter(
        (element): element is OverpassWayElement => element.type === "way",
      );
    }

    lastError = new Error(
      `Overpass request failed: ${response.status} ${response.statusText}`,
    );
    if (!RETRYABLE_STATUS_CODES.has(response.status) || attempt === MAX_ATTEMPTS - 1) {
      throw lastError;
    }
  }
  // Unreachable (the loop always returns or throws), but keeps TypeScript
  // happy about a guaranteed return value.
  throw lastError ?? new Error("Overpass request failed");
}

/** Recovers the HTTP status this module encoded into its own error message,
 * for `onRetry`'s benefit — the retry loop doesn't otherwise carry the
 * numeric status across iterations. */
function statusFromError(error: Error): number {
  const match = /failed: (\d+)/.exec(error.message);
  return match ? Number(match[1]) : 0;
}
