# Automated utility network generation

`@geolibre/utility-network` generates a road-following pipe/cable network inside a
drawn project-area polygon, connected back to a source/point-of-connection. It
backs both the Utility Design wizard (`UtilityDesignDialog.tsx`) and the AI
assistant's `generate_utility_network` tool — same underlying function, two
front doors.

## Algorithm

1. **Fetch roads** (`fetch-roads.ts`) — queries the public
   [Overpass API](https://overpass-api.de) for OSM road centerlines within the
   drawn polygon (`way["highway"](poly:"...")`), returning a plain LineString
   `FeatureCollection`. This is the only network call; everything after this
   step is synchronous and local.
2. **Clip to the drawn area** (`clip-to-area.ts`) — Overpass's `poly:` filter
   matches any way that *intersects* the drawn polygon, not just the part
   inside it, so a fetched road commonly continues past the boundary the user
   actually drew. Every road is split at the polygon boundary and the
   outside portions are dropped before anything else happens, so the
   generated network never extends past the drawn project area.
3. **Build a graph** (`road-graph.ts`) — every (now-clipped) road vertex
   becomes a graph node (deduped by coordinate so ways sharing an
   intersection share a node), every consecutive vertex pair becomes an edge
   weighted by real distance.
4. **Place junctions** — two sources, merged:
   - Spacing-based candidates: points walked along each road at the
     configured spacing (`spacingKm`), then snapped to the nearest existing
     graph node (see "Known simplifications" below).
   - Every real intersection and dead-end in the network reachable from the
     source *always* gets a junction marker, regardless of spacing — a
     mainline that visibly splits at an intersection always has a junction
     dot there, not just wherever a spacing candidate happened to land.
   Both are subject to `maxJunctions`; if the cap forces a choice, real
   intersections are kept and spacing-only candidates are dropped first.
5. **Connect to source** — Dijkstra's algorithm from the source node produces
   a shortest-path tree over the real road graph; the union of every edge
   along every junction's path back to the source becomes the line network
   (shared trunk segments are emitted once, not duplicated per junction).
6. **Offset** — each line is offset perpendicular to the road centerline by
   `offsetMeters`, to one or both sides (`side: "left" | "right" | "both"`).
7. **Services** (`mode: "mainlineAndServices"` only) — fetches OSM building
   footprints in the drawn area (`fetch-buildings.ts`, a second Overpass
   query, `way["building"](poly:"...")`) and connects each one to the
   already-offset mainline (`connect-services.ts`):
   1. The building's centroid (`@turf/centroid`) is an approximate anchor.
   2. `@turf/nearest-point-on-line` runs against every generated mainline
      feature (both offset lines when `side: "both"`) to find the nearest
      point overall — the main-side tap point. This naturally picks whichever
      side's offset line is physically closer.
   3. `@turf/nearest-point-on-line` runs again, this time against the
      building's own footprint ring, using the tap point as the reference —
      giving the building-side connection point on the footprint edge
      closest to the main, not the centroid itself.
   4. A 2-point service line is emitted between those two points.

   Available for every utility type. Buildings beyond `maxServices` (default
   500, same shape as `maxJunctions`) are dropped and reported via
   `servicesTruncated`.

   Optionally (`junctionsAtServiceTaps: true`), each service's main-side tap
   point also gets its own junction marker — a real tap is a real fitting on
   the main, so it can be worth showing as a junction distinct from the
   road-spacing/intersection junctions above. Off by default.

## Known simplifications

- **Junctions snap to the nearest existing graph node rather than splitting
  the road edge they land nearest to.** True edge-splitting would place
  junctions at exact regular intervals; snapping means a junction can be off
  by up to half the distance between two real road vertices. A reasonable
  first pass, not pixel-perfect.
- **Junction markers are not offset** — only the connecting lines are shifted
  to the side of the road. Offsetting junction points too would need
  projecting them onto the offset line, which is out of scope for now.
- **Area clipping is vertex-level, not true segment/polygon boundary
  counting** — a road segment that dips outside the drawn area and back in
  without either endpoint actually leaving the area (a very sharp concave
  notch cutting across one long segment) won't be detected as leaving. Fine
  for the polygons users draw by hand; a known edge case for adversarial
  inputs.
- **No road fallback**: if Overpass returns zero roads for the drawn area,
  generation fails with a clear error rather than falling back to a floating
  grid (an earlier version of this tool laid out a raster grid + straight-line
  minimum spanning tree with no road awareness at all — replaced entirely).
- **Service connections are ways-only** — buildings modeled as OSM
  `relation`s (multipolygon buildings, e.g. ones with courtyards) are not
  fetched, the same ways-only simplification already accepted for roads.
- **Service connections are a two-step nearest-point approximation, not a
  true mutual-nearest solve.** The main-side tap point is chosen using the
  building's centroid as a stand-in for "where on the building we'll connect
  from," which can pick a slightly different tap point than jointly
  optimizing both ends at once would. A reasonable first pass, not a
  network-design-grade solve.

## Explicitly out of scope

- Domain-specific rules: pipe/cable sizing, slope/elevation-aware gravity
  sewer routing, valve or vault placement at intersections.
- Cost/quantity takeoff.
- A self-hosted Overpass instance UI (there's no per-run endpoint override in
  the wizard yet, unlike the routing/Valhalla tools' `VITE_ROUTING_ENDPOINT`
  pattern — `fetchOsmRoads`'s `endpoint` option exists for this, just not
  wired to a Settings field yet).
