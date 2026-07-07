import type { Feature, FeatureCollection, LineString, MultiPolygon, Polygon } from "geojson";
import {
  queryOverpassWays,
  type OverpassFetchOptions,
} from "./overpass-client";

export type { OverpassFetchOptions as FetchOsmRoadsOptions } from "./overpass-client";
export { DEFAULT_OVERPASS_ENDPOINT } from "./overpass-client";

/**
 * OSM `highway` values that carry real vehicle traffic — a utility mainline
 * runs in the vehicle right-of-way, not a footpath or trail. Deliberately an
 * allowlist (not "everything except footway/path/..."): new/unusual highway
 * values default to excluded rather than silently included. `*_link` ramps
 * are included since they're still drivable road segments.
 */
const DRIVABLE_HIGHWAY_VALUES = [
  "motorway",
  "trunk",
  "primary",
  "secondary",
  "tertiary",
  "unclassified",
  "residential",
  "living_street",
  "service",
  "motorway_link",
  "trunk_link",
  "primary_link",
  "secondary_link",
  "tertiary_link",
];

const DRIVABLE_HIGHWAY_FILTER = `["highway"~"^(${DRIVABLE_HIGHWAY_VALUES.join("|")})$"]`;

/**
 * Fetches OSM road centerlines for the given project-area polygon via the
 * public Overpass API, restricted to drivable highway classes (see
 * `DRIVABLE_HIGHWAY_VALUES`) — footways, cycleways, paths, tracks, and steps
 * are excluded, since a utility mainline follows the vehicle right-of-way.
 * Returns a plain LineString FeatureCollection tagged with each way's
 * `highway` value — the caller (`generateNetwork`) builds a routing graph
 * from this. Throws on a non-OK response or network failure; callers decide
 * how to surface that (the wizard shows it as an error, per
 * docs/utility-network.md).
 */
export async function fetchOsmRoads(
  area: Feature<Polygon | MultiPolygon>,
  options: OverpassFetchOptions = {},
): Promise<FeatureCollection<LineString, { highway: string }>> {
  const ways = await queryOverpassWays(area, DRIVABLE_HIGHWAY_FILTER, options);
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
