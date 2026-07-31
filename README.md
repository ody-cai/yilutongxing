# 「驿」路同行 · 街角的清凉 / YiLuTongXing · Cool Corner

[![荣誉](https://img.shields.io/badge/荣誉-全国中学生领导力大赛%20五星项目-gold.svg)](https://github.com/ody-cai/yilutongxing)
[![分类](https://img.shields.io/badge/项目分类-帮扶弱势群体-blue.svg)](https://github.com/ody-cai/yilutongxing)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Web%20%7C%20WeChat%20Mini%20Program-green.svg)]()

> 🏆 **全国中学生领导力大赛 · 五星项目**（赛事最高荣誉等级）| National Student Leadership Competition · Five-Star Project (top honor)
>
> 🎯 项目分类：帮扶弱势群体 | Category: Supporting Vulnerable Groups
>
> 📛 完整获奖名称：帮扶弱势群体方案设计和实践示范 项目

---

[English](#english) | [中文](#chinese)

---

## <a name="chinese"></a>🇨🇳 中文

### 项目简介

「驿」路同行是一个为户外劳动者（环卫工人、快递员、外卖骑手等）打造的驿站数字服务平台。通过一张可交互的地图，让每一位高温下的劳动者都能快速找到离自己最近的、设施齐全的歇脚驿站。

**核心矛盾**：驿站建了，但劳动者不知道在哪、不敢进去、或者门锁着进不去。我们要做的，就是让"建了"真正变成"用上了"。

### 系统架构

```
┌─────────────────────────────────────────────────────┐
│                    用户层 (Clients)                    │
│   ┌──────────────┐           ┌──────────────────┐   │
│   │  Web 前端     │           │  微信小程序        │   │
│   │  (SPA)       │           │  (WeChat MiniApp) │   │
│   └──────┬───────┘           └────────┬─────────┘   │
└──────────┼────────────────────────────┼─────────────┘
           │                            │
           ▼                            ▼
┌─────────────────────────────────────────────────────┐
│               API 层 (Cloudflare Workers)             │
│   ┌──────────────────────────────────────────────┐  │
│   │  驿站查询 / 报修闭环 / 权益验证 / 人脸签到      │  │
│   │  数据驾驶舱 / 选址众包 / 增量同步               │  │
│   └──────────────────────────────────────────────┘  │
└──────────────────────┬──────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────┐
│               数据层 (Cloudflare D1)                  │
│   stations / feedback / repair_reports /             │
│   site_suggestions / face_enrollments / face_records │
└─────────────────────────────────────────────────────┘
```

### 功能特性

| 模块 | 说明 |
|------|------|
| 🗺️ 驿站地图 | 82 个郑州工会驿站，实时状态、设施标签、距离排序、一键导航 |
| 🔧 一键报修 | 拍照上报 → 待处理 → 处理中 → 已修复，全闭环跟踪 |
| ⭐ 权益自助站 | 工会高温补贴、法律咨询等 8 项权益，口令验证后解锁 |
| 📊 数据驾驶舱 | KPI、状态分布、区域覆盖、报修闭环率、选址建议可视化 |
| 📸 刷脸签到 | 摄像头人脸识别签到，face-api.js 128 维 descriptor 匹配 |
| 📱 微信小程序 | 增量同步、离线可用、匿名反馈，对接同一后端 |
| ⏰ 物资管理 | 免费物资到期自动提醒，确保站内物品安全可用 |

### 目录结构

```
├── ldl-platform/          # Web 前端 + Cloudflare Workers 后端
│   ├── workers/api/       # Workers API 源码 (TypeScript)
│   ├── public/            # 前端静态资源 (HTML/CSS/JS)
│   ├── docs/              # API 文档
│   ├── migrate.sql        # 数据库迁移脚本
│   ├── schema.sql         # 数据库表结构
│   └── wrangler.toml      # Cloudflare Workers 配置
├── miniprogram/           # 微信小程序
│   ├── pages/             # 小程序页面
│   ├── utils/             # 工具函数 (请求/同步/配置)
│   ├── services/          # API 服务层
│   └── data/              # 驿站静态数据
└── README.md              # 本文件
```

### 技术栈

| 层级 | 技术 |
|------|------|
| 后端 | Cloudflare Workers (TypeScript) |
| 数据库 | Cloudflare D1 (SQLite) |
| Web 前端 | 原生 HTML/CSS/JS + 高德地图 JS API |
| 小程序 | 微信原生框架 (WXML/WXSS/JS) |
| 人脸识别 | face-api.js (TinyFaceDetector + FaceLandmarks68 + FaceRecognition) |
| 部署 | Cloudflare Pages / EdgeOne Pages |

### 快速开始

#### 1. 部署后端

```bash
cd ldl-platform

# 安装 Wrangler CLI
npm install -g wrangler

# 登录 Cloudflare
wrangler login

# 创建 D1 数据库
wrangler d1 create ldl-yizhan-db
# 将输出的 database_id 填入 wrangler.toml

# 初始化数据库
wrangler d1 execute ldl-yizhan-db --file=./schema.sql
wrangler d1 execute ldl-yizhan-db --file=./migrate.sql

# 设置管理员 Token
wrangler secret put ADMIN_TOKEN

# 部署
wrangler deploy
```

#### 2. 部署前端

```bash
# Cloudflare Pages
cd ldl-platform/public
npx wrangler pages deploy . --project-name your-project-name

# 或 EdgeOne Pages
npx edgeone pages deploy . --name your-project-name
```

#### 3. 配置前端

编辑 `ldl-platform/public/index.html`：

```js
window.__API_BASE__ = 'YOUR_WORKER_URL';   // 替换为 Workers 部署地址
window.__AMAP_KEY__ = 'YOUR_AMAP_KEY';     // 替换为高德 JS API Key
```

#### 4. 小程序接入

1. 替换 `miniprogram/app.js` 中的 `baseUrl`
2. 替换 `miniprogram/project.config.json` 中的 `appid`
3. 在微信公众平台配置 request 合法域名
4. 用微信开发者工具打开 `miniprogram/` 目录

### 数据说明

- 驿站坐标采用 **GCJ-02** 坐标系（与高德地图、微信地图一致）
- 所有写入操作经后端校验，前端零信任
- 人脸数据仅存 128 维特征向量（descriptor），不保留原始图片
- 反馈为匿名提交，不采集用户信息

### License

MIT License

### 项目团队

「驿」路同行项目组 · 全国中学生领导力大赛参赛队伍

---

## <a name="english"></a>🇬🇧 English

### Overview

YiLuTongXing ("Journey Together") is a digital service platform for outdoor workers — sanitation workers, couriers, food delivery riders — helping them find the nearest rest stations with essential facilities during extreme heat.

**The core problem**: China has built thousands of rest stations for outdoor workers, but many workers don't know where they are, are hesitant to enter, or find them locked when needed. We bridge this information gap.

### Architecture

```
┌─────────────────────────────────────────────────────┐
│                    Clients                           │
│   ┌──────────────┐           ┌──────────────────┐   │
│   │  Web SPA     │           │  WeChat MiniApp  │   │
│   └──────┬───────┘           └────────┬─────────┘   │
└──────────┼────────────────────────────┼─────────────┘
           │                            │
           ▼                            ▼
┌─────────────────────────────────────────────────────┐
│           API Layer (Cloudflare Workers)             │
│   Station lookup / Repair tracking / Benefits       │
│   Dashboard / Crowdsourcing / Face check-in         │
└──────────────────────┬──────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────┐
│              Data Layer (Cloudflare D1)              │
└─────────────────────────────────────────────────────┘
```

### Features

| Module | Description |
|--------|-------------|
| 🗺️ Station Map | 82 verified rest stations in Zhengzhou with real-time status and facility tags |
| 🔧 Repair Reporting | One-click fault reporting with full lifecycle tracking |
| ⭐ Benefits Portal | 8 union welfare benefits unlocked via passcode verification |
| 📊 Dashboard | KPI metrics, status distribution, regional coverage, repair closure rate |
| 📸 Face Check-in | Camera-based face recognition via face-api.js 128-dim descriptors |
| 📱 Mini Program | Incremental sync, offline support, anonymous feedback |

### Tech Stack

| Layer | Technology |
|-------|------------|
| Backend | Cloudflare Workers (TypeScript) |
| Database | Cloudflare D1 (SQLite-compatible) |
| Web Frontend | Vanilla HTML/CSS/JS + AMap JS API |
| Mini Program | WeChat Native Framework (WXML/WXSS/JS) |
| Face Recognition | face-api.js |
| Deployment | Cloudflare Pages / EdgeOne Pages |

### Quick Start

See the [Chinese section](#快速开始) above for detailed setup instructions. Key steps:

1. Deploy the Workers backend (`cd ldl-platform && wrangler deploy`)
2. Initialize the D1 database (`wrangler d1 execute`)
3. Deploy the frontend (`wrangler pages deploy`)
4. Configure `YOUR_WORKER_URL` and `YOUR_AMAP_KEY` in `index.html`
5. Set up the WeChat Mini Program with your own AppID

### Data Notes

- Station coordinates use the **GCJ-02** coordinate system
- All write operations are server-validated (zero trust on client)
- Face data stores only 128-dim descriptor vectors, no raw images
- Feedback is anonymous, no user data collection

### License

MIT License

### Team

YiLuTongXing Project Team · National High School Student Leadership Competition

---

<p align="center">
  <b>「驿」路同行 — 让城市更有温度</b><br>
  <i>Journey Together — Making cities warmer, one rest station at a time</i>
</p>
