const { getStation } = require('../../services/station');
const location = require('../../utils/location');

Page({
  data: {
    id: null,
    station: null,
    loading: true,
    canUseLocation: false, // 个人号下为 false，按钮显示为「复制地址」
  },

  onLoad(options) {
    this.setData({ id: options.id });
    this.load();
  },

  async load() {
    this.setData({ loading: true });
    try {
      // 探测定位能力：组织号可用，个人号会 fail
      let canUseLocation = false;
      let loc = null;
      try {
        loc = await location.getLocation();
        canUseLocation = true;
      } catch (e) {}

      const station = await getStation(
        this.data.id,
        loc ? { lat: loc.lat, lng: loc.lng } : {}
      );
      const hasMeta = !!(
        station.open_hours ||
        station.district ||
        station.capacity ||
        station.contact_phone ||
        station.description
      );
      this.setData({ station, loading: false, canUseLocation, hasMeta });
    } catch (e) {
      wx.showToast({ title: '加载失败', icon: 'none' });
      this.setData({ loading: false });
    }
  },

  navigate() {
    // openStation 内部已做 fail-safe：个人号自动降级为复制地址
    if (this.data.station) location.openStation(this.data.station);
  },

  goFeedback() {
    wx.navigateTo({ url: `/pages/feedback/feedback?station_id=${this.data.id}` });
  },

  onShareAppMessage() {
    const s = this.data.station || {};
    return { title: s.name || '歇脚驿站', path: `/pages/detail/detail?id=${this.data.id}` };
  },
});
