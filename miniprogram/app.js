const sync = require('./utils/sync');

App({
  globalData: {
    baseUrl: 'YOUR_WORKER_URL',  // 替换为你的 Cloudflare Workers 地址
    userLocation: null,
    privacyAuthorized: false,
  },

  onLaunch() {
    // 微信基础库 2.32.3+ 对位置等敏感接口要求隐私授权弹窗
    if (typeof wx.requirePrivacyAuthorize === 'function') {
      wx.requirePrivacyAuthorize({
        success: () => { this.globalData.privacyAuthorized = true; },
        fail: () => {},
      });
    }
    // 启动即静默增量同步，保证首屏有数据（离线也能用本地缓存）
    sync.smartSync().catch(() => {});
    // 反馈为匿名提交，不采集、不存储任何用户信息（openid 等），故无静默登录
  },
});
