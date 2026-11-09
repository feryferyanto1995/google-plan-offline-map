# Offline map for Google Plan

This folder holds `offline-osm.js`, a drop-in module, plus a demo page. It answers the same questions as the [open-streetmap-mcp](https://github.com/jagan-shanmugam/open-streetmap-mcp) server, entirely in the browser with no network. It covers the prototype's two map areas: central Tokyo (Shinjuku to Oshiage, Ikebukuro edge to Shinagawa) and central Kyoto (Arashiyama edge to Ginkaku-ji, Kyoto Station to Kitaōji).

## Run the demo
```bash
python3 -m http.server 8765 --directory "/Users/feryanto/Documents/Claude Code/google-plan-v2"
```
Then open http://127.0.0.1:8765/offline-map/. You can switch off Wi-Fi first: nothing on the page loads from the internet.

## What the repo does, and why it can't run offline as is
The MCP server is a thin Python wrapper with no data of its own. Each tool makes a live HTTP call:

| MCP tool | Live service it calls | Offline replacement here |
|---|---|---|
| `geocode_address` | Nominatim search | `geocode(q)`: fuzzy search over about 44k bundled OSM names (English, Japanese, romaji) |
| `reverse_geocode` | Nominatim reverse | `reverseGeocode(lat, lng)`: nearest place, neighbourhood, district and station |
| `find_nearby_places` | Overpass | `findNearbyPlaces(lat, lng, {radius, categories})`: grid index, haversine |
| `search_category` | Overpass | `searchCategory(cat, [s, w, n, e])` |
| `get_route_directions` | OSRM demo server (car, bike or foot) | `getRouteDirections(a, b, {mode})`: on-device A* over the OSM street graph, plus a rail router (see below) |
| `suggest_meeting_point` | Centroid, then Overpass | `suggestMeetingPoint(points, {category})`: also compares real trip times and picks the fairest |
| `explore_area`, `analyze_neighborhood` | Overpass | `exploreArea(lat, lng)`: counts by category and highlights |
| `analyze_commute` | OSRM × 3 | `analyzeCommute(home, work)`: walk, bike and transit compared |
| `location://map/{z}/{x}/{y}` | tile.openstreetmap.org (raster) | `createMap(el)`: the prototype's bundled vector tiles through an `offline://` protocol |

Not ported: the EV-charging, parking and schools tools. They aren't useful for a trip planner, and Japan's OSM coverage for them is thin.

Two notes on the repo itself:
- Its OSRM URL is `http://` and points at the public demo server, which has no SLA. Its "transit" mode doesn't exist in OSRM, so it can't do trains at all. That gap is why the prototype's seed legs were estimates.
- Overpass and Nominatim rate-limit hard (we were reset several times while building these packs). That's another reason the prototype shouldn't call them live.

## Using it in the prototype
```html
<script src="vendor/maplibre-gl.js"></script>   <!-- or the prototype's own copy -->
<script src="offline-osm.js"></script>
<script>
  const osm = OfflineOSM.create({ dataUrl: 'offline-map/data/', tilesUrl: 'data/' });
  const map = await osm.createMap('map', { center: [139.76, 35.68], zoom: 12 });   // optional: or keep your own map
  const hits = await osm.geocode('Kinkaku-ji');                                      // [{ name, local, category, type, lat, lng, … }]
  const r = await osm.getRouteDirections(hotel, hits[0], { mode: 'transit' });      // { durationMin, distanceKm, legs[], geometry, steps[] }
</script>
```
- **Tiles.** If the page already registers the `local://` protocol (claude-prototype does), skip `createMap`. Use only the data methods; they don't touch the map.
- **Where it plugs in.** In `../google-plan-redesign/app.js`, `osm.nearby()` → `findNearbyPlaces`, `osm.byCategory()` → `searchCategory`, and `travel(a, b)` → `getRouteDirections(a, b).durationMin`. In `claude-prototype/app.js`, `getLeg()` can call `getRouteDirections` instead of reading the precomputed `seed.legs`.
- **Coordinates.** Inputs take `{lat, lng}`, `{lat, lon}` or `[lat, lng]`. Route `geometry` comes back as GeoJSON `[lng, lat]`, ready for a `line` layer.
- **Tokyo ⇄ Kyoto.** These trips come back as `mode: 'intercity'`: a local leg to Tokyo Station, the Shinkansen (135 min, same figure as the seed), then a local leg.

## How routing works
- **Walk and bike.** The OSM footway and street network (trunk roads down to steps) is packed as a binary graph: about 147k junctions in Tokyo and 80k in Kyoto. Routing is A*, typically 5–120 ms in the browser. Steps cost 1.6× when walking and 8× when cycling.
- **Transit.** OSM rail route relations (JR, Tokyo Metro, Toei, Keihan, Hankyu, Kyoto subway, Randen, Eizan…) are turned into stop-to-stop line patterns. Shinkansen is excluded inside a city. A multimodal Dijkstra runs walk → board (4 min wait for rail, 7 for bus) → ride → transfer (+5 min) → walk. Ride speeds are per mode: subway 33 km/h, train 40, tram 15, including stops. If walking is about as fast, the router says so and returns the walk.
- **Buses (Kyoto only).** Kyoto's sights are mostly bus-served, so its pack also has about 280 City Bus, Kyoto Bus, Keihan Bus and JR Bus route variants (about 840 stops), from OSM route relations. Buses assume a 7 min wait and 14 km/h including stops. Long-distance coaches are left out. Pass `{ bus: false }` to `getRouteDirections` for rail only. Tokyo is rail only: its rail network is dense enough, and its buses would roughly double the pack.
- **Limits.** The router has no timetables, fares or service frequency. Times are honest estimates, so label them as such in the UI ("about 18 min"). Ride geometry is drawn station to station, not along the track.

## Rebuilding the packs
```bash
python3 build/fetch_osm.py /path/to/raw     # downloads from Overpass (~25 requests, ~15 min; set BUS_AREAS for buses)
python3 build/build_pack.py /path/to/raw data
node build/smoke_test.mjs                    # geocode / nearby / routes sanity check
```
To change the coverage, edit `AREAS` in both scripts. Keep each area inside the vector-tile packs' z14 coverage, or the map will show streets you can't route on. The tile packs themselves come from `../claude-prototype/data/` (`tiles-*.json`, `style.json`, `glyphs.json`, `sprite.json`, `relief.json`).

## Place details: photos, descriptions, tips, food info, reviews
`getPlaceDetails(place)` returns everything known about a place, offline. `famousPlaces({ area, limit })` lists the top attractions, each with a photo.

| Field | Source | Coverage |
|---|---|---|
| `photo` (url, author, licence, source link) | Wikimedia Commons via Wikidata | 114 most famous attractions (ranked by how many Wikipedia editions cover them), 500 px JPEGs in `photos/` (7.8 MB) |
| `description` | English Wikipedia intro (CC BY-SA) | the same attractions |
| `tips` (text, price, hours) | Wikivoyage see / do / eat / drink / buy listings (CC BY-SA) | about 350 places. 71 restaurants and bars from Wikivoyage that OSM lacks are added to the map |
| `info` (cuisines, vegetarian, vegan, takeaway, outdoor seating, cards, Wi-Fi, wheelchair, smoking, fee, phone, website, chain) | OpenStreetMap tags | about 21,000 places, most of them food |
| `sampleReviews` | **Generated examples, not real.** Picked from short pools by place type (temple, museum, ramen, sushi, café…) | any sight, park, shop, food, café, bar or hotel |

**Reviews are examples.** There's no free source of real reviews that can be bundled offline: OSM has none, and Google or Tripadvisor reviews can't be copied. Every `sampleReviews` object carries `example: true` and a `label`. Show the label wherever the reviews appear, as the demo does. Swap in a real review source before this goes beyond a prototype.

**Credits.** Show each photo's author and licence with the image; the demo does this in the caption. Credit Wikipedia and Wikivoyage text where it's shown.

**Clicking the map.** In the demo, clicking a place's icon or label opens its card. The map's POIs come from the same OSM data and are matched to the places pack by name. Clicking empty map does nothing; no pin is dropped. In Directions and Meet up, a click still sets a point.

To refresh: `python3 build/fetch_extras.py <raw> photos`, then `build_pack.py`. Wikimedia rate-limits hard, so the fetcher batches its requests (one SPARQL query per city, 50 files per Commons call) and backs off on HTTP 429. Bump `dataVersion` in `OfflineOSM.create()` after rebuilding, so browsers don't serve stale packs.

## Map style
The demo uses `data/style-streets.json`: the bundled OpenMapTiles style recoloured to look like Mapbox Streets v12. It has warm-grey land, a white street grid with grey casings, orange motorways, yellow trunk roads, green parks, plain land until buildings fade in at z15, and POI labels coloured by category. It reuses the same offline tiles, fonts and icons, so there's no Mapbox token and no Mapbox data. Only the colours are matched by eye from the public Streets style. The icons stay the bundled OSM ones, so they're grey glyphs rather than Mapbox's coloured circles.

- Pick a style with `OfflineOSM.create({ styleUrl: 'offline-map/data/style-streets.json' })`, or per map with `createMap(el, { styleUrl })`. Without one you get the prototype's original style.
- Regenerate it with `python3 build/make_streets_style.py` after changing the palette at the top of that file.
- The browser caches styles, so bump the `?v=` on the style URL after regenerating.

## Pack sizes
Places: Tokyo 2.4 MB, Kyoto 1.0 MB. Details: Tokyo 1.4 MB, Kyoto 0.4 MB. Photos: 7.8 MB, loaded only when shown. Network: Tokyo 2.9 MB, Kyoto 1.7 MB (with buses). Each loads lazily, the first time that city is used. The tile packs (about 30 MB) are shared with claude-prototype.

## Files
- `offline-osm.js`: the module (no dependencies; MapLibre is only needed for `createMap`)
- `data/places-{tokyo,kyoto}.json`: POIs, stations and neighbourhoods, compact rows with stable OSM keys
- `data/details-{tokyo,kyoto}.json`: photos, descriptions, Wikivoyage tips, food and access info, keyed by OSM id
- `photos/`: Wikimedia Commons photos of famous attractions, each credited in the details pack
- `data/network-{tokyo,kyoto}.json`: walking graph (gzip+base64 binary) and rail lines
- `index.html`, `demo.css`, `demo.js`: demo (Google Maps desktop design system tokens)
- `vendor/`: MapLibre GL 4.7.1, so the demo has no CDN dependency
- `assets/fonts/`: Google Sans (OFL), copied from the design-system folder

Data © OpenStreetMap contributors (ODbL). Tiles © OpenMapTiles and OpenFreeMap. If any of this ships beyond a prototype, keep the attribution visible on the map; MapLibre's attribution control does this already.
