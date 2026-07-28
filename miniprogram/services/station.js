// services/station.js
// 驿站业务接口封装，全部对接后端 /api/mp/* 前缀。
const { request } = require('../utils/request');

const listStations = (params = {}) => request({ url: '/api/mp/stations', data: params });

const getStation = async (id, params = {}) => {
  try {
    return await request({ url: `/api/mp/stations/${id}`, data: params });
  } catch (e) {
    // 后端故障兜底：从内置数据按 id 查找，保证详情可打开
    const BUNDLED = require('../data/stations');
    const found = BUNDLED.find((s) => String(s.id) === String(id));
    if (found) return found;
    throw e;
  }
};

const nearby = (lat, lng, radius = 3000, status) =>
  request({
    url: `/api/mp/nearby?lat=${lat}&lng=${lng}&radius=${radius}${
      status ? '&status=' + status : ''
    }`,
  });

const getMeta = () => request({ url: '/api/mp/meta' });

const getStats = () => request({ url: '/api/mp/stats' });

const submitFeedback = async (payload) => {
  // 纯匿名提交：不采集、不传递任何用户信息（openid / 联系方式）
  return request({
    url: '/api/mp/feedback',
    method: 'POST',
    data: payload,
  });
};

module.exports = { listStations, getStation, nearby, getMeta, getStats, submitFeedback };
