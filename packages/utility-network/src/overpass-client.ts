import type { Feature, MultiPolygon, Polygon, Position } from "geojson";

export const DEFAULT_OVERPASS_ENDPOINT =
  "https://overpass-api.de/api/interpreter";

export interface OverpassFetchOptions {
  /** Overpass API endpoint. Defaults to the public overpass-api.de instance. */
  endpoint?: string;
  signal?: AbortSignal;
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
 */
export async function queryOverpassWays(
  area: Feature<Polygon | MultiPolygon>,
  tagSelector: string,
  options: OverpassFetchOptions = {},
): Promise<OverpassWayElement[]> {
  const endpoint = options.endpoint?.trim() || DEFAULT_OVERPASS_ENDPOINT;
  const polyFilter = toOverpassPolyFilter(outerRing(area));
  const query = `[out:json][timeout:25];way${tagSelector}(poly:"${polyFilter}");out geom;`;

  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `data=${encodeURIComponent(query)}`,
    signal: options.signal,
  });
  if (!response.ok) {
    throw new Error(
      `Overpass request failed: ${response.status} ${response.statusText}`,
    );
  }

  const data = (await response.json()) as OverpassResponse;
  return (data.elements ?? []).filter(
    (element): element is OverpassWayElement => element.type === "way",
  );
}
