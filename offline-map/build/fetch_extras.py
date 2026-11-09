"""Step 1b: enrich places with open content, for offline use.
  - Famous attractions: ranked by how many Wikipedia language editions cover them (Wikidata sitelinks)
  - Their photo: Wikimedia Commons (Wikidata P18), with author and licence kept for the credit line
  - Their description: the English Wikipedia summary (CC BY-SA)
  - Traveller tips and extra food places: Wikivoyage "see / do / eat / drink / buy" listings (CC BY-SA)
usage: python3 fetch_extras.py <raw_dir> <photos_dir>     (needs network; ~5 min, ~15 API calls per area + photos)
"""
import json, os, re, subprocess, sys, time, urllib.parse

RAW, PHOTOS = sys.argv[1], sys.argv[2]
UA = 'google-plan-offline-map/1.0 (prototype build script)'
TOP_N = 60  # attractions with photos per area
WV_PREFIX = {'tokyo': 'Tokyo', 'kyoto': 'Kyoto'}

def get(url, binary=False, tries=5, post=None, accept=None):
    """GET (or POST form data) with backoff. Wikimedia rate-limits hard (HTTP 429), so requests are
    batched and spaced out, and a 429 waits progressively longer."""
    for i in range(tries):
        cmd = ['curl', '-sS', '-L', '--compressed', '--max-time', '120', '-A', UA, '-w', '\n%{http_code}']
        if accept: cmd += ['-H', f'Accept: {accept}']
        if post: cmd += ['--data-urlencode', f'{post[0]}@-']
        r = subprocess.run(cmd + [url], input=post[1].encode() if post else None, capture_output=True)
        body, _, code = r.stdout.rpartition(b'\n')
        if code == b'200':
            try: return body if binary else json.loads(body)
            except ValueError: pass
        wait = 20 * (i + 1) if code == b'429' else 3 * (i + 1)
        print(f'  HTTP {code.decode() or "?"} — waiting {wait}s: {url[:70]}'); time.sleep(wait)
    return None

def okey(e): return e['type'][0] + str(e['id'])  # n123 / w456 / r789: stable id used across packs

# ---------- attractions ----------
ATTRACTION = re.compile(r'^(tourism=(attraction|museum|gallery|viewpoint|zoo|aquarium|theme_park)|historic=.*|leisure=(park|garden)|amenity=(place_of_worship|theatre|marketplace)|shop=(mall|department_store))$')
def kind(t):
    for k in ('tourism', 'historic', 'leisure', 'amenity', 'shop'):
        if k in t: return f'{k}={t[k]}'
    return ''

def wikidata(ids):
    """One SPARQL query per area: fame (number of Wikipedia editions), English article, image."""
    q = ('SELECT ?item ?links ?image ?enwiki WHERE { VALUES ?item { ' + ' '.join('wd:' + i for i in ids) + ' } '
         '?item wikibase:sitelinks ?links ; wdt:P625 [] . OPTIONAL { ?item wdt:P18 ?image } '  # P625: has a location, so a memorial OSM mislinked to a person isn't ranked by that person's fame
         
         'OPTIONAL { ?enwiki schema:about ?item ; schema:isPartOf <https://en.wikipedia.org/> } }')
    j = get('https://query.wikidata.org/sparql', post=('query', q), accept='application/sparql-results+json')
    out = {}
    for b in (j or {}).get('results', {}).get('bindings', []):
        qid = b['item']['value'].rsplit('/', 1)[1]
        if qid in out and out[qid]['image']: continue
        img = b.get('image', {}).get('value')
        out[qid] = {'sitelinks': int(b['links']['value']), 'image': urllib.parse.unquote(img.rsplit('/', 1)[1]) if img else None,
                    'enwiki': urllib.parse.unquote(b['enwiki']['value'].rsplit('/', 1)[1]).replace('_', ' ') if 'enwiki' in b else None}
    print(f'  wikidata: {len(out)} items')
    return out

def commons_batch(files):
    """imageinfo for up to 50 files per request → {filename: info}"""
    out = {}
    for i in range(0, len(files), 50):
        j = get('https://commons.wikimedia.org/w/api.php?action=query&format=json&prop=imageinfo&iiprop=url|extmetadata&iiurlwidth=500&titles='
                + urllib.parse.quote('|'.join('File:' + f for f in files[i:i + 50])))
        q = (j or {}).get('query', {})
        norm = {n['to']: n['from'] for n in q.get('normalized', [])}
        for page in q.get('pages', {}).values():
            if page.get('imageinfo'): out[norm.get(page['title'], page['title'])[5:]] = page['imageinfo'][0]
        time.sleep(2)
    return out

def summaries(titles):
    """English Wikipedia intro text, 20 articles per request."""
    out = {}
    for i in range(0, len(titles), 20):
        j = get('https://en.wikipedia.org/w/api.php?action=query&format=json&prop=extracts&exintro=1&explaintext=1&exsentences=4&exlimit=20&redirects=1&titles='
                + urllib.parse.quote('|'.join(titles[i:i + 20])))
        q = (j or {}).get('query', {})
        back = {r['to']: r['from'] for r in q.get('redirects', [])}
        back.update({n['to']: n['from'] for n in q.get('normalized', [])})
        for page in q.get('pages', {}).values():
            if page.get('extract'): out[back.get(page['title'], page['title'])] = page['extract'].strip()
        time.sleep(2)
    return out

def save_photo(info, key):
    md = info.get('extmetadata', {})
    strip = lambda s: re.sub(r'<[^>]+>', '', s or '').strip()
    path = os.path.join(PHOTOS, key + '.jpg')
    if not os.path.exists(path):
        data = get(info['thumburl'], binary=True)
        if not data or data[:3] != b'\xff\xd8\xff': return None  # only accept JPEGs
        open(path, 'wb').write(data); time.sleep(1)
    return {'file': f'photos/{key}.jpg', 'author': strip(md.get('Artist', {}).get('value'))[:120],
            'license': strip(md.get('LicenseShortName', {}).get('value')), 'source': info.get('descriptionurl')}

# ---------- Wikivoyage listings ----------
def templates(text):
    """Yield the bodies of top-level {{...}} templates (handles nesting)."""
    i = 0
    while True:
        i = text.find('{{', i)
        if i < 0: return
        depth, j = 0, i
        while j < len(text) - 1:
            if text.startswith('{{', j): depth += 1; j += 2
            elif text.startswith('}}', j):
                depth -= 1; j += 2
                if depth == 0: break
            else: j += 1
        yield text[i + 2:j - 2]; i = j

def split_params(body):
    parts, depth, cur = [], 0, ''
    for ch_i, ch in enumerate(body):
        if ch in '{[': depth += 1
        elif ch in '}]': depth -= 1
        if ch == '|' and depth == 0: parts.append(cur); cur = ''
        else: cur += ch
    parts.append(cur)
    return parts

def wikiclean(s):
    s = re.sub(r'\{\{[^{}]*\}\}', '', s)
    s = re.sub(r'\[\[(?:[^|\]]*\|)?([^\]]*)\]\]', r'\1', s)
    s = re.sub(r'\[https?://\S+ ([^\]]*)\]', r'\1', s)
    s = re.sub(r"'{2,}", '', s); s = re.sub(r'<[^>]+>', '', s)
    return re.sub(r'\s+', ' ', s).strip()

def wikivoyage(prefix):
    titles = [prefix]
    j = get(f'https://en.wikivoyage.org/w/api.php?action=query&format=json&list=allpages&apnamespace=0&aplimit=200&apprefix={prefix}/')
    titles += [p['title'] for p in (j or {}).get('query', {}).get('allpages', [])]
    listings = []
    for i in range(0, len(titles), 20):
        j = get('https://en.wikivoyage.org/w/api.php?action=query&format=json&prop=revisions&rvprop=content&rvslots=main&formatversion=2&titles='
                + urllib.parse.quote('|'.join(titles[i:i + 20])))
        for page in (j or {}).get('query', {}).get('pages', []):
            text = (page.get('revisions') or [{}])[0].get('slots', {}).get('main', {}).get('content', '')
            for body in templates(text):
                ps = split_params(body); name = ps[0].strip().lower()
                if name not in ('see', 'do', 'eat', 'drink', 'buy', 'listing', 'sleep'): continue
                kv = {}
                for p in ps[1:]:
                    if '=' in p: k, v = p.split('=', 1); kv[k.strip().lower()] = v.strip()
                typ = kv.get('type', name) if name == 'listing' else name
                if typ == 'sleep' or not kv.get('name'): continue
                try: lat, lng = float(kv.get('lat') or 'x'), float(kv.get('long') or 'x')
                except ValueError: lat = lng = None
                content = wikiclean(kv.get('content') or kv.get('description') or '')
                if len(content) < 25: continue
                listings.append({'type': typ, 'name': wikiclean(kv['name']), 'alt': wikiclean(kv.get('alt', '')), 'wikidata': kv.get('wikidata') or None,
                                 'lat': lat, 'lng': lng, 'content': content, 'price': wikiclean(kv.get('price', '')), 'hours': wikiclean(kv.get('hours', '')),
                                 'page': page['title']})
        time.sleep(0.3)
    print(f'  wikivoyage {prefix}: {len(titles)} pages, {len(listings)} listings')
    return listings

os.makedirs(PHOTOS, exist_ok=True)
for area in ('tokyo', 'kyoto'):
    out_path = f'{RAW}/{area}-extras.json'
    if os.path.exists(out_path): print('have', out_path); continue
    print(area)
    el = json.load(open(f'{RAW}/{area}-poi.json'))['elements']
    cands = {e['tags']['wikidata']: e for e in el if 'wikidata' in e.get('tags', {}) and 'name' in e['tags'] and ATTRACTION.match(kind(e['tags']))}
    wd = wikidata(list(cands))
    ranked = sorted((q for q in wd if wd[q]['image']), key=lambda q: -wd[q]['sitelinks'])[:TOP_N + 20]
    infos = commons_batch([wd[q]['image'] for q in ranked])
    texts = summaries([wd[q]['enwiki'] for q in ranked if wd[q]['enwiki']])
    attractions = {}
    for q in ranked:
        if len(attractions) >= TOP_N: break
        e = cands[q]; key = okey(e); info = infos.get(wd[q]['image'])
        photo = info and save_photo(info, key)
        if not photo: continue
        attractions[key] = {'wikidata': q, 'sitelinks': wd[q]['sitelinks'], 'wikipedia': wd[q]['enwiki'],
                            'description': texts.get(wd[q]['enwiki']), 'photo': photo}
        print(f'  {len(attractions):2d} {e["tags"].get("name:en") or e["tags"]["name"]} ({wd[q]["sitelinks"]} wikis)')
    json.dump({'attractions': attractions, 'wikidata': {q: wd[q]['sitelinks'] for q in wd},
               'listings': wikivoyage(WV_PREFIX[area])}, open(out_path, 'w'), ensure_ascii=False)
    time.sleep(10)
