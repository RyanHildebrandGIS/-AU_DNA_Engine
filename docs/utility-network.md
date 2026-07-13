# Automated utility network generation

`@geolibre/utility-network` generates a road-following pipe/cable network inside a
drawn project-area polygon, connected back to a source/point-of-connection. It
backs both the Utility Design wizard (`UtilityDesignDialog.tsx`) and the AI
assistant's `generate_utility_network` tool — same underlying function, two
front doors.

## Algorithm

1. **Fetch roads** (`fetch-roads.ts`) — queries the public
   [Overpass API](https://overpass-api.de) for OSM road centerlines within the
   drawn polygon, restricted to drivable highway classes via a regex value
   filter (`way["highway"~"^(motorway|trunk|primary|secondary|tertiary|
   unclassified|residential|living_street|service|track|road|...|_link
   variants)$"](poly:"...")`) — footways, cycleways, paths, bridleways, and
   steps are excluded, since a utility mainline runs in the vehicle
   right-of-way, not a footpath; `track` (unpaved rural/agricultural access
   roads) and `road` (OSM's placeholder for a road not yet classified,
   common on older roads never reclassified after initial mapping) are
   included since they carry real vehicle traffic. Neither is filtered by
   `access`/`motor_vehicle` tags — see "Known simplifications" below. Returns
   a plain LineString `FeatureCollection`. This is the only
   network call; everything after this step is synchronous and local.
   `queryOverpassWays` (`overpass-client.ts`, shared with the buildings fetch)
   retries a 429/502/503/504 response up to twice with a short backoff before
   giving up — the public Overpass instance is well known to intermittently
   return these under load, so a request that would previously surface as
   "Overpass request failed: 502 Bad Gateway" (requiring the user to manually
   click Generate again) now recovers on its own most of the time.
   `generateNetwork`'s optional 5th parameter, `onProgress`, reports real
   stage checkpoints (`"fetching" | "building" | "done"`) plus these retry
   attempts, driving `UtilityDesignDialog`'s `NetworkGenerationOverlay`.
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
   Every junction feature carries a `junctionType` property — the standard
   industry name for that utility's junction structure (water → "Valve",
   sewer → "Manhole", stormwater → "Catch Basin", electric → "Vault",
   fiber → "Handhole", anything else → generic "Junction"). A simple
   utility-based lookup for now (`JUNCTION_TYPE_LABELS` in
   `generate-network.ts`), not a rules-driven pick between e.g. a dead-end
   and a real intersection.
5. **Connect to source** — Dijkstra's algorithm from the source node produces
   a shortest-path **tree** over the real road graph; the union of every edge
   along every junction's path back to the source becomes the line network
   (shared trunk segments are emitted once, not duplicated per junction).
   Because this is a tree, not the full road topology, a street that forms a
   loop back into the already-connected network (a horseshoe/cul-de-sac loop,
   or any street reconnecting to a road it already branched from) gets a line
   on every reachable node **except the single edge that would close the
   loop** — that edge simply isn't on anyone's shortest path back to the
   source, so it's correctly left undrawn rather than a bug in the highway
   filter. This mirrors how utility mains are actually laid out in practice
   (branching off a source, not duplicated around a loop) — see "Design
   standards" below. It is *not* related to the drivable-highway allowlist in
   step 1: `residential`, `living_street`, `service`, and `unclassified` are
   all included there, so ordinary smaller streets are fetched and graphed
   the same as arterial roads. A street that's missing entirely (not just one
   loop-closing edge) usually means its only connection to the rest of the
   network falls outside the polygon the user drew — draw the project area to
   fully enclose every street that should connect, not just up to its
   frontage.
6. **Offset** — each line is offset perpendicular to the road centerline by
   `offsetMeters`, to one or both sides (`side: "left" | "right" | "both"`),
   then **anchored back to the true (unoffset) junction/decision-point
   location at both of its endpoints** via `anchor-offset-line.ts`. Without
   this, an offset line runs parallel to the centerline for its whole length
   and never actually touches the junction marker sitting on the true on-road
   point, and two chains sharing a node would each be offset independently,
   leaving a visible gap right at the junction instead of meeting there.
   Every generated line's endpoints are therefore guaranteed to exactly match
   a junction (or the source) — connectivity, not just visual proximity.
   `@turf/line-offset`'s mitered joins can overshoot past a sharp bend, which
   a naive prepend/append of the true endpoint could turn into a
   self-intersecting spike right next to the junction; `anchorOffsetLine`
   trims the offset line to the span between where it lands closest to each
   true endpoint first, and as an unconditional final guarantee checks the
   result with `@turf/kinks`, falling back to a plain straight line between
   the two true endpoints (a single segment, which can never self-intersect)
   if it still does. **Lines never self-intersect**, even at the cost of
   losing the offset's visual detail in that rare fallback case.
7. **Services** (`mode: "mainlineAndServices"` only) — fetches OSM building
   footprints in the drawn area (`fetch-buildings.ts`, a second Overpass
   query, `way["building"](poly:"...")`) and connects each one to the
   already-offset mainline (`connect-services.ts`):
   1. The building's centroid (`@turf/centroid`) is an approximate anchor.
   2. Every mainline feature (both offset lines when `side: "both"`) is
      ranked by `@turf/nearest-point-on-line` distance to that anchor, closest
      first, keeping the nearest 5 as candidates.
   3. Candidates are tried in that order. For each one,
      `@turf/nearest-point-on-line` runs again against the building's own
      footprint ring, using the candidate's main-side point as the
      reference, giving the building-side connection point on the footprint
      edge closest to the main (not the centroid itself). The resulting
      2-point service line is checked with `@turf/boolean-intersects`
      against every *other* building in the area — real service laterals
      stay within the public right-of-way and the customer's own lot, never
      cutting across a neighboring property, and without parcel/lot-line
      data this is the closest enforceable proxy for that rule. The first
      candidate whose line doesn't cross another building's footprint wins.
   4. If none of the 5 nearest candidates qualify, the building is skipped
      entirely rather than drawn through a neighbor's home, and counted in
      `servicesBlockedCount` (`servicesBlocked` is true when that count is
      nonzero).

   Available for every utility type. Buildings beyond `maxServices` (default
   500, same shape as `maxJunctions`) are dropped and reported via
   `servicesTruncated`.

   Optionally (`junctionsAtServiceTaps: true`), each service's main-side tap
   point also gets its own junction marker — a real tap is a real fitting on
   the main, so it can be worth showing as a junction distinct from the
   road-spacing/intersection junctions above. Off by default.

## Design standards

The junction/spacing/offset/service-connection behavior above was checked
against real municipal/utility water-main design manuals (e.g. Saskatchewan's
rural water design standards and comparable municipal servicing manuals) and
matches this tool's defaults reasonably well:

- **Valves/junctions belong on every branch of every intersection and tee** —
  "valves shall be placed on all branches of crosses and tees... located where
  right-of-way lines intersect with proposed water mains" is a standard
  requirement across these manuals. This matches step 4 above: every real
  intersection or dead-end reachable from the source always gets a junction
  marker, unconditionally, not just wherever a spacing candidate happens to
  land.
- **Valve spacing standards vary by main size and density**, commonly ranging
  from roughly 500 ft up to a 1/4–1/2 mile depending on pipe diameter and
  surrounding development density. This matches `spacingKm` being a
  user-configurable input rather than a fixed constant — there's no single
  correct number, it's a real design decision that depends on the project.
- **Service connections are conventionally perpendicular to the main** for a
  straight run — which is exactly what `@turf/nearest-point-on-line` produces
  by construction (the nearest point on a straight segment to an external
  point is always the perpendicular foot), validating the nearest-point
  approach in step 7 rather than it being an arbitrary simplification.
- **Minimum main-to-main separation is commonly around 10 ft (~3 m)** in these
  manuals, which is in the same range as this tool's `DEFAULT_OFFSET_METERS`
  (3 m) default for how far a line sits from the road centerline.

None of this is pipe-sizing, hydraulic, or gravity-slope engineering — those
remain explicitly out of scope (see below) — this is specifically about
where junctions, spacing, and service taps go, which is the part this tool
actually generates.

## Known simplifications

- **The drivable-highway filter checks only the `highway` tag, not
  `access`/`motor_vehicle`/lifecycle prefixes.** A `track` or `residential`
  way tagged `access=private` or `access=no` is still fetched and used —
  there's no per-project way to know whether "private" should mean "exclude
  from the utility main" (a real gated road) or is just noise (many rural
  tracks are tagged private but are the only road serving a property). A way
  tagged with an OSM lifecycle prefix (`disused:highway=residential`,
  `demolished:highway=track`, etc., meaning it no longer physically exists as
  a road) is correctly excluded, since the filter matches the literal
  `highway` key and lifecycle-prefixed tags use a different key entirely.
- **Junctions snap to the nearest existing graph node rather than splitting
  the road edge they land nearest to.** True edge-splitting would place
  junctions at exact regular intervals; snapping means a junction can be off
  by up to half the distance between two real road vertices. A reasonable
  first pass, not pixel-perfect.
- **Junction markers themselves are not offset** — they stay at the true
  on-road point, matching the anchor point each connecting line's endpoints
  snap back to (see step 6 above). This is what actually makes them connect;
  it just means a junction marker sits exactly on the centerline rather than
  to the side of it, even though the pipe run passing through it is offset.
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
- **Service connections are a nearest-point approximation, not a true
  mutual-nearest solve.** The main-side tap point is chosen using the
  building's centroid as a stand-in for "where on the building we'll connect
  from," which can pick a slightly different tap point than jointly
  optimizing both ends at once would. A reasonable first pass, not a
  network-design-grade solve.
- **The "don't cross another building" check only has building footprints to
  work with, not real parcel/lot lines.** A service line that squeezes
  between two close-together buildings without touching either one is
  accepted even if it would, in reality, cross a third property's yard; a
  line whose endpoint merely touches a neighboring building's wall (two
  buildings built right up against each other) is rejected even though nothing
  is actually being crossed. Real lot-line data would resolve both, but isn't
  available from OSM building footprints alone.
- **Only the 5 nearest mainline candidates are tried per building** (not
  every mainline segment) before giving up and skipping it — bounds the cost
  of the crossing check (building × candidate × building) for large project
  areas. A building whose nearest 5 candidates are all blocked but whose 6th
  would have worked is skipped rather than found.

## Explicitly out of scope

- Domain-specific rules: pipe/cable sizing, slope/elevation-aware gravity
  sewer routing, valve or vault placement at intersections.
- Cost/quantity takeoff.
- A self-hosted Overpass instance UI (there's no per-run endpoint override in
  the wizard yet, unlike the routing/Valhalla tools' `VITE_ROUTING_ENDPOINT`
  pattern — `fetchOsmRoads`'s `endpoint` option exists for this, just not
  wired to a Settings field yet).
