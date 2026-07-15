import centroid from "@turf/centroid";
import type { Feature, FeatureCollection, LineString, MultiPolygon, Polygon } from "geojson";
import { fetchNrnRoads } from "./fetch-roads-nrn";
import { fetchOsmRoads, type FetchOsmRoadsOptions } from "./fetch-roads";
import { fetchTigerwebRoads } from "./fetch-roads-tigerweb";

export type RoadSourceId = "auto" | "osm" | "tigerweb" | "nrn";

/** Rough country bounding boxes for `"auto"` source selection — a
 * centroid-in-bbox heuristic, not a real reverse-geocode, so it can
 * misfire right at the US/Canada border (the two countries' bboxes overlap
 * in latitude across a wide stretch). Good enough as a helpful default;
 * `roadSource` can always be set explicitly to override it. */
const US_BBOXES: Array<[number, number, number, number]> = [
  [-125, 24.5, -66.9, 49.5], // Contiguous US
  [-170, 51, -129, 72], // Alaska (mainland — excludes Aleutians crossing the antimeridian)
  [-160.5, 18.5, -154.5, 22.5], // Hawaii
];
const CANADA_BBOX: [number, number, number, number] = [-141, 41.5, -52, 83.5];

function isInBbox(lon: number, lat: number, box: [number, number, number, number]): boolean {
  const [minLon, minLat, maxLon, maxLat] = box;
  return lon >= minLon && lon <= maxLon && lat >= minLat && lat <= maxLat;
}

/** Picks a country-specific authoritative road source for `"auto"` mode
 * based on the drawn area's centroid, or `null` for anywhere else (falls
 * back to OpenStreetMap, the only source with global coverage). */
export function detectCountryRoadSource(
  area: Feature<Polygon | MultiPolygon>,
): "tigerweb" | "nrn" | null {
  const [lon, lat] = centroid(area).geometry.coordinates;
  if (US_BBOXES.some((box) => isInBbox(lon, lat, box))) return "tigerweb";
  if (isInBbox(lon, lat, CANADA_BBOX)) return "nrn";
  return null;
}

export interface RoadSourceFallbackEvent {
  attemptedSource: "tigerweb" | "nrn";
  error: Error;
}

export interface FetchRoadsForAreaOptions extends FetchOsmRoadsOptions {
  /** Overrides the TIGERweb MapServer endpoint (testing only). */
  tigerwebEndpoint?: string;
  /** Overrides the NRN MapServer endpoint (testing only). */
  nrnEndpoint?: string;
  /** Called when a country-specific source was attempted (explicitly or via
   * `"auto"`) but failed and this fell back to OpenStreetMap instead —
   * lets a caller show "TIGER/Line unavailable — using OpenStreetMap
   * instead" rather than silently substituting a different data source. */
  onSourceFallback?: (event: RoadSourceFallbackEvent) => void;
}

/**
 * Fetches road centerlines for `area` from a country-appropriate
 * authoritative source when available, with OpenStreetMap as the universal
 * fallback and default — see docs/utility-network.md, "Road sources", for
 * why: US Census TIGERweb and Canada's National Road Network are generally
 * stronger than OSM specifically for older/rural roads (built from
 * road-authority records, not crowdsourced), which is exactly the gap
 * that motivated adding them, but neither's exact endpoint schema could be
 * independently verified live during development. So this **never lets a
 * country-specific source's failure break generation**: any error
 * (network, CORS, unexpected response shape) during a `"tigerweb"`/`"nrn"`
 * attempt — whether the caller asked for it explicitly or `"auto"` picked
 * it — is caught, reported via `onSourceFallback`, and generation proceeds
 * on OpenStreetMap instead, the same as if that source had never been
 * requested.
 */
export async function fetchRoadsForArea(
  area: Feature<Polygon | MultiPolygon>,
  roadSource: RoadSourceId,
  options: FetchRoadsForAreaOptions = {},
): Promise<FeatureCollection<LineString, { highway: string }>> {
  const resolvedSource: "osm" | "tigerweb" | "nrn" =
    roadSource === "auto" ? detectCountryRoadSource(area) ?? "osm" : roadSource;

  if (resolvedSource === "osm") {
    return fetchOsmRoads(area, options);
  }

  try {
    if (resolvedSource === "tigerweb") {
      return await fetchTigerwebRoads(area, {
        endpoint: options.tigerwebEndpoint,
        signal: options.signal,
      });
    }
    return await fetchNrnRoads(area, {
      endpoint: options.nrnEndpoint,
      signal: options.signal,
    });
  } catch (error) {
    options.onSourceFallback?.({
      attemptedSource: resolvedSource,
      error: error instanceof Error ? error : new Error(String(error)),
    });
    return fetchOsmRoads(area, options);
  }
}
