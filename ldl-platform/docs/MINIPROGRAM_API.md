# 小程序数据同步接口文档

> 「驿」路同行 — 高温劳动者护航行动 · 环卫工人歇脚驿站平台
> 给微信小程序调取 / 同步网站数据专用接口（前缀 `/api/mp/*`）

---

## 一、基础信息

| 项 | 值 |
|---|---|
| Base URL | `YOUR_WORKER_URL`（部署 Cloudflare Workers 后获得） |
| 统一响应 | `{ ok, code, message, data }` |
| 时间格式 | **Unix 秒（UTC）**，如 `1753584000`，便于增量比较 |
| 鉴权 | 读取类接口**公开**，无需 token；写操作（管理员）走 `X-Admin-Token`，小程序不应内置 |
| CORS | 已放开 `*`；小程序 `wx.request` 不受浏览器同源限制，但需在微信后台配「request 合法域名」 |

> 所有时间（驿站 `updated_at`、接口返回的 `server_time` / `since` / `latest_updated_at`）均为 **UTC Unix 秒**，小程序端直接整数比较即可，避免时区问题。

---

## 二、接口一览

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/mp/sync` | **增量同步核心**：拉取自 `since` 以来新增/更新/删除的驿站 |
| GET | `/api/mp/stations` | 列表 / 搜索 / 筛选（支持分页、距离排序） |
| GET | `/api/mp/stations/:id` | 驿站详情 |
| GET | `/api/mp/nearby` | 附近驿站（经纬度 + 半径） |
| GET | `/api/mp/meta` | 设施 / 状态枚举值 |
| GET | `/api/mp/stats` | 各区 / 各状态统计 |
| GET | `/api/mp/version` | 轻量版本探测（总数 + 最新更新时间），判断是否需全量刷新 |
| POST | `/api/mp/feedback` | 提交一线反馈（匿名，服务端校验 + 内容安全） |
| POST | `/api/mp/login` | 小程序登录：wx.login 的 code 换 openid（**当前匿名模式未启用**，预留给组织号 + 内容安全 v2） |

---

## 三、增量同步策略（重点）

小程序应在本地 `Storage` / 本地数据库缓存驿站数据，并**定期与网站同步**，而不是每次进页面全量请求。

### 首次启动
```
GET /api/mp/sync?since=0&limit=200
```
- 返回全部未删除驿站（`items`），并带 `has_more`。
- 若 `has_more=true`，继续 `offset` 翻页直到 `has_more=false`，全部写入本地。
- 记下本次返回的 `server_time`。

### 日常同步（后台定时 / 下拉刷新）
```
GET /api/mp/sync?since=<上次保存的 server_time>
```
- 只返回**自该时间以来变化**的驿站，流量极小。
- 对每条 `items` 做 Upsert：
  - `is_deleted === true` → 本地删除该 `id`；
  - 否则按 `id` 插入或更新。
- 用本次返回的 `server_time` 覆盖本地保存值。

### 返回字段说明
| 字段 | 含义 |
|---|---|
| `server_time` | 服务端当前 Unix 秒，下次同步作为 `since` |
| `since` | 本次请求的 `since` 回显 |
| `has_more` | 是否还有下一页（用于翻页） |
| `next_offset` | 下一页 `offset`（为 `null` 表示到底） |
| `items[]` | 变化记录数组，含 `is_deleted` 标记 |

---

## 四、各接口详情

### 1. GET /api/mp/sync — 增量同步
**Query**
| 参数 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `since` | 否 | `0` | Unix 秒，只返回此时间之后变化的记录 |
| `limit` | 否 | `200` | 单页条数，最大 500 |
| `offset` | 否 | `0` | 分页偏移 |

**返回示例**
```json
{
  "ok": true, "code": 0, "message": "ok",
  "data": {
    "server_time": 1753584000,
    "since": 1753580000,
    "has_more": false,
    "next_offset": null,
    "items": [
      {
        "id": 1,
        "name": "火车站东广场工会驿站",
        "address": "二七区火车站东广场",
        "district": "二七区",
        "location": { "lat": 34.747, "lng": 113.665 },
        "facilities": ["drink", "ac", "seat", "toilet", "first_aid"],
        "status": "open",
        "status_label": "开放中",
        "open_hours": "24小时",
        "distance_m": null,
        "verified": true,
        "is_deleted": false,
        "updated_at": "2026-07-27 03:00:00",
        "deleted_at": 0
      },
      {
        "id": 99,
        "name": "已撤销的旧驿站",
        "is_deleted": true,
        "deleted_at": 1753583000
      }
    ]
  }
}
```

### 2. GET /api/mp/stations — 列表 / 搜索
**Query**：`status`(open/closed/maintenance)、`district`、`keyword`(名称/地址/街道模糊)、`lat`、`lng`(传则按距离升序)、`limit`、`offset`

**返回** `{ total, offset, limit, server_time, items[] }`

### 3. GET /api/mp/stations/:id — 详情
**Query**：`lat`、`lng`（可选，返回该用户到驿站的距离）

### 4. GET /api/mp/nearby — 附近驿站
**Query**：`lat`(必填)、`lng`(必填)、`radius`(米，默认 3000，最大 50000)、`status`(可选)
**返回** `{ origin, radius, server_time, items[] }`（按距离升序，已过滤半径内）

### 5. GET /api/mp/meta — 枚举
**返回** `{ facilities:[{key,label}], statuses:[{key,label}] }`，用于小程序渲染筛选器与图标。

### 6. GET /api/mp/stats — 统计
**返回** `{ total, by_status:[{key,label,count}], by_district:[{district,count}] }`

### 7. GET /api/mp/version — 版本探测
**返回** `{ total, deleted, latest_updated_at, server_time }`
- 小程序可缓存 `latest_updated_at`，下次先调本接口对比，若相等则无需拉数据。

### 8. POST /api/mp/feedback — 提交反馈
**Body**（JSON）
| 字段 | 必填 | 说明 |
|---|---|---|
| `message` | 是 | 反馈内容，1–500 字 |
| `station_id` | 否 | 关联驿站 id |
| `contact` | 否 | 联系方式（≤60 字） |
| `kind` | 否 | `suggestion`/`issue`/`praise`，默认 `suggestion` |

**返回** `{ received: true }`

> ⚠️ **内容安全（匿名）**：服务端在写入前会调用微信 `msgSecCheck` 同步模式（`version=1`，**不依赖 openid**，前端全程匿名、不采集任何用户信息）对 `message` 做文本审核。命中敏感词返回 `403 {"message":"内容包含敏感信息，请修改后重试"}`。微信接口异常时放行（fail-open），避免误伤用户；未配置 `WX_APPID`/`WX_APPSECRET` 密钥或 `WX_SECURITY_DISABLE=1` 时跳过校验。

### 9. POST /api/mp/login — 小程序登录（换 openid）
> **状态：当前匿名模式未启用。** 反馈接口已改为纯匿名提交，不再上传 openid，故前端不再调用本接口。此处仅保留，供将来升级到「组织号 + 内容安全 v2（需 openid）」时启用。

前端 `wx.login()` 拿到 `code` 后调用本接口，后端用 `code2session` 换取 `openid` 返回（用于上述内容安全校验）。`session_key` 不下发前端。

**Body**（JSON）
| 字段 | 必填 | 说明 |
|---|---|---|
| `code` | 是 | `wx.login()` 返回的临时登录凭证 |

**返回** `{ openid, unionid? }`

> 未配置 `WX_APPID`/`WX_APPSECRET` 时返回占位 `openid: "dev_no_wx_config"`（仅本地联调，不触发内容安全校验）。生产请通过 `wrangler secret put WX_APPID WX_APPSECRET` 注入真实密钥。

---

## 五、微信小程序接入要点（必看）

1. **配置 request 合法域名**
   登录 [微信公众平台](https://mp.weixin.qq.com/) → 开发 → 开发管理 → 开发设置 → 服务器域名 → **request 合法域名** 添加：
   ```
   YOUR_WORKER_URL
   ```
   > 只填域名、必须是 https、不带路径。保存后约 5 分钟生效。

2. **开发期调试**：微信开发者工具可勾选「不校验合法域名、TLS 版本以及 HTTPS 证书」，但**真机预览/发布必须配置第 1 步**。

3. **调用示例**
   ```js
   // 增量同步
   const lastSync = wx.getStorageSync('last_sync') || 0;
   wx.request({
     url: 'YOUR_WORKER_URL/api/mp/sync',
     data: { since: lastSync, limit: 200 },
     success(res) {
       if (!res.data.ok) return;
       const { items, server_time, has_more } = res.data.data;
       // upsert 到本地：is_deleted=true 则删，否则存
       items.forEach(s => upsertLocal(s));
       wx.setStorageSync('last_sync', server_time);
     }
   });
   ```

4. **不要在小程序内置管理员 Token**：创建 / 删除 / 改状态等写操作需 `X-Admin-Token`，仅由网站管理后台使用，切勿下发到小程序端。

---

## 六、错误码

| HTTP | code | 含义 |
|---|---|---|
| 200 | 0 | 成功（`ok:true`） |
| 200 | 非 0 | 业务失败，看 `message`（`ok:false`） |
| 400 | 400 | 参数错误 |
| 401 | 401 | 需要管理员鉴权（仅写操作） |
| 404 | 404 | 资源不存在 |
| 500 | 500 | 服务器内部错误 |

> 小程序建议：所有请求统一判 `res.data.ok`，失败弹 `res.data.message`；网络层失败走 `wx.request` 的 `fail` 做重试。
