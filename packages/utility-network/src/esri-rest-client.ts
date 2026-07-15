import type { Feature, FeatureCollection, LineString } from "geojson";

/**
 * Shared client for querying an Esri ArcGIS Server MapServer (the pattern
 * both `fetch-roads-tigerweb.ts` and `fetch-roads-nrn.ts` use) — mirrors
 * `overpass-client.ts`'s role as the common HTTP layer under multiple
 * source-specific fetchers.
 *
 * Layer IDs on a MapServer aren't guaranteed stable across services or
 * documented consistently, so both callers **discover** layers by name
 * (`listEsriLayers` + a name filter) rather than hardcoding numeric IDs —
 * a defensive choice given neither TIGERweb's nor NRN's exact layer
 * numbering could be independently verified during development (see
 * docs/utility-network.md). A bbox query naturally over-fetches relative to
 * the drawn polygon (an envelope, not the exact shape); that's fine, the
 * caller (`generate-network.ts`) already clips every source to the drawn
 * area downstream regardless of where the roads came from.
 */

export interface EsriFetchOptions {
  signal?: AbortSignal;
}

export interface EsriLayerInfo {
  id: number;
  name: string;
}

/** Every layer/sublayer a MapServer exposes, via its `?f=json` metadata
 * endpoint. Throws on a non-OK response or unexpected shape. */
export async function listEsriLayers(
  mapServerUrl: string,
  options: EsriFetchOptions = {},
): Promise<EsriLayerInfo[]> {
  const response = await fetch(`${mapServerUrl}?f=json`, {
    signal: options.signal,
  });
  if (!response.ok) {
    throw new Error(
      `Esri MapServer layer list failed: ${response.status} ${response.statusText}`,
    );
  }
  const data = (await response.json()) as { layers?: Array<{ id: number; name: string }> };
  if (!Array.isArray(data.layers)) {
    throw new Error("Esri MapServer layer list response missing 'layers'");
  }
  return data.layers.map((layer) => ({ id: layer.id, name: layer.name }));
}

/**
 * Queries one MapServer layer for LineString features intersecting `bbox`
 * (`[minX, minY, maxX, maxY]` in WGS84), requesting only `outFields` plus
 * geometry. Throws on a non-OK response, a non-2xx-shaped body, or a
 * response that isn't a GeoJSON FeatureCollection (`f=geojson` is not
 * universally guaranteed across every ArcGIS Server version/config, so this
 * is treated as a real failure mode, not assumed to always succeed).
 */
export async function queryEsriLayerByBbox(
  mapServerUrl: string,
  layerId: number,
  bbox: [number, number, number, number],
  outFields: string[],
  options: EsriFetchOptions = {},
): Promise<FeatureCollection<LineString>> {
  const [minX, minY, maxX, maxY] = bbox;
  const params = new URLSearchParams({
    geometry: `${minX},${minY},${maxX},${maxY}`,
    geometryType: "esriGeometryEnvelope",
    inSR: "4326",
    spatialRel: "esriSpatialRelIntersects",
    outFields: outFields.join(","),
    returnGeometry: "true",
    outSR: "4326",
    f: "geojson",
  });
  const response = await fetch(`${mapServerUrl}/${layerId}/query?${params.toString()}`, {
    signal: options.signal,
  });
  if (!response.ok) {
    throw new Error(
      `Esri layer query failed: ${response.status} ${response.statusText}`,
    );
  }
  const data = (await response.json()) as FeatureCollection<LineString> | { error?: unknown };
  if (!("type" in data) || data.type !== "FeatureCollection" || !Array.isArray(data.features)) {
    throw new Error("Esri layer query did not return a GeoJSON FeatureCollection");
  }
  return {
    type: "FeatureCollection",
    features: data.features.filter(
      (feature): feature is Feature<LineString> =>
        feature.geometry?.type === "LineString",
    ),
  };
}
