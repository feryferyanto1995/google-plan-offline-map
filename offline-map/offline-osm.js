/* OfflineOSM — the open-streetmap-mcp tool set, running in the browser with no network.
 *
 * The MCP server (github.com/jagan-shanmugam/open-streetmap-mcp) answers each tool by calling
 * Nominatim, Overpass and OSRM live. This module answers the same questions from packs built
 * ahead of time (build/build_pack.py) for the prototype's two map areas, central Tokyo and Kyoto:
 *
 *   MCP tool                  →  OfflineOSM method
 *   geocode_address           →  geocode(query)
 *   reverse_geocode           →  reverseGeocode(lat, lng)
 *   find_nearby_places        →  findNearbyPlaces(lat, lng, { radius, categories })
 *   search_category           →  searchCategory(category, bbox)
 *   get_route_directions      →  getRouteDirections(from, to, { mode: walk | bike | transit })
 *   suggest_meeting_point     →  suggestMeetingPoint(points, { category })
 *   explore_area              →  exploreArea(lat, lng, { radius })
 *   analyze_commute           →  analyzeCommute(home, work)
 *   location://map tiles      →  createMap(container) — bundled vector tiles, no tile server
 *
 * Coordinates in and out are { lat, lng } objects (or [lat, lng] arrays on input).
 * Route geometry is GeoJSON order: [lng, lat].
 * Data © OpenStreetMap contributors (ODbL). Map tiles © OpenMapTiles / OpenFreeMap.
 */
(function (root) {
  'use strict';

  const WALK_M_PER_MIN = 80;      // 4.8 km/h
  const BIKE_M_PER_MIN = 250;     // 15 km/h
  const BOARD_MIN = 4;            // average wait to board a train
  const TRANSFER_MIN = 5;         // extra cost of changing trains (platform walk, risk) so routes don't hop lines every stop
  const ACCESS_MAX_MIN = 18;      // furthest we'll walk to or from a station
  const TRANSFER_M = 350;         // stations this close (different names) count as a walking transfer
  const SHINKANSEN = { min: 135, km: 476, name: 'Tokaido Shinkansen (Nozomi)', colour: '#1A73E8',
    tokyo: { name: 'Tokyo Station', lat: 35.6812, lng: 139.7671 }, kyoto: { name: 'Kyoto Station', lat: 34.9858, lng: 135.7588 } };

  // ---------- small helpers ----------
  const R = Math.PI / 180;
  function hav(aLat, aLng, bLat, bLng) {
    const dLa = (bLat - aLat) * R, dLo = (bLng - aLng) * R;
    const h = Math.sin(dLa / 2) ** 2 + Math.cos(aLat * R) * Math.cos(bLat * R) * Math.sin(dLo / 2) ** 2;
    return 2 * 6371000 * Math.asin(Math.sqrt(h));
  }
  const pt = (p) => Array.isArray(p) ? { lat: +p[0], lng: +p[1] } : { lat: +p.lat, lng: +(p.lng ?? p.lon) };
  const round = (n, d = 0) => Math.round(n * 10 ** d) / 10 ** d;
  const fold = (s) => (s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').normalize('NFKC')
    .toLowerCase().replace(/[\s\-_,.'’·()/&]+/g, ' ').trim();
  const fmtDist = (m) => m < 950 ? `${Math.max(10, Math.round(m / 10) * 10)} m` : `${round(m / 1000, 1)} km`;
  async function gunzipB64(b64) {
    const bin = atob(b64); const u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    const s = new Blob([u]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Response(s).arrayBuffer();
  }

  // min-heap of (key, value) on parallel arrays
  class Heap {
    constructor() { this.k = []; this.v = []; }
    get size() { return this.k.length; }
    push(key, val) {
      const k = this.k, v = this.v; let i = k.length; k.push(key); v.push(val);
      while (i > 0) { const p = (i - 1) >> 1; if (k[p] <= key) break; k[i] = k[p]; v[i] = v[p]; i = p; }
      k[i] = key; v[i] = val;
    }
    pop() {
      const k = this.k, v = this.v, top = v[0], lastK = k.pop(), lastV = v.pop(), n = k.length;
      if (n) {
        let i = 0;
        for (;;) {
          let c = 2 * i + 1; if (c >= n) break;
          if (c + 1 < n && k[c + 1] < k[c]) c++;
          if (k[c] >= lastK) break;
          k[i] = k[c]; v[i] = v[c]; i = c;
        }
        k[i] = lastK; v[i] = lastV;
      }
      return top;
    }
    topKey() { return this.k[0]; }
  }

  // ---------- places pack ----------
  class Places {
    constructor(j) {
      this.area = j.area; this.bbox = j.bbox; this.cats = j.cats; this.subs = j.subs; this.attribution = j.attribution;
      const q = j.q, n = j.rows.length;
      this.rows = j.rows; this.lat = new Float64Array(n); this.lng = new Float64Array(n);
      this.keys = new Array(n);
      this.grid = new Map(); // 0.005° cells
      j.rows.forEach((r, i) => {
        this.lat[i] = r[4] / q; this.lng[i] = r[5] / q;
        const extra = this.cats[r[2]] === 'transit' ? ' station' : '';
        const k0 = fold(r[0]);
        this.keys[i] = [k0, fold(r[1]), r[0] && extra ? fold(r[0] + extra) : '', k0.includes(' ') ? k0.replace(/ /g, '') : ''];
        const c = this.cell(this.lat[i], this.lng[i]);
        (this.grid.get(c) || this.grid.set(c, []).get(c)).push(i);
      });
    }
    cell(lat, lng) { return Math.floor(lat / 0.005) * 100000 + Math.floor(lng / 0.005); }
    contains(lat, lng, m = 0) { const [s, w, n, e] = this.bbox; return lat >= s - m && lat <= n + m && lng >= w - m && lng <= e + m; }
    place(i, from) {
      const r = this.rows[i];
      const o = { id: `${this.area}:${i}`, name: r[0], local: r[1] || null, category: this.cats[r[2]], type: this.subs[r[3]],
        lat: this.lat[i], lng: this.lng[i], hours: r[6] || null, notable: !!r[7], famous: r[7] === 2, key: r[8] || null, area: this.area };
      if (from) o.distanceM = Math.round(hav(from.lat, from.lng, o.lat, o.lng));
      return o;
    }
    within(lat, lng, radius, fn) {
      const dLa = radius / 110540 + 0.005, dLo = radius / (111320 * Math.cos(lat * R)) + 0.005;
      for (let a = Math.floor((lat - dLa) / 0.005); a <= Math.floor((lat + dLa) / 0.005); a++)
        for (let b = Math.floor((lng - dLo) / 0.005); b <= Math.floor((lng + dLo) / 0.005); b++) {
          const ids = this.grid.get(a * 100000 + b); if (!ids) continue;
          for (const i of ids) { const d = hav(lat, lng, this.lat[i], this.lng[i]); if (d <= radius) fn(i, d); }
        }
    }
  }

  // ---------- network pack: walking graph + rail lines ----------
  class Network {
    static async load(j) {
      const net = new Network(); net.area = j.area; net.bbox = j.bbox;
      const buf = await gunzipB64(j.walk.bin), dv = new DataView(buf), q = j.q;
      const nV = dv.getUint32(0, true), nE = dv.getUint32(4, true), nG = dv.getUint32(8, true);
      let o = 12;
      net.vLat = new Float64Array(nV); net.vLng = new Float64Array(nV);
      for (let i = 0; i < nV; i++, o += 8) { net.vLat[i] = dv.getInt32(o, true) / q; net.vLng[i] = dv.getInt32(o + 4, true) / q; }
      net.eA = new Uint32Array(nE); net.eB = new Uint32Array(nE); net.eLen = new Float32Array(nE);
      net.eKind = new Uint8Array(nE); net.eName = new Uint16Array(nE); net.eGOff = new Uint32Array(nE); net.eGLen = new Uint16Array(nE);
      for (let i = 0; i < nE; i++, o += 24) {
        net.eA[i] = dv.getUint32(o, true); net.eB[i] = dv.getUint32(o + 4, true); net.eLen[i] = dv.getUint32(o + 8, true) / 10;
        net.eKind[i] = dv.getUint8(o + 12); net.eName[i] = dv.getUint16(o + 14, true);
        net.eGOff[i] = dv.getUint32(o + 16, true); net.eGLen[i] = dv.getUint16(o + 20, true);
      }
      net.gLat = new Float64Array(nG); net.gLng = new Float64Array(nG);
      for (let i = 0; i < nG; i++, o += 8) { net.gLat[i] = dv.getInt32(o, true) / q; net.gLng[i] = dv.getInt32(o + 4, true) / q; }
      net.names = j.walk.names;
      // CSR adjacency (undirected: pedestrians ignore one-way streets)
      const deg = new Uint32Array(nV + 1);
      for (let i = 0; i < nE; i++) { deg[net.eA[i] + 1]++; deg[net.eB[i] + 1]++; }
      for (let i = 0; i < nV; i++) deg[i + 1] += deg[i];
      net.adjOff = deg; net.adjE = new Uint32Array(nE * 2); const fill = deg.slice(0, nV);
      for (let i = 0; i < nE; i++) { net.adjE[fill[net.eA[i]]++] = i; net.adjE[fill[net.eB[i]]++] = i; }
      net.vGrid = new Map();
      for (let i = 0; i < nV; i++) { const c = Math.floor(net.vLat[i] / 0.002) * 1000000 + Math.floor(net.vLng[i] / 0.002); (net.vGrid.get(c) || net.vGrid.set(c, []).get(c)).push(i); }
      // transit
      const t = j.transit;
      net.stations = t.stations.map((s, i) => ({ id: i, name: s[0], local: s[1], lat: s[2] / q, lng: s[3] / q, rail: s[4] !== 0 }));
      net.lines = t.lines;
      for (const s of net.stations) s.v = net.snap(s.lat, s.lng)?.v ?? -1;
      net.stationsAtV = new Map(); net.stations.forEach((s) => { if (s.v >= 0) (net.stationsAtV.get(s.v) || net.stationsAtV.set(s.v, []).get(s.v)).push(s.id); });
      // transit graph: nodes 0..nS-1 are stations, then one "ride" node per (line, stop index)
      const nS = net.stations.length; let nR = nS; net.rideBase = [];
      for (const l of net.lines) { net.rideBase.push(nR); nR += l.stops.length; }
      net.nT = nR; net.rideLine = new Int32Array(nR).fill(-1); net.rideIdx = new Int32Array(nR);
      net.lines.forEach((l, li) => l.stops.forEach((_, k) => { net.rideLine[net.rideBase[li] + k] = li; net.rideIdx[net.rideBase[li] + k] = k; }));
      net.boardAt = Array.from({ length: nS }, () => []);
      net.lines.forEach((l, li) => l.stops.forEach((s, k) => { if (k < l.stops.length - 1) net.boardAt[s].push(net.rideBase[li] + k); }));
      net.hopMin = net.lines.map((l) => l.stops.slice(1).map((s, k) => {
        const a = net.stations[l.stops[k]], b = net.stations[s];
        return hav(a.lat, a.lng, b.lat, b.lng) * 1.05 / (l.kmh * 1000 / 60) + 0.5;
      }));
      net.transfers = Array.from({ length: nS }, () => []);
      for (let a = 0; a < nS; a++) for (let b = a + 1; b < nS; b++) {
        const d = hav(net.stations[a].lat, net.stations[a].lng, net.stations[b].lat, net.stations[b].lng);
        if (d < TRANSFER_M) { const m = d * 1.3 / WALK_M_PER_MIN + 2; net.transfers[a].push([b, m, d]); net.transfers[b].push([a, m, d]); }
      }
      return net;
    }
    contains(lat, lng, m = 0) { const [s, w, n, e] = this.bbox; return lat >= s - m && lat <= n + m && lng >= w - m && lng <= e + m; }
    snap(lat, lng) {
      let best = -1, bd = Infinity;
      for (let r = 0; r <= 3 && best < 0; r++) {
        const a0 = Math.floor(lat / 0.002), b0 = Math.floor(lng / 0.002);
        for (let a = a0 - r; a <= a0 + r; a++) for (let b = b0 - r; b <= b0 + r; b++) {
          const ids = this.vGrid.get(a * 1000000 + b); if (!ids) continue;
          for (const i of ids) { const d = hav(lat, lng, this.vLat[i], this.vLng[i]); if (d < bd) { bd = d; best = i; } }
        }
      }
      return best < 0 ? null : { v: best, m: bd };
    }
    edgeCost(e, mode) {
      const k = this.eKind[e], len = this.eLen[e];
      if (mode === 'bike') return len * (k === 1 ? 8 : k === 2 ? 1.6 : 1) / BIKE_M_PER_MIN;
      return len * (k === 1 ? 1.6 : 1) / WALK_M_PER_MIN;
    }
    // Dijkstra (A* when a target is given). Returns { dist, prevE } over vertices.
    search(src, { target = -1, mode = 'walk', maxMin = Infinity } = {}) {
      const nV = this.vLat.length, dist = new Float64Array(nV).fill(Infinity), prevE = new Int32Array(nV).fill(-1);
      const speed = mode === 'bike' ? BIKE_M_PER_MIN : WALK_M_PER_MIN;
      const h = target < 0 ? () => 0 : (v) => hav(this.vLat[v], this.vLng[v], this.vLat[target], this.vLng[target]) / speed;
      const heap = new Heap(); dist[src] = 0; heap.push(h(src), src);
      const done = new Uint8Array(nV);
      while (heap.size) {
        const u = heap.pop(); if (done[u]) continue; done[u] = 1;
        if (u === target) break;
        if (dist[u] > maxMin) break;
        for (let p = this.adjOff[u]; p < this.adjOff[u + 1]; p++) {
          const e = this.adjE[p], v = this.eA[e] === u ? this.eB[e] : this.eA[e];
          const nd = dist[u] + this.edgeCost(e, mode);
          if (nd < dist[v]) { dist[v] = nd; prevE[v] = e; heap.push(nd + h(v), v); }
        }
      }
      return { dist, prevE };
    }
    // vertex path → coords + per-street steps
    trace(prevE, src, dst, reverse = false) {
      const edges = []; let v = dst;
      while (v !== src) { const e = prevE[v]; if (e < 0) return null; edges.push([e, v]); v = this.eA[e] === v ? this.eB[e] : this.eA[e]; }
      edges.reverse(); // now src → dst
      const coords = [[this.vLng[src], this.vLat[src]]], runs = []; let metres = 0;
      for (const [e, to] of edges) {
        const fwd = this.eB[e] === to, n = this.eGLen[e], off = this.eGOff[e];
        for (let i = 0; i < n; i++) { const g = off + (fwd ? i : n - 1 - i); coords.push([this.gLng[g], this.gLat[g]]); }
        coords.push([this.vLng[to], this.vLat[to]]);
        const name = this.names[this.eName[e]] || '', kind = this.eKind[e];
        metres += this.eLen[e];
        const last = runs[runs.length - 1];
        if (last && last.name === name) last.m += this.eLen[e]; else runs.push({ name, m: this.eLen[e], steps: kind === 1 });
      }
      if (reverse) { coords.reverse(); runs.reverse(); }
      return { coords, metres, runs };
    }
  }

  const stopLabel = (s) => (s.rail ? `${s.name} Station` : `${s.name} bus stop`);

  function walkSteps(runs) {
    // fold slivers (< 40 m) into the previous run, then merge neighbours with the same street name
    const out = [];
    for (const r of runs) {
      const last = out[out.length - 1];
      if (last && (r.m < 40 || last.name === r.name)) { last.m += r.m; continue; }
      if (last && last.m < 40 && !last.name) { last.name = r.name; last.m += r.m; continue; }
      out.push({ ...r });
    }
    return out.filter((r) => r.m >= 5).map((r) => r.name ? `Walk ${fmtDist(r.m)} along ${r.name}` : `Walk ${fmtDist(r.m)}`);
  }

  // ---------- example reviews ----------
  // There is no free, bundleable source of real reviews, so the prototype shows EXAMPLE reviews: picked
  // deterministically from short pools by place type. Always present them labelled as examples.
  const SAMPLE_LABEL = 'Example reviews written for this prototype. Not real reviews.';
  const POOLS = {
    temple: ['Go early: by mid-morning the main hall gets crowded with tour groups.', 'Quiet corners behind the main buildings are worth the detour.', 'Lovely grounds. Take your shoes off where signs ask and keep voices low.', 'The incense and the old wooden halls make it feel worlds away from the city.', 'Pick up a goshuin stamp book here, the calligraphy is beautiful.', 'Come back at dusk if you can, the light on the roofs is special.'],
    museum: ['Allow at least two hours, the permanent collection is bigger than it looks.', 'English captions on most pieces, which made it easy to follow.', 'Rainy-day rescue. The café inside is a nice place to rest.', 'Check the temporary exhibitions before you go, they change often.', 'Lockers at the entrance, so you can leave bags and wander freely.'],
    historic: ['Good signage explaining the history, worth reading as you walk.', 'Smaller than I expected but very photogenic.', 'Combine it with the sights nearby, it is an easy walk between them.', 'Free to look around the outside, small fee for the inside.', 'Best in the morning light for photos.'],
    attraction: ['Touristy, but genuinely worth it once.', 'Queues move faster than they look. Buy tickets online if you can.', 'Great views on a clear day; check the weather first.', 'Spend an hour here, then explore the streets around it.', 'Busy at weekends, much calmer on a weekday afternoon.'],
    show: ['Booked a day ahead and got decent seats.', 'Even without the language, the staging carried the story.', 'Arrive early to find your seat and browse the shop.', 'A memorable evening. Earphone guides help a lot.'],
    family: ['Great with kids, plan for half a day.', 'Weekday mornings are much quieter.', 'Food inside is pricey, bring snacks.', 'Well signposted in English, easy to get around.'],
    park: ['Perfect for a break between sights. Lots of benches.', 'Beautiful in autumn colours; also lovely in cherry blossom season.', 'Grab a bento from a convenience store and picnic here.', 'Big enough to escape the crowds even on a weekend.', 'Toilets and vending machines near the entrances.'],
    shopping: ['Fun to wander even if you do not buy anything.', 'Most shops open around 10 or 11, go late morning.', 'Tax-free counters available, bring your passport.', 'Good for souvenirs and snacks to take home.', 'Gets very busy on weekends.'],
    noodles: ['Rich broth, springy noodles. The queue moves fast.', 'Order from the ticket machine at the door; there are pictures.', 'Counter seats only, perfect for solo travellers.', 'Worth the wait. Try it with the soft-boiled egg.', 'Small portions are big here, come hungry.'],
    sushi: ['Very fresh fish and friendly chefs at the counter.', 'Go for the set lunch, great value.', 'Book ahead for dinner, it fills up quickly.', 'The omakase was the highlight of our trip.', 'Not cheap, but you can taste why.'],
    japanese: ['Cosy spot with a picture menu, staff were patient with us.', 'Great place to try local dishes, order a few to share.', 'Lively in the evenings; expect a bit of smoke from the grill.', 'Excellent set meals at lunchtime.', 'Felt like eating where the locals eat.'],
    restaurant: ['Tasty food, quick service and fair prices.', 'Good choice if the famous places nearby have long queues.', 'English menu available on request.', 'Portions were generous, we shared two dishes between three.', 'Nice atmosphere for a relaxed dinner.'],
    quick: ['Fast, cheap and exactly what we needed between sights.', 'Order at the counter, food came in minutes.', 'Clean, reliable, open late.', 'Good for a quick breakfast before an early start.'],
    cafe: ['Nice place to rest your feet. Good coffee, quiet inside.', 'The seasonal sweets were lovely.', 'Small, so it can be hard to get a seat at weekends.', 'Great matcha and friendly staff.', 'Free Wi-Fi and plugs, handy for planning the next stop.'],
    bar: ['Tiny bar with a great atmosphere. Small cover charge.', 'Friendly bartender who recommended local drinks.', 'Happy hour is good value.', 'Fun night out, it gets crowded after nine.'],
    stay: ['Rooms are compact but spotless.', 'Great location, close to the station.', 'Helpful front desk that kept our bags after check-out.', 'Quiet at night despite being central.'],
  };
  const NAMES = ['Aiko', 'Tom', 'Priya', 'Leon', 'Mei', 'Josh', 'Kenji', 'Sara', 'Lucas', 'Hana', 'Omar', 'Elena', 'Yuto', 'Grace', 'Marco', 'Nina'];
  function hashStr(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
  function poolFor(p, info = {}) {
    const t = p.type || '', c = (info.cuisines || []).join(' ') + ' ' + t;
    if (p.category === 'sights') return /temple|shrine|worship/.test(t) ? 'temple' : /museum|gallery|arts/.test(t) ? 'museum' : /theatre|cinema/.test(t) ? 'show'
      : /zoo|aquarium|theme/.test(t) ? 'family' : /castle|monument|memorial|building|archaeolog/.test(t) ? 'historic' : 'attraction';
    if (p.category === 'parks') return 'park';
    if (p.category === 'shopping') return 'shopping';
    if (p.category === 'food') return /ramen|noodle|udon|soba/.test(c) ? 'noodles' : /sushi|seafood/.test(c) ? 'sushi'
      : /japanese|izakaya|yakitori|tempura|tonkatsu|kaiseki|okonomiyaki|yakiniku|donburi|tofu/.test(c) ? 'japanese' : /fast_food|burger|sandwich/.test(c) ? 'quick' : 'restaurant';
    if (p.category === 'cafe') return 'cafe';
    if (p.category === 'nightlife') return 'bar';
    if (p.category === 'stays') return 'stay';
    return null;
  }
  function sampleReviews(p, info) {
    const pool = POOLS[poolFor(p, info)]; if (!pool) return null;
    const h = hashStr(p.key || p.name), n = 2 + (h % 2), used = new Set(), reviews = [];
    for (let i = 0; reviews.length < n && i < 10; i++) {
      const j = (h >>> (i * 3)) % pool.length; if (used.has(j)) continue; used.add(j);
      reviews.push({ author: NAMES[(h >>> (i * 5 + 2)) % NAMES.length], stars: 4 + ((h >>> (i * 7)) % 3 === 0 ? 0 : 1), text: pool[j], monthsAgo: 1 + ((h >>> (i * 4)) % 11) });
    }
    const rating = Math.round((3.9 + ((h % 9) / 10)) * 10) / 10;
    return { example: true, label: SAMPLE_LABEL, rating, reviews };
  }

  // ---------- the public object ----------
  function create(opts = {}) {
    const dataUrl = (opts.dataUrl || 'data/').replace(/\/?$/, '/');
    const tilesUrl = (opts.tilesUrl || '../claude-prototype/data/').replace(/\/?$/, '/');
    const areas = opts.areas || ['tokyo', 'kyoto'];
    const cache = {};
    const ver = opts.dataVersion ? `?v=${opts.dataVersion}` : '';   // bump after rebuilding packs so browsers don't serve stale copies
    const getJSON = (u) => cache[u] || (cache[u] = fetch(u).then((r) => { if (!r.ok) throw new Error(`${u}: ${r.status}`); return r.json(); }));
    const places = {}, nets = {}, details = {};
    const loadPlaces = (a) => places[a] || (places[a] = getJSON(`${dataUrl}places-${a}.json${ver}`).then((j) => new Places(j)));
    const loadDetails = (a) => details[a] || (details[a] = getJSON(`${dataUrl}details-${a}.json${ver}`).catch(() => ({ places: {}, famous: [] })));
    const photosUrl = (opts.photosUrl ?? `${dataUrl}../`).replace(/\/?$/, '/').replace(/^\/$/, '');
    const loadNet = (a) => nets[a] || (nets[a] = getJSON(`${dataUrl}network-${a}.json${ver}`).then((j) => Network.load(j)));
    const allPlaces = () => Promise.all(areas.map(loadPlaces));

    async function areaFor(p, margin = 0.02) {
      const ps = await allPlaces(); const hit = ps.find((x) => x.contains(p.lat, p.lng, margin));
      return hit ? hit.area : null;
    }

    async function geocode(query, { near = null, limit = 8, categories = null } = {}) {
      const m = String(query).match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
      if (m) { const r = await reverseGeocode(+m[1], +m[2]); return r ? [r] : []; }
      const qf0 = fold(query); if (!qf0) return [];
      const qc = qf0.replace(/ /g, '');
      const toks = qf0.split(' '), nearP = near && pt(near);
      const hits = [];
      for (const P of await allPlaces()) {
        const catIdx = categories ? new Set(categories.map((c) => P.cats.indexOf(c))) : null;
        for (let i = 0; i < P.rows.length; i++) {
          if (catIdx && !catIdx.has(P.rows[i][2])) continue;
          let s = 0;
          for (let ki = 0; ki < 4; ki++) {
            const k = P.keys[i][ki]; if (!k) continue;
            const qf = ki === 3 ? qc : qf0;
            let v = 0;
            if (k === qf) v = 100; else if (k.startsWith(qf)) v = 80;
            else if ((' ' + k).includes(' ' + qf)) v = 65; else if (k.includes(qf)) v = 45;
            else if (toks.length > 1 && toks.every((t) => k.includes(t))) v = 35;
            if (v > s) s = v;
          }
          if (!s) continue;
          const r = P.rows[i], cat = P.cats[r[2]];
          s += r[7] === 2 ? 30 : r[7] ? 15 : 0;
          s += { sights: 8, transit: 8, area: 6, parks: 5, shopping: 2 }[cat] || 0;
          if (nearP) s -= Math.min(20, hav(nearP.lat, nearP.lng, P.lat[i], P.lng[i]) / 500);
          hits.push([s, P, i]);
        }
      }
      hits.sort((a, b) => b[0] - a[0]);
      // one result per name within ~400 m (a big station is several OSM nodes: JR, Metro, private lines)
      const kept = [];
      for (const h of hits) {
        const [, P, i] = h, nm = P.rows[i][0];
        if (kept.some(([, Q, j]) => Q === P && Q.rows[j][0] === nm && hav(Q.lat[j], Q.lng[j], P.lat[i], P.lng[i]) < 400)) continue;
        kept.push(h); if (kept.length >= limit) break;
      }
      return kept.map(([s, P, i]) => ({ ...P.place(i, nearP), score: round(s, 1) }));
    }

    async function reverseGeocode(lat, lng) {
      const p = pt([lat, lng]); const a = await areaFor(p, 0.05); if (!a) return null;
      const P = await loadPlaces(a);
      let poi = null, pd = 45, star = null, std = 120, hood = null, hd = 1500, quarter = null, qd = 2500, station = null, sd = 1500;
      P.within(p.lat, p.lng, 2500, (i, d) => {
        const r = P.rows[i], cat = P.cats[r[2]], sub = P.subs[r[3]];
        if (cat === 'area') { if (sub === 'neighbourhood' && d < hd) { hd = d; hood = i; } else if (sub !== 'neighbourhood' && d < qd) { qd = d; quarter = i; } }
        else if (cat === 'transit') { if (d < sd) { sd = d; station = i; } if (d < pd) { pd = d; poi = i; } }
        else { if (d < pd) { pd = d; poi = i; } if (r[7] && d < std) { std = d; star = i; } }
      });
      if (star !== null) poi = star;
      const nm = (i) => (i === null ? null : P.rows[i][0]);
      const parts = [nm(hood), nm(quarter) !== nm(hood) ? nm(quarter) : null, a === 'tokyo' ? 'Tokyo' : 'Kyoto'].filter(Boolean);
      return {
        name: poi !== null ? nm(poi) : parts[0] || (a === 'tokyo' ? 'Tokyo' : 'Kyoto'),
        label: (poi !== null ? [nm(poi), ...parts] : parts).join(', '),
        place: poi !== null ? P.place(poi, p) : null,
        neighbourhood: nm(hood), district: nm(quarter),
        nearestStation: station !== null ? P.place(station, p) : null,
        lat: p.lat, lng: p.lng, area: a, city: a === 'tokyo' ? 'Tokyo' : 'Kyoto',
      };
    }

    async function findNearbyPlaces(lat, lng, { radius = 1000, categories = null, limit = 50, notableFirst = false } = {}) {
      const p = pt([lat, lng]); const a = await areaFor(p, 0.03); if (!a) return { center: p, radius, places: [], counts: {} };
      const P = await loadPlaces(a); const want = categories && new Set(categories);
      const found = [];
      P.within(p.lat, p.lng, radius, (i, d) => { const c = P.cats[P.rows[i][2]]; if (c === 'area' || (want && !want.has(c))) return; found.push([d - (notableFirst && P.rows[i][7] ? 400 : 0), i]); });
      found.sort((x, y) => x[0] - y[0]);
      const counts = {}; for (const [, i] of found) { const c = P.cats[P.rows[i][2]]; counts[c] = (counts[c] || 0) + 1; }
      return { center: p, radius, total: found.length, counts, places: found.slice(0, limit).map(([, i]) => P.place(i, p)) };
    }

    async function searchCategory(category, bbox, { subcategories = null, limit = 200 } = {}) {
      const [s, w, n, e] = bbox; const want = subcategories && new Set(subcategories); const out = [];
      for (const P of await allPlaces()) {
        const ci = P.cats.indexOf(category);
        for (let i = 0; i < P.rows.length && out.length < limit; i++) {
          const r = P.rows[i];
          if (r[2] !== ci || P.lat[i] < s || P.lat[i] > n || P.lng[i] < w || P.lng[i] > e) continue;
          if (want && !want.has(P.subs[r[3]])) continue;
          out.push(P.place(i));
        }
      }
      return { category, bbox, count: out.length, places: out };
    }

    // --- routing ---
    async function routeWithin(a, f, t, mode, bus = true) {
      const net = await loadNet(a);
      const sf = net.snap(f.lat, f.lng), st = net.snap(t.lat, t.lng);
      if (!sf || !st) throw new Error('Point is outside the offline map area');
      if (mode === 'transit') return transitRoute(net, f, t, sf, st, bus);
      const { prevE, dist } = net.search(sf.v, { target: st.v, mode });
      const tr = net.trace(prevE, sf.v, st.v);
      const speed = mode === 'bike' ? BIKE_M_PER_MIN : WALK_M_PER_MIN;
      const metres = tr.metres + sf.m + st.m, minutes = dist[st.v] + (sf.m + st.m) / speed;
      const coords = [[f.lng, f.lat], ...tr.coords, [t.lng, t.lat]];
      const steps = mode === 'bike' ? [`Cycle ${fmtDist(metres)}`] : walkSteps(tr.runs);
      return { mode, durationMin: Math.max(1, Math.round(minutes)), distanceKm: round(metres / 1000, 2),
        legs: [{ type: mode, minutes: Math.max(1, Math.round(minutes)), distanceM: Math.round(metres), geometry: coords, steps }],
        geometry: coords, steps };
    }

    function transitRoute(net, f, t, sf, st, bus = true) {
      const walkOnly = (() => {
        const { prevE, dist } = net.search(sf.v, { target: st.v });
        const tr = net.trace(prevE, sf.v, st.v);
        return { min: dist[st.v] + (sf.m + st.m) / WALK_M_PER_MIN, tr };
      })();
      const acc = net.search(sf.v, { maxMin: ACCESS_MAX_MIN }), egr = net.search(st.v, { maxMin: ACCESS_MAX_MIN });
      const nS = net.stations.length, D = new Float64Array(net.nT).fill(Infinity), prev = new Int32Array(net.nT).fill(-1), how = new Int8Array(net.nT);
      const heap = new Heap();
      for (let s = 0; s < nS; s++) { const v = net.stations[s].v; if (v >= 0 && acc.dist[v] <= ACCESS_MAX_MIN) { D[s] = acc.dist[v] + sf.m / WALK_M_PER_MIN; how[s] = 0; heap.push(D[s], s); } }
      let best = Infinity, bestS = -1;
      const done = new Uint8Array(net.nT);
      while (heap.size) {
        const u = heap.pop(); if (done[u]) continue; done[u] = 1;
        if (D[u] >= best) break;
        if (u < nS) {
          const v = net.stations[u].v; const eg = v >= 0 ? egr.dist[v] : Infinity;
          if (how[u] !== 0 && eg <= ACCESS_MAX_MIN && D[u] + eg + st.m / WALK_M_PER_MIN < best) { best = D[u] + eg + st.m / WALK_M_PER_MIN; bestS = u; }
          for (const r of net.boardAt[u]) { if (!bus && net.lines[net.rideLine[r]].mode === 'bus') continue; const nd = D[u] + (net.lines[net.rideLine[r]].wait || BOARD_MIN) + (how[u] === 0 ? 0 : TRANSFER_MIN); if (nd < D[r]) { D[r] = nd; prev[r] = u; how[r] = 1; heap.push(nd, r); } }
          if (how[u] === 2) for (const [b, m] of net.transfers[u]) { const nd = D[u] + m; if (nd < D[b]) { D[b] = nd; prev[b] = u; how[b] = 3; heap.push(nd, b); } }
        } else {
          const li = net.rideLine[u], k = net.rideIdx[u], l = net.lines[li];
          if (k + 1 < l.stops.length) { const nx = u + 1, nd = D[u] + net.hopMin[li][k]; if (nd < D[nx]) { D[nx] = nd; prev[nx] = u; how[nx] = 4; heap.push(nd, nx); } }
          if (k > 0) { const s = l.stops[k]; if (D[u] < D[s]) { D[s] = D[u]; prev[s] = u; how[s] = 2; heap.push(D[u], s); } }
        }
      }
      if (bestS < 0 || best >= walkOnly.min - 2) {
        const coords = [[f.lng, f.lat], ...walkOnly.tr.coords, [t.lng, t.lat]], metres = walkOnly.tr.metres + sf.m + st.m;
        const steps = walkSteps(walkOnly.tr.runs), minutes = Math.max(1, Math.round(walkOnly.min));
        return { mode: 'walk', requestedMode: 'transit', note: 'Walking is as fast as any train here', durationMin: minutes, distanceKm: round(metres / 1000, 2),
          legs: [{ type: 'walk', minutes, distanceM: Math.round(metres), geometry: coords, steps }], geometry: coords, steps };
      }
      // unwind the chain of transit nodes
      const chain = []; for (let u = bestS; u >= 0; u = prev[u]) chain.push(u); chain.reverse();
      const legs = []; const S = (i) => net.stations[i];
      const first = chain[0], last = chain[chain.length - 1];
      const aTr = net.trace(acc.prevE, sf.v, S(first).v);
      legs.push(walkLeg(aTr, [f.lng, f.lat], [S(first).lng, S(first).lat], sf.m, `Walk to ${stopLabel(S(first))}`));
      for (let i = 0; i < chain.length; i++) {
        const u = chain[i];
        if (u >= nS && how[u] === 1) { // boarding: collect consecutive ride nodes
          let j = i; while (j + 1 < chain.length && chain[j + 1] >= nS) j++;
          const li = net.rideLine[u], l = net.lines[li], k0 = net.rideIdx[u], k1 = net.rideIdx[chain[j]];
          const ids = l.stops.slice(k0, k1 + 1), mins = net.hopMin[li].slice(k0, k1).reduce((x, y) => x + y, 0);
          const from = S(ids[0]), to = S(ids[ids.length - 1]), toward = S(l.stops[l.stops.length - 1]), bus = l.mode === 'bus';
          let km = 0; for (let x = 1; x < ids.length; x++) km += hav(S(ids[x - 1]).lat, S(ids[x - 1]).lng, S(ids[x]).lat, S(ids[x]).lng) / 1000;
          const ref = l.ref && l.ref.length <= 4 ? l.ref : null;
          legs.push({ type: 'ride', line: l.name, ref, colour: l.colour || null, vehicle: l.mode, from: from.name, to: to.name,
            toward: toward.name, stops: ids.length - 1, waitMin: l.wait || BOARD_MIN, minutes: Math.round(mins), distanceM: Math.round(km * 1000),
            stations: ids.map((x) => ({ name: S(x).name, local: S(x).local, lat: S(x).lat, lng: S(x).lng, rail: S(x).rail })),
            geometry: ids.map((x) => [S(x).lng, S(x).lat]),
            steps: [bus ? `Take ${l.name} toward ${toward.name}` : `Take the ${l.name}${ref ? ` (${ref})` : ''} toward ${toward.name}`, `Ride ${ids.length - 1} stop${ids.length > 2 ? 's' : ''} to ${to.name}`] });
          i = j;
        } else if (u < nS && how[u] === 3) {
          const a = S(prev[u]), b = S(u), d = hav(a.lat, a.lng, b.lat, b.lng);
          legs.push({ type: 'walk', minutes: Math.round(d * 1.3 / WALK_M_PER_MIN + 2), distanceM: Math.round(d * 1.3), transfer: true,
            geometry: [[a.lng, a.lat], [b.lng, b.lat]], steps: [`Transfer: walk to ${stopLabel(b)}`] });
        }
      }
      const eTr = net.trace(egr.prevE, st.v, S(last).v, true);
      legs.push(walkLeg(eTr, [S(last).lng, S(last).lat], [t.lng, t.lat], st.m, 'Walk to your destination'));
      const geometry = legs.flatMap((l) => l.geometry);
      const distanceKm = round(legs.reduce((x, l) => x + l.distanceM, 0) / 1000, 2);
      return { mode: 'transit', durationMin: Math.round(best), distanceKm, walkOnlyMin: Math.round(walkOnly.min), legs, geometry,
        steps: legs.flatMap((l) => l.steps), transfers: legs.filter((l) => l.type === 'ride').length - 1 };
    }
    function walkLeg(tr, start, end, extraM, label) {
      const coords = [start, ...(tr ? tr.coords : []), end];
      const m = (tr ? tr.metres : hav(start[1], start[0], end[1], end[0])) + extraM;
      return { type: 'walk', minutes: Math.max(1, Math.round(m / WALK_M_PER_MIN)), distanceM: Math.round(m), geometry: coords,
        steps: [`${label} (${fmtDist(m)})`] };
    }

    async function getRouteDirections(from, to, { mode = 'transit', bus = true } = {}) {
      const f = pt(from), t = pt(to);
      if (mode === 'car' || mode === 'drive') mode = 'transit';
      const [af, at] = [await areaFor(f, 0.01), await areaFor(t, 0.01)];
      if (!af || !at) throw new Error('Start or end is outside the offline map (central Tokyo and Kyoto only)');
      if (af === at) return { from: f, to: t, area: af, ...(await routeWithin(af, f, t, mode, bus)) };
      // Tokyo ⇄ Kyoto: local leg, Shinkansen, local leg
      const A = SHINKANSEN[af], B = SHINKANSEN[at];
      const lm = mode === 'bike' ? 'transit' : mode;
      const r1 = await routeWithin(af, f, A, lm, bus), r2 = await routeWithin(at, B, t, lm, bus);
      const ride = { type: 'ride', line: SHINKANSEN.name, colour: SHINKANSEN.colour, vehicle: 'shinkansen', from: A.name, to: B.name, toward: B.name.replace(' Station', ''),
        stops: 1, waitMin: 10, minutes: SHINKANSEN.min, distanceM: SHINKANSEN.km * 1000, geometry: [[A.lng, A.lat], [B.lng, B.lat]],
        stations: [A, B], steps: [`Take the ${SHINKANSEN.name} from ${A.name} to ${B.name} (${SHINKANSEN.min} min)`] };
      const legs = [...r1.legs, ride, ...r2.legs];
      return { from: f, to: t, area: `${af}→${at}`, mode: 'intercity', durationMin: r1.durationMin + 10 + SHINKANSEN.min + r2.durationMin,
        distanceKm: round(r1.distanceKm + SHINKANSEN.km + r2.distanceKm, 1), legs, geometry: legs.flatMap((l) => l.geometry), steps: legs.flatMap((l) => l.steps) };
    }

    async function analyzeCommute(home, work) {
      const out = {};
      for (const mode of ['walk', 'bike', 'transit']) {
        try { const r = await getRouteDirections(home, work, { mode }); out[mode] = { durationMin: r.durationMin, distanceKm: r.distanceKm, mode: r.mode, steps: r.steps }; }
        catch (e) { out[mode] = { error: e.message }; }
      }
      const fastest = Object.entries(out).filter(([, v]) => v.durationMin).sort((a, b) => a[1].durationMin - b[1].durationMin)[0];
      return { home: pt(home), work: pt(work), options: out, recommended: fastest ? fastest[0] : null };
    }

    async function exploreArea(lat, lng, { radius = 800 } = {}) {
      const p = pt([lat, lng]); const where = await reverseGeocode(p.lat, p.lng);
      const near = await findNearbyPlaces(p.lat, p.lng, { radius, limit: 100000 });
      const highlights = {};
      for (const pl of near.places) { const h = highlights[pl.category] || (highlights[pl.category] = []); if (h.length < 5 && (pl.notable || h.length < 3)) h.push(pl); }
      for (const c in highlights) highlights[c].sort((a, b) => b.notable - a.notable || a.distanceM - b.distanceM);
      return { center: p, radius, location: where, total: near.total, counts: near.counts, highlights };
    }

    async function suggestMeetingPoint(points, { category = 'cafe', limit = 3, mode = 'transit' } = {}) {
      const ps = points.map(pt);
      const c = { lat: ps.reduce((x, p) => x + p.lat, 0) / ps.length, lng: ps.reduce((x, p) => x + p.lng, 0) / ps.length };
      let cand = [];
      for (const r of [600, 1200, 2500]) { cand = (await findNearbyPlaces(c.lat, c.lng, { radius: r, categories: [category], limit: 40, notableFirst: true })).places; if (cand.length >= 6) break; }
      cand = cand.slice(0, 10);
      const scored = [];
      for (const pl of cand) {
        try {
          const times = []; for (const p of ps) times.push((await getRouteDirections(p, pl, { mode })).durationMin);
          scored.push({ place: pl, travelMin: times, maxMin: Math.max(...times), totalMin: times.reduce((x, y) => x + y, 0) });
        } catch { /* outside area */ }
      }
      scored.sort((a, b) => a.maxMin - b.maxMin || a.totalMin - b.totalMin);
      return { centroid: c, category, suggestions: scored.slice(0, limit) };
    }

    // --- place details: photo, description, traveller tips, food & access info, example reviews ---
    async function getPlaceDetails(place) {
      const D = await loadDetails(place.area), d = (place.key && D.places[place.key]) || {};
      const out = { key: place.key, description: d.description || null, wikipedia: d.wikipedia ? `https://en.wikipedia.org/wiki/${encodeURIComponent(d.wikipedia.replace(/ /g, '_'))}` : null,
        photo: d.photo ? { ...d.photo, url: photosUrl + d.photo.file } : null, tips: (d.tips || []).map((x) => ({ ...x, source: `Wikivoyage: ${x.page}` })),
        gallery: (d.gallery || []).map((g) => ({ ...g, url: photosUrl + g.file })),
        views: d.views ? { total: d.views.total, en: d.views.en, ja: d.views.ja, period: d.views.period, source: 'Wikipedia page views (English + Japanese)' } : null,
        info: d.info || {}, sampleReviews: sampleReviews(place, d.info) };
      return out;
    }
    async function famousPlaces({ area = null, limit = 20 } = {}) {
      const out = [];
      for (const P of await allPlaces()) {
        if (area && P.area !== area) continue;
        const D = await loadDetails(P.area), idx = new Map(); P.rows.forEach((r, i) => { if (r[7] === 2) idx.set(r[8], i); });
        D.famous.forEach((k, rank) => { const i = idx.get(k); if (i === undefined) return; const pl = P.place(i); pl.photo = photosUrl + D.places[k].photo.file; pl.fame = rank; pl.views = D.places[k].views ? D.places[k].views.total : null; pl.photoCount = 1 + (D.places[k].gallery || []).length; out.push(pl); });
      }
      return out.sort((a, b) => a.fame - b.fame).slice(0, limit);
    }

    // --- map (bundled vector tiles through a custom protocol) ---
    let protocolOn = false;
    const tilePacks = {};
    const loadTiles = (name) => tilePacks[name] || (tilePacks[name] = getJSON(`${tilesUrl}${name}.json`));
    const b64u8 = (s) => { const bin = atob(s); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; };
    function registerProtocol(maplibregl) {
      if (protocolOn) return; protocolOn = true;
      maplibregl.addProtocol('offline', async (params) => {
        const [kind, ...rest] = params.url.replace('offline://', '').split('/');
        if (kind === 't') {
          const [z, x, y] = rest.map(Number); const lon = (x + 0.5) / 2 ** z * 360 - 180;
          const pack = z <= 9 ? 'tiles-overview' : lon > 137.5 ? 'tiles-tokyo' : 'tiles-kyoto';
          const d = (await loadTiles(pack))[`${z}/${x}/${y}`];
          if (!d) throw new Error('Tile outside the bundled area'); // MapLibre overzooms the parent
          return { data: await gunzipB64(d) };
        }
        if (kind === 'r') { const d = (await loadTiles('relief'))[rest.join('/')]; if (!d) throw new Error('none'); return { data: b64u8(d).buffer }; }
        if (kind === 'g') { const g = await loadTiles('glyphs'); const k = `${decodeURIComponent(rest[0])}/${rest[1]}`; return { data: g[k] ? b64u8(g[k]).buffer : new ArrayBuffer(0) }; }
        if (kind === 's') {
          const sp = await loadTiles('sprite'); const v = sp[rest.join('/').replace('ofm', '')]; if (!v) throw new Error('sprite');
          if (params.type === 'json') return { data: JSON.parse(new TextDecoder().decode(b64u8(v))) };
          return { data: b64u8(v).buffer };
        }
        throw new Error('unknown offline resource');
      });
    }
    // styleUrl: any style.json that uses the bundled local:// sources — e.g. data/style-streets.json
    // (Mapbox Streets look) or the prototype's own ${tilesUrl}style.json (the default)
    async function createMap(container, { styleUrl = opts.styleUrl || `${tilesUrl}style.json`, ...mapOpts } = {}) {
      const maplibregl = opts.maplibregl || root.maplibregl;
      if (!maplibregl) throw new Error('Load maplibre-gl.js first');
      registerProtocol(maplibregl);
      const style = JSON.parse(JSON.stringify(await getJSON(styleUrl)).replace(/local:\/\//g, 'offline://'));
      const map = new maplibregl.Map({ container, style, center: [139.765, 35.684], zoom: 12.5, maxZoom: 18, minZoom: 4,
        attributionControl: { compact: false }, ...mapOpts });
      map.on('error', (e) => { if (/outside the bundled|none/.test(String(e?.error?.message))) return; console.warn(e?.error || e); });
      return map;
    }

    return {
      areas, ready: () => Promise.all(areas.map(loadPlaces)), loadNetwork: (a) => loadNet(a), areaFor,
      geocode, reverseGeocode, findNearbyPlaces, searchCategory, getRouteDirections, analyzeCommute, exploreArea, suggestMeetingPoint,
      getPlaceDetails, famousPlaces, sampleReviews: (p) => sampleReviews(p),
      createMap, coverage: async () => (await allPlaces()).map((P) => ({ area: P.area, bbox: P.bbox, places: P.rows.length })),
      categories: ['food', 'cafe', 'nightlife', 'sights', 'shopping', 'parks', 'stays', 'transit', 'health', 'services'],
      attribution: '© OpenStreetMap contributors · © OpenMapTiles · OpenFreeMap',
    };
  }

  const api = { create, version: '1.0.0' };
  if (typeof module === 'object' && module.exports) module.exports = api; else root.OfflineOSM = api;
})(typeof self !== 'undefined' ? self : this);
