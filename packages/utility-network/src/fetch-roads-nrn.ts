import bbox from "@turf/bbox";
import type { Feature, FeatureCollection, LineString, MultiPolygon, Polygon } from "geojson";
import { listEsriLayers, queryEsriLayerByBbox, type EsriFetchOptions } from "./esri-rest-client";

export const DEFAULT_NRN_ENDPOINT =
  "https://geo.statcan.gc.ca/geo_wa/rest/services/NRN-RRN/nrn_rrn/MapServer";

export interface FetchNrnRoadsOptions extends EsriFetchOptions {
  endpoint?: string;
}

/**
 * Maps a Canada National Road Network `ROADCLASS` value to this tool's
 * `highway` vocabulary, keyword-matched (not exact string equality) against
 * a lowercased value. **`ROADCLASS`'s exact enumerated value set could not
 * be independently verified during development** (the official NRN product
 * specification/data dictionary wasn't reachable to confirm literal
 * spelling/punctuation — see docs/utility-network.md) — keyword matching
 * is a deliberate hedge against minor formatting differences ("Local /
 * Street" vs "Local/Street" vs different casing) rather than assuming exact
 * string equality against unverified values. An unrecognized value falls
 * back to `"residential"` (permissive) rather than being excluded, since
 * getting this wrong in the exclude direction would silently return zero
 * or too few roads and defeat the point of adding this source at all;
 * `Rapid Transit` and `Ferry Connection` are the only classes excluded
 * outright, since neither is a road the public drives on.
 */
function classifyRoadClass(roadClass: string | undefined): string | undefined {
  if (!roadClass) return "residential";
  const normalized = roadClass.toLowerCase();
  if (normalized.includes("rapid transit") || normalized.includes("ferry")) return undefined;
  if (normalized.includes("freeway")) return "motorway";
  if (normalized.includes("expressway") || normalized.includes("highway")) return "trunk";
  if (normalized.includes("arterial")) return "primary";
  if (normalized.includes("collector")) return "secondary";
  if (normalized.includes("ramp")) return "primary_link";
  if (normalized.includes("alleyway") || normalized.includes("lane")) return "service";
  if (normalized.includes("service")) return "service";
  if (normalized.includes("resource") || normalized.includes("recreation")) return "track";
  if (normalized.includes("winter")) return "track";
  if (normalized.includes("local")) return "residential";
  return "residential";
}

/**
 * Fetches road centerlines from Canada's National Road Network (NRN) Esri
 * MapServer for the given area, in the same
 * `FeatureCollection<LineString, { highway }>` shape `fetchOsmRoads`
 * returns. NRN publishes many per-province/per-road-type sublayers (e.g.
 * "AB - Local roads", "QC - Trans-Canada Highway") rather than one unified
 * layer, so layers are discovered by name (matching road/highway/street/
 * route) and queried in parallel — most won't intersect a small project's
 * bounding box and will simply return no features quickly. Throws if the
 * layer list or every layer query fails — the caller (`road-source.ts`) is
 * responsible for falling back to OpenStreetMap.
 */
export async function fetchNrnRoads(
  area: Feature<Polygon | MultiPolygon>,
  options: FetchNrnRoadsOptions = {},
): Promise<FeatureCollection<LineString, { highway: string }>> {
  const endpoint = options.endpoint?.trim() || DEFAULT_NRN_ENDPOINT;
  const layers = await listEsriLayers(endpoint, options);
  const roadLayers = layers.filter((layer) => /road|highway|street|route/i.test(layer.name));
  if (roadLayers.length === 0) {
    throw new Error("NRN MapServer has no layer matching road/highway/street/route in its name");
  }

  const areaBbox = bbox(area) as [number, number, number, number];
  const layerResults = await Promise.all(
    roadLayers.map((layer) =>
      queryEsriLayerByBbox(endpoint, layer.id, areaBbox, ["ROADCLASS"], options),
    ),
  );

  const features: Feature<LineString, { highway: string }>[] = [];
  for (const result of layerResults) {
    for (const feature of result.features) {
      const roadClass = (feature.properties as { ROADCLASS?: string } | null)?.ROADCLASS;
      const highway = classifyRoadClass(roadClass);
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
