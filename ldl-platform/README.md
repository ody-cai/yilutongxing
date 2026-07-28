# 「驿」路同行 — 环卫工人歇脚驿站地图平台

> 项目组：「驿」路同行 — 高温劳动者护航行动（全国中学生领导力大赛）
> 站点标识：`ldl-yizhan`（项目内前缀）
> 技术：Cloudflare Workers（D1 / API） + 静态前端（EdgeOne Pages / Cloudflare Pages）

---

## 一、功能总览

| 模块 | 说明 |
|---|---|
| 驿站列表 | 卡片式展示，含名称、状态、地址、设施、距离 |
| 地图标注 | 高德地图 JS API v2.0，支持 Marker + 自动视野适配 |
| 距离排序 | 用户授权定位后，按距用户最近排序 |
| 详情查看 | 底部抽屉：地址、设施、容量、描述、联系方式 |
| 导航跳转 | 一键唤起高德地图 App/Web 步行导航 |
| 状态实时 | 写操作由后端校验，列表每 5 分钟自动刷新（手动按刷新按钮即时） |
| 用户反馈 | 匿名提交至后端，项目组整理后递交工会 / 城管 |
| 管理后门 | 通过 `X-Admin-Token` 切换状态，token 仅存浏览器 localStorage |
| 一键报修 | **闭环**：驿站详情内「一键报修」→ 工单（待处理/处理中/已修复）→ 进度在「报修」页与驿站卡片可见；报修中驿站标记红点，立即提升使用率 |
| 权益自助站 | **工会专属**：凭专属口令解锁 8 项户外劳动者权益（高温津贴/清凉包/体检/法律援助等），口令校验在服务端，源码不含明文，别人抄不走，汇报最加分 |
| 选址众包 | 市民/劳动者在「驾驶舱」地图点选推荐新点位 + 理由，提交进入审核流（待审核/考察中/已采纳/未采纳） |
| 数据驾驶舱 | **扩点有依据、领导有数**：一屏掌握驿站/报修/众包聚合指标、区域覆盖、近期动态与建议地图 |

---

## 二、目录结构

```
ldl-platform/
├── wrangler.toml            # Cloudflare Workers 配置
├── schema.sql               # D1 数据库表结构
├── seed.sql                 # 郑州市驿站示例数据（15 个）
├── workers/
│   └── api/
│       └── index.ts         # 后端 API（Cloudflare Workers）
├── public/                  # 前端静态资源
│   ├── index.html
│   ├── styles.css
│   ├── app.js
│   └── assets/
│       ├── logo.png         # 项目组 logo（小牛 IP）
│       ├── logo.jpg
│       └── favicon.svg
└── README.md
```

---

## 三、本地预览（无需 Cloudflare 账号）

### 3.1 仅预览前端

```bash
cd ldl-platform/public
python3 -m http.server 5173
# 浏览器打开 http://localhost:5173
```

> ⚠️ 此时 API 请求会失败（因为没起后端），地图标注会是空的；可在 app.js 中临时指向演示数据。

### 3.2 全栈本地起（推荐）

需要 Node.js 22+ 与 npm。

```bash
# 1) 启动后端模拟器
npx wrangler dev --local --port 8787 --persist-to .wrangler/state

# 2) 启动前端静态服务器（另一终端）
cd public && python3 -m http.server 5173

# 3) 配置前端 API base
#    编辑 public/index.html，把
#      window.__API_BASE__ = '';
#    改为
#      window.__API_BASE__ = 'http://localhost:8787';
```

访问 `http://localhost:5173` 即可看到完整功能。

---

## 四、生产部署

### 4.1 后端（Cloudflare Workers + D1）

```bash
# 1) 安装 wrangler
npm install -g wrangler
wrangler login

# 2) 创建 D1 数据库
wrangler d1 create ldl-yizhan-db
# 把输出的 database_id 填到 wrangler.toml 的 database_id 字段

# 3) 初始化表结构与种子数据
wrangler d1 execute ldl-yizhan-db --file=./schema.sql
wrangler d1 execute ldl-yizhan-db --file=./seed.sql --env=production

# 4) 设置管理员 token（敏感，存为 secret）
wrangler secret put ADMIN_TOKEN
# 按提示输入 token（建议 ≥ 32 位随机字符串）

# 4.5) 增量迁移：新增「报修工单」「选址众包」两张表（幂等，可重复执行）
wrangler d1 execute ldl-yizhan-db --file=./migrate.sql --env=production

# 4.6) 设置权益自助站「工会专属」口令（可选；不设则用默认口令 YIZHAN2026）
wrangler secret put BENEFITS_PASSCODE
# 按提示输入口令，建议易分发、难猜测，由各区总工会/项目组分发

# 5) 部署
wrangler deploy
# 输出示例：Published ldl-yizhan-api (x.xx sec)
#         https://ldl-yizhan-api.<your-subdomain>.workers.dev
```

把得到的 URL 填到前端 `index.html` 的 `window.__API_BASE__`。

### 4.2 前端（EdgeOne Pages / Cloudflare Pages）

**方式 A · EdgeOne Pages**

```bash
cd ldl-platform/public
npx edgeone pages deploy . --name your-project-name
```

**方式 B · Cloudflare Pages**

```bash
cd ldl-platform/public
npx wrangler pages deploy . --project-name your-project-name
```

---

## 五、高德地图 Key 配置

> ✅ 请在高德开放平台 https://lbs.amap.com/ 申请「Web端(JS API)」Key 后填入此处

### 5.1 先确认 Key 类型（这一步最容易配错）

浏览器里的 `<script src="https://webapi.amap.com/maps?v=2.0...">` **必须使用「服务平台：Web端(JS API)」的 Key**。
你截图里显示「绑定服务：Web服务」，这是 Web 服务 API 类型，不能直接用于浏览器 JS 地图；请在同一应用里点击「添加Key」，新建一个服务平台为 **Web端(JS API)** 的 Key。

创建 JS API Key 后，还必须同时获取安全密钥 `securityJsCode`：

### 5.2 若地图不显示 / 控制台报 `INVALID_USER_SCODE`

高德官方说明：2021 年 12 月 2 日之后创建的 Key 必须配套安全密钥。处理方式二选一：

**方式 A · 配置安全密钥（推荐，先用于本地验证）**
1. 登录 [高德控制台](https://console.amap.com/dev/key/app) → 找到「Web端(JS API)」Key → 复制对应的**安全密钥**
2. 填入 `public/index.html`（注意：必须在高德脚本标签之前设置）：
   ```js
   window.__AMAP_SECURITY__ = '你的安全密钥';
   ```
3. 刷新页面；若仍报错，检查 Key 的域名白名单是否包含当前访问域名。

**方式 B · 代理转发（生产更安全）**
在服务端做一层 `/_AMapService` 代理，安全密钥不暴露到前端，再配置：
```js
window._AMapSecurityConfig = { serviceHost: '你的代理域名/_AMapService' };
```

### 5.3 域名白名单

上线后请在高德控制台给该 Key 添加**域名白名单**（如你的部署域名），
避免 Key 被他人盗用。本地调试可临时加 `localhost`。

---

## 六、API 文档

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET  | `/api/health`               | —  | 健康检查 |
| GET  | `/api/meta`                 | —  | 获取设施/状态枚举 |
| GET  | `/api/stations`             | —  | 列表，支持 `?status=&district=&facility=&lat=&lng=` |
| GET  | `/api/stations/:id`         | —  | 详情 |
| POST | `/api/stations/:id/status`  | ✅  | 修改状态，body `{ status, note }` |
| POST | `/api/feedback`             | —  | 提交反馈 |
| GET  | `/api/stats`                | —  | 统计 |
| POST | `/api/admin/stations`       | ✅  | 新增驿站 |
| POST | `/api/stations/:id/reports` | —  | 一键报修（提交工单） |
| GET  | `/api/stations/:id/reports` | —  | 某驿站报修列表 |
| GET  | `/api/reports`              | —  | 报修工单列表（`?status=new,acknowledged`） |
| POST | `/api/reports/:id/status`   | ✅  | 处理报修（new/acknowledged/resolved） |
| POST | `/api/suggestions`          | —  | 提交选址众包建议 |
| GET  | `/api/suggestions`          | —  | 选址建议列表（`?status=`/`?district=`） |
| POST | `/api/suggestions/:id/status` | ✅ | 处理建议（pending/reviewing/accepted/rejected） |
| GET  | `/api/dashboard`            | —  | 数据驾驶舱聚合（驿站/报修/众包/近期动态） |
| POST | `/api/benefits/verify`      | —  | 权益自助站口令校验，通过下发工会专属权益 |

> 鉴权方式：HTTP header `X-Admin-Token: <token>`，与 `wrangler secret put ADMIN_TOKEN` 设置的值一致。

---

## 七、数据安全设计

1. **前端零信任**：所有写入均经后端 API 校验，前端仅展示；前端无法直接修改数据库。
2. **敏感字段**：管理员 token 走 Cloudflare Secret，不进仓库。
3. **审计追踪**：`station_events` 表记录所有状态变更，可回溯「谁、何时、从什么改到什么」。
4. **CORS**：默认 `*`，生产建议在 wrangler.toml 中改为具体前端域名。
5. **API 输入校验**：所有写接口均在 Workers 端做白名单校验（status、坐标范围、字段长度）。

---

## 八、自定义与扩展

- **新增驿站**：POST `/api/admin/stations`，或在 Cloudflare D1 控制台直接 `INSERT INTO stations ...`
- **新增设施**：在前端 `FACILITY_SVG` / `FACILITY_LABEL` 与 `workers/api/index.ts` 的 `FACILITY_LABELS` 各加一行即可。
- **接入其他地图**：当前仅高德；如需百度/腾讯，请重写 `initMap` 与 `placeMarkers`，其它逻辑无影响。

---

## 九、关于项目前缀

部署到 EdgeOne Pages 或 Cloudflare Pages 时使用自定义项目名，会自动得到对应的 `.edgeone.app` 或 `.pages.dev` 子域名。

---

## 十、部署后

| 服务 | 说明 |
|---|---|
| 前端 | 部署到 Cloudflare Pages 或 EdgeOne Pages |
| 后端 API（Workers） | 部署到 Cloudflare Workers，D1 数据库需提前初始化 |
| 健康检查 | `GET /api/health` 返回 `{ ok:true }` |

部署后将 Workers URL 填入 `public/index.html` 的 `window.__API_BASE__`，CORS 默认已放开（`*`）。

### 自定义域名

若需绑定自定义域名，在 Cloudflare Pages 控制台「Custom domains」添加即可。Cloudflare Pages 项目名不能含小数点，域名中的点号需替换为连字符。

---

## 十一、小程序数据同步接口

为微信小程序提供独立的同步接口（前缀 `/api/mp/*`），支持**增量同步**（带 `since` 时间戳 + 软删除感知），小程序首次拉全量、之后只拉增量，省流量且实时。

- 接口 Base：部署 Workers 后获得
- 完整文档与调用示例：**`docs/MINIPROGRAM_API.md`**
- 接入要点：在微信公众平台「服务器域名 → request 合法域名」添加 Workers URL（仅域名、需 https）；真机必须配置，开发期可勾选「不校验合法域名」。
- 写操作（创建/删除/改状态）需 `X-Admin-Token`，仅网站后台使用，**不要下发到小程序**。

---

## 十二、二期新增功能（2026-07-27）

底部新增四宫格导航：**地图 · 报修 · 权益 · 驾驶舱**，首页「地图」保持原有体验不变。

### 1. 一键报修（闭环，立刻提升使用率）
- 驿站详情页点「一键报修」→ 选设施 + 填故障 → 提交即生成工单。
- 工单状态：`待处理 → 处理中 → 已修复`，进度在「报修」页全程可见。
- 有未闭环报修的驿站，列表卡片与地图标点显示「报修中」红点徽标。
- 管理员在「报修」页凭 `X-Admin-Token` 一键「标记已修复」完成闭环。

### 2. 权益自助站（工会专属，别人抄不走）
- 入口「权益」页，凭**工会专属口令**解锁 8 项户外劳动者权益（高温津贴、清凉包、免费体检、法律援助、技能培训、困难帮扶、意外保险、驿站就近权益）。
- 口令在服务端校验（`POST /api/benefits/verify`），权益内容不下发前端源码，未授权访客看不到 —— 天然「抄不走」，汇报最加分。
- 口令通过 `wrangler secret put BENEFITS_PASSCODE` 设置（不设则默认 `YIZHAN2026`）。

### 3. 驿站选址众包 + 数据驾驶舱（扩点有依据、领导有数）
- 「驾驶舱」页一屏聚合：驿站总数/开放数、报修待处理、选址建议数、状态分布、区域覆盖 Top8、报修闭环、众包状态、近期动态。
- 选址众包：在驾驶舱地图点选推荐点位 + 填理由提交，进入审核流；建议点位实时打点在地图上。

> 新增数据表见 `migrate.sql`（已上线库执行一次即可，幂等）；完整建表见 `schema.sql`。

---

> 最后更新：2026-07-27
> 项目联系：「驿」路同行项目组（全国中学生领导力大赛参赛队伍）