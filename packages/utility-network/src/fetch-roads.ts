import type { Feature, FeatureCollection, LineString, MultiPolygon, Polygon } from "geojson";
import {
  queryOverpassWays,
  type OverpassFetchOptions,
} from "./overpass-client";

export type { OverpassFetchOptions as FetchOsmRoadsOptions } from "./overpass-client";
export { DEFAULT_OVERPASS_ENDPOINT } from "./overpass-client";

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
  options: OverpassFetchOptions = {},
): Promise<FeatureCollection<LineString, { highway: string }>> {
  const ways = await queryOverpassWays(area, '["highway"]', options);
  const features: Feature<LineString, { highway: string }>[] = [];
  for (const way of ways) {
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
