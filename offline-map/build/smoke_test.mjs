// Node smoke test: runs the browser module against the real packs with fetch() pointed at disk.
// usage: node build/smoke_test.mjs   (from the offline-map folder)
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
globalThis.fetch = async (u) => { const b = await readFile(path.resolve(root, u)); return { ok: true, json: async () => JSON.parse(b) }; };
const OfflineOSM = createRequire(import.meta.url)(path.join(root, 'offline-osm.js'));
const osm = OfflineOSM.create({ dataUrl: 'data/', tilesUrl: '../claude-prototype/data/' });
const t = async (label, fn) => { const t0 = performance.now(); try { const r = await fn(); console.log(`✓ ${label} (${Math.round(performance.now() - t0)} ms)`, r); } catch (e) { console.log(`✗ ${label}`, e); process.exitCode = 1; } };
const brief = (r) => ({ mode: r.mode, min: r.durationMin, km: r.distanceKm, walkOnly: r.walkOnlyMin, legs: r.legs.map((l) => l.type === 'ride' ? `${l.line} ${l.from}→${l.to} (${l.stops})` : `${l.type} ${l.minutes}m`), steps: r.steps.slice(0, 4) });

await t('coverage', () => osm.coverage());
for (const q of ['Senso-ji', 'sensoji', 'Shibuya Station', '金閣寺', 'Fushimi Inari', 'ramen', 'Gion', 'Meiji Jingu', 'Tokyo Tower'])
  await t(`geocode "${q}"`, async () => (await osm.geocode(q, { limit: 3 })).map((p) => `${p.name} [${p.category}/${p.type}] ${p.local || ''} ${p.area}`));
await t('reverse Sensō-ji', async () => { const r = await osm.reverseGeocode(35.7148, 139.7967); return r.label + ' | station ' + r.nearestStation?.name; });
await t('reverse Kyoto', async () => (await osm.reverseGeocode(35.0037, 135.7788)).label);
await t('nearby cafés Shibuya', async () => { const r = await osm.findNearbyPlaces(35.658, 139.7016, { radius: 400, categories: ['cafe'], limit: 3 }); return [r.total, r.places.map((p) => p.name)]; });
await t('searchCategory parks', async () => (await osm.searchCategory('parks', [35.70, 139.76, 35.72, 139.78])).count);
await t('explore Gion', async () => { const r = await osm.exploreArea(35.0037, 135.7788); return [r.location.label, r.counts]; });
const ueno = { lat: 35.7141, lng: 139.7774 }, sensoji = { lat: 35.7148, lng: 139.7967 }, shibuya = { lat: 35.658, lng: 139.7016 }, shinjuku = { lat: 35.6909, lng: 139.7003 };
await t('walk Ueno→Senso-ji', async () => brief(await osm.getRouteDirections(ueno, sensoji, { mode: 'walk' })));
await t('transit Shibuya→Senso-ji', async () => brief(await osm.getRouteDirections(shibuya, sensoji, { mode: 'transit' })));
await t('transit Shinjuku→Ueno', async () => brief(await osm.getRouteDirections(shinjuku, ueno, { mode: 'transit' })));
await t('transit Kyoto Stn→Kiyomizu', async () => brief(await osm.getRouteDirections({ lat: 34.9858, lng: 135.7588 }, { lat: 34.9949, lng: 135.785 }, { mode: 'transit' })));
await t('transit short hop (should walk)', async () => brief(await osm.getRouteDirections(sensoji, { lat: 35.7127, lng: 139.788 }, { mode: 'transit' })));
await t('bike Shibuya→Shinjuku', async () => brief(await osm.getRouteDirections(shibuya, shinjuku, { mode: 'bike' })));
await t('intercity Shinjuku→Gion', async () => brief(await osm.getRouteDirections(shinjuku, { lat: 35.0037, lng: 135.7788 })));
await t('commute', async () => { const r = await osm.analyzeCommute(shinjuku, shibuya); return [r.recommended, Object.fromEntries(Object.entries(r.options).map(([k, v]) => [k, v.durationMin]))]; });
await t('meet', async () => (await osm.suggestMeetingPoint([shibuya, ueno, shinjuku], { category: 'cafe' })).suggestions.map((s) => [s.place.name, s.travelMin]));
await t('outside area', async () => { try { await osm.getRouteDirections({ lat: 35.5, lng: 139.5 }, ueno); return 'no error?!'; } catch (e) { return e.message; } });

// Kyoto buses
const kyotoSt = { lat: 34.9858, lng: 135.7588 }, kinkakuji = { lat: 35.0394, lng: 135.7292 }, ginkakuji = { lat: 35.0270, lng: 135.7982 }, kiyomizu = { lat: 34.9949, lng: 135.785 };
for (const [n, a, b] of [['Kyoto Stn→Kinkaku-ji', kyotoSt, kinkakuji], ['Kyoto Stn→Ginkaku-ji', kyotoSt, ginkakuji], ['Kyoto Stn→Kiyomizu', kyotoSt, kiyomizu], ['Kinkaku-ji→Ginkaku-ji', kinkakuji, ginkakuji]]) {
  await t(`bus ${n}`, async () => brief(await osm.getRouteDirections(a, b, { mode: 'transit' })));
  await t(`  rail only ${n}`, async () => { const r = await osm.getRouteDirections(a, b, { mode: 'transit', bus: false }); return `${r.mode} ${r.durationMin} min`; });
}

// details: photos, descriptions, tips, food info, example reviews
await t('famous Kyoto', async () => (await osm.famousPlaces({ area: 'kyoto', limit: 6 })).map((p) => `${p.name} → ${p.photo}`));
for (const q of ['Kinkaku-ji', 'Senso-ji', 'Ichiran', 'Tsukiji Outer Market']) {
  await t(`details "${q}"`, async () => {
    const [p] = await osm.geocode(q, { limit: 1 }); const d = await osm.getPlaceDetails(p);
    return { name: p.name, cat: p.category, famous: p.famous, photo: d.photo && `${d.photo.url} (${d.photo.license}, ${d.photo.author.slice(0, 30)})`,
      desc: d.description?.slice(0, 90), tips: d.tips.map((x) => x.text.slice(0, 70)), info: d.info, reviews: d.sampleReviews && `${d.sampleReviews.rating} · ${d.sampleReviews.reviews[0].text}` };
  });
}
