const { submitFeedback } = require('../../services/station');

Page({
  data: {
    stationId: '',
    stationName: '',
    message: '',
    kind: 'suggestion',
    submitting: false,
  },

  onLoad(options) {
    if (options.station_id) {
      this.setData({ stationId: options.station_id });
    }
  },

  onInput(e) {
    const field = e.currentTarget.dataset.field;
    this.setData({ [field]: e.detail.value });
  },

  chooseKind(e) {
    this.setData({ kind: e.currentTarget.dataset.kind });
  },

  async onSubmit() {
    const { message, kind, stationId } = this.data;
    if (!message || message.trim().length < 1) {
      wx.showToast({ title: '请填写反馈内容', icon: 'none' });
      return;
    }
    this.setData({ submitting: true });
    try {
      await submitFeedback({
        message: message.trim(),
        kind,
        station_id: stationId ? Number(stationId) : undefined,
      });
      wx.showToast({ title: '提交成功，感谢！', icon: 'success' });
      this.requestNotify();
      setTimeout(() => {
        if (wx.getStorageSync('feedback_from_detail')) {
          wx.removeStorageSync('feedback_from_detail');
        }
        wx.navigateBack();
      }, this.data.stationId ? 1000 : 1000);
    } catch (e) {
      wx.showToast({ title: (e && e.message) || '提交失败', icon: 'none' });
    } finally {
      this.setData({ submitting: false });
    }
  },

  // 留言后申请订阅消息（模板需在微信后台「订阅消息」中申请并填到 tmplId）
  requestNotify() {
    const tmplId = '';
    if (!tmplId) return;
    wx.requestSubscribeMessage({
      tmplIds: [tmplId],
      success() {},
      fail() {},
    });
  },
});
