import type { Feature, FeatureCollection, LineString, MultiPolygon, Polygon } from "geojson";
import {
  queryOverpassWays,
  type OverpassFetchOptions,
} from "./overpass-client";

export { DEFAULT_OVERPASS_ENDPOINT } from "./overpass-client";

export interface FetchOsmRoadsOptions extends OverpassFetchOptions {
  /**
   * Exclude ways tagged `access=private`/`access=no`/`motor_vehicle=no`.
   * Off by default: plenty of legitimately driven rural roads (especially
   * `track`s serving a single farm/property) carry these tags, and a utility
   * mainline generally still needs to reach them — see the "known
   * simplifications" note in docs/utility-network.md. Opt in when a project
   * specifically needs to avoid gated/private roads.
   */
  excludePrivateAccess?: boolean;
}

/**
 * OSM `highway` values that carry real vehicle traffic — a utility mainline
 * runs in the vehicle right-of-way, not a footpath or trail. Deliberately an
 * allowlist (not "everything except footway/path/..."): new/unusual highway
 * values default to excluded rather than silently included. `*_link` ramps
 * are included since they're still drivable road segments.
 *
 * `track` and `road` are included alongside the standard classified/
 * residential/service classes: `track` is OSM's tag for unpaved
 * agricultural/rural access roads, which are genuinely driven on even though
 * they're not classified street types, and `road` is OSM's placeholder for a
 * road whose real classification hasn't been surveyed/entered yet — both are
 * common on older rural roads that were never reclassified after initial
 * mapping, which is exactly the kind of road a user has reported missing.
 * Neither is filtered by `access`/`motor_vehicle` tags by default (e.g. a
 * `track` marked `access=private` is still fetched) — see
 * `FetchOsmRoadsOptions.excludePrivateAccess` for an opt-in filter, and
 * docs/utility-network.md.
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
  "track",
  "road",
  "motorway_link",
  "trunk_link",
  "primary_link",
  "secondary_link",
  "tertiary_link",
];

const DRIVABLE_HIGHWAY_FILTER = `["highway"~"^(${DRIVABLE_HIGHWAY_VALUES.join("|")})$"]`;
/**
 * Appended to the highway filter only when `excludePrivateAccess` is set.
 * Overpass QL's `!~` matches elements where the tag is either absent or
 * present with a non-matching value — so a way with no `access`/
 * `motor_vehicle` tag at all (the vast majority) still passes both clauses;
 * only an explicit private/no value excludes it.
 */
const PRIVATE_ACCESS_EXCLUSION_FILTER =
  '["access"!~"^(private|no)$"]["motor_vehicle"!~"^no$"]';

/**
 * Fetches OSM road centerlines for the given project-area polygon via the
 * public Overpass API, restricted to drivable highway classes (see
 * `DRIVABLE_HIGHWAY_VALUES`) — footways, cycleways, paths, bridleways, and
 * steps are excluded, since a utility mainline follows the vehicle
 * right-of-way; unpaved/unclassified rural roads (`track`, `road`) are
 * still included since they carry real vehicle traffic. Returns a plain
 * LineString FeatureCollection tagged with each way's
 * `highway` value — the caller (`generateNetwork`) builds a routing graph
 * from this. Throws on a non-OK response or network failure; callers decide
 * how to surface that (the wizard shows it as an error, per
 * docs/utility-network.md).
 */
export async function fetchOsmRoads(
  area: Feature<Polygon | MultiPolygon>,
  options: FetchOsmRoadsOptions = {},
): Promise<FeatureCollection<LineString, { highway: string }>> {
  const filter = options.excludePrivateAccess
    ? `${DRIVABLE_HIGHWAY_FILTER}${PRIVATE_ACCESS_EXCLUSION_FILTER}`
    : DRIVABLE_HIGHWAY_FILTER;
  const ways = await queryOverpassWays(area, filter, options);
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
