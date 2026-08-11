import type { Feature, FeatureCollection, LineString, Point } from "geojson";

export type EditableGeometry =
  | { type: "Point"; coordinates: [number, number] }
  | { type: "LineString"; coordinates: [number, number][] };

/**
 * Returns a new FeatureCollection with the feature whose `properties.id`
 * matches `featureId` given `geometry` in place of its own — every other
 * feature is untouched (same object references, so callers doing a shallow
 * diff elsewhere aren't fooled into re-rendering unrelated features).
 * Throws if no feature has that id, or if `geometry`'s type doesn't match
 * the existing feature's geometry type (a caller should never turn a point
 * into a line or vice versa by accident).
 */
export function replaceFeatureGeometry(
  collection: FeatureCollection,
  featureId: string,
  geometry: EditableGeometry,
): FeatureCollection {
  const index = collection.features.findIndex(
    (feature) => feature.properties?.id === featureId,
  );
  if (index === -1) {
    throw new Error(`No feature with id "${featureId}" in this layer.`);
  }
  const existing = collection.features[index] as Feature<Point | LineString>;
  if (existing.geometry?.type !== geometry.type) {
    throw new Error(
      `Feature "${featureId}" is a ${existing.geometry?.type}, not a ${geometry.type}.`,
    );
  }
  const features = collection.features.slice();
  features[index] = { ...existing, geometry };
  return { ...collection, features };
}

/**
 * Returns a new FeatureCollection with the feature whose `properties.id`
 * matches `featureId` removed. Throws if no feature has that id, matching
 * `replaceFeatureGeometry`'s behavior for an unknown id.
 */
export function removeFeatureById(
  collection: FeatureCollection,
  featureId: string,
): FeatureCollection {
  const index = collection.features.findIndex(
    (feature) => feature.properties?.id === featureId,
  );
  if (index === -1) {
    throw new Error(`No feature with id "${featureId}" in this layer.`);
  }
  return {
    ...collection,
    features: collection.features.filter((_, i) => i !== index),
  };
}
