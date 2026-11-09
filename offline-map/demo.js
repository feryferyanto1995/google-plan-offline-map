/* Offline map demo: every panel calls the OfflineOSM API, the same calls the prototype will make. */
const P = { // stroke icons, same set and style as ../claude-prototype/app.js (stroke 1.8, round caps); a few added to match
  search: '<circle cx="11" cy="11" r="6"/><path d="m16 16 4 4"/>', close: '<path d="m6 6 12 12M18 6 6 18"/>', back: '<path d="m15 18-6-6 6-6"/>',
  nearby: '<circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>',
  directions: '<path d="m12 2.5 9.5 9.5-9.5 9.5L2.5 12Z"/><path d="M9 14v-2.5a1.5 1.5 0 0 1 1.5-1.5H15M13 8l2 2-2 2"/>',
  groups: '<circle cx="9" cy="8" r="3"/><path d="M3 19a6 6 0 0 1 12 0M16 5.5a3 3 0 0 1 0 5.5M18 14a5 5 0 0 1 3 5"/>',
  walk: '<circle cx="13" cy="4" r="2"/><path d="m10 21 2-7-3-3 2-4 4 3 3 1M12 14l4 7M9 11l-4 5"/>',
  transit: '<rect x="6" y="3" width="12" height="17" rx="3"/><path d="M8 7h8M8 14h8M9 20l-2 2M15 20l2 2"/><circle cx="9" cy="17" r=".8"/><circle cx="15" cy="17" r=".8"/>',
  bus: '<rect x="5" y="3" width="14" height="15" rx="3"/><path d="M5 11h14M5 7h14M8 21v-3M16 21v-3"/><circle cx="8.5" cy="14.5" r=".8"/><circle cx="15.5" cy="14.5" r=".8"/>',
  bike: '<circle cx="6" cy="16" r="4"/><circle cx="18" cy="16" r="4"/><path d="M6 16 9.5 9h6L18 16M12 16l-2.5-7M14 6h2.5"/>',
  pin: '<path d="M20 10c0 5-8 11-8 11S4 15 4 10a8 8 0 1 1 16 0Z"/><circle cx="12" cy="10" r="2.5"/>',
  swap: '<path d="M8 4v16M4 8l4-4 4 4M16 20V4M12 16l4 4 4-4"/>', plus: '<path d="M12 5v14M5 12h14"/>',
  bed: '<path d="M3 18V7M3 14h18v4M21 14v-2a3 3 0 0 0-3-3h-7v5"/><circle cx="7" cy="11" r="2"/>',
  restaurant: '<path d="M7 3v8a2 2 0 0 0 2 2v8M5 3v5M9 3v5M17 3c-2 2-2 6 0 8v10"/>',
  cafe: '<path d="M4 9h12v5a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5Z"/><path d="M16 10h2a2 2 0 0 1 0 4h-2M7 3v3M11 3v3"/>',
  museum: '<path d="m3 9 9-5 9 5M5 9v9M9.5 9v9M14.5 9v9M19 9v9M3 20h18"/>', bag: '<path d="M5 8h14l-1 12H6Z"/><path d="M9 8V6a3 3 0 0 1 6 0v2"/>',
  train: '<rect x="6" y="3" width="12" height="15" rx="3"/><path d="M6 11h12M9 21l1.5-3M15 21l-1.5-3"/><circle cx="9" cy="14.5" r=".8"/><circle cx="15" cy="14.5" r=".8"/>',
  tree: '<path d="M12 21v-5M12 3 6 12h3l-3 4h12l-3-4h3Z"/>', clock: '<circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/>',
  glass: '<path d="M6 4h12l-6 8Z M12 12v8M8 20h8"/>', health: '<rect x="4" y="4" width="16" height="16" rx="4"/><path d="M12 8v8M8 12h8"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/>', star: '<path d="m12 3 2.7 5.5 6 .9-4.35 4.2 1 6-5.35-2.8-5.35 2.8 1-6L3.3 9.4l6-.9Z"/>',
};
const ic = (n, cls = '') => `<svg class="icon ${cls}" viewBox="0 0 24 24" aria-hidden="true">${P[n] || ''}</svg>`;
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const dist = (m) => (m < 950 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`);
const dur = (m) => (m >= 60 ? `${Math.floor(m / 60)} hr${m % 60 ? ` ${m % 60} min` : ''}` : `${m} min`);
const debounce = (fn, ms = 160) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

// category look: colours from the prototype's seed categories; stays/transit/health/services use system hues
const CAT = {
  food: { label: 'Food', icon: 'restaurant', color: '#FE8022' }, cafe: { label: 'Cafés', icon: 'cafe', color: '#FE8022' },
  sights: { label: 'Sights', icon: 'museum', color: '#74909E' }, shopping: { label: 'Shopping', icon: 'bag', color: '#0096FE' },
  parks: { label: 'Parks', icon: 'tree', color: '#34A853' }, nightlife: { label: 'Nightlife', icon: 'glass', color: '#804084' },
  stays: { label: 'Stays', icon: 'bed', color: '#A142F4' }, transit: { label: 'Stations', icon: 'train', color: '#1A73E8' },
  health: { label: 'Health', icon: 'health', color: '#EA4335' }, services: { label: 'Services', icon: 'info', color: '#5F6368' },
  area: { label: 'Area', icon: 'pin', color: '#5F6368' },
};
const AREAS = { tokyo: { center: [139.757, 35.684], zoom: 12.6 }, kyoto: { center: [135.7681, 35.0036], zoom: 12.8 } };

const osm = OfflineOSM.create({ dataUrl: 'data/', tilesUrl: '../claude-prototype/data/', styleUrl: 'data/style-streets.json?v=6', dataVersion: 6 });
const S = { tab: 'search', places: [], active: null, dir: { from: null, to: null, mode: 'transit', focus: 'from', route: null }, meet: { people: [], cat: 'cafe', result: null, pick: null }, nearbyCat: null };
const markers = [];
let map;

$$('[data-ic]').forEach((el) => { el.innerHTML = ic(el.dataset.ic); });

/* ---------- map ---------- */
(async function init() {
  map = await osm.createMap('map', { center: AREAS.tokyo.center, zoom: AREAS.tokyo.zoom });
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'bottom-right');
  map.addControl(new maplibregl.ScaleControl(), 'bottom-right');
  map.on('load', () => {
    map.addSource('route', { type: 'geojson', data: fc([]) });
    map.addLayer({ id: 'route-casing', type: 'line', source: 'route', filter: ['==', ['get', 'type'], 'ride'], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#fff', 'line-width': 9 } });
    map.addLayer({ id: 'route-ride', type: 'line', source: 'route', filter: ['==', ['get', 'type'], 'ride'], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': ['get', 'colour'], 'line-width': 5, 'line-opacity': ['get', 'op'] } });
    map.addLayer({ id: 'route-bike', type: 'line', source: 'route', filter: ['==', ['get', 'type'], 'bike'], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': ['get', 'colour'], 'line-width': 5, 'line-opacity': ['get', 'op'] } });
    map.addLayer({ id: 'route-walk', type: 'line', source: 'route', filter: ['==', ['get', 'type'], 'walk'], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': ['get', 'colour'], 'line-width': 5, 'line-dasharray': [0.1, 1.8], 'line-opacity': ['get', 'op'] } });
    map.addLayer({ id: 'route-stops', type: 'circle', source: 'route', filter: ['==', ['geometry-type'], 'Point'], paint: { 'circle-radius': 4.5, 'circle-color': '#fff', 'circle-stroke-color': ['get', 'colour'], 'circle-stroke-width': 2.5 } });
    map.getSource('route').setData(lastRoute); // anything routed while tiles were loading
  });
  map.on('click', onMapClick);
  map.on('moveend', drawBubbles);
  map.on('load', drawBubbles);
  map.on('mousemove', (e) => {   // pointer cursor over clickable places (search / nearby tabs)
    if (S.tab !== 'search' && S.tab !== 'nearby') { map.getCanvas().style.cursor = ''; return; }
    const layers = POI_LAYERS.filter((id) => map.getLayer(id));
    map.getCanvas().style.cursor = map.queryRenderedFeatures([[e.point.x - 6, e.point.y - 6], [e.point.x + 6, e.point.y + 6]], { layers }).length ? 'pointer' : '';
  });
  map.on('moveend', () => { const c = map.getCenter(); const a = c.lng > 137.5 ? 'tokyo' : 'kyoto'; $$('[data-area]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.area === a))); });
  render();
})();
const fc = (features) => ({ type: 'FeatureCollection', features });
let lastRoute = fc([]);
function clearMarkers() { markers.splice(0).forEach((m) => m.remove()); }
function addMarker(lngLat, html, onClick, label) {
  const el = document.createElement('div'); el.innerHTML = html.trim(); const node = el.firstChild;
  if (label) { node.setAttribute('role', 'button'); node.setAttribute('aria-label', label); node.title = label; }
  if (onClick) node.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
  const m = new maplibregl.Marker({ element: node, anchor: node.classList.contains('mk') ? 'bottom' : 'center' }).setLngLat(lngLat).addTo(map); markers.push(m); return m;
}
const placePin = (p, big) => big ? `<div class="mk" style="background:${CAT[p.category].color}"><span>${ic(CAT[p.category].icon)}</span></div>` : `<div class="mk-dot" style="background:${CAT[p.category].color}"></div>`;
function showPlaces(list, { fit = true, activeId = null } = {}) {
  clearMarkers();
  list.forEach((p) => addMarker([p.lng, p.lat], placePin(p, p.id === activeId || list.length <= 12), () => openPlace(p), p.name));
  if (fit && list.length) fitTo(list.map((p) => [p.lng, p.lat]));
}
function fitTo(coords, maxZoom = 16) {
  if (!map || !coords.length) return;
  const b = new maplibregl.LngLatBounds(coords[0], coords[0]); coords.forEach((c) => b.extend(c));
  const panel = $('#panel').getBoundingClientRect();
  const wide = innerWidth >= 900;
  map.setPadding({ top: 0, bottom: 0, left: 0, right: 0 }); // flyTo padding persists on the map; don't stack it
  map.fitBounds(b, { padding: { top: 70, bottom: wide ? 60 : innerHeight * 0.52 + 30, left: wide ? panel.right - 72 + 40 : 40, right: 60 }, maxZoom, duration: 700 });
}
function setRoute(routes) {
  const feats = [];
  routes.forEach(({ route, colour, op = 1 }) => {
    route.legs.forEach((l) => {
      const c = l.type === 'ride' ? (l.colour || '#1A73E8') : (colour || (l.type === 'bike' ? '#188038' : '#1A73E8'));
      feats.push({ type: 'Feature', properties: { type: l.type, colour: c, op }, geometry: { type: 'LineString', coordinates: l.geometry } });
      if (l.type === 'ride') l.geometry.forEach((g) => feats.push({ type: 'Feature', properties: { type: 'stop', colour: c }, geometry: { type: 'Point', coordinates: g } }));
    });
  });
  lastRoute = fc(feats); map?.getSource('route')?.setData(lastRoute);
}
async function onMapClick(e) {
  const { lat, lng } = e.lngLat;
  if (S.tab === 'directions') { const r = await osm.reverseGeocode(lat, lng); if (!r) return hint('That spot is outside the offline map'); setEnd(S.dir.focus, toPoint(r)); return; }
  if (S.tab === 'meet') { if (S.meet.people.length >= 4) return hint('Up to 4 people'); const r = await osm.reverseGeocode(lat, lng); if (!r) return hint('That spot is outside the offline map'); S.meet.people.push(toPoint(r)); S.meet.result = null; renderMeet(); return; }
  // Search / Nearby: open the place that was clicked. Never drop a pin.
  const p = await placeAt(e.point, e.lngLat);
  if (p) openPlace(p, { fromMap: true });
}
// The map's own POI icons and labels come from the vector tiles; match the clicked one to the offline
// places pack (same OSM data) by name, else take the nearest pack place within a few metres of the click.
const POI_LAYERS = ['poi_r1', 'poi_r7', 'poi_r20', 'poi_transit'];
const norm = (s) => (s || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[\s\-_'’.()]/g, '');
async function placeAt(point, lngLat) {
  const layers = POI_LAYERS.filter((id) => map.getLayer(id));
  const box = [[point.x - 10, point.y - 10], [point.x + 10, point.y + 10]];
  const hit = map.queryRenderedFeatures(box, { layers })[0];
  const at = hit ? { lat: hit.geometry.coordinates[1], lng: hit.geometry.coordinates[0] } : { lat: lngLat.lat, lng: lngLat.lng };
  const near = (await osm.findNearbyPlaces(at.lat, at.lng, { radius: hit ? 120 : 25, limit: 40 })).places;
  if (hit) {
    const names = [hit.properties['name:en'], hit.properties.name_en, hit.properties['name:latin'], hit.properties.name, hit.properties['name:ja']].map(norm).filter(Boolean);
    const same = near.find((p) => names.includes(norm(p.name)) || names.includes(norm(p.local)));
    if (same) return same;
    // In the tiles but not in our pack (e.g. an unlisted category): still show what the map knows
    return { id: `tile:${hit.id ?? hit.properties.name}`, name: hit.properties['name:en'] || hit.properties.name_en || hit.properties.name, local: hit.properties.name !== (hit.properties['name:en'] || hit.properties.name_en) ? hit.properties.name : null,
      category: hit.layer.id === 'poi_transit' ? 'transit' : 'services', type: hit.properties.subclass || hit.properties.class, lat: at.lat, lng: at.lng, area: currentArea() };
  }
  return near[0] || null;   // nothing within 25 m of an empty click: do nothing
}
const toPoint = (r) => ({ name: r.place && r.place.distanceM < 30 ? r.place.name : (r.neighbourhood || r.name), label: r.label, lat: r.lat, lng: r.lng });
let hintT; function hint(msg) { const h = $('#hint'); h.textContent = msg; h.hidden = false; clearTimeout(hintT); hintT = setTimeout(() => { h.hidden = true; }, 2600); }

$$('[data-area]').forEach((b) => b.addEventListener('click', () => map.flyTo({ ...AREAS[b.dataset.area], duration: 1200 })));
$$('.rail__btn').forEach((b) => b.addEventListener('click', () => { S.tab = b.dataset.tab; $$('.rail__btn').forEach((x) => x.setAttribute('aria-current', String(x === b))); setRoute([]); clearMarkers(); render(); drawBubbles(); }));


/* ---------- famous places: photo bubbles on the map, photo-led preview card on click ---------- */
const bubbles = new Map();   // place id → maplibregl.Marker
let preview = null;          // the open maplibregl.Popup
const compact = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}K` : String(n));
function drawBubbles() {
  if (!map) return;
  const on = S.tab === 'search' || S.tab === 'nearby';
  const z = map.getZoom(), cap = z < 11.5 ? 8 : z < 12.5 ? 16 : z < 13.5 ? 30 : 60;
  const keep = new Set(), taken = [], b = map.getBounds();
  if (on) for (const p of [...FAMOUS.tokyo, ...FAMOUS.kyoto]) {   // most famous first; skip one that would overlap a more famous bubble
    if (!b.contains([p.lng, p.lat]) || p.fame >= cap) continue;
    const pt = map.project([p.lng, p.lat]);
    if (taken.some((q) => Math.abs(q.x - pt.x) < 56 && Math.abs(q.y - pt.y) < 62)) continue;
    taken.push(pt); keep.add(p.id);
  }
  for (const [id, m] of bubbles) if (!keep.has(id) && !m.getElement().classList.contains('is-open')) { m.remove(); bubbles.delete(id); }
  for (const p of [...FAMOUS.tokyo, ...FAMOUS.kyoto]) {
    if (!keep.has(p.id) || bubbles.has(p.id)) continue;
    const el = document.createElement('button');
    el.className = 'bub'; el.setAttribute('aria-label', `${p.name}, show photos and details`);
    el.innerHTML = `<span class="bub__photo"><img src="${esc(p.photo)}" alt="" loading="lazy"></span><span class="bub__name">${esc(p.name)}</span>`;
    el.addEventListener('click', (e) => { e.stopPropagation(); openPreview(p); });
    bubbles.set(p.id, new maplibregl.Marker({ element: el, anchor: 'bottom' }).setLngLat([p.lng, p.lat]).addTo(map));
    el.setAttribute('aria-label', `${p.name}, show photos and details`);   // MapLibre overwrites it with "Map marker"
    el.removeAttribute('role');
  }
  map.getContainer().classList.toggle('z-labels', z >= 14.5);
}
async function openPreview(p) {
  if (preview) preview.remove();
  const X = await osm.getPlaceDetails(p);
  const photos = [X.photo, ...(X.gallery || [])].filter(Boolean);
  const R = X.sampleReviews, V = X.views;
  const el = document.createElement('div'); el.className = 'pv';
  el.innerHTML = `
    <div class="pv__media">
      <div class="pv__track">${photos.map((ph, i) => `<img src="${esc(ph.url)}" alt="${esc(p.name)}, photo ${i + 1}" ${i ? 'loading="lazy"' : ''}>`).join('')}</div>
      ${photos.length > 1 ? `<button class="pv__nav pv__nav--prev" aria-label="Previous photo">${ic('back', 's18')}</button><button class="pv__nav pv__nav--next" aria-label="Next photo">${ic('back', 's18')}</button>` : ''}
      <span class="pv__count">1 / ${photos.length}</span>
      <button class="pv__close" aria-label="Close">${ic('close', 's18')}</button>
    </div>
    <p class="pv__credit"></p>
    <div class="pv__body">
      <h3>${esc(p.name)}</h3>
      <p class="sub">${esc([prettyType(p.type) || CAT[p.category].label.replace(/s$/, ''), p.local].filter(Boolean).join(' · '))}</p>
      <div class="pv__stats">
        ${R ? `<div class="pv__stat"><b>${R.rating.toFixed(1)} <span class="stars">★</span></b><span>Example rating</span></div>` : ''}
        ${V ? `<div class="pv__stat" title="${esc(`${V.source}, ${V.period}: ${V.total.toLocaleString()} (English ${V.en.toLocaleString()}, Japanese ${V.ja.toLocaleString()})`)}"><b>${compact(V.total)}</b><span>Wikipedia views</span></div>` : ''}
        <div class="pv__stat"><b>${photos.length}</b><span>Photo${photos.length > 1 ? 's' : ''}</span></div>
      </div>
      <p class="pv__note">${ic('info', 's16')}<span>${R ? 'The rating is an example, not a real rating. ' : ''}${V ? `Views are real: Wikipedia page views in English and Japanese, ${esc(V.period)}.` : ''}</span></p>
      ${X.description ? `<p class="pv__desc">${esc(X.description)}</p><p class="credit">From <a href="${esc(X.wikipedia)}" target="_blank" rel="noopener">Wikipedia</a> · CC BY-SA</p>` : ''}
      ${p.hours ? `<p class="pv__hours">${ic('clock', 's16')}<span>${esc(p.hours)}</span></p>` : ''}
      <div class="pv__actions">
        <button class="btn btn--primary" data-act="dir">${ic('directions', 's18')}Directions</button>
        <button class="btn btn--outline" data-act="more">More details</button>
      </div>
    </div>`;
  const track = el.querySelector('.pv__track'), count = el.querySelector('.pv__count'), credit = el.querySelector('.pv__credit');
  const showCredit = (i) => { const ph = photos[i]; if (!ph) return; count.textContent = `${i + 1} / ${photos.length}`;
    credit.innerHTML = `${esc([ph.author, ph.license].filter(Boolean).join(' · '))} · <a href="${esc(ph.source)}" target="_blank" rel="noopener">Wikimedia Commons</a>`; };
  let cur = 0;   // arrows move from the photo they last went to, so quick clicks don't land mid-scroll
  const go = (d) => { cur = (cur + d + photos.length) % photos.length; showCredit(cur); track.scrollTo({ left: cur * track.clientWidth, behavior: 'smooth' }); };
  track.addEventListener('scroll', debounce(() => { cur = Math.round(track.scrollLeft / track.clientWidth); showCredit(cur); }, 120));   // swipe / trackpad
  el.querySelector('.pv__nav--prev')?.addEventListener('click', () => go(-1));
  el.querySelector('.pv__nav--next')?.addEventListener('click', () => go(1));
  el.querySelector('.pv__close').addEventListener('click', () => preview && preview.remove());
  el.querySelector('[data-act="dir"]').addEventListener('click', () => { preview.remove(); S.dir.to = { name: p.name, lat: p.lat, lng: p.lng }; S.dir.focus = 'from'; switchTab('directions'); });
  el.querySelector('[data-act="more"]').addEventListener('click', () => { preview.remove(); openPlace(p, { fromMap: true }); });
  el.addEventListener('keydown', (e) => { if (e.key === 'ArrowRight') go(1); if (e.key === 'ArrowLeft') go(-1); if (e.key === 'Escape') preview.remove(); });
  showCredit(0);
  const bub = bubbles.get(p.id)?.getElement(); bub?.classList.add('is-open');
  preview = new maplibregl.Popup({ className: 'pv-pop', closeButton: false, maxWidth: '340px', offset: [0, -66], anchor: 'bottom' })
    .setLngLat([p.lng, p.lat]).setDOMContent(el).addTo(map);
  preview.on('close', () => bub?.classList.remove('is-open'));
  // make room for the card above the bubble: pan so the bubble sits just below the card's height
  const H = map.getContainer().clientHeight, h = Math.min(el.offsetHeight, H - 66 - 32);
  el.style.maxHeight = `${h}px`;
  const left = innerWidth >= 900 ? $('#panel').getBoundingClientRect().right - 72 : 0;
  map.easeTo({ center: [p.lng, p.lat], offset: [left / 2, 16 + h + 66 - H / 2], duration: 500 });
}

/* ---------- panels ---------- */
function render() { ({ search: renderSearch, nearby: renderNearby, directions: renderDirections, meet: renderMeet })[S.tab](); }
const placeRow = (p, side = '') => `<button class="row" data-pid="${esc(p.id)}">
  ${p.photo ? `<img class="row__thumb" src="${esc(p.photo)}" alt="" loading="lazy">` : `<span class="row__ic" style="background:${CAT[p.category].color}">${ic(CAT[p.category].icon, 's18')}</span>`}
  <span class="row__main"><div class="row__title">${esc(p.name)}${p.notable ? ` <span class="star" title="Has a Wikipedia/Wikidata entry">${ic('star', 's16')}</span>` : ''}</div>
  <div class="row__meta">${esc([CAT[p.category].label.replace(/s$/, ''), prettyType(p.type), p.local].filter(Boolean).join(' · '))}</div></span>
  <span class="row__side">${side}</span></button>`;
const prettyType = (t) => (t && !['restaurant', 'cafe', 'station', 'park', 'hotel', 'pin'].includes(t) ? t.replace(/_/g, ' ') : '');
function bindRows(list) { $$('[data-pid]').forEach((b) => b.addEventListener('click', () => openPlace(list.find((p) => p.id === b.dataset.pid)))); }

let FAMOUS = { tokyo: [], kyoto: [] };
osm.famousPlaces({ area: 'tokyo', limit: 60 }).then((l) => { FAMOUS.tokyo = l; if (S.tab === 'search' && !S.places.length) renderSearch(); drawBubbles(); });
osm.famousPlaces({ area: 'kyoto', limit: 60 }).then((l) => { FAMOUS.kyoto = l; drawBubbles(); });
const currentArea = () => (map && map.getCenter().lng < 137.5 ? 'kyoto' : 'tokyo');
function famousHtml() {
  const list = FAMOUS[currentArea()].slice(0, 24);
  if (!list.length) return '<div class="empty">Try “Senso-ji”, “Shibuya Station”, “ramen”, “金閣寺” or “Gion”.</div>';
  return `<div class="section-label">Famous in ${currentArea() === 'tokyo' ? 'Tokyo' : 'Kyoto'}</div><div class="famous">${list.map((p) => `<button class="famous__card" data-fid="${esc(p.id)}"><img src="${esc(p.photo)}" alt="" loading="lazy"><span>${esc(p.name)}</span></button>`).join('')}</div>`;
}
function bindFamous() { $$('[data-fid]').forEach((b) => b.addEventListener('click', () => openPlace(FAMOUS[currentArea()].find((p) => p.id === b.dataset.fid)))); }
function renderSearch(results = S.places, q = $('#q')?.value || '') {
  $('#panel').innerHTML = `<div class="panel__head">
      <label class="field">${ic('search')}<input id="q" type="search" placeholder="Search places, stations, areas" value="${esc(q)}" autocomplete="off" aria-label="Search"></label>
      <p class="sub">Works with no internet. ${'Searches 40,000+ OpenStreetMap places in central Tokyo and Kyoto, in English or Japanese.'}</p>
    </div>
    <div class="panel__body" id="results">${results.length ? results.map((p) => placeRow(p, p.distanceM != null ? dist(p.distanceM) : '')).join('') : famousHtml()}</div>`;
  if (!results.length) bindFamous();
  const input = $('#q'); input.focus(); input.setSelectionRange(q.length, q.length);
  input.addEventListener('input', debounce(async () => {
    const c = map?.getCenter();
    S.places = input.value.trim() ? await osm.geocode(input.value, { near: c && { lat: c.lat, lng: c.lng }, limit: 12 }) : [];
    $('#results').innerHTML = S.places.length ? S.places.map((p) => placeRow(p, p.distanceM != null ? dist(p.distanceM) : '')).join('') : input.value.trim() ? '<div class="empty">No matches in the offline area</div>' : famousHtml();
    if (!S.places.length && !input.value.trim()) bindFamous();
    bindRows(S.places); showPlaces(S.places);
  }));
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && S.places[0]) openPlace(S.places[0]); });
  bindRows(results);
}

async function openPlace(p, { fromMap = false } = {}) {
  S.active = p;
  const where = p.where || await osm.reverseGeocode(p.lat, p.lng);
  if (!markers.length || S.tab === 'directions' || S.tab === 'meet') { clearMarkers(); }
  if (!fromMap) {   // clicked on the map: its icon is already there, so add nothing and keep the camera still
  addMarker([p.lng, p.lat], placePin(p, true), null, p.name);
  map.flyTo({ center: [p.lng, p.lat], zoom: Math.max(map.getZoom(), 15.5), duration: 800, padding: { left: innerWidth >= 900 ? 400 : 0, top: 0, right: 0, bottom: innerWidth >= 900 ? 0 : innerHeight * 0.5 } });
  }
  const back = S.tab;
  const X = p.key ? await osm.getPlaceDetails(p) : { info: {}, tips: [], sampleReviews: null };
  const I = X.info || {};
  const yesNo = (v) => (v === 'only' ? 'only' : v === 'yes' || v === 'designated' ? 'yes' : v === 'no' ? 'no' : v);
  const facts = [
    ...(I.cuisines || []).map((c) => c[0].toUpperCase() + c.slice(1)),
    I.vegetarian && I.vegetarian !== 'no' ? `Vegetarian ${yesNo(I.vegetarian) === 'only' ? 'only' : 'options'}` : '',
    I.vegan && I.vegan !== 'no' ? `Vegan ${yesNo(I.vegan) === 'only' ? 'only' : 'options'}` : '',
    I.takeaway && I.takeaway !== 'no' ? 'Takeaway' : '', I.outdoorSeating === 'yes' ? 'Outdoor seating' : '',
    I.smoking === 'no' ? 'No smoking' : I.smoking && I.smoking !== 'no' ? `Smoking: ${I.smoking}` : '',
    I.wheelchair === 'yes' ? 'Wheelchair accessible' : I.wheelchair === 'limited' ? 'Limited wheelchair access' : '',
    I.cards === 'yes' ? 'Cards accepted' : I.cards === 'no' ? 'Cash only' : '', I.wifi && I.wifi !== 'no' ? 'Wi-Fi' : '',
  ].filter(Boolean);
  const R = X.sampleReviews;
  const stars = (n) => `<span class="stars" aria-label="${n} out of 5">${'★'.repeat(Math.round(n))}${'☆'.repeat(5 - Math.round(n))}</span>`;
  const detailsHtml = `
      ${X.description ? `<div class="block"><p class="desc">${esc(X.description)}</p><p class="credit">From <a href="${esc(X.wikipedia)}" target="_blank" rel="noopener">Wikipedia</a> · CC BY-SA</p></div>` : ''}
      ${facts.length || I.phone || I.website || I.note ? `<div class="block">${facts.length ? `<div class="chips">${facts.map((f) => `<span class="chip chip--static">${esc(f)}</span>`).join('')}</div>` : ''}
        ${I.note ? `<p class="desc" style="margin-top:8px">${esc(I.note)}</p>` : ''}
        <dl class="kv" style="margin-top:8px">${I.phone ? `<dt>Phone</dt><dd>${esc(I.phone)}</dd>` : ''}${I.website ? `<dt>Website</dt><dd><a href="${esc(I.website)}" target="_blank" rel="noopener">${esc(I.website.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '').slice(0, 40))}</a></dd>` : ''}${I.chain ? `<dt>Chain</dt><dd>${esc(I.chain)}</dd>` : ''}${I.fee ? `<dt>Entry fee</dt><dd>${esc(yesNo(I.fee))}</dd>` : ''}</dl></div>` : ''}
      ${X.tips.length ? `<div class="section-label">Traveller tips</div>${X.tips.map((t) => `<div class="tip"><p>${esc(t.text)}</p>${t.price || t.hours ? `<p class="tip__meta">${[t.price && `Price: ${esc(t.price)}`, t.hours && `Hours: ${esc(t.hours)}`].filter(Boolean).join(' · ')}</p>` : ''}<p class="credit">${esc(t.source)} · CC BY-SA</p></div>`).join('')}` : ''}
      ${R ? `<div class="section-label">Reviews</div><div class="reviews">
          <div class="reviews__head"><b>${R.rating.toFixed(1)}</b>${stars(R.rating)}<span class="sub">Example rating</span></div>
          <p class="example-label">${ic('info', 's16')}${esc(R.label)}</p>
          ${R.reviews.map((v) => `<div class="review"><div class="review__by"><span class="avatar">${esc(v.author[0])}</span><b>${esc(v.author)}</b>${stars(v.stars)}<span class="sub">${v.monthsAgo} month${v.monthsAgo > 1 ? 's' : ''} ago</span></div><p>${esc(v.text)}</p></div>`).join('')}
        </div>` : ''}`;
  $('#panel').innerHTML = `${X.photo ? `<figure class="hero"><img src="${esc(X.photo.url)}" alt="${esc(p.name)}"><figcaption>${esc([X.photo.author, X.photo.license].filter(Boolean).join(' · ') || 'Wikimedia Commons')} · <a href="${esc(X.photo.source)}" target="_blank" rel="noopener">Wikimedia Commons</a></figcaption></figure>` : ''}<div class="panel__head"><div style="display:flex;align-items:center;gap:8px"><button class="icon-btn" id="back" aria-label="Back">${ic('back')}</button><h2 style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(p.name)}</h2></div>
      <p class="sub">${esc([CAT[p.category].label.replace(/s$/, ''), prettyType(p.type)].filter(Boolean).join(' · '))}${p.local ? ` · ${esc(p.local)}` : ''}</p></div>
    <div class="panel__body">
      <div class="card"><div class="actions">
        <button class="btn btn--primary" id="goTo">${ic('directions', 's18')}Directions</button>
        <button class="btn btn--soft" id="goFrom">From here</button>
        <button class="btn btn--outline" id="nearHere">${ic('nearby', 's18')}Nearby</button></div>
      <dl class="kv">
        <dt>Address</dt><dd>${esc(where?.label || '—')}</dd>
        ${p.hours ? `<dt>Hours</dt><dd>${esc(p.hours)}</dd>` : ''}
        ${where?.nearestStation ? `<dt>Station</dt><dd>${esc(where.nearestStation.name)} · ${dist(where.nearestStation.distanceM)}</dd>` : ''}
        <dt>Coordinates</dt><dd>${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}</dd>
      </dl></div>
      ${detailsHtml}
      <p class="sub" style="padding:8px 16px">From the offline OpenStreetMap pack. Hours are as tagged in OSM and may be out of date.</p>
    </div>`;
  $('#back').onclick = () => { S.tab = back; render(); if (back === 'search') showPlaces(S.places, { fit: false }); };
  const pt = { name: p.name, label: where?.label, lat: p.lat, lng: p.lng };
  $('#goTo').onclick = () => { S.dir.to = pt; S.dir.focus = S.dir.from ? 'to' : 'from'; switchTab('directions'); };
  $('#goFrom').onclick = () => { S.dir.from = pt; S.dir.focus = 'to'; switchTab('directions'); };
  $('#nearHere').onclick = () => { switchTab('nearby'); exploreAt(p.lat, p.lng); };
}
function switchTab(t) { S.tab = t; $$('.rail__btn').forEach((x) => x.setAttribute('aria-current', String(x.dataset.tab === t))); clearMarkers(); setRoute([]); render(); drawBubbles(); }

/* nearby / explore_area */
let lastExplore = null;
async function exploreAt(lat, lng) {
  $('#panel').innerHTML = `<div class="panel__head"><h2>Nearby</h2><p class="sub">Looking around…</p></div>`;
  lastExplore = await osm.exploreArea(lat, lng, { radius: 800 });
  renderNearby();
}
async function renderNearby() {
  if (!lastExplore) { const c = map ? map.getCenter() : { lat: 35.684, lng: 139.757 }; return exploreAt(c.lat, c.lng); }
  const X = lastExplore, cats = Object.keys(CAT).filter((c) => c !== 'area' && X.counts[c]);
  $('#panel').innerHTML = `<div class="panel__head">
      <h2>${esc(X.location?.neighbourhood || X.location?.name || 'This area')}</h2>
      <p class="sub">${X.total.toLocaleString()} places within 800 m${X.location?.nearestStation ? ` · nearest station ${esc(X.location.nearestStation.name)} (${dist(X.location.nearestStation.distanceM)})` : ''}</p>
      <div class="chips">${cats.map((c) => `<button class="chip" data-cat="${c}" aria-pressed="${S.nearbyCat === c}">${ic(CAT[c].icon, 's16')}${CAT[c].label}</button>`).join('')}</div>
      <button class="btn btn--outline" id="here" style="justify-self:start">${ic('nearby', 's18')}Search this area of the map</button>
    </div>
    <div class="panel__body" id="nb"></div>`;
  $('#here').onclick = () => { const c = map.getCenter(); S.nearbyCat = null; exploreAt(c.lat, c.lng); };
  $$('[data-cat]').forEach((b) => b.addEventListener('click', () => { S.nearbyCat = S.nearbyCat === b.dataset.cat ? null : b.dataset.cat; renderNearby(); }));
  clearMarkers(); addMarker([X.center.lng, X.center.lat], '<div class="mk-here"></div>', null, 'Search centre');
  if (S.nearbyCat) {
    const r = await osm.findNearbyPlaces(X.center.lat, X.center.lng, { radius: 800, categories: [S.nearbyCat], limit: 400, notableFirst: true });
    let list = r.places, cuisineBar = '';
    if (S.nearbyCat === 'food' || S.nearbyCat === 'cafe') {   // filter by cuisine from the details pack
      const det = await Promise.all(list.map((p) => osm.getPlaceDetails(p)));
      const cu = new Map(); det.forEach((d, i) => (d.info.cuisines || []).forEach((c) => { (cu.get(c) || cu.set(c, []).get(c)).push(list[i]); }));
      const top = [...cu.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 8);
      if (S.cuisine && cu.has(S.cuisine)) list = cu.get(S.cuisine); else S.cuisine = null;
      cuisineBar = top.length ? `<div class="chips" style="padding:8px 16px">${top.map(([c, l]) => `<button class="chip" data-cu="${esc(c)}" aria-pressed="${S.cuisine === c}">${esc(c[0].toUpperCase() + c.slice(1))} <span class="sub">${l.length}</span></button>`).join('')}</div>` : '';
    }
    list = list.slice(0, 60); r.places = list;
    $('#nb').innerHTML = cuisineBar + list.map((p) => placeRow(p, dist(p.distanceM))).join('');
    $$('[data-cu]').forEach((b) => b.addEventListener('click', () => { S.cuisine = S.cuisine === b.dataset.cu ? null : b.dataset.cu; renderNearby(); }));
    bindRows(r.places); r.places.forEach((p) => addMarker([p.lng, p.lat], placePin(p, false), () => openPlace(p), p.name));
    fitTo([[X.center.lng, X.center.lat], ...r.places.slice(0, 25).map((p) => [p.lng, p.lat])]);
  } else {
    $('#nb').innerHTML = `<div class="stats">${cats.map((c) => `<button class="stat" data-cat2="${c}"><b>${X.counts[c]}</b><span>${CAT[c].label}</span></button>`).join('')}</div>
      ${cats.filter((c) => X.highlights[c]?.length && c !== 'transit').slice(0, 5).map((c) => `<div class="section-label">${CAT[c].label}</div>${X.highlights[c].slice(0, 3).map((p) => placeRow(p, dist(p.distanceM))).join('')}`).join('')}`;
    const all = Object.values(X.highlights).flat(); bindRows(all);
    $$('[data-cat2]').forEach((b) => b.addEventListener('click', () => { S.nearbyCat = b.dataset.cat2; renderNearby(); }));
    all.forEach((p) => addMarker([p.lng, p.lat], placePin(p, false), () => openPlace(p), p.name));
    map?.flyTo({ center: [X.center.lng, X.center.lat], zoom: 15, duration: 700, padding: { left: innerWidth >= 900 ? 400 : 0, top: 0, right: 0, bottom: 0 } });
  }
}

/* directions / get_route_directions */
function setEnd(which, pt) { S.dir[which] = pt; S.dir.focus = which === 'from' ? 'to' : 'from'; renderDirections(); }
async function renderDirections() {
  const D = S.dir;
  $('#panel').innerHTML = `<div class="panel__head">
      <div class="seg" role="group" aria-label="Travel mode">${[['transit', 'Transit'], ['walk', 'Walk'], ['bike', 'Bike']].map(([m, l]) => `<button data-mode="${m}" aria-pressed="${D.mode === m}">${ic(m, 's18')}${l}</button>`).join('')}</div>
      <div class="dir-fields">
        <span class="dir-dot" style="grid-area:1/1"></span><label class="field field--small" style="grid-area:1/2"><input id="from" placeholder="Choose start, or click the map" value="${esc(D.from?.name || '')}" aria-label="Start"></label>
        <span class="dir-dot dir-dot--to" style="grid-area:2/1"></span><label class="field field--small" style="grid-area:2/2"><input id="to" placeholder="Choose destination, or click the map" value="${esc(D.to?.name || '')}" aria-label="Destination"></label>
        <button class="icon-btn" id="swap" aria-label="Swap start and destination" style="grid-area:1/3/3/4">${ic('swap')}</button>
      </div>
    </div>
    <div class="panel__body" id="dirBody"><div class="empty">Type a place or click the map to set the ${D.focus === 'from' ? 'start' : 'destination'}.</div></div>`;
  $$('[data-mode]').forEach((b) => b.addEventListener('click', () => { D.mode = b.dataset.mode; renderDirections(); }));
  $('#swap').onclick = () => { [D.from, D.to] = [D.to, D.from]; renderDirections(); };
  for (const which of ['from', 'to']) {
    const inp = $('#' + which);
    inp.addEventListener('focus', () => { D.focus = which; });
    inp.addEventListener('input', debounce(async () => {
      const c = map.getCenter(); const list = inp.value.trim() ? await osm.geocode(inp.value, { near: { lat: c.lat, lng: c.lng }, limit: 7 }) : [];
      $('#dirBody').innerHTML = list.map((p) => placeRow(p, p.distanceM != null ? dist(p.distanceM) : '')).join('') || '<div class="empty">No matches in the offline area</div>';
      $$('[data-pid]').forEach((b) => b.addEventListener('click', () => { const p = list.find((x) => x.id === b.dataset.pid); setEnd(which, { name: p.name, lat: p.lat, lng: p.lng }); }));
    }));
  }
  clearMarkers();
  if (D.from) addMarker([D.from.lng, D.from.lat], '<div class="mk-here" style="background:#fff;border-color:#5F6368;box-shadow:none;border-width:4px"></div>', null, 'Start');
  if (D.to) addMarker([D.to.lng, D.to.lat], `<div class="mk" style="background:var(--red)"><span>${ic('pin')}</span></div>`, null, 'Destination');
  if (!(D.from && D.to)) { setRoute([]); return; }
  $('#dirBody').innerHTML = '<div class="empty">Routing offline…</div>';
  try {
    const t0 = performance.now();
    const r = await osm.getRouteDirections(D.from, D.to, { mode: D.mode });
    const ms = Math.round(performance.now() - t0);
    D.route = r; setRoute([{ route: r }]); fitTo(r.geometry);
    $('#dirBody').innerHTML = routeHtml(r) + `<p class="sub" style="padding:8px 16px">Routed on-device in ${ms} ms from the bundled OpenStreetMap street and rail network. Train and bus times are estimates from distance; real timetables aren't included.</p>`;
  } catch (e) { $('#dirBody').innerHTML = `<div class="empty">${esc(e.message)}</div>`; setRoute([]); }
}
function routeHtml(r) {
  const rides = r.legs.filter((l) => l.type === 'ride');
  const bar = r.legs.filter((l) => !l.transfer && (l.type === 'ride' || l.minutes >= 1)).map((l) => l.type === 'ride'
    ? `<span class="lb lb--ride" style="background:${l.colour || '#1A73E8'}">${ic(l.vehicle === 'bus' ? 'bus' : 'train', 's16')}${esc(l.ref || shortLine(l.line))}</span>`
    : `<span class="lb">${ic(l.type === 'bike' ? 'bike' : 'walk', 's16')}${l.minutes}</span>`).join(ic('back', 's16').replace('class="icon', 'style="transform:rotate(180deg);color:#9AA0A6" class="icon'));
  return `<div class="summary"><b>${dur(r.durationMin)}</b><span class="sub">${r.distanceKm} km${rides.length ? ` · ${rides.length === 1 ? 'no transfers' : `${rides.length - 1} transfer${rides.length > 2 ? 's' : ''}`}` : ''}${r.walkOnlyMin ? ` · walking ${dur(r.walkOnlyMin)}` : ''}</span></div>
    <div class="legs-bar">${bar}</div>${r.note ? `<div class="note">${esc(r.note)}</div>` : ''}
    <div class="timeline">${r.legs.map((l) => l.type === 'ride'
      ? `<div class="tl tl--ride" style="--lc:${l.colour || '#1A73E8'}"><div class="tl__rail"><span class="tl__node"></span><span class="tl__line"></span></div><div class="tl__body">
          <div class="tl__title">${esc(l.from)}${l.vehicle === 'bus' ? ' <span class="tl__meta">bus stop</span>' : ''}</div><div class="tl__meta"><b style="color:${l.colour || '#1A73E8'}">${esc(l.line)}</b> toward ${esc(l.toward)}</div>
          <div class="tl__meta">${l.stops} stop${l.stops > 1 ? 's' : ''} · ${dur(l.minutes)} (+ about ${l.waitMin} min wait) · get off at ${esc(l.to)}</div></div></div>`
      : `<div class="tl"><div class="tl__rail"><span class="tl__node" style="border-width:2px;width:10px;height:10px;margin-top:5px"></span><span class="tl__line"></span></div><div class="tl__body">
          <div class="tl__title">${l.type === 'bike' ? 'Cycle' : l.transfer ? 'Transfer' : 'Walk'} · ${dur(l.minutes)}</div><div class="tl__meta">${dist(l.distanceM)}</div>
          <ul class="tl__steps">${l.steps.slice(0, 6).map((s) => `<li>${esc(s)}</li>`).join('')}</ul></div></div>`).join('')}
      <div class="tl"><div class="tl__rail"><span class="dir-dot dir-dot--to" style="margin-top:4px"></span></div><div class="tl__body"><div class="tl__title">${esc(S.dir.to?.name || 'Destination')}</div></div></div>
    </div>`;
}
const shortLine = (n) => n.replace(/^(Tokyo Metro|Toei|JR|Keihan|Hankyu|Kyoto Municipal Subway|Kintetsu|Randen|Keifuku|Eizan)\s*/i, '').replace(/\s*Line$/i, '').slice(0, 14);

/* meet up / suggest_meeting_point */
async function renderMeet() {
  const M = S.meet;
  $('#panel').innerHTML = `<div class="panel__head"><h2>Meet up</h2>
      <p class="sub">Click the map to add where each person is (up to 4). We'll suggest a spot that keeps the longest trip short.</p>
      <div class="chips">${['cafe', 'food', 'nightlife', 'parks', 'sights'].map((c) => `<button class="chip" data-mc="${c}" aria-pressed="${M.cat === c}">${ic(CAT[c].icon, 's16')}${CAT[c].label}</button>`).join('')}</div>
      <button class="btn btn--primary btn--wide" id="suggest" ${M.people.length < 2 ? 'disabled' : ''}>Suggest a meeting point</button>
    </div>
    <div class="panel__body" id="mb">
      ${M.people.map((p, i) => `<div class="row"><span class="mk-num" style="flex:none">${i + 1}</span><span class="row__main"><div class="row__title">${esc(p.name)}</div><div class="row__meta">${esc(p.label || '')}</div></span><button class="icon-btn" data-rm="${i}" aria-label="Remove person ${i + 1}">${ic('close', 's18')}</button></div>`).join('') || '<div class="empty">No one added yet. Click two or more spots on the map.</div>'}
      <div id="meetRes"></div>
    </div>`;
  $$('[data-mc]').forEach((b) => b.addEventListener('click', () => { M.cat = b.dataset.mc; M.result = null; renderMeet(); }));
  $$('[data-rm]').forEach((b) => b.addEventListener('click', () => { M.people.splice(+b.dataset.rm, 1); M.result = null; renderMeet(); }));
  $('#suggest').onclick = async () => { $('#meetRes').innerHTML = '<div class="empty">Comparing trips offline…</div>'; M.result = await osm.suggestMeetingPoint(M.people, { category: M.cat, limit: 3 }); M.pick = 0; renderMeet(); };
  clearMarkers(); setRoute([]);
  M.people.forEach((p, i) => addMarker([p.lng, p.lat], `<div class="mk-num">${i + 1}</div>`, null, `Person ${i + 1}`));
  if (!M.result) return;
  if (!M.result.suggestions.length) { $('#meetRes').innerHTML = '<div class="empty">Nothing of that kind near the middle. Try another category.</div>'; return; }
  $('#meetRes').innerHTML = `<div class="section-label">Suggestions</div>` + M.result.suggestions.map((s, k) => `<button class="row ${k === M.pick ? 'is-active' : ''}" data-pick="${k}">
      <span class="row__ic" style="background:${CAT[s.place.category].color}">${ic(CAT[s.place.category].icon, 's18')}</span>
      <span class="row__main"><div class="row__title">${esc(s.place.name)}</div><div class="row__meta">${s.travelMin.map((m, i) => `${i + 1}: ${m} min`).join(' · ')}</div></span>
      <span class="row__side">max ${s.maxMin} min</span></button>`).join('');
  $$('[data-pick]').forEach((b) => b.addEventListener('click', () => { M.pick = +b.dataset.pick; renderMeet(); }));
  const s = M.result.suggestions[M.pick];
  addMarker([s.place.lng, s.place.lat], placePin(s.place, true), () => openPlace(s.place), s.place.name);
  const routes = await Promise.all(M.people.map((p) => osm.getRouteDirections(p, s.place, { mode: 'transit' })));
  setRoute(routes.map((route) => ({ route })));
  fitTo([...M.people.map((p) => [p.lng, p.lat]), [s.place.lng, s.place.lat]]);
}

// expose for console experiments: osm.geocode('Kinkaku-ji'), osm.getRouteDirections(a, b, { mode: 'transit' }) …
window.osm = osm;
