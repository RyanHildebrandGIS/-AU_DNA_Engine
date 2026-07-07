import type { Feature, FeatureCollection, MultiPolygon, Polygon, Position } from "geojson";
import {
  queryOverpassWays,
  type OverpassFetchOptions,
} from "./overpass-client";

/**
 * Fetches OSM building footprints for the given project-area polygon via the
 * public Overpass API, for the "mainline + services" coverage mode. Only
 * `way`-tagged buildings are handled — multipolygon buildings modeled as OSM
 * `relation`s are out of scope (the same ways-only simplification already
 * accepted for roads; see docs/utility-network.md).
 */
export async function fetchOsmBuildings(
  area: Feature<Polygon | MultiPolygon>,
  options: OverpassFetchOptions = {},
): Promise<FeatureCollection<Polygon, { building: string }>> {
  const ways = await queryOverpassWays(area, '["building"]', options);
  const features: Feature<Polygon, { building: string }>[] = [];
  for (const way of ways) {
    if (!way.geometry || way.geometry.length < 3) continue;
    const coords: Position[] = way.geometry.map((node) => [node.lon, node.lat]);
    const [first] = coords;
    const last = coords[coords.length - 1];
    const closed = first[0] === last[0] && first[1] === last[1];
    // A closed ring needs at least 3 distinct vertices plus the closing
    // point; an unclosed one needs at least 3 distinct vertices before we
    // close it ourselves below.
    if (closed && coords.length < 4) continue;
    const ring = closed ? coords : [...coords, first];
    features.push({
      type: "Feature",
      properties: { building: way.tags?.building ?? "yes" },
      geometry: { type: "Polygon", coordinates: [ring] },
    });
  }
  return { type: "FeatureCollection", features };
}
