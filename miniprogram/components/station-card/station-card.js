Component({
  properties: {
    station: {
      type: Object,
      value: {},
      // WXML 不支持方法调用（如 .toFixed()），距离格式化放这里算好字符串
      observer(station) {
        this.formatDistance(station);
      },
    },
    showDistance: { type: Boolean, value: true },
    showFacilities: { type: Boolean, value: true },
  },
  data: {
    distanceLabel: '',
  },
  lifetimes: {
    attached() {
      // 兜底：属性 observer 可能早于首屏数据初始化，这里再算一次
      this.formatDistance(this.data.station);
    },
  },
  methods: {
    formatDistance(station) {
      const dm = station && station.distance_m;
      let label = '';
      if (dm != null && typeof dm === 'number') {
        label = dm < 1000 ? `${dm}m` : `${(dm / 1000).toFixed(1)}km`;
      }
      this.setData({ distanceLabel: label });
    },
    onTap() {
      const id = this.data.station && this.data.station.id;
      if (id != null) {
        wx.navigateTo({ url: `/pages/detail/detail?id=${id}` });
      }
    },
  },
});
