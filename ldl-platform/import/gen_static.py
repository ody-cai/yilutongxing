"""把 import/stations_full.json(82条) 生成为前端可直接读取的静态 JSON。
- public/stations.json : 与后端 /api/stations 返回同构（data 形态），前端优先读取
- public/meta.json     : 设施/状态枚举
- public/stats.json    : 统计概览
这样前端不再依赖 *.workers.dev 实时接口，在国内网络也能正常显示。
"""
import json
from collections import Counter

SRC = 'import/stations_full.json'
FAC = {
    'drink': '饮水', 'ac': '空调', 'seat': '座椅', 'charging': '充电',
    'wifi': 'Wi-Fi', 'first_aid': '急救包', 'toilet': '厕所', 'microwave': '微波炉',
}
STAT = {'open': '开放中', 'closed': '已关闭', 'maintenance': '维护中'}

rows = json.load(open(SRC))
items = []
for i, r in enumerate(rows, 1):
    facs = r.get('facilities') or []
    items.append({
        'id': i,
        'name': r['name'],
        'address': r['address'],
        'district': r['district'],
        'street': r.get('street'),
        'location': {'lat': r['lat'], 'lng': r['lng']},
        'facilities': facs,
        'facility_labels': [{'key': f, 'label': FAC.get(f, f)} for f in facs],
        'status': r.get('status', 'open'),
        'status_label': STAT.get(r.get('status', 'open'), r.get('status', 'open')),
        'open_hours': r.get('open_hours', '24小时'),
        'contact_phone': r.get('contact_phone'),
        'manager': r.get('manager'),
        'capacity': r.get('capacity', 8),
        'description': r.get('description'),
        'verified': (r.get('verified') == 1),
        'distance_m': None,
        'updated_at': '2026-07-27 08:00:00',
        'created_at': '2026-07-27 08:00:00',
        'deleted_at': 0,
        'is_deleted': False,
    })

# 默认按区域排序（与后端无定位入参时一致）
items.sort(key=lambda s: s['district'])

stations = {'total': len(items), 'origin': None, 'items': items}
with open('public/stations.json', 'w', encoding='utf-8') as f:
    json.dump(stations, f, ensure_ascii=False, separators=(',', ':'))

meta = {
    'facilities': [{'key': k, 'label': v} for k, v in FAC.items()],
    'statuses': [{'key': k, 'label': v} for k, v in STAT.items()],
}
with open('public/meta.json', 'w', encoding='utf-8') as f:
    json.dump(meta, f, ensure_ascii=False, separators=(',', ':'))

bs = Counter(s['status'] for s in items)
bd = Counter(s['district'] for s in items)
stats = {
    'total': len(items),
    'by_status': [{'key': k, 'label': STAT.get(k, k), 'count': bs[k]} for k in STAT if bs[k]],
    'by_district': [{'district': d, 'count': c} for d, c in bd.most_common()],
}
with open('public/stats.json', 'w', encoding='utf-8') as f:
    json.dump(stats, f, ensure_ascii=False, separators=(',', ':'))

# 内联数据：以 <script> 引入，绕开 file:// 下 fetch 本地文件被浏览器拦截的限制
with open('public/stations-data.js', 'w', encoding='utf-8') as f:
    f.write('window.__LOCAL_STATIONS__ = ')
    json.dump(stations, f, ensure_ascii=False, separators=(',', ':'))
    f.write(';\n')
    f.write('window.__LOCAL_META__ = ')
    json.dump(meta, f, ensure_ascii=False, separators=(',', ':'))
    f.write(';\n')
    f.write('window.__LOCAL_STATS__ = ')
    json.dump(stats, f, ensure_ascii=False, separators=(',', ':'))
    f.write(';\n')

print(f'stations.json: {len(items)} 条, 覆盖 {len(bd)} 个区域')
print('districts:', dict(bd))
