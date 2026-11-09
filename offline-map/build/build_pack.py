"""Step 2: turn raw Overpass JSON into compact offline packs the browser module reads.
usage: python3 build_pack.py <raw_dir> <out_data_dir>

Per area it writes:
  places-<area>.json   searchable POIs, stations and neighbourhoods (geocode / nearby / category search)
  network-<area>.json  walking graph (binary, gzip+base64) + rail lines and stations (transit routing)
"""
import base64, glob, gzip, json, math, os, re, struct, sys, unicodedata
from collections import defaultdict

RAW, OUT = sys.argv[1], sys.argv[2]
AREAS = {'tokyo': (35.639, 139.680, 35.729, 139.834), 'kyoto': (34.958, 135.659, 35.048, 135.813)}
Q = 1e5  # coordinate quantisation: 1e-5 deg ≈ 1.1 m

# ---------- categories (ids match the prototype's chips, plus a few extras) ----------
CATS = ['food', 'cafe', 'nightlife', 'sights', 'shopping', 'parks', 'stays', 'transit', 'health', 'services', 'area']
def categorise(t):
    a, to, sh, le, hi = t.get('amenity'), t.get('tourism'), t.get('shop'), t.get('leisure'), t.get('historic')
    if t.get('place'): return 'area', t['place']
    if t.get('railway') == 'station': return 'transit', 'subway' if t.get('station') == 'subway' or t.get('subway') == 'yes' else 'station'
    if a in ('restaurant', 'fast_food'): return 'food', (t.get('cuisine') or a).split(';')[0]
    if a in ('cafe', 'ice_cream') or sh in ('bakery', 'confectionery', 'tea'): return 'cafe', a or sh
    if a in ('bar', 'pub'): return 'nightlife', a
    if to in ('hotel', 'hostel', 'guest_house'): return 'stays', to
    if le in ('park', 'garden'): return 'parks', le
    if to in ('attraction', 'museum', 'gallery', 'viewpoint', 'zoo', 'aquarium', 'theme_park', 'artwork') or hi \
            or a in ('place_of_worship', 'theatre', 'cinema', 'arts_centre'):
        sub = to or hi or a
        if a == 'place_of_worship': sub = {'shinto': 'shrine', 'buddhist': 'temple'}.get(t.get('religion'), 'worship')
        return 'sights', sub
    if sh or a == 'marketplace': return 'shopping', sh or a
    if a in ('pharmacy', 'hospital', 'clinic'): return 'health', a
    if a: return 'services', a
    return None, None

def names(t):
    local = t.get('name:ja') or t.get('name')
    en = t.get('name:en') or t.get('name:ja-Latn') or t.get('name:ja_rm')
    if not en and local and re.fullmatch(r"[\x00-\x7f’'éōūÉŌŪ·&.,\- ]+", local): en = local
    return en, local

def hav(a, b):  # (lat, lng) metres
    la1, lo1, la2, lo2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = math.sin((la2 - la1) / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2
    return 2 * 6371000 * math.asin(math.sqrt(h))

def inbox(lat, lng, box, m=0.0):
    s, w, n, e = box
    return s - m <= lat <= n + m and w - m <= lng <= e + m

def pack_b64(raw: bytes) -> str:
    return base64.b64encode(gzip.compress(raw, 9, mtime=0)).decode()

# ---------- places ----------
def okey(e): return e['type'][0] + str(e['id'])  # n123 / w456 / r789 — stable id shared with details packs

def nfold(s):
    s = unicodedata.normalize('NFKD', s or '').encode('ascii', 'ignore').decode().lower() if s and re.search('[A-Za-z]', s) else (s or '')
    return re.sub(r'[\W_]+', '', s.lower())

def load_extras(area):
    p = f'{RAW}/{area}-extras.json'
    return json.load(open(p)) if os.path.exists(p) else {'attractions': {}, 'listings': [], 'wikidata': {}}

def match_listings(area, box, el, extras):
    """Attach Wikivoyage listings to OSM places: by Wikidata id, else by name within 150 m.
    Returns ({okey: [listing…]}, [unmatched eat/drink listings inside the area])."""
    by_wd, pts = {}, []
    for e in el:
        t = e.get('tags', {})
        lat, lng = (e['lat'], e['lon']) if 'lat' in e else (e['center']['lat'], e['center']['lon']) if 'center' in e else (None, None)
        if lat is None or not t.get('name'): continue
        if t.get('wikidata'): by_wd[t['wikidata']] = okey(e)
        pts.append((lat, lng, okey(e), {nfold(t.get(k)) for k in ('name', 'name:en', 'name:ja', 'name:ja-Latn', 'official_name:en') if t.get(k)}))
    attached, extra = defaultdict(list), []
    for L in extras['listings']:
        key = by_wd.get(L['wikidata'])
        if not key and L['lat'] is not None:
            want = {nfold(L['name']), nfold(L['alt'])} - {''}
            best = None
            for lat, lng, k, nm in pts:
                if abs(lat - L['lat']) > 0.004 or abs(lng - L['lng']) > 0.004: continue
                d = hav((lat, lng), (L['lat'], L['lng']))
                if d < (300 if L['type'] in ('see', 'do') else 150) and any(w and (w in n or n in w) for w in want for n in nm if len(n) >= 2) and (not best or d < best[0]): best = (d, k)
            key = best and best[1]
        if key: attached[key].append(L)
        elif L['type'] in ('eat', 'drink') and L['lat'] is not None and inbox(L['lat'], L['lng'], box): extra.append(L)
    return attached, extra

def build_places(area, box, extras):
    el = json.load(open(f'{RAW}/{area}-poi.json'))['elements']
    famous = set(extras['attractions'])
    tips, wv_only = match_listings(area, box, el, extras)
    seen, rows, tagmap = set(), [], {}
    for e in el:
        t = e.get('tags', {})
        lat, lng = (e['lat'], e['lon']) if 'lat' in e else (e['center']['lat'], e['center']['lon']) if 'center' in e else (None, None)
        if lat is None or not inbox(lat, lng, box): continue
        cat, sub = categorise(t)
        if not cat: continue
        en, local = names(t)
        if not (en or local): continue
        key = (en or local, round(lat, 3), round(lng, 3))
        if key in seen: continue
        seen.add(key)
        k = okey(e); tagmap[k] = t
        rank = 2 if k in famous else 1 if (t.get('wikidata') or t.get('wikipedia') or k in tips) else 0
        rows.append([en or local, local if local != (en or local) else None, CATS.index(cat), sub,
                     round(lat * Q), round(lng * Q), t.get('opening_hours'), rank, k])
    # restaurants and bars that Wikivoyage recommends but OSM doesn't have yet
    for i, L in enumerate(wv_only):
        cafe = re.search(r'\b(caf[eé]|coffee|tea ?house|kissaten)\b', L['name'] + ' ' + L['content'], re.I)
        cat = 'cafe' if cafe else 'nightlife' if L['type'] == 'drink' else 'food'
        k = f'v{i}'; tips[k].append(L)
        rows.append([L['name'], L['alt'] or None, CATS.index(cat), 'cafe' if cafe else 'bar' if cat == 'nightlife' else 'restaurant',
                     round(L['lat'] * Q), round(L['lng'] * Q), L['hours'] or None, 1, k])
    # most notable first (famous, wiki-linked, then sights/stations/areas) so search ties resolve sensibly
    pri = {CATS.index(c): i for i, c in enumerate(['sights', 'transit', 'area', 'parks', 'shopping', 'stays', 'food', 'cafe', 'nightlife', 'health', 'services'])}
    rows.sort(key=lambda r: (-r[7], pri[r[2]]))
    subs = sorted({r[3] for r in rows})
    sidx = {s: i for i, s in enumerate(subs)}
    for r in rows: r[3] = sidx[r[3]]
    out = {'v': 2, 'area': area, 'bbox': box, 'q': Q, 'cats': CATS, 'subs': subs,
           'cols': ['name', 'local', 'cat', 'sub', 'lat', 'lng', 'hours', 'rank (2 famous, 1 notable)', 'key'], 'rows': rows,
           'attribution': '© OpenStreetMap contributors (ODbL); Wikivoyage listings CC BY-SA'}
    print(f'  places {area}: {len(rows)} ({len(wv_only)} added from Wikivoyage), {len(tips)} with traveller tips')
    return out, tagmap, tips

# ---------- details: photos, descriptions, tips, food and access info ----------
def clean_intro(t):
    t = re.sub(r'\s*\[[^\]]*\]', '', t)                                   # IPA / footnote brackets
    for _ in range(2):  # parentheses holding Japanese script, pronunciations or "lit." glosses
        t = re.sub(r'\s*[(（][^()（）]*(?:[\u3040-\u30ff\u3400-\u9fff]|pronunciation|lit\.)[^()（）]*[)）]', '', t)
    t = re.sub(r'^([^,.]{2,60}), (is|was|are|were) ', r'\1 \2 ', t)        # "Sensō-ji, is" left after removing "(浅草寺…)"
    return re.sub(r'\s+([,.;])', r'\1', re.sub(r'\s{2,}', ' ', t)).strip()

def yes(v): return v in ('yes', 'only', 'designated')
def build_details(area, places, tagmap, tips, extras):
    det = {}
    for r in places['rows']:
        k, cat = r[8], CATS[r[2]]
        t = tagmap.get(k, {}); d = {}
        a = extras['attractions'].get(k)
        if a:
            d['photo'] = a['photo']; d['wikipedia'] = a['wikipedia']; d['fame'] = a['sitelinks']
            if a['description']: d['description'] = clean_intro(a['description'])
        if k in tips:
            d['tips'] = [{'text': L['content'], 'type': L['type'], 'price': L['price'] or None, 'hours': L['hours'] or None, 'page': L['page']}
                         for L in tips[k][:3]]
        info = {}
        if t.get('cuisine'): info['cuisines'] = [c.strip().replace('_', ' ') for c in t['cuisine'].split(';') if c.strip()][:4]
        for tag, name in (('diet:vegetarian', 'vegetarian'), ('diet:vegan', 'vegan'), ('takeaway', 'takeaway'), ('outdoor_seating', 'outdoorSeating'),
                          ('payment:credit_cards', 'cards'), ('reservation', 'reservations')):
            if t.get(tag): info[name] = t[tag]
        for tag, name in (('wheelchair', 'wheelchair'), ('smoking', 'smoking'), ('fee', 'fee'), ('internet_access', 'wifi')):
            if t.get(tag): info[name] = t[tag]
        phone = t.get('phone') or t.get('contact:phone'); web = t.get('website') or t.get('contact:website')
        if phone: info['phone'] = phone
        if web and web.startswith('http'): info['website'] = web
        if t.get('brand:en') or t.get('brand'): info['chain'] = t.get('brand:en') or t.get('brand')
        if t.get('description') and cat != 'area': info['note'] = t['description'][:300]
        if info: d['info'] = info
        if d: det[k] = d
    famous = sorted(extras['attractions'], key=lambda k: -extras['attractions'][k]['sitelinks'])
    print(f'  details {area}: {len(det)} places, {len(famous)} with photos')
    return {'v': 1, 'area': area, 'famous': famous, 'places': det,
            'attribution': {'osm': '© OpenStreetMap contributors (ODbL)', 'wikipedia': 'Descriptions: Wikipedia, CC BY-SA 4.0',
                            'wikivoyage': 'Tips: Wikivoyage, CC BY-SA', 'photos': 'Photos: Wikimedia Commons, licence and author per photo'}}

# ---------- walking graph ----------
HW_SPEED = {'steps': 0.6}  # time multiplier vs flat walking (steps are slow)
def build_walk(area, box):
    nodes, ways = {}, {}
    for f in sorted(glob.glob(f'{RAW}/{area}-walk-*.json')):
        for e in json.load(open(f))['elements']:
            if e['type'] == 'node': nodes[e['id']] = (e['lat'], e['lon'])
            elif e['type'] == 'way': ways[e['id']] = e
    use = defaultdict(int)
    for w in ways.values():
        nd = w['nodes']
        for i, n in enumerate(nd): use[n] += 2 if i in (0, len(nd) - 1) else 1
    names_tbl, name_idx = [''], {'': 0}
    vid, vco = {}, []
    def vertex(n):
        if n not in vid: vid[n] = len(vco); vco.append(nodes[n])
        return vid[n]
    edges = []  # (a, b, metres, kind, name, [interior coords])
    for w in ways.values():
        t = w.get('tags', {}); hw = t.get('highway')
        if t.get('foot') in ('no', 'private') or t.get('access') in ('no', 'private') or t.get('area') == 'yes': continue
        nm = t.get('name:en') or t.get('name') or ''
        if nm not in name_idx: name_idx[nm] = len(names_tbl); names_tbl.append(nm)
        kind = 1 if hw == 'steps' else 2 if hw in ('footway', 'path', 'pedestrian', 'corridor', 'track') else 3 if hw in ('trunk', 'trunk_link', 'primary', 'primary_link') else 0
        nd = [n for n in w['nodes'] if n in nodes]
        if len(nd) < 2: continue
        start, geom, dist = nd[0], [], 0.0
        for i in range(1, len(nd)):
            dist += hav(nodes[nd[i - 1]], nodes[nd[i]])
            if use[nd[i]] >= 2 or i == len(nd) - 1:
                if nd[i] != start:
                    edges.append((vertex(start), vertex(nd[i]), dist, kind, name_idx[nm], simplify([nodes[start]] + geom + [nodes[nd[i]]])[1:-1]))
                start, geom, dist = nd[i], [], 0.0
            else:
                geom.append(nodes[nd[i]])
    # keep only the largest connected component so every snapped point can reach every other
    adj = defaultdict(list)
    for i, (a, b, *_) in enumerate(edges): adj[a].append(b); adj[b].append(a)
    comp, best = {}, None
    for s in range(len(vco)):
        if s in comp or s not in adj: continue
        stack, members = [s], [s]; comp[s] = s
        while stack:
            u = stack.pop()
            for v in adj[u]:
                if v not in comp: comp[v] = s; stack.append(v); members.append(v)
        if not best or len(members) > len(best): best = members
    keep = set(best)
    remap = {old: i for i, old in enumerate(sorted(keep))}
    verts = [vco[o] for o in sorted(keep)]
    edges = [(remap[a], remap[b], d, k, nm, g) for a, b, d, k, nm, g in edges if a in keep and b in keep]
    # binary layout (little endian):
    #   header: nV u32, nE u32, nG u32
    #   verts: nV × (lat i32, lng i32)            quantised 1e-5
    #   edges: nE × (a u32, b u32, len_dm u32, kind u8, pad u8, name u16, gOff u32, gLen u16, pad u16)  = 24 bytes
    #   geom:  nG × (lat i32, lng i32)
    geo = []
    eb = bytearray()
    for a, b, d, k, nm, g in edges:
        eb += struct.pack('<IIIBBHIHH', a, b, round(d * 10), k, 0, nm, len(geo), len(g), 0)
        geo.extend(g)
    vb = b''.join(struct.pack('<ii', round(la * Q), round(lo * Q)) for la, lo in verts)
    gb = b''.join(struct.pack('<ii', round(la * Q), round(lo * Q)) for la, lo in geo)
    raw = struct.pack('<III', len(verts), len(edges), len(geo)) + vb + bytes(eb) + gb
    print(f'  walk {area}: {len(verts)} junctions, {len(edges)} edges, {len(geo)} shape pts, {len(raw)//1024} KB raw')
    return {'names': names_tbl, 'bin': pack_b64(raw)}, verts

def simplify(pts, tol=2.5):  # Douglas–Peucker in metres
    if len(pts) <= 2: return pts
    a, b = pts[0], pts[-1]
    kx = 111320 * math.cos(math.radians(a[0]))
    def dist(p):
        ax, ay, bx, by, px, py = a[1] * kx, a[0] * 110540, b[1] * kx, b[0] * 110540, p[1] * kx, p[0] * 110540
        dx, dy = bx - ax, by - ay
        if dx == dy == 0: return math.hypot(px - ax, py - ay)
        t = max(0, min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
        return math.hypot(px - ax - t * dx, py - ay - t * dy)
    i, dm = max(((i, dist(p)) for i, p in enumerate(pts[1:-1], 1)), key=lambda x: x[1])
    if dm <= tol: return [a, b]
    return simplify(pts[:i + 1], tol)[:-1] + simplify(pts[i:], tol)

# ---------- transit ----------
SPEED = {'subway': 33, 'train': 40, 'light_rail': 22, 'monorail': 30, 'tram': 15, 'bus': 14, 'trolleybus': 14}  # km/h incl. stops
WAIT = {'bus': 7}  # average wait to board, minutes (rail default 4 in the client)
BUS_OPS = {'京都市交通局': 'City Bus', '京都バス': 'Kyoto Bus', '京阪バス': 'Keihan Bus', '西日本ジェイアールバス': 'JR Bus',
           '西日本JRバス': 'JR Bus', '京阪京都交通': 'Keihan Kyoto Kotsu Bus'}
BUS_COLOUR = '#188038'  # system green; OSM rarely tags bus colours
def clean_line(t):
    nm = t.get('name:en') or t.get('name') or t.get('ref') or 'Line'
    nm = re.sub(r'\s*[\(（].*?[\)）]\s*', ' ', nm).strip()
    nm = re.sub(r'\s*:\s*[^:]*(=>|→).*$', '', nm).strip()           # "…: Shibuya => Yokohama"
    nm = re.sub(r'\s+(Local|Rapid|Express)$', '', nm).strip()
    nm = re.sub(r'\s*(inbound|outbound|clockwise|counterclockwise|counter-clockwise|anti-clockwise)$', '', nm, flags=re.I).strip()
    return nm

def bus_name(t):
    op = BUS_OPS.get(t.get('operator') or t.get('network'), 'Bus')
    ref = t.get('ref') or re.sub(r'\D.*$', '', re.sub(r'^\D*', '', t.get('name', '')))  # "32系統 …" → 32
    return (f'{op} {ref}' if ref and len(ref) <= 5 else op), (ref if ref and len(ref) <= 5 else None)

def build_transit(area, box, verts):
    M = 0.03  # ~3 km margin so lines that leave and re-enter the area stay joined
    stations = []  # [en, local, lat, lng, served_by_rail]
    def station_for(n, rail):
        t = n.get('tags', {}); en, local = names(t)
        local = re.sub(r'\d+$', '', local or '') or local; en = re.sub(r'\s*(Platform|Gleis)?\s*\d+$', '', en or '') or en
        p = (n['lat'], n['lon'])
        hit = None
        for i, s in enumerate(stations):
            if (s[1] == local or (en and s[0] == en)) and hav(p, (s[2], s[3])) < (600 if rail else 250): hit = i; break
        if hit is None:
            for i, s in enumerate(stations):
                if hav(p, (s[2], s[3])) < 60: hit = i; break
        if hit is None: stations.append([en or local, local, p[0], p[1], rail]); return len(stations) - 1
        stations[hit][4] = stations[hit][4] or rail
        return hit
    lines, seen = [], set()
    sources = [(f'{RAW}/{area}-transit.json', False)] + ([(f'{RAW}/{area}-bus.json', True)] if os.path.exists(f'{RAW}/{area}-bus.json') else [])
    for path, is_bus in sources:
        el = json.load(open(path))['elements']
        nodes = {e['id']: e for e in el if e['type'] == 'node'}
        named = [n for n in nodes.values() if names(n.get('tags', {}))[1] or names(n.get('tags', {}))[0]]
        def resolve(n):  # unnamed stop position → the named platform/stop next to it
            if any(names(n.get('tags', {}))): return n
            best = min(named, key=lambda m: hav((n['lat'], n['lon']), (m['lat'], m['lon'])), default=None)
            return best if best and hav((n['lat'], n['lon']), (best['lat'], best['lon'])) < 80 else None
        for r in (e for e in el if e['type'] == 'relation'):
            t = r['tags']; tj = json.dumps(t, ensure_ascii=False)
            if is_bus:
                if re.search('高速|夜行|千葉|Highway|Express|空港|リムジン', tj) or (t.get('operator') or t.get('network')) not in BUS_OPS: continue
            else:
                if t.get('service') == 'high_speed' or re.search('新幹線|Shinkansen|Nozomi|Hikari|Kodama|Hayabusa|Hayate|Komachi|Tsubasa|Kagayaki|Toki', tj): continue
                if re.search(r'Limited Express|Ltd\.?\s?Exp|Narita Express|Hitachi|Shiosai|Kinugawa|Nikko|Koedo|S-Train|Cityliner|Skyliner|(?<!Toneri )Liner|Romancecar|Airport limited|拝島ライナー|特急|まいづる|はしだて|きのさき|はるか|サンダーバード|くろしお|びわこエクスプレス|Haruka|Thunderbird|Maizuru|Hashidate|Kinosaki', tj, re.I):
                    continue  # reserved-seat limited expresses: skip, they'd give unrealistic shortcuts
            mem = [m for m in r['members'] if m['type'] == 'node' and m['ref'] in nodes]
            # Japanese bus relations name their platforms, not their stop positions: prefer platforms there
            roles = ('platform', 'stop') if is_bus and any(m['role'].startswith('platform') for m in mem) else ('stop',)
            seq = []
            for m in mem:
                if not m['role'].startswith(roles[0]): continue
                n = nodes[m['ref']]
                if not inbox(n['lat'], n['lon'], box, M): seq.append(None); continue
                n = resolve(n)
                if not n: continue
                sid = station_for(n, not is_bus)
                if not seq or seq[-1] != sid: seq.append(sid)
            mode = 'bus' if is_bus else t.get('route')
            if is_bus: (name, ref), colour = bus_name(t), t.get('colour') or BUS_COLOUR
            else: name, ref, colour = clean_line(t), t.get('ref'), t.get('colour')
            for part in ' '.join('_' if s is None else str(s) for s in seq).split('_'):
                ids = [int(x) for x in part.split()]
                if len(ids) < 2: continue
                k = (name, tuple(ids))
                if k in seen: continue
                seen.add(k)
                l = {'name': name, 'ref': ref, 'colour': colour, 'mode': mode, 'kmh': SPEED.get(mode, 30), 'stops': ids}
                if mode in WAIT: l['wait'] = WAIT[mode]
                lines.append(l)
    # rail relations are often one-way only: add the reverse. Buses are mapped per direction (and some
    # streets are one-way), so they keep only what's mapped.
    have = {(l['name'], tuple(l['stops'])) for l in lines}
    for l in list(lines):
        rev = tuple(reversed(l['stops']))
        if l['mode'] != 'bus' and (l['name'], rev) not in have: lines.append({**l, 'stops': list(rev)}); have.add((l['name'], rev))
    used = sorted({s for l in lines for s in l['stops']})
    rm = {o: i for i, o in enumerate(used)}
    st = [[stations[o][0], stations[o][1] if stations[o][1] != stations[o][0] else None, round(stations[o][2] * Q), round(stations[o][3] * Q), 1 if stations[o][4] else 0] for o in used]
    for l in lines: l['stops'] = [rm[s] for s in l['stops']]
    print(f'  transit {area}: {len(st)} stops/stations ({sum(s[4] for s in st)} rail), {len(lines)} line patterns ({sum(l["mode"] == "bus" for l in lines)} bus)')
    return {'stations': st, 'lines': lines}

os.makedirs(OUT, exist_ok=True)
for area, box in AREAS.items():
    print(area)
    extras = load_extras(area)
    places, tagmap, tips = build_places(area, box, extras)
    json.dump(places, open(f'{OUT}/places-{area}.json', 'w'), ensure_ascii=False, separators=(',', ':'))
    json.dump(build_details(area, places, tagmap, tips, extras), open(f'{OUT}/details-{area}.json', 'w'), ensure_ascii=False, separators=(',', ':'))
    walk, verts = build_walk(area, box)
    transit = build_transit(area, box, verts)
    json.dump({'v': 1, 'area': area, 'bbox': box, 'q': Q, 'walk': walk, 'transit': transit,
               'attribution': '© OpenStreetMap contributors (ODbL)'},
              open(f'{OUT}/network-{area}.json', 'w'), ensure_ascii=False, separators=(',', ':'))
    for f in (f'{OUT}/places-{area}.json', f'{OUT}/details-{area}.json', f'{OUT}/network-{area}.json'):
        print(f'  {os.path.basename(f)}: {os.path.getsize(f)//1024} KB')
