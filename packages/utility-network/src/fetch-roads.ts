import type {
  Feature,
  FeatureCollection,
  LineString,
  MultiPolygon,
  Polygon,
  Position,
} from "geojson";

export const DEFAULT_OVERPASS_ENDPOINT =
  "https://overpass-api.de/api/interpreter";

export interface FetchOsmRoadsOptions {
  /** Overpass API endpoint. Defaults to the public overpass-api.de instance. */
  endpoint?: string;
  signal?: AbortSignal;
}

interface OverpassGeometryNode {
  lat: number;
  lon: number;
}

interface OverpassWayElement {
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
 * Fetches OSM road centerlines for the given project-area polygon via the
 * public Overpass API. Returns a plain LineString FeatureCollection tagged
 * with each way's `highway` value — the caller (`generateNetwork`) builds a
 * routing graph from this. Throws on a non-OK response or network failure;
 * callers decide how to surface that (the wizard shows it as an error, per
 * docs/utility-network.md).
 */
export async function fetchOsmRoads(
  area: Feature<Polygon | MultiPolygon>,
  options: FetchOsmRoadsOptions = {},
): Promise<FeatureCollection<LineString, { highway: string }>> {
  const endpoint = options.endpoint?.trim() || DEFAULT_OVERPASS_ENDPOINT;
  const polyFilter = toOverpassPolyFilter(outerRing(area));
  const query = `[out:json][timeout:25];way["highway"](poly:"${polyFilter}");out geom;`;

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
  const features: Feature<LineString, { highway: string }>[] = [];
  for (const element of data.elements ?? []) {
    if (element.type !== "way") continue;
    const way = element as OverpassWayElement;
    if (!way.geometry || way.geometry.length < 2) continue;
    features.push({
      type: "Feature",
      properties: { highway: way.tags?.highway ?? "unknown" },
      geometry: {
        type: "LineString",
        coordinates: way.geometry.map((node) => [node.lon, node.lat]),
      },
    });
  }

  return { type: "FeatureCollection", features };
}
