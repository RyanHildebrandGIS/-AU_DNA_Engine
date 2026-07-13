import type { GeoLibreLayer } from "@geolibre/core";
import type { NetworkQuantities } from "@geolibre/utility-network";

/**
 * Discriminates a generated utility-network layer (junctions/lines/services)
 * from any other GeoJSON layer in the project, and records which utility
 * type it belongs to — set via `addGeoJsonLayer`'s metadata param when
 * `UtilityDesignDialog` creates the layer. CostPanel reads this back to
 * derive quantities to price, without needing its own parallel store of
 * "networks generated this session" that could drift from the actual layers
 * (which are already the project's source of truth and survive save/load).
 */
export type UtilityNetworkLayerRole = "junctions" | "lines" | "services";

export interface UtilityNetworkLayerMetadata {
  utilityNetworkRole: UtilityNetworkLayerRole;
  utilityType: string;
  [key: string]: unknown;
}

export function utilityNetworkLayerMetadata(
  role: UtilityNetworkLayerRole,
  utilityType: string,
): UtilityNetworkLayerMetadata {
  return { utilityNetworkRole: role, utilityType };
}

function roleOf(layer: GeoLibreLayer): UtilityNetworkLayerRole | undefined {
  const role = layer.metadata.utilityNetworkRole;
  return role === "junctions" || role === "lines" || role === "services"
    ? role
    : undefined;
}

/**
 * Sums quantities across every utility-network layer currently in the
 * project, grouped by utility type: total main length (from each line
 * feature's `length_km` property, summed and converted to meters), junction
 * count, and service count. A utility type only generated as mainline (no
 * services layer) simply gets `serviceCount: 0`.
 */
export function deriveNetworkQuantities(
  layers: GeoLibreLayer[],
): NetworkQuantities[] {
  const byUtilityType = new Map<string, NetworkQuantities>();
  const get = (utilityType: string): NetworkQuantities => {
    let entry = byUtilityType.get(utilityType);
    if (!entry) {
      entry = { utilityType, mainLengthMeters: 0, junctionCount: 0, serviceCount: 0 };
      byUtilityType.set(utilityType, entry);
    }
    return entry;
  };

  for (const layer of layers) {
    const role = roleOf(layer);
    if (!role || !layer.geojson) continue;
    const utilityType =
      typeof layer.metadata.utilityType === "string"
        ? layer.metadata.utilityType
        : "unknown";
    const entry = get(utilityType);
    const features = layer.geojson.features ?? [];

    if (role === "junctions") {
      entry.junctionCount += features.length;
    } else if (role === "services") {
      entry.serviceCount += features.length;
    } else if (role === "lines") {
      for (const feature of features) {
        const lengthKm = feature.properties?.length_km;
        if (typeof lengthKm === "number" && Number.isFinite(lengthKm)) {
          entry.mainLengthMeters += lengthKm * 1000;
        }
      }
    }
  }

  return [...byUtilityType.values()];
}
