# -*- coding: utf-8 -*-
"""
「驿」路同行 — 郑州市驿站导入构建脚本

功能：
  1. 读取手工整理的郑州市驿站清单（来自郑州市总工会官网 + 高德/腾讯地图 POI 公开检索）
  2. 对缺坐标的条目调用高德「Web服务」地理编码 API 批量补齐经纬度（GCJ-02，与高德前端一致）
  3. 生成 stations_full.json 与 import.sql（source='import'，verified=0）

用法：
  # 仅汇总（不编码，需要 Key 的条目标记为待编码）
  python build_import.py --summary

  # 用高德 Web 服务 Key 编码并生成 import.sql
  python build_import.py --key 你的高德Web服务Key

说明：
  高德地理编码返回 GCJ-02（火星坐标），与项目前端高德 JS API 及 seed 数据一致，
  故直接存储，不做 WGS-84 转换（避免地图标记偏移）。
"""

import json
import os
import sys
import time
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))

# ─────────────────────────── 原始清单 ───────────────────────────
# 每条：name 名称 / address 地址 / district 行政区 / street 路名(可选)
#       open_hours(可选) / contact(可选) / manager(可选) / lat,lng(已知则填)
# 坐标已知的（来自地图 POI 检索，GCJ-02）直接给出，其余留空待编码。
RAW = [
    # ---------- 高新区（多已带坐标） ----------
    dict(name="工会驿站(郑州高新区枫杨办事处便民服务大厅)", address="郑州市中原区石佛镇翠竹街1号53楼", district="高新区", lat=34.819187, lng=113.564525),
    dict(name="郑州工会驿站(郑州高新区华强商圈王屋路工会驿站)", address="郑州市中原区石佛镇王屋路游园内", district="高新区", lat=34.789937, lng=113.601265),
    dict(name="工会驿站(郑州高新区石楠路乐恩阅读成长中心)", address="郑州市中原区枫杨街道石楠路藤松里路金兰西景苑北门", district="高新区", lat=34.809372, lng=113.549941),
    dict(name="郑州市郑州银行高新区小微支行工会驿站", address="郑州市中原区郑州高新技术产业开发区长椿路11号19号楼1层1号", district="高新区", lat=34.789483, lng=113.547476, contact="0371-55269597"),
    dict(name="工会驿站(郑州高新区雪松路河南优德大药房)", address="郑州市中原区石佛镇冬青街与雪松路交叉口正北92米", district="高新区", lat=34.802189, lng=113.556127),
    dict(name="郑州高新区科学大道佳乐房地产营销策划工会驿站", address="郑州市中原区石佛镇科学大道657号", district="高新区", lat=34.807532, lng=113.569266, contact="187****2336"),
    dict(name="张仲景郑州市高新区电厂西路工会驿站", address="郑州市中原区石佛镇电厂南路与王屋路交叉口向北200米", district="高新区", lat=34.801319, lng=113.60254),
    dict(name="工会驿站(郑州高新区凯旋路河南云充新能源科技)", address="郑州市高新区凯旋路河南云充新能源科技有限公司", district="高新区"),

    # ---------- 巩义市 ----------
    dict(name="巩义市工会户外劳动者爱心驿站", address="巩义市回郭镇长春路9号", district="巩义市", lat=34.688505, lng=112.876458),
    dict(name="巩义服务站河南公路爱心驿站", address="巩义市大峪沟镇院内东侧一楼休息室", district="巩义市", lat=34.764408, lng=113.10256, contact="138****5596", open_hours="周一至周五 09:00-17:00"),
    dict(name="巩义万洋商贸城工会户外劳动者驿站", address="巩义市杜甫路街道杜甫路173-1号", district="巩义市", lat=34.741902, lng=112.971839, contact="158****6066", open_hours="周一至周五 08:30-12:00,13:00-17:30"),
    dict(name="巩义市孝义街道火车站社区户外劳动者工会驿站", address="巩义市孝义街道孝义路38号", district="巩义市", lat=34.759483, lng=112.97701, contact="0371-56906513"),
    dict(name="工会驿站(巩义市嵩山路学院社区便民服务中心)", address="巩义市紫荆路街道嵩山路学院社区恒星花园42号楼北侧", district="巩义市", lat=34.759331, lng=113.019775, contact="0371-64203669"),
    dict(name="巩义市小关镇政府便民服务中心户外劳动者工会驿站", address="巩义市小关镇改新中路18号", district="巩义市", lat=34.706187, lng=113.171498, contact="156****5062", open_hours="周一至周五 09:00-17:00"),
    dict(name="工会驿站(巩义市鲁庄镇商业街广场)", address="巩义市鲁庄镇鲁庄村商业街广场7号", district="巩义市", lat=34.617204, lng=112.873391, contact="139****7169", open_hours="周一至周五 08:00-12:00,14:00-18:00"),
    dict(name="巩义市新华路街道大钟楼社区中国黄金户外劳动者工会驿站", address="巩义市新华路街道新华路262号", district="巩义市", lat=34.755621, lng=112.983801),
    dict(name="巩义市青龙山党群服务中心户外劳动者工会驿站", address="巩义市北山口镇北山口路与望嵩路辅路交叉口西南", district="巩义市", lat=34.727581, lng=112.999721),
    dict(name="巩义市大峪沟镇便民服务中心户外劳动者工会驿站", address="巩义市大峪沟镇政通街17号", district="巩义市", lat=34.71361, lng=113.097237, contact="0371-64057961", open_hours="周一至周五 09:00-17:00"),
    dict(name="巩义市杜甫路街道桐本南路社区便民服务中心户外劳动者爱心驿站", address="巩义市杜甫路街道桐本南路社区便民服务中心", district="巩义市"),
    dict(name="巩义市龙尾村便民服务中心户外劳动者爱心驿站", address="巩义市龙尾村便民服务中心", district="巩义市"),
    dict(name="巩义市二十里村通桥路孝义街道便民服务中心户外劳动者爱心驿站", address="巩义市二十里村通桥路孝义街道便民服务中心", district="巩义市"),

    # ---------- 经开区 ----------
    dict(name="工会驿站(郑州市高新技术创业中心)", address="郑州市经济技术开发区明湖街道航海东路1356号", district="经开区", lat=34.721381, lng=113.756998),
    dict(name="郑州经济技术开发区航海东路中原福塔户外劳动者爱心驿站", address="郑州市经济技术开发区航海东路中原福塔", district="经开区"),

    # ---------- 中原区 / 二七区（来自地图 POI，需编码） ----------
    dict(name="工会驿站(郑州市张仲景大药房互助路店)", address="郑州市中原区林山寨街道互助路28号楼1单元1号", district="中原区", contact="0371-67718779", open_hours="07:30-22:30"),
    dict(name="工会驿站(河南工会·嵩山医院)", address="郑州市中原区林山寨街道工人路31号", district="中原区"),
    dict(name="工会驿站(郑州银行郑州市中原区伊河路)", address="郑州市中原区伊河路与工人路西南角", district="中原区"),
    dict(name="中原银行郑州工人路支行工会驿站", address="郑州市中原区林山寨街道工人路中原银行", district="中原区"),
    dict(name="郑州市张仲景大药房工人中路店工会驿站", address="郑州市中原区林山寨街道工人路23号", district="中原区", contact="0371-67956331;0371-60223349", open_hours="08:00-22:00"),
    dict(name="郑州移动中原路工会驿站", address="郑州市二七区大学路街道中原路103号附14号", district="二七区", contact="0371-60124604"),
    dict(name="郑州市张仲景大药房豫欣生活小区分店工会驿站", address="郑州市中原区工人路74-3号", district="中原区"),
    dict(name="郑州电信二七区中原路营业厅工会驿站", address="郑州市二七区大学路街道中原路郑大北门西隔壁", district="二七区", contact="193****8889", open_hours="08:00-18:30"),
    dict(name="农情暖域工会驿站", address="郑州市中原区陇海西路50号", district="中原区"),
    dict(name="工会驿站(郑品书舍)", address="郑州市中原区建设路街道桐柏北路桐柏路197号院", district="中原区", open_hours="周一至周五 09:00-20:00"),
    dict(name="郑州市职工中心文体驿站郑州工会驿站", address="郑州市中原区建设西路125号", district="中原区"),
    dict(name="工会驿站(郑州市职工服务中心)", address="郑州市中原区建设路126号东配楼1楼", district="中原区", contact="0371-67883273", open_hours="08:30-19:30"),
    dict(name="工会驿站(郑州市职工之家)", address="郑州市中原区建设西路35号", district="中原区"),
    dict(name="工会驿站(郑州市二七区棉纺路苏宁易购店)", address="郑州市二七区棉纺东路23号苏宁易购店内", district="二七区", contact="186****5790", open_hours="09:00-20:00"),
    dict(name="郑州银行郑州市中原区中原路支行工会驿站", address="郑州市中原区中原西路43号", district="中原区"),
    dict(name="郑州市中原区绿东村街道办事处工会驿站", address="郑州市中原区绿东村街道颍河路53号一楼110", district="中原区", open_hours="08:00-12:00,14:00-16:00"),
    dict(name="郑州市中原区文化宫路正合口腔工会驿站", address="郑州市中原区林山寨街道文化宫路14-7号", district="中原区", open_hours="08:30-12:00,14:00-17:30"),
    dict(name="郑州市中原区三棉东社区党群服务中心工会驿站", address="郑州市中原区棉纺路街道绿化东街7号楼对面(三厂医院大门南侧)", district="中原区"),
    dict(name="棉纺路环卫中转站户外劳动者环卫工驿站", address="郑州市中原区棉纺路街道棉纺西路185号", district="中原区"),

    # ---------- 火车站片区（来自调研报告，需编码） ----------
    dict(name="郑州工会爱心驿站·蜜蜂张街道办事处", address="郑州市二七区中原东路127号", district="二七区"),
    dict(name="郑州民生耳鼻喉医院户外劳动者爱心驿站", address="郑州市二七区中原东路125号", district="二七区", open_hours="08:00-20:00"),
    dict(name="郑州市二七区铭功路西后街户外劳动者爱心驿站", address="郑州市二七区铭功路西后街", district="二七区", open_hours="工作日开放"),
    dict(name="管城区爱心驿站(南大街佳苑小区)", address="郑州市管城回族区南大街28号佳苑小区", district="管城回族区", open_hours="工作日开放"),
    dict(name="郑州市工会爱心驿站(商城路220号)", address="郑州市管城回族区商城路220号", district="管城回族区"),
    dict(name="郑州市工会爱心驿站(商城路206号)", address="郑州市管城回族区商城路206号", district="管城回族区"),
    dict(name="金水工会杜岭户外劳动者爱心驿站", address="郑州市金水区杜岭街28号", district="金水区", open_hours="05:00-17:30"),
    dict(name="张仲景大药房人民路店工会驿站", address="郑州市金水区人民路", district="金水区", open_hours="07:30-22:30"),
    dict(name="二七京广烟酒商贸驿站", address="郑州市二七区京广中路93号", district="二七区", open_hours="08:45-23:45"),

    # ---------- 管城回族区（city8 / 报告） ----------
    dict(name="工会户外劳动者爱心驿站(管城街社区)", address="郑州市管城回族区紫荆山路62号兴达国贸一楼", district="管城回族区"),
    dict(name="郑州市管城回族区紫荆山南路工会驿站", address="郑州市管城回族区紫荆山南路", district="管城回族区"),

    # ---------- 上街区 ----------
    dict(name="上街区中心路工会驿站(金苑社区党群服务中心旁)", address="郑州市上街区中心路97号", district="上街区", open_hours="24小时"),
    dict(name="工会户外劳动者爱心驿站(上街区新乡路香园街社区)", address="郑州市上街区市场街与新乡路交叉口西南", district="上街区"),
    dict(name="上街区新建街东段困难职工帮扶中心户外劳动者爱心驿站", address="郑州市上街区新建街东段上街区困难职工帮扶中心", district="上街区"),
    dict(name="上街区济源路中段商业街社区户外劳动者爱心驿站", address="郑州市上街区济源路中段商业街社区", district="上街区"),

    # ---------- 惠济区 ----------
    dict(name="惠济区古须路纪公庙村户外劳动者爱心驿站", address="郑州市惠济区古须路纪公庙村", district="惠济区"),
    dict(name="惠济区兴隆社区工会驿站", address="郑州市惠济区兴隆社区", district="惠济区"),
    dict(name="惠济区迎宾路街道万达广场工会驿站", address="郑州市惠济区迎宾路街道万达广场", district="惠济区"),

    # ---------- 金水区 ----------
    dict(name="金水区文雅党群服务中心户外劳动者爱心驿站", address="郑州市金水区文雅党群服务中心", district="金水区"),
    dict(name="金水区南阳新村街道便民服务中心户外劳动者爱心驿站", address="郑州市金水区南阳新村街道便民服务中心", district="金水区"),
    dict(name="金水区南阳新村街道翠花社区户外劳动者爱心驿站", address="郑州市金水区南阳新村街道翠花社区", district="金水区"),
    dict(name="郑州银行郑州市金水区黄河路支行户外劳动者爱心驿站", address="郑州市金水区黄河路支行", district="金水区"),
    dict(name="郑州银行郑州市金水区花园路支行户外劳动者爱心驿站", address="郑州市金水区花园路支行", district="金水区"),
    dict(name="金水区人民路街道东里路爱心驿站", address="郑州市金水区人民路街道东里路35号", district="金水区", open_hours="08:30-18:00"),

    # ---------- 二七区（其余） ----------
    dict(name="郑州银行郑州市二七区京广南路支行户外劳动者爱心驿站", address="郑州市二七区京广南路郑州银行", district="二七区"),
    dict(name="大学路街道工心驿站", address="郑州市二七区勤劳街与桃源路交叉口东南角", district="二七区", open_hours="24小时"),
    dict(name="郑州热力集团南区供热分公司客服中心户外劳动者爱心驿站", address="郑州市二七区淮河路郑州热力南区供热分公司客服中心", district="二七区"),

    # ---------- 郑东新区 ----------
    dict(name="郑州联化集团商都路加气站户外劳动者爱心驿站", address="郑州市郑东新区商都路加气站", district="郑东新区"),

    # ---------- 新密市 ----------
    dict(name="新密市青屏街街道金博大环卫工人服务站户外劳动者爱心驿站", address="新密市青屏街街道金博大", district="新密市"),
    dict(name="新密市青屏街街道梁沟社区党群服务中心户外劳动者爱心驿站", address="新密市青屏街街道梁沟社区党群服务中心", district="新密市"),
    dict(name="工会户外劳动者爱心驿站(新密市西大街金巴斗购物中心)", address="新密市青屏大街西段178号郑州金巴斗购物中心", district="新密市"),

    # ---------- 荥阳市 ----------
    dict(name="农商银行荥阳市康泰路支行户外劳动者爱心驿站", address="荥阳市康泰路农商银行", district="荥阳市"),
    dict(name="工会户外劳动者爱心驿站(荥阳郊野公园)", address="荥阳市陇海路与塔山路交叉口向北一公里路西", district="荥阳市"),
    dict(name="工会户外劳动者爱心驿站(荥阳广场办)", address="荥阳市索河路西边人民广场", district="荥阳市"),

    # ---------- 新郑市 ----------
    dict(name="新郑市困难职工帮扶中心户外劳动者爱心驿站", address="新郑市困难职工帮扶中心", district="新郑市"),
    dict(name="新郑市中华路家可美家政服务有限公司户外劳动者爱心驿站", address="新郑市中华路家可美家政服务有限公司", district="新郑市"),

    # ---------- 中牟县 ----------
    dict(name="中牟县青年路街道绿云社区党群服务中心户外劳动者爱心驿站", address="中牟县青年路街道绿云社区党群服务中心", district="中牟县"),
    dict(name="中牟县狼城岗镇党群服务中心农民工服务站户外劳动者爱心驿站", address="中牟县狼城岗镇党群服务中心", district="中牟县"),
    dict(name="工会户外劳动者爱心驿站(中牟县恒业家电店北环路店)", address="中牟县老县城解放路与北环路交叉口东南角", district="中牟县"),

    # ---------- 航空港区 ----------
    dict(name="工会户外劳动者爱心驿站(中国银行郑州航空港区新港大道支行)", address="郑州市航空港区新港大道与S102省道交叉口西南角", district="航空港区"),
]


# ─────────────────────────── 推断字段 ───────────────────────────
def infer_facilities(name):
    n = name
    if "环卫" in n or "中转站" in n:
        return ["drink", "seat", "charging"]
    if any(k in n for k in ["银行", "药房", "电信", "移动", "营业厅", "超市", "购物中心", "家电", "商贸", "加油站", "加气站"]):
        return ["drink", "seat", "charging"]
    if any(k in n for k in ["党群", "便民", "服务中心", "职工", "书院", "书屋", "社区", "驿站"]):
        return ["drink", "ac", "seat", "charging", "wifi", "first_aid"]
    return ["drink", "seat", "charging"]


def infer_open_hours(name, entry):
    if entry.get("open_hours"):
        return entry["open_hours"]
    if "24小时" in name or "工心驿站" in name or "东广场" in name:
        return "24小时"
    if "银行" in name:
        return "周一至周五 09:00-17:00"
    if "药房" in name or "张仲景" in name:
        return "07:30-22:30"
    if any(k in name for k in ["党群", "便民", "服务中心", "社区"]):
        return "08:00-20:00"
    return "08:00-20:00"


def infer_manager(name, district):
    if "银行" in name:
        return "银行网点"
    if "药房" in name or "张仲景" in name:
        return "张仲景大药房"
    if "电信" in name or "移动" in name:
        return "运营商营业厅"
    if any(k in name for k in ["党群", "社区", "街道", "办事处", "便民", "服务中心"]):
        return f"{district}街道/社区"
    return f"{district}总工会"


def infer_capacity(name):
    if any(k in name for k in ["职工", "党群", "服务中心", "书院"]):
        return 12
    if "环卫" in name or "中转站" in name:
        return 6
    return 8


# ─────────────────────────── 地理编码 ───────────────────────────
def geocode(key, address, city="郑州"):
    q = urllib.parse.urlencode({"key": key, "address": address, "city": city})
    url = "https://restapi.amap.com/v3/geocode/geo?" + q
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "curl/8.0"})
        with urllib.request.urlopen(req, timeout=10) as r:
            data = json.loads(r.read().decode("utf-8"))
        if data.get("status") == "1" and data.get("geocodes"):
            loc = data["geocodes"][0]["location"]  # "lng,lat"
            lng, lat = (float(x) for x in loc.split(","))
            return lat, lng
    except Exception as e:
        print(f"  [geocode fail] {address}: {e}", file=sys.stderr)
    return None, None


# ─────────────────────────── 主流程 ───────────────────────────
def main():
    args = sys.argv[1:]
    do_summary = "--summary" in args
    key = None
    if "--key" in args:
        i = args.index("--key")
        key = args[i + 1] if i + 1 < len(args) else None

    stations = []
    need_geocode = []
    for e in RAW:
        has_coord = e.get("lat") and e.get("lng")
        rec = {
            "name": e["name"],
            "address": e["address"],
            "district": e["district"],
            "street": e.get("street"),
            "lat": e.get("lat"),
            "lng": e.get("lng"),
            "facilities": infer_facilities(e["name"]),
            "status": "open",
            "open_hours": infer_open_hours(e["name"], e),
            "contact_phone": e.get("contact"),
            "manager": infer_manager(e["name"], e["district"]),
            "capacity": infer_capacity(e["name"]),
            "description": "联网检索整理（郑州市总工会官网/地图POI），坐标" + ("已核实(地图POI)" if has_coord else "待地理编码"),
            "source": "import",
            "verified": 0,
        }
        if not has_coord:
            need_geocode.append(rec)
        stations.append(rec)

    # 去重（按 name+address）
    seen = set()
    dedup = []
    for s in stations:
        kk = (s["name"], s["address"])
        if kk in seen:
            continue
        seen.add(kk)
        dedup.append(s)
    stations = dedup

    if key and need_geocode:
        print(f"→ 正在用高德 Web 服务 Key 编码 {len(need_geocode)} 条缺失坐标...", file=sys.stderr)
        for s in need_geocode:
            lat, lng = geocode(key, s["address"])
            if lat and lng:
                s["lat"], s["lng"] = lat, lng
                s["description"] = "联网检索整理（郑州市总工会官网/地图POI），坐标经高德地理编码"
            else:
                s["description"] = "联网检索整理，坐标地理编码失败（待人工补）"
            time.sleep(0.25)  # 限流

    # 写出 JSON
    with_coord = sum(1 for s in stations if s.get("lat") and s.get("lng"))
    out_json = os.path.join(HERE, "stations_full.json")
    with open(out_json, "w", encoding="utf-8") as f:
        json.dump(stations, f, ensure_ascii=False, indent=2)

    print(f"条目总数: {len(stations)} | 已有/已编码坐标: {with_coord} | 待编码: {len(stations) - with_coord}", file=sys.stderr)

    if do_summary or not key:
        # 仅汇总，不生成 SQL
        by_district = {}
        for s in stations:
            by_district.setdefault(s["district"], 0)
            by_district[s["district"]] += 1
        print("按行政区分布:", file=sys.stderr)
        for d, c in sorted(by_district.items(), key=lambda x: -x[1]):
            print(f"  {d}: {c}", file=sys.stderr)
        print(f"\nJSON 已写出: {out_json}", file=sys.stderr)
        return

    # 生成 import.sql
    sql_path = os.path.join(HERE, "import.sql")
    lines = []
    lines.append("-- ============================================")
    lines.append("-- 「驿」路同行 — 郑州市驿站批量导入（联网检索整理）")
    lines.append("-- 执行: wrangler d1 execute ldl-yizhan-db --file=import.sql [--env=production]")
    lines.append("-- 注意: 坐标存 GCJ-02，与高德前端一致；verified=0 表示未实地核实")
    lines.append("-- ============================================\n")
    for s in stations:
        if not (s.get("lat") and s.get("lng")):
            # 没有坐标的不写入（避免地图标记出错），提示人工补
            print(f"  [skip no coord] {s['name']}", file=sys.stderr)
            continue
        fac = json.dumps(s["facilities"], ensure_ascii=False)
        def q(v):
            if v is None:
                return "NULL"
            return "'" + str(v).replace("'", "''") + "'"
        lines.append(
            "INSERT INTO stations (name, address, district, street, lat, lng, facilities, "
            "status, open_hours, contact_phone, manager, capacity, description, source, verified) VALUES ("
            + ", ".join([
                q(s["name"]), q(s["address"]), q(s["district"]), q(s["street"]),
                str(s["lat"]), str(s["lng"]), q(fac), q(s["status"]), q(s["open_hours"]),
                q(s["contact_phone"]), q(s["manager"]), str(s["capacity"]), q(s["description"]),
                q(s["source"]), "0",
            ]) + ");"
        )
    with open(sql_path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    print(f"\nimport.sql 已生成: {sql_path}（含 {sum(1 for s in stations if s.get('lat') and s.get('lng'))} 条有坐标）", file=sys.stderr)


if __name__ == "__main__":
    main()
