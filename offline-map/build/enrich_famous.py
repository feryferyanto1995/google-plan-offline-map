"""Step 2b: give every famous place a photo gallery and a real popularity number.

  - Gallery: up to 4 extra photos from the place's English Wikipedia article, topped up from its
    Wikimedia Commons category. Author and licence are kept per photo, like the main photo.
  - Views: Wikipedia page views over the last 12 complete months, English + Japanese articles
    (Wikimedia pageviews API, human traffic only). This is a real number, unlike the example ratings.

Runs after build_pack.py and edits data/details-*.json in place. Fetched results are cached in
build/famous-cache.json, so re-running it after a rebuild needs no network for places already done.

usage: python3 build/enrich_famous.py          (from the offline-map folder; ~5 min the first time)
"""
import datetime, json, os, re, subprocess, time, urllib.parse

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, '..')
CACHE = os.path.join(HERE, 'famous-cache.json')
UA = 'google-plan-offline-map/1.0 (prototype build script)'
EXTRA = 4  # photos per place on top of the main one

def get(url, binary=False, tries=5):
    for i in range(tries):
        r = subprocess.run(['curl', '-sS', '-L', '--compressed', '--max-time', '60', '-A', UA, '-w', '\n%{http_code}', url], capture_output=True)
        body, _, code = r.stdout.rpartition(b'\n')
        if code == b'200':
            try: return body if binary else json.loads(body)
            except ValueError: pass
        if code == b'404': return None
        wait = 20 * (i + 1) if code == b'429' else 3 * (i + 1)
        print(f'  HTTP {code.decode() or "?"}, waiting {wait}s: {url[:80]}'); time.sleep(wait)
    return None

def api(host, **params):
    return get(f'https://{host}/w/api.php?' + urllib.parse.urlencode({'action': 'query', 'format': 'json', 'formatversion': 2, **params}))

# last 12 complete months
today = datetime.date.today().replace(day=1)
end = today - datetime.timedelta(days=1)
start = (end.replace(day=1) - datetime.timedelta(days=330)).replace(day=1)
PERIOD = f'{start:%b %Y} – {end:%b %Y}'

def pageviews(project, title):
    if not title: return 0
    t = urllib.parse.quote(title.replace(' ', '_'), safe='')
    j = get(f'https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/{project}/all-access/user/{t}/monthly/{start:%Y%m}0100/{end:%Y%m%d}00')
    return sum(x['views'] for x in (j or {}).get('items', []))

BAD = re.compile(r'(map|logo|icon|flag|seal|emblem|diagram|plan|locator|coat_of_arms|signature|svg)', re.I)
def candidates(title, commons_cat):
    """Photo file names: article images first (editor-chosen), then the Commons category."""
    files = []
    j = api('en.wikipedia.org', prop='images', titles=title, imlimit=100, redirects=1)
    for p in (j or {}).get('query', {}).get('pages', []):
        files += [i['title'][5:] for i in p.get('images', [])]
    if commons_cat:
        j = api('commons.wikimedia.org', list='categorymembers', cmtitle='Category:' + commons_cat, cmtype='file', cmlimit=60)
        files += [m['title'][5:] for m in (j or {}).get('query', {}).get('categorymembers', [])]
    seen, out = set(), []
    for f in files:
        if f in seen or not re.search(r'\.jpe?g$', f, re.I) or BAD.search(f): continue
        seen.add(f); out.append(f)
    return out

def imageinfo(files):
    out = {}
    for i in range(0, len(files), 50):
        j = api('commons.wikimedia.org', prop='imageinfo', iiprop='url|size|extmetadata', iiurlwidth=500, titles='|'.join('File:' + f for f in files[i:i + 50]))
        q = (j or {}).get('query', {})
        norm = {n['to']: n['from'] for n in q.get('normalized', [])}
        for p in q.get('pages', []):
            if p.get('imageinfo'): out[norm.get(p['title'], p['title'])[5:]] = p['imageinfo'][0]
        time.sleep(1)
    return out

strip = lambda s: re.sub(r'\s+', ' ', re.sub(r'<[^>]+>', '', s or '')).strip()

def fetch(area, det):
    keys = det['famous']; titles = {k: det['places'][k]['wikipedia'] for k in keys}
    # Wikidata: Commons category (P373) and the Japanese article title
    wd = {}
    tl = list(titles.values())
    for i in range(0, len(tl), 50):
        j = get('https://www.wikidata.org/w/api.php?' + urllib.parse.urlencode({'action': 'wbgetentities', 'format': 'json', 'sites': 'enwiki',
                'titles': '|'.join(tl[i:i + 50]), 'props': 'claims|sitelinks', 'sitefilter': 'enwiki|jawiki', 'normalize': 1}))
        for e in (j or {}).get('entities', {}).values():
            en = e.get('sitelinks', {}).get('enwiki', {}).get('title')
            if not en: continue
            cat = e.get('claims', {}).get('P373', [{}])[0].get('mainsnak', {}).get('datavalue', {}).get('value')
            wd[en] = {'commons': cat, 'ja': e.get('sitelinks', {}).get('jawiki', {}).get('title')}
        time.sleep(1)
    out = {}
    for n, k in enumerate(keys, 1):
        p = det['places'][k]; title = titles[k]; w = wd.get(title, {})
        main = urllib.parse.unquote(p['photo']['source'].rsplit('File:', 1)[-1]).replace('_', ' ')
        cands = [f for f in candidates(title, w.get('commons')) if f.replace('_', ' ') != main][:30]
        info = imageinfo(cands)
        gallery = []
        for f in cands:
            ii = info.get(f)
            if not ii or ii.get('width', 0) < 800 or ii.get('height', 0) < 500 or ii['width'] / ii['height'] > 2.2: continue  # skip small and panoramic
            md = ii.get('extmetadata', {})
            lic = strip(md.get('LicenseShortName', {}).get('value'))
            if not lic: continue
            path = f'photos/{k}-{len(gallery) + 1}.jpg'
            if not os.path.exists(os.path.join(ROOT, path)):
                data = get(ii['thumburl'], binary=True)
                if not data or data[:3] != b'\xff\xd8\xff': continue
                open(os.path.join(ROOT, path), 'wb').write(data); time.sleep(0.5)
            gallery.append({'file': path, 'author': strip(md.get('Artist', {}).get('value'))[:120], 'license': lic, 'source': ii.get('descriptionurl')})
            if len(gallery) == EXTRA: break
        en_v, ja_v = pageviews('en.wikipedia', title), pageviews('ja.wikipedia', w.get('ja'))
        out[k] = {'gallery': gallery, 'views': {'total': en_v + ja_v, 'en': en_v, 'ja': ja_v, 'period': PERIOD, 'jaTitle': w.get('ja')}}
        print(f'  {area} {n:2d}/{len(keys)} {title}: {len(gallery)} photos, {en_v + ja_v:,} views')
    return out

def main():
    cache = json.load(open(CACHE)) if os.path.exists(CACHE) else {}
    for area in ('tokyo', 'kyoto'):
        path = os.path.join(ROOT, 'data', f'details-{area}.json')
        det = json.load(open(path))
        det['famous'] = [k for k in det['famous'] if det['places'].get(k, {}).get('wikipedia')]  # a few famous ids lost their row in de-duplication
        if not all(k in cache for k in det['famous']):
            cache.update(fetch(area, {**det, 'famous': [k for k in det['famous'] if k not in cache]}))
            json.dump(cache, open(CACHE, 'w'), ensure_ascii=False, indent=0)
        for k in det['famous']:
            det['places'][k].update(cache[k])
        det = {**json.load(open(path)), 'places': det['places']}  # keep the original famous order list untouched
        det['attribution']['views'] = 'Popularity: Wikipedia page views (Wikimedia pageviews API), English + Japanese'
        json.dump(det, open(path, 'w'), ensure_ascii=False, separators=(',', ':'))
        print(f'{area}: {sum(len(cache[k]["gallery"]) for k in det["famous"] if k in cache)} gallery photos, {os.path.getsize(path) // 1024} KB')

if __name__ == '__main__':
    main()
