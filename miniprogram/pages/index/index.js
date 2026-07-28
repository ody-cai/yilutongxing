const sync = require('../../utils/sync');
const location = require('../../utils/location');

Page({
  data: {
    stations: [],
    keyword: '',
    tab: 'all',
    center: { lat: 34.747, lng: 113.665 },
    scale: 11,
    markers: [],
    loading: true,
    hasLocation: false,
    canUseLocation: false, // 个人号/未授权时为 false，自动降级为「全部+搜索」
    showLocTip: false,     // 冷启动定位提示弹窗
  },

  // 全量缓存，搜索时从中过滤，避免越过滤越窄
  allStations: [],

  onLoad() {
    this.loadData();
    this.detectLocation();
    this.showLocTip(); // 冷启动：提示暂未开通定位（可手动关闭，5 秒自动消失）
  },

  // 冷启动弹窗：告知用户当前暂不支持自动定位与一键导航
  showLocTip() {
    this.setData({ showLocTip: true });
    if (this._locTipTimer) clearTimeout(this._locTipTimer);
    this._locTipTimer = setTimeout(() => {
      this.setData({ showLocTip: false });
    }, 5000);
  },

  // 用户主动关闭（点 × / 我知道了 / 遮罩）
  closeLocTip() {
    if (this._locTipTimer) clearTimeout(this._locTipTimer);
    this.setData({ showLocTip: false });
  },

  onHide() {
    if (this._locTipTimer) clearTimeout(this._locTipTimer);
  },

  onUnload() {
    if (this._locTipTimer) clearTimeout(this._locTipTimer);
  },

  onReady() {
    this.mapCtx = wx.createMapContext('map');
    this.fitMap();
    // 双保险：onReady 时首屏 setData 可能尚未完成，下一帧再框选一次
    wx.nextTick(() => this.fitMap());
  },

  async loadData() {
    this.setData({ loading: true });
    // 离线优先：首屏立即渲染本地缓存或内置兜底数据，不等网络（避免后端 502 白屏）
    this.allStations = sync.getLocalOrBundled();
    this.renderStations();
    // 再后台同步最新数据
    try {
      const list = await sync.smartSync();
      this.allStations = list || [];
    } catch (e) {
      if (!this.allStations.length) this.allStations = sync.getBundledStations();
      wx.showToast({ title: '网络异常，已显示本地数据', icon: 'none' });
    } finally {
      this.setData({ loading: false });
      this.renderStations();
    }
  },

  // 探测定位能力：组织号可用，个人号会 fail → 降级
  async detectLocation() {
    try {
      const loc = await location.getLocation();
      this.setData({ center: loc, hasLocation: true, canUseLocation: true });
      this.renderStations();
    } catch (e) {
      // 个人号 / 拒绝授权：保持「全部列表 + 搜索」模式
      this.setData({ hasLocation: false, canUseLocation: false, tab: 'all' });
    }
  },

  renderStations() {
    let stations = (this.allStations || []).slice();

    // 关键词过滤（名称 / 区域 / 地址），个人号首屏即靠它找驿站
    const kw = (this.data.keyword || '').trim().toLowerCase();
    if (kw) {
      stations = stations.filter((s) =>
        [s.name, s.district, s.address].some((f) => (f || '').toLowerCase().includes(kw))
      );
    }

    // 仅当定位可用且处于「附近」tab 时按距离排序
    if (this.data.tab === 'nearby' && this.data.canUseLocation) {
      stations = stations
        .map((s) => ({ ...s, distance_m: location.distance(this.data.center, s.location) }))
        .sort((a, b) => (a.distance_m || 0) - (b.distance_m || 0));
    }

    const markers = stations.map((s) => ({
      id: s.id,
      latitude: s.location.lat,
      longitude: s.location.lng,
      title: s.name,
      iconPath: '/assets/marker.png',
      width: 32,
      height: 40,
      anchor: { x: 0.5, y: 1 },
    }));
    // 关键：includePoints 命令式 API 必须在 setData 真正完成（地图节点拿到 markers）后调用，
    // 否则真机上首屏地图会停在默认视图、看不到标记（看起来像"地图没了"）
    this.setData({ stations, markers }, () => {
      this.fitMap();
    });
  },

  // 自动框选所有标记，保证 82 个驿站都在屏幕内（避免默认缩放太近看不到）
  fitMap() {
    if (!this.mapCtx) return;
    const points = this.data.markers.map((m) => ({ latitude: m.latitude, longitude: m.longitude }));
    if (points.length) {
      this.mapCtx.includePoints({ points, padding: [60, 60, 60, 60] });
    }
  },

  onSearchInput(e) {
    this.setData({ keyword: e.detail.value });
    this.renderStations();
  },

  switchTab(e) {
    const tab = e.currentTarget.dataset.tab;
    if (tab === 'nearby' && !this.data.canUseLocation) return; // 个人号屏蔽「附近」
    if (tab === this.data.tab) return;
    this.setData({ tab });
    this.renderStations();
  },

  onMarkerTap(e) {
    const id = e.detail && e.detail.markerId;
    if (id != null) wx.navigateTo({ url: `/pages/detail/detail?id=${id}` });
  },

  onPullDownRefresh() {
    this.loadData().then(() => wx.stopPullDownRefresh());
  },

  onShareAppMessage() {
    return {
      title: '「驿」路同行 — 找到离你最近的歇脚驿站',
      path: '/pages/index/index',
    };
  },

  onShareTimeline() {
    return { title: '「驿」路同行 — 户外劳动者的清凉地图', query: '' };
  },
});
