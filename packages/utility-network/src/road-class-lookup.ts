import type { FeatureCollection, GeoJsonProperties, LineString, Position } from "geojson";

/** Same ~0.1m rounding tolerance as `road-graph.ts`'s own node merging — not
 * shared code, just the same reasonable precision for real OSM coordinates,
 * kept independent since this lookup's key (a coordinate pair) is a
 * different shape than that module's (a single coordinate). */
const COORD_PRECISION = 6;

function coordKey(coord: Position): string {
  return `${coord[0].toFixed(COORD_PRECISION)},${coord[1].toFixed(COORD_PRECISION)}`;
}

function segmentKey(a: Position, b: Position): string {
  const ka = coordKey(a);
  const kb = coordKey(b);
  return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
}

/**
 * Maps every consecutive coordinate pair (segment) across a set of road
 * features to that road's `highway` class — lets `generate-network.ts` look
 * up "what kind of road is this bit of the mainline actually following"
 * (for pipe-size-by-hierarchy and major-road-crossing detection) without
 * threading the class through the routing graph itself, which only tracks
 * coordinates and distances. Coordinate-keyed, not geometry-indexed, so
 * lookups are exact-match against a segment that came from the same road
 * data this was built from.
 */
export class RoadClassLookup {
  private readonly classBySegment = new Map<string, string>();

  constructor(roads: FeatureCollection<LineString, GeoJsonProperties>) {
    for (const feature of roads.features) {
      const highwayClass =
        (feature.properties?.highway as string | undefined) ?? "unclassified";
      const coords = feature.geometry.coordinates;
      for (let i = 0; i < coords.length - 1; i++) {
        this.classBySegment.set(segmentKey(coords[i], coords[i + 1]), highwayClass);
      }
    }
  }

  /** The highway class of the road segment directly between `a` and `b`, or
   * `undefined` if no road in the data this lookup was built from has that
   * exact segment. */
  segmentClass(a: Position, b: Position): string | undefined {
    return this.classBySegment.get(segmentKey(a, b));
  }
}
