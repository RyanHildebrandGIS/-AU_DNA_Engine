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
   `access`/`motor_vehicle` tags by default — pass `excludePrivateAccess:
   true` to exclude ways tagged `access=private`/`no` or
   `motor_vehicle=no` (an opt-in Overpass QL clause, not a default, since
   plenty of legitimately driven rural roads carry these tags — see "Known
   simplifications" below). Returns
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
   fiber → "Handhole", anything else → generic "Junction"). A real dead end
   (zero tree children — a true termination, not just truncated by
   `maxJunctions`) gets a flushing-point label instead (water → "Blow-off",
   sewer/stormwater → "Cleanout"; electric/fiber have no distinct standard
   dead-end structure and keep the normal label) — every junction carries an
   `isDeadEnd` boolean so a caller can tell which label applies. This is
   still a simple utility-based lookup (`JUNCTION_TYPE_LABELS` /
   `DEAD_END_JUNCTION_TYPE_LABELS` in `generate-network.ts`), not a fully
   rules-driven pick across every possible fitting type. Junction markers
   are **never placed on the road itself** — see step 6 for how they're
   offset alongside the mainline.

   A dead end also carries `deadEndRunKm` (its unlooped run length: the
   tree distance back to the nearest *real* branch — one with more than one
   child — or the source, walking through any number of plain spacing
   junctions in between, since those don't themselves split the run) and
   `exceedsMaxDeadEndLength` (true when that exceeds `maxDeadEndKm`, default
   0.18 km / ~180 m / 600 ft). This only flags — it never rejects, shortens,
   or loops the run; a long dead end is still generated exactly as the road
   network dictates, just marked for review.
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
   `offsetMeters` (floored to `MIN_OFFSET_METERS`, 3 m — see below), to one or
   both sides (`side: "left" | "right" | "both"`), then **anchored to an
   offset anchor position at both of its endpoints** via
   `anchor-offset-line.ts`, instead of the true (on-road) junction/
   decision-point coordinate. A junction sitting exactly on the road
   centerline is unrealistic — a valve or manhole sits in the pipe, not
   painted on the pavement — so every junction marker, and every line
   endpoint that meets one, is offset the same `offsetMeters` distance off
   the centerline, perpendicular to the road, on the matching side
   (`offset-junction.ts`'s `perpendicularOffsetPoint`, using `@turf/bearing` +
   `@turf/destination`). A user-requested `offsetMeters` below 3 m is clamped
   up to 3 m for **both** the mainline and its junctions, so they always stay
   at the same distance from the road as each other — matching the ~10 ft
   (~3 m) minimum main-to-road separation cited in the design standards below.
   `side: "both"` produces two full sets of junction markers (one per side),
   not one shared marker, since two parallel mains really do have two
   separate valves/manholes at each cross street.

   Each node's offset anchor position is computed **once** (from whichever of
   its incident chains is encountered first while walking the tree — see
   `generate-network.ts`'s `offsetAnchorForNode`) and cached per `(node,
   side)`, so every chain sharing that node reuses the exact same point
   rather than drifting to its own independently-computed offset. This is the
   same "connectivity over independent per-line visual fidelity" tradeoff
   `anchorOffsetLine` already makes at the line level — a real 3+ way
   intersection's roads don't all point the same direction, so only one of
   them can define "the" perpendicular; the rest bend slightly to still meet
   it exactly rather than drawing a visible gap.

   Every generated line's endpoints are therefore guaranteed to exactly match
   a junction (or the source's own offset anchor, which has no marker of its
   own) — connectivity, not just visual proximity. `@turf/line-offset`'s
   mitered joins can overshoot past a sharp bend, which a naive
   prepend/append of the anchor point could turn into a self-intersecting
   spike right next to the junction; `anchorOffsetLine` trims the offset line
   to the span between where it lands closest to each anchor point first, and
   as an unconditional final guarantee checks the result with `@turf/kinks`,
   falling back to a plain straight line between the two anchor points (a
   single segment, which can never self-intersect) if it still does. **Lines
   never self-intersect**, even at the cost of losing the offset's visual
   detail in that rare fallback case.
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
8. **Pipe sizing and casing** (`generate-network.ts`, `road-class-lookup.ts`)
   — two illustrative attributes derived from the road hierarchy the
   mainline actually follows, via `RoadClassLookup` (maps every consecutive
   coordinate pair across the fetched roads to that road's `highway` class,
   since the routing graph itself only tracks coordinates/distances, not
   which original road contributed each edge):
   - Every line gets `pipeSizeMm`, an illustrative planning-level size
     picked from a 3-tier lookup (`PIPE_SIZE_MM_BY_TIER`) keyed by the
     chain's representative road class — "arterials carry transmission
     mains, residentials carry distribution" is the common framing. The
     representative class is the chain's *first* segment's class (a chain
     can technically span more than one original road's worth of vertices —
     see "Known simplifications"). **Not a hydraulic design size** — real
     sizing needs demand/fire-flow calculations this tool doesn't do.
   - Every junction gets `crossesMajorRoad`, true when any of its incident
     graph edges is primary class or above (`MAJOR_HIGHWAY_MIN_RANK`) — a
     common casing-requirement trigger ("mains crossing motorway/trunk/
     railway are cased"; primary is included too since it's often treated
     the same way). Checked only at chain endpoints, not every interior
     vertex, specifically to avoid a mainline that merely runs *alongside* a
     major road for a long stretch registering as "crossing" it repeatedly
     from floating-point wiggle between two nearly-parallel lines — see
     "Known simplifications" for the tradeoff this creates.
9. **Hydrants** (`includeHydrants: true`) — sampled directly along the
   finished, already-offset mainline at `hydrantSpacingKm` intervals
   (default 0.15 km / ~150 m / 500 ft, a typical residential fire-code
   figure — commercial/high-density areas commonly want tighter spacing,
   ~90 m/300 ft, left to the caller) via the same `@turf/along` +
   `@turf/length` walk `placeJunctionsAlongRoads` uses on the raw roads, just
   applied to the finished lines instead. Hydrants don't need to coincide
   with a junction/decision point the way a line's endpoint does, so they
   aren't snapped to graph nodes at all — wherever the fixed interval lands
   on the offset line is where the hydrant goes. Meaningful for any utility
   type structurally, but standard fire-hydrant spacing specifically applies
   to water; off by default.

## Road sources

Step 1 above describes the default OSM/Overpass fetch. `generateNetwork`'s
`roadSource` option (`"auto" | "osm" | "tigerweb" | "nrn"`, default `"auto"`)
can instead resolve to a country-specific authoritative source, since OSM
coverage is occasionally incomplete for older roads that were never
comprehensively mapped:

- **`"tigerweb"`** (`fetch-roads-tigerweb.ts`) queries the US Census Bureau's
  [TIGERweb](https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Transportation_LargeScale/MapServer)
  `MapServer`. Rather than hardcoding a layer ID (uncertain across TIGERweb's
  several published services), it discovers the road layer by listing
  `?f=json` and name-matching `/road/i`, then queries it via a bbox envelope
  (`esri-rest-client.ts`, shared with NRN below) and classifies each feature's
  `MTFCC` code to an OSM-style `highway` value (`S1100`→primary, `S1200`→
  secondary, `S1400`→residential, `S1500`→track, `S1630`→primary_link,
  `S1640`/`S1730`/`S1780`→service). Unrecognized `MTFCC` codes are dropped
  rather than guessed.
- **`"nrn"`** (`fetch-roads-nrn.ts`) queries Statistics Canada's
  [National Road Network](https://geo.statcan.gc.ca/geo_wa/rest/services/NRN-RRN/nrn_rrn/MapServer)
  `MapServer` the same way, matching layer names against
  `/road|highway|street|route/i` (NRN splits roads across several
  per-province/per-type sublayers, unlike TIGERweb's single layer). Its
  `ROADCLASS` field is classified by lowercase substring/keyword matching
  (`"freeway"`→motorway, `"expressway"`/`"highway"`→trunk, `"arterial"`→
  primary, `"collector"`→secondary, `"local"`→residential, `"alleyway"`/
  `"lane"`/`"service"`→service, `"resource"`/`"recreation"`/`"winter"`→track),
  not exact value matching — a missing or unrecognized `ROADCLASS` defaults
  permissively to `residential` rather than being dropped, so an unexpected
  value set doesn't silently under-cover an area. `"rapid transit"` and
  `"ferry"` classes are excluded outright (not drivable).
- **`"auto"`** picks `"tigerweb"` or `"nrn"` by checking the drawn area's
  centroid against rough US (contiguous + Alaska + Hawaii) and Canada
  bounding boxes (`road-source.ts`'s `detectCountryRoadSource`) — a coarse
  heuristic, not real reverse geocoding, so it can guess wrong within ~tens of
  km of the border. Anywhere else in the world, `"auto"` uses OSM directly.
  The road-source picker in the Utility Design wizard always allows an
  explicit override.
- **Fallback is automatic and silent to the algorithm.** `fetchRoadsForArea`
  wraps every `"tigerweb"`/`"nrn"` attempt (explicit or via `"auto"`) in a
  try/catch; any failure — network error, non-OK response, no matching layer,
  unexpected response shape — falls back to fetching OSM instead, via an
  `onSourceFallback` callback surfaced through `generateNetwork`'s existing
  `onProgress` event and shown to the user as a small "X was unavailable —
  used OpenStreetMap instead" notice (`NetworkGenerationOverlay`,
  `UtilityDesignDialog`'s result summary). Worst case, a wrong assumption
  about either endpoint's schema behaves exactly like this feature not
  existing — it never breaks generation outright. **A technically-successful
  response with zero usable road features also triggers the fallback**, not
  just a thrown error — a source can return HTTP 200 with an empty or
  entirely-unrecognized-classification result if a layer/field assumption is
  wrong against the real endpoint, and without this check that would silently
  skip OSM and surface as a misleading "no roads found in this project area"
  even in a place OSM covers perfectly well.

**Caveat:** TIGERweb's and NRN's exact layer IDs, field names, and
`ROADCLASS` value set were researched from public documentation and could not
be independently verified against the live endpoints during development —
this sandboxed environment's network policy blocks outbound requests to both
hosts. The layer-discovery-by-name and keyword-classification approaches
above are deliberately defensive for exactly this reason (see "Fallback is
automatic and silent" above). Treat `"tigerweb"`/`"nrn"` results as unverified
until exercised against the real deployed app.

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
  manuals, which is why this tool enforces `MIN_OFFSET_METERS` (3 m) as a
  hard floor — not just a default — for how far both the mainline **and its
  junctions** sit from the road centerline, matching `DEFAULT_OFFSET_METERS`.
  This is also the standard usually cited for **water-to-sewer horizontal
  separation** specifically — generating two utility types for the same
  project and picking opposite sides (e.g. water on `side: "right"`, sewer
  on `side: "left"`) already satisfies it structurally, since each utility's
  own mainline independently maintains that same 3 m-minimum clearance from
  the shared road centerline in the opposite direction. Nothing extra to
  configure; a natural consequence of how offsetting already works.
- **Dead ends require a flushing point** (a blow-off for water, commonly a
  cleanout for sewer/stormwater) so the main can be flushed without an
  isolating valve on both sides. Matches step 4: every dead end is
  unconditionally detected already (0 tree children), so relabeling it with
  the flushing-point name instead of the normal junction type was close to
  free once dead ends were already being found.
- **Manuals commonly cap unlooped dead-end run length** (a frequently cited
  figure is ~180 m / 600 ft) or require special justification (extra
  flushing, larger pipe) beyond it. Matches `maxDeadEndKm` — flagged via
  `exceedsMaxDeadEndLength`, not enforced by changing the network's
  topology, since a real dead end that's "too long" is a design conversation
  (loop it back, oversize it, add an interim flushing point), not something
  a generator should silently alter.
- **Fire hydrant spacing follows fire-code tables**, commonly ~150 m/500 ft
  residential and tighter (~90 m/300 ft) for commercial/high-density areas —
  a different interval than valve spacing, generated by the same spacing
  mechanism (see step 9), left fully configurable since there's no single
  correct number across jurisdictions.
- **Mains crossing a motorway/trunk/railway are commonly cased** to protect
  the pipe and allow future maintenance without disturbing the major
  road. Matches step 8's `crossesMajorRoad` flag — an attribute to review,
  not a generated casing detail (this tool doesn't model casing pipe
  geometry, just flags where it's likely required).
- **Pipe/conduit sizing generally follows road hierarchy** — arterials carry
  transmission mains, residential streets carry distribution mains. Matches
  step 8's `pipeSizeMm`, an illustrative planning-level attribute from a
  3-tier lookup, explicitly **not** a hydraulic design size (see "Explicitly
  out of scope").
- **Valve (or vault/manhole) placement at intersections commonly follows an
  "N-1" rule**: a tee gets 2 valves and a cross gets 3 (every leg but one),
  so a single break can be isolated to a minimal area. **This tool does not
  yet implement per-leg N-1 valving** — it places exactly one junction
  marker per intersection node, representing "a junction belongs here,"
  not the full valve count/placement a real isolation design would need.
  Doing this properly requires placing a junction per physical road leg
  (using the raw graph's degree at that node, not just its tree-child
  count) and choosing which leg to omit — a real geometry and design-rules
  addition, not a quick attribute, and deliberately not attempted here yet.
  See "Explicitly out of scope."

None of this is hydraulic or gravity-slope engineering (pipe sizing here is
illustrative, not calculated from demand/fire-flow) — this is specifically
about where junctions, spacing, service taps, hydrants, and casing/sizing
attributes go, which is the part this tool actually generates.

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
- **A multi-way intersection's offset anchor point only reflects one of its
  roads' directions, not all of them.** `offsetAnchorForNode` picks whichever
  incident chain is encountered first to compute the perpendicular offset
  direction; every other chain meeting at that same node bends slightly to
  meet that exact point instead of using its own natural perpendicular. At a
  true 4-way intersection where the two roads aren't parallel, this means the
  junction (and the point where each line meets it) isn't equidistant from
  every connecting road in a strict geometric sense — a reasonable
  approximation, not a rules-driven "true" intersection offset solve.
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
- **TIGERweb/NRN endpoint behavior is unverified against the live
  services** — see "Road sources" above. Layer discovery and field
  classification were built defensively (auto-fallback to OSM on any
  failure) specifically because this couldn't be confirmed during
  development. **Country detection is a bounding-box centroid check, not
  real reverse geocoding** — imprecise near the US/Canada border; always
  overridable via an explicit `roadSource`.
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
- **`crossesMajorRoad` also flags a chain endpoint that merely *starts on* a
  major road, not only ones that geometrically cross one.** Checking only at
  chain endpoints (see step 8) avoids the far worse false-positive of a
  mainline running *alongside* a major road for a long stretch registering
  as "crossing" it repeatedly, but conflates two different real standards:
  perpendicular casing (crossing under/through) and parallel encasement
  (running near/along). A reasonable approximation given the tradeoff, not
  a precise crossing-angle solve.
- **`pipeSizeMm`'s "representative road class" is the chain's first segment,
  not an analysis of every segment in it.** A chain can span more than one
  original road's worth of vertices when a pass-through node isn't a
  decision point — if that stretch changes highway class partway through
  (e.g. residential becoming tertiary with no branch in between), the whole
  chain still gets one size, from whichever class comes first.
- **`deadEndRunKm` is computed from tree distance, not the actual generated
  line geometry.** It sums real road distances along the shortest-path tree
  back to the nearest real branch, which is what standards mean by "unlooped
  run length" — the small amount added/removed by offsetting doesn't change
  which runs are flagged in practice, but the two numbers aren't bit-for-bit
  identical.
- **Hydrant spacing is independent of junction spacing** — hydrants are
  sampled fresh along the finished mainline at their own interval, not
  reused from or aligned with the `spacingKm` junction candidates, so a
  hydrant and a junction can end up very close together or with an
  arbitrary offset between them. A hydrant marker is not itself a junction
  (no `junctionType`/`isDeadEnd` properties) and isn't counted toward
  `maxJunctions`.
- **`excludePrivateAccess` is all-or-nothing** — there's no way to exclude
  `access=private` on `track`s specifically while keeping it on
  `residential` roads, or vice versa; one flag applies the same filter
  across every drivable class in the request.

## Explicitly out of scope

- Hydraulic/engineering-grade pipe sizing (demand and fire-flow
  calculations) and slope/elevation-aware gravity sewer routing —
  `pipeSizeMm` (step 8) is an illustrative road-hierarchy lookup, not a
  calculated size.
- Per-leg "N-1" valve placement at intersections (a tee gets 2 valves, a
  cross gets 3) — see "Design standards" above for what a real
  implementation would need. Currently one junction marker represents "a
  junction belongs here," not the full isolation-design valve count.
- Air-release valves at high points — these need elevation data (a DEM) this
  tool doesn't fetch or use anywhere else; the lowest-priority gap of the
  ones considered so far, specifically because of that new data dependency.
- A self-hosted Overpass instance UI (there's no per-run endpoint override in
  the wizard yet, unlike the routing/Valhalla tools' `VITE_ROUTING_ENDPOINT`
  pattern — `fetchOsmRoads`'s `endpoint` option exists for this, just not
  wired to a Settings field yet).

Cost/quantity takeoff is **not** out of scope — see the Cost panel and
`@geolibre/utility-network`'s `estimateNetworkCost`, which price a
generated network's junctions/lines/services against an editable
per-utility-type unit-cost template.
