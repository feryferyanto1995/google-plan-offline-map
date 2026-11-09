"""Fill in Japanese Wikipedia views in build/famous-cache.json (titles via the English article's language links),
then re-run enrich_famous.py to merge. usage: python3 build/fix_ja_views.py"""
import json, os, sys, time, urllib.parse
sys.argv = sys.argv[:1]
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import enrich_famous as E

cache = json.load(open(E.CACHE))
titles = {}
for area in ('tokyo', 'kyoto'):
    d = json.load(open(os.path.join(E.ROOT, 'data', f'details-{area}.json')))
    for k in cache:
        if k in d['places'] and d['places'][k].get('wikipedia'): titles[k] = d['places'][k]['wikipedia']
tl = sorted(set(titles.values())); ja = {}
for i in range(0, len(tl), 50):
    j = E.api('en.wikipedia.org', prop='langlinks', lllang='ja', lllimit='max', redirects=1, titles='|'.join(tl[i:i + 50]))
    q = (j or {}).get('query', {}); back = {r['to']: r['from'] for r in q.get('redirects', []) + q.get('normalized', [])}
    for p in q.get('pages', []):
        if p.get('langlinks'): ja[back.get(p['title'], p['title'])] = p['langlinks'][0]['title']
    time.sleep(1)
print(f'{len(ja)}/{len(tl)} Japanese titles')
for k, t in titles.items():
    v = cache[k]['views']; v['jaTitle'] = ja.get(t)
    v['ja'] = E.pageviews('ja.wikipedia', v['jaTitle']); v['total'] = v['en'] + v['ja']
    time.sleep(0.2)
json.dump(cache, open(E.CACHE, 'w'), ensure_ascii=False, indent=0)
print('missing ja:', [titles[k] for k in titles if not cache[k]['views']['jaTitle']])
E.main()
