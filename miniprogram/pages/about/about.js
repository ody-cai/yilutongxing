const { getStats } = require('../../services/station');
const { SITE_NAME, SITE_URL } = require('../../utils/config');

Page({
  data: {
    stats: null,
    siteName: SITE_NAME,
    siteUrl: SITE_URL,
  },

  onLoad() {
    getStats()
      .then((s) => this.setData({ stats: s }))
      .catch(() => {});
  },

  // 个人号无法直接打开外链，采用「复制链接」方案
  copySite() {
    wx.setClipboardData({
      data: this.data.siteUrl,
      success: () => {
        wx.showToast({ title: '链接已复制，去浏览器打开', icon: 'none' });
      },
    });
  },

  onShareAppMessage() {
    return {
      title: '「驿」路同行 — 高温劳动者护航行动',
      path: '/pages/about/about',
    };
  },
});
