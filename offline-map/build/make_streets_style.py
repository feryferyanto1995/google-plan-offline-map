"""Make data/style-streets.json: the bundled OpenMapTiles style recoloured to look like Mapbox Streets v12.

Only colours, label fonts and casing are changed. It uses the same offline tiles, glyphs and sprite as
../claude-prototype/data/style.json, so nothing new is downloaded and no Mapbox data or token is used.
The palette values are read off the public Streets v12 style (a reference look, not its assets).

usage: python3 build/make_streets_style.py   (from the offline-map folder)
"""
import json, os

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, '..', '..', 'claude-prototype', 'data', 'style.json')
OUT = os.path.join(HERE, '..', 'data', 'style-streets.json')

LAND = ['interpolate', ['linear'], ['zoom'], 9, 'hsl(20, 20%, 95%)', 11, 'hsl(20, 18%, 91%)']
PARK = 'hsl(110, 52%, 81%)'
WOOD = 'hsla(115, 55%, 74%, 0.8)'
WATER = 'hsl(200, 100%, 80%)'
WHITE = 'hsl(0, 0%, 100%)'
CASE = 'hsl(220, 20%, 85%)'          # grey casing of ordinary streets
CASE_TUNNEL = 'hsl(220, 13%, 72%)'
CASE_MAJOR = 'hsl(220, 20%, 97%)'    # near-white casing of motorways and trunks
MOTORWAY = 'hsl(30, 100%, 70%)'
MOTORWAY_LOW = 'hsl(30, 88%, 64%)'
TRUNK = 'hsl(50, 89%, 70%)'
RAIL = ['interpolate', ['linear'], ['zoom'], 13, 'hsl(35, 25%, 82%)', 16, 'hsl(220, 4%, 71%)']
INK = 'hsl(220, 30%, 0%)'
HALO = 'hsl(20, 25%, 100%)'
FONT = ['Noto Sans Regular']
POI_COLOUR = ['match', ['get', 'class'],
    ['restaurant', 'fast_food', 'cafe', 'bar', 'beer', 'ice_cream', 'bakery'], 'hsl(40, 95%, 43%)',
    ['park', 'garden', 'playground', 'campsite', 'zoo'], 'hsl(110, 70%, 28%)',
    ['school', 'college', 'university', 'library', 'kindergarten'], 'hsl(30, 50%, 43%)',
    ['hospital', 'doctors', 'pharmacy', 'dentist', 'veterinary'], 'hsl(0, 70%, 58%)',
    ['stadium', 'pitch', 'sports', 'swimming', 'golf'], 'hsl(190, 60%, 48%)',
    ['lodging', 'bank', 'post', 'fuel', 'parking', 'car', 'town_hall', 'police', 'fire_station'], 'hsl(260, 70%, 63%)',
    ['museum', 'art_gallery', 'theatre', 'cinema', 'attraction', 'monument', 'castle', 'place_of_worship', 'religion', 'historic', 'music', 'aquarium'], 'hsl(320, 70%, 63%)',
    ['shop', 'grocery', 'clothing_store', 'alcohol_shop', 'books', 'gift', 'jewelry', 'shoe', 'electronics', 'hardware', 'furniture', 'florist', 'department_store', 'mall'], 'hsl(210, 70%, 58%)',
    'hsl(210, 20%, 46%)']

def trunk_or(other):  # OpenMapTiles puts trunk and primary in one layer: trunk yellow, primary white
    return ['match', ['get', 'class'], 'trunk', TRUNK, other]

FILL = {  # layer id → {paint prop: value}
    'background': {'background-color': LAND},
    'park': {'fill-color': 'hsl(110, 60%, 80%)', 'fill-outline-color': 'hsl(110, 60%, 80%)', 'fill-opacity': 1},
    'landcover_wood': {'fill-color': WOOD, 'fill-opacity': 1},
    'landcover_grass': {'fill-color': PARK, 'fill-opacity': 0.8},
    'landcover_sand': {'fill-color': 'hsl(52, 65%, 86%)'},
    'landcover_ice': {'fill-color': 'hsl(200, 70%, 90%)'},
    'landuse_pitch': {'fill-color': 'hsl(100, 70%, 85%)'},
    'landuse_track': {'fill-color': 'hsl(100, 70%, 85%)'},
    'landuse_cemetery': {'fill-color': 'hsl(110, 48%, 85%)'},
    'landuse_hospital': {'fill-color': 'hsl(0, 50%, 92%)'},
    'landuse_school': {'fill-color': 'hsl(40, 50%, 88%)'},
    'water': {'fill-color': WATER},
    'waterway_river': {'line-color': WATER}, 'waterway_other': {'line-color': WATER}, 'waterway_tunnel': {'line-color': WATER},
    'aeroway_fill': {'fill-color': 'hsl(225, 52%, 87%)'},
    'aeroway_runway': {'line-color': 'hsl(225, 52%, 87%)'}, 'aeroway_taxiway': {'line-color': 'hsl(225, 52%, 87%)'},
    'building': {'fill-color': 'hsl(20, 15%, 85%)', 'fill-outline-color': 'hsl(20, 10%, 79%)'},
    'building-3d': {'fill-extrusion-color': 'hsl(20, 15%, 85%)'},
    'boundary_2': {'line-color': 'hsl(240, 50%, 60%)'}, 'boundary_3': {'line-color': 'hsl(240, 50%, 65%)'},
    'boundary_disputed': {'line-color': 'hsl(240, 50%, 60%)'},
}
HIDE = {'landuse_residential', 'natural_earth', 'park_outline'}  # Streets leaves these unshaded

def fade_in(colour, z0, z1):
    # Below z0 a casing is drawn white, so a street whose fill hasn't started yet still reads as a thin
    # white line on the warm-grey land (the Streets look) instead of a grey speckle.
    return ['interpolate', ['linear'], ['zoom'], z0, WHITE, z1, colour]

def road_paint(lid):
    tunnel = lid.startswith('tunnel_')
    if 'rail' in lid: return {'line-color': RAIL}
    if lid.endswith('_casing'):
        if 'motorway' in lid: return {'line-color': CASE_MAJOR}
        case = CASE_TUNNEL if tunnel else CASE
        if 'trunk_primary' in lid:  # zoom must be the outermost expression, so the class match goes inside each stop
            by = lambda c: ['match', ['get', 'class'], 'trunk', CASE_MAJOR, c]
            return {'line-color': ['interpolate', ['linear'], ['zoom'], 11, by(WHITE), 13, by(case)]}
        if 'secondary_tertiary' in lid or '_link_' in lid: return {'line-color': fade_in(case, 11, 13)}
        return {'line-color': fade_in(case, 13.8, 14.6)}  # minor, street, service, path casings
    if 'motorway_link' in lid: return {'line-color': 'hsl(30, 100%, 80%)' if tunnel else MOTORWAY}
    if 'motorway' in lid:
        if tunnel: return {'line-color': 'hsl(30, 100%, 80%)'}
        return {'line-color': ['step', ['zoom'], MOTORWAY_LOW, 9, MOTORWAY]}
    if 'trunk_primary' in lid: return {'line-color': trunk_or(WHITE) if not tunnel else ['match', ['get', 'class'], 'trunk', 'hsl(50, 78%, 80%)', WHITE]}
    if lid.endswith('_link'): return {'line-color': trunk_or(WHITE)}
    return {'line-color': WHITE}

def main():
    s = json.load(open(SRC))
    s['name'] = 'Offline Streets (Mapbox Streets v12 look, OpenMapTiles data)'
    for l in s['layers']:
        lid, p, lay = l['id'], l.setdefault('paint', {}), l.setdefault('layout', {})
        if lid in HIDE: lay['visibility'] = 'none'; continue
        if lid in FILL: p.update(FILL[lid])
        # Streets keeps the land plain until street level, then fades buildings in. The source style draws
        # flat 'building' below z14 and 'building-3d' from z14, so hide the first and start the second at z15.
        if lid == 'building': lay['visibility'] = 'none'; continue
        if lid == 'building-3d':
            l['minzoom'] = 15
            p['fill-extrusion-opacity'] = ['interpolate', ['linear'], ['zoom'], 15, 0, 16, 0.9]
            p['fill-extrusion-height'] = 0; p['fill-extrusion-base'] = 0  # flat footprints, like Streets
        if lid in FILL: continue
        if l.get('source-layer') == 'transportation' and l['type'] == 'line': p.update(road_paint(lid)); continue
        if l['type'] != 'symbol': continue
        # labels
        p['text-halo-color'] = HALO; p['text-halo-width'] = 1.2; p['text-halo-blur'] = 0
        if lid.startswith('poi_r'):
            p['text-color'] = POI_COLOUR; lay['text-font'] = FONT; lay['text-size'] = 11
        elif lid == 'poi_transit':
            p['text-color'] = 'hsl(225, 60%, 58%)'; lay['text-font'] = FONT
        elif lid.startswith('highway-name'):
            p['text-color'] = 'hsl(0, 0%, 0%)'; lay['text-font'] = FONT
        elif lid in ('waterway_line_label', 'water_name_point_label', 'water_name_line_label'):
            p['text-color'] = 'hsl(200, 68%, 57%)'; p['text-halo-color'] = 'hsla(20, 17%, 100%, 0.5)'; lay['text-font'] = FONT
        elif lid == 'label_other':  # neighbourhoods: spaced-out caps in slate blue, like "HATSUDAI"
            p['text-color'] = 'hsl(220, 30%, 40%)'; p['text-halo-color'] = 'hsla(20, 25%, 100%, 0.75)'
            lay['text-font'] = FONT; lay['text-transform'] = 'uppercase'; lay['text-letter-spacing'] = 0.15
        elif lid.startswith('label_'):
            p['text-color'] = INK
            if 'Italic' in json.dumps(lay.get('text-font', '')): lay['text-font'] = FONT
        elif lid == 'airport':
            p['text-color'] = 'hsl(225, 60%, 58%)'; lay['text-font'] = FONT
    json.dump(s, open(OUT, 'w'), ensure_ascii=False, separators=(',', ':'))
    print('wrote', os.path.relpath(OUT), os.path.getsize(OUT) // 1024, 'KB')

if __name__ == '__main__':
    main()
