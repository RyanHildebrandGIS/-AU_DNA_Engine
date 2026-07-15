import bbox from "@turf/bbox";
import type { Feature, FeatureCollection, LineString, MultiPolygon, Polygon } from "geojson";
import { listEsriLayers, queryEsriLayerByBbox, type EsriFetchOptions } from "./esri-rest-client";

export const DEFAULT_TIGERWEB_ENDPOINT =
  "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Transportation_LargeScale/MapServer";

export interface FetchTigerwebRoadsOptions extends EsriFetchOptions {
  endpoint?: string;
}

/**
 * US Census TIGERweb road classification (`MTFCC` — MAF/TIGER Feature Class
 * Code) mapped to this tool's `highway` vocabulary, so the rest of the
 * pipeline (graph building, junction placement, offsetting) works
 * identically regardless of which source fetched the roads. An allowlist,
 * same philosophy as `fetch-roads.ts`'s OSM highway filter: an MTFCC not in
 * this table is excluded rather than silently included. Values verified
 * against Census's MAF/TIGER Feature Class Code reference; `S1500`
 * (vehicular trail/4WD) and `S1730`/`S1780` (alley/parking lot road) are
 * included since they carry real, if minor, vehicle traffic, matching how
 * `track`/`service` are treated on the OSM side.
 */
const MTFCC_TO_HIGHWAY: Record<string, string> = {
  S1100: "primary", // Primary Road
  S1200: "secondary", // Secondary Road
  S1400: "residential", // Local Neighborhood Road, Rural Road, City Street
  S1500: "track", // Vehicular Trail (4WD)
  S1630: "primary_link", // Ramp
  S1640: "service", // Service Drive (usually alongside a limited-access highway)
  S1730: "service", // Alley
  S1780: "service", // Parking Lot Road
};

/**
 * Fetches road centerlines from the US Census TIGERweb `Transportation_
 * LargeScale` MapServer for the given area, in the same
 * `FeatureCollection<LineString, { highway }>` shape `fetchOsmRoads`
 * returns, so it's a drop-in alternative source. Layers are discovered by
 * name (containing "road") rather than hardcoded IDs — TIGERweb's exact
 * layer numbering wasn't independently verifiable during development, see
 * docs/utility-network.md. Queries every matching layer within the area's
 * bounding box (an over-fetch relative to the drawn polygon; the caller
 * clips to the exact area downstream regardless of source) and merges the
 * results. Throws if the layer list or any layer query fails — the caller
 * (`road-source.ts`) is responsible for falling back to OpenStreetMap.
 */
export async function fetchTigerwebRoads(
  area: Feature<Polygon | MultiPolygon>,
  options: FetchTigerwebRoadsOptions = {},
): Promise<FeatureCollection<LineString, { highway: string }>> {
  const endpoint = options.endpoint?.trim() || DEFAULT_TIGERWEB_ENDPOINT;
  const layers = await listEsriLayers(endpoint, options);
  const roadLayers = layers.filter((layer) => /road/i.test(layer.name));
  if (roadLayers.length === 0) {
    throw new Error("TIGERweb MapServer has no layer matching 'road' in its name");
  }

  const areaBbox = bbox(area) as [number, number, number, number];
  const layerResults = await Promise.all(
    roadLayers.map((layer) =>
      queryEsriLayerByBbox(endpoint, layer.id, areaBbox, ["MTFCC"], options),
    ),
  );

  const features: Feature<LineString, { highway: string }>[] = [];
  for (const result of layerResults) {
    for (const feature of result.features) {
      const mtfcc = (feature.properties as { MTFCC?: string } | null)?.MTFCC;
      const highway = mtfcc ? MTFCC_TO_HIGHWAY[mtfcc] : undefined;
      if (!highway || !feature.geometry || feature.geometry.coordinates.length < 2) continue;
      features.push({
        type: "Feature",
        properties: { highway },
        geometry: feature.geometry,
      });
    }
  }
  return { type: "FeatureCollection", features };
}
