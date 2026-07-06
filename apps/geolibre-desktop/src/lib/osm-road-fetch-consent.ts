/**
 * Consent gate for the Utility Design wizard's road-following network
 * generation. Generating a network sends the drawn project area's polygon
 * coordinates to the public Overpass API, so the user must acknowledge a
 * one-time privacy notice before the first request — mirrors the network
 * routing (Valhalla) consent gate in routing-consent.ts, kept as a separate
 * key since it's a distinct third-party endpoint.
 */
export const OSM_ROAD_FETCH_CONSENT_KEY =
  "geolibre:utility-network-osm-road-fetch-notice";

/** Whether the user has acknowledged the Overpass road-fetch privacy notice. */
export function hasOsmRoadFetchConsent(): boolean {
  try {
    return localStorage.getItem(OSM_ROAD_FETCH_CONSENT_KEY) === "1";
  } catch {
    // localStorage unavailable (private mode): treat as not acknowledged so
    // the notice is shown rather than silently sending coordinates.
    return false;
  }
}

/** Record that the user acknowledged the Overpass road-fetch privacy notice. */
export function recordOsmRoadFetchConsent(): void {
  try {
    localStorage.setItem(OSM_ROAD_FETCH_CONSENT_KEY, "1");
  } catch {
    // Ignore: the notice will simply show again next time.
  }
}
