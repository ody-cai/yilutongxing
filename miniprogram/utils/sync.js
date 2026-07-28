// utils/sync.js
// 增量同步管理器：首次拉全量（since=0），之后用 server_time 做增量；
// 本地用 Storage 缓存（数据量小，几十~几百条足够），离线也能展示。
// 离线优先：内置 82 条驿站兜底（data/stations.js），后端故障（如 502）时保证可用。
const { request } = require('./request');
const BUNDLED = require('../data/stations');

const SYNC_KEY = 'mp_stations_cache';
const SINCE_KEY = 'mp_last_sync';
const VER_KEY = 'mp_latest_updated_at';

function loadCache() {
  return wx.getStorageSync(SYNC_KEY) || {};
}
function saveCache(map) {
  wx.setStorageSync(SYNC_KEY, map);
}
function getCachedStations() {
  return Object.values(loadCache());
}

// 本地优先：有缓存用缓存，无缓存用内置兜底（首屏秒显，不等网络）
function getLocalOrBundled() {
  const cached = getCachedStations();
  return cached.length ? cached : BUNDLED.slice();
}

// 把内置兜底写入缓存，使后续离线/弱网直接命中
function fallbackBundled() {
  const map = {};
  BUNDLED.forEach((it) => { map[it.id] = it; });
  saveCache(map);
  return BUNDLED.slice();
}

// 增量同步：since 不变，按 offset 翻页直到 has_more=false
async function syncIncremental() {
  const since = wx.getStorageSync(SINCE_KEY) || 0;
  const map = loadCache();
  let offset = 0;
  while (true) {
    const data = await request({
      url: `/api/mp/sync?since=${since}&limit=200&offset=${offset}`,
    });
    (data.items || []).forEach((it) => {
      if (it.is_deleted) delete map[it.id];
      else map[it.id] = it;
    });
    if (!data.has_more) {
      wx.setStorageSync(SINCE_KEY, data.server_time);
      break;
    }
    offset = data.next_offset != null ? data.next_offset : offset + 200;
  }
  saveCache(map);
  return Object.values(map);
}

// 智能同步：先调 /version 比对 latest_updated_at，无变化直接返回本地缓存；
// 任意网络失败或返回空，均降级为内置兜底（写入缓存供离线复用）。
async function smartSync() {
  try {
    const ver = await request({ url: '/api/mp/version' });
    const last = wx.getStorageSync(VER_KEY);
    if (last && last === ver.latest_updated_at && getCachedStations().length) {
      return getCachedStations();
    }
    wx.setStorageSync(VER_KEY, ver.latest_updated_at);
    const list = await syncIncremental();
    if (list && list.length) return list;
    return fallbackBundled(); // 后端返回空，兜底
  } catch (e) {
    const cached = getCachedStations();
    if (cached.length) return cached; // 优先用本地缓存
    return fallbackBundled();         // 缓存空则用内置数据
  }
}

module.exports = {
  syncIncremental,
  smartSync,
  getCachedStations,
  getLocalOrBundled,
  getBundledStations: () => BUNDLED.slice(),
  loadCache,
  saveCache,
};
