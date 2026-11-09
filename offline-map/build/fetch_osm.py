"""Step 1: download raw OSM data for each bundled area from Overpass.
Same source the open-streetmap-mcp server queries live. Run once, needs network.
usage: python3 fetch_osm.py <raw_dir>"""
import json, sys, time, subprocess, os

AREAS = {  # S, W, N, E — matches the z14 coverage of the bundled vector-tile packs
    'tokyo': (35.639, 139.680, 35.729, 139.834),
    'kyoto': (34.958, 135.659, 35.048, 135.813),
}
POI = '''[out:json][timeout:180];
(
  nwr[name][amenity~"^(restaurant|cafe|fast_food|bar|pub|ice_cream|pharmacy|hospital|clinic|toilets|atm|bank|post_office|police|library|theatre|cinema|marketplace|place_of_worship|townhall|arts_centre)$"]({b});
  nwr[name][tourism~"^(attraction|museum|gallery|viewpoint|hotel|hostel|guest_house|zoo|aquarium|theme_park|artwork)$"]({b});
  nwr[name][shop~"^(mall|department_store|supermarket|convenience|bakery|books|clothes|gift|electronics|confectionery|tea|souvenir|anime|games|variety_store|craft)$"]({b});
  nwr[name][leisure~"^(park|garden)$"]({b});
  nwr[name][historic~"^(castle|monument|memorial|shrine|temple|building|archaeological_site)$"]({b});
  node[name][railway=station]({b});
  node[name][place~"^(suburb|quarter|neighbourhood)$"]({b});
);
out center tags qt;'''
WALK = '''[out:json][timeout:300];
way[highway~"^(trunk|trunk_link|primary|primary_link|secondary|secondary_link|tertiary|tertiary_link|unclassified|residential|living_street|pedestrian|footway|path|steps|cycleway|service|track|corridor)$"]({b});
out body qt; >; out skel qt;'''
TRANSIT = '''[out:json][timeout:180];
rel[type=route][route~"^(subway|train|light_rail|monorail|tram)$"]({b})->.r;
.r out body qt;
node(r.r); out qt;'''

BUS = '''[out:json][timeout:240];
rel[type=route][route~"^(bus|trolleybus)$"]({b})->.r;
.r out body qt;
node(r.r); out qt;'''
BUS_AREAS = {'kyoto'}  # Kyoto's sights are mostly bus-served; Tokyo's rail network is dense enough without

def run(q, path):
    if os.path.exists(path): print('have', path); return
    for url in ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'] * 4:  # public servers reset often: retry
        try:
            data = subprocess.run(['curl', '-sS', '--fail', '--max-time', '400', '--compressed', '-A', 'google-plan-offline-map/1.0',
                                   '--data-urlencode', 'data@-', url], input=q.encode(), capture_output=True, check=True).stdout
            json.loads(data); open(path, 'wb').write(data); print('got', path, len(data) // 1024, 'KB'); return
        except Exception as e: print('fail', url, e); time.sleep(30)
    raise SystemExit('could not fetch ' + path)

out = sys.argv[1]
for name, (s, w, n, e) in AREAS.items():
    b = f'{s},{w},{n},{e}'
    for kind, q in (('poi', POI), ('transit', TRANSIT)) + ((('bus', BUS),) if name in BUS_AREAS else ()):
        run(q.replace('{b}', b), f'{out}/{name}-{kind}.json'); time.sleep(3)
    # the street network is big: fetch it in a 3x3 grid of chunks (merged in build_pack.py)
    G = 3
    for i in range(G):
        for j in range(G):
            cs, cn = s + (n - s) * i / G, s + (n - s) * (i + 1) / G
            cw, ce = w + (e - w) * j / G, w + (e - w) * (j + 1) / G
            run(WALK.replace('{b}', f'{cs:.5f},{cw:.5f},{cn:.5f},{ce:.5f}'), f'{out}/{name}-walk-{i}{j}.json'); time.sleep(3)
