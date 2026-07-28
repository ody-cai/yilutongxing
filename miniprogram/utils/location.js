// utils/location.js
// 定位与地图工具：用微信原生能力，免高德 Key，坐标体系与后端一致（gcj02）。
// 注意：个人主体小程序类目通常不支持位置接口（getLocation/openLocation），
// 因此本模块所有调用均 fail-safe —— 失败时不抛错，自动降级为「复制地址」。
function getLocation() {
  return new Promise((resolve, reject) => {
    wx.getLocation({
      type: 'gcj02',
      success: (res) => resolve({ lat: res.latitude, lng: res.longitude }),
      // 个人号 / 未授权 / 未声明 requiredPrivateInfos 都会走到 fail
      fail: (err) => reject(err),
    });
  });
}

function copyAddress(addr) {
  if (!addr) return;
  wx.setClipboardData({
    data: addr,
    success: () => wx.showToast({ title: '地址已复制，去地图App粘贴', icon: 'none' }),
    fail: () => wx.showToast({ title: '复制失败，请手动记录地址', icon: 'none' }),
  });
}

// 唤起微信内置地图做步行/驾车导航（无需第三方 SDK）
// 个人号若不支持 openLocation，则降级为复制地址，保证用户仍能拿到位置信息。
function openStation(station) {
  if (!station) return;
  if (!station.location) {
    copyAddress(station.address); // 无坐标也能复制文字地址
    return;
  }
  wx.openLocation({
    latitude: station.location.lat,
    longitude: station.location.lng,
    name: station.name,
    address: station.address,
    scale: 16,
    fail: () => copyAddress(station.address), // 个人号受限兜底
  });
}

// Haversine 距离（米）
function distance(a, b) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(h)));
}

function formatDistance(m) {
  if (m == null) return '';
  if (m < 1000) return `${m}m`;
  return `${(m / 1000).toFixed(1)}km`;
}

module.exports = { getLocation, openStation, distance, formatDistance };
