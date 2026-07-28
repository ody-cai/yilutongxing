// utils/request.js
// 统一请求层：封装 wx.request 为 Promise，并适配后端 { ok, code, message, data } 响应信封。
// 后端地址：部署 Cloudflare Workers 后获得（在微信后台「request 合法域名」中配置）
const BASE_URL = 'YOUR_WORKER_URL';  // 替换为你的 Workers URL

function request(options, _retry = 0) {
  return new Promise((resolve, reject) => {
    wx.request({
      url: BASE_URL + options.url,
      method: options.method || 'GET',
      data: options.data,
      timeout: 10000,
      header: { 'content-type': 'application/json' },
      success(res) {
        const body = res.data;
        if (res.statusCode >= 200 && res.statusCode < 300 && body && body.ok) {
          resolve(body.data);
        } else {
          reject({
            code: body && body.code != null ? body.code : res.statusCode,
            message: (body && body.message) || '请求失败',
          });
        }
      },
      fail(err) {
        // 网络层失败自动重试 1 次
        if (_retry < 1) return resolve(request(options, _retry + 1));
        reject({ code: -1, message: '网络错误，请检查网络', detail: err });
      },
    });
  });
}

module.exports = { request, BASE_URL };
