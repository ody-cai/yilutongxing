/**
 * 「驿」路同行 — 高温劳动者护航行动
 * Cloudflare Workers API（后端）
 *
 * 设计原则：
 *   1. 所有业务数据统一由后端校验与持久化，前端仅展示与交互
 *   2. 写操作（新增/改状态/反馈）需 X-Admin-Token 鉴权
 *   3. 列表接口支持按距离排序（lat/lng 入参）
 *   4. 所有响应统一为 { ok, code, message, data } 包装
 */

export interface Env {
  DB: D1Database;
  ADMIN_TOKEN?: string;        // wrangler secret put ADMIN_TOKEN
  CORS_ALLOW_ORIGIN?: string;
  API_VERSION?: string;
  // 微信小程序内容安全 + 登录所需密钥（wrangler secret put WX_APPID / WX_APPSECRET）
  WX_APPID?: string;
  WX_APPSECRET?: string;
  WX_KV?: any;                 // 可选：KV 命名空间，用于缓存 access_token（生产建议开启）
  WX_SECURITY_DISABLE?: string;// 置 "1" 时跳过内容安全校验（仅调试用）
  BENEFITS_PASSCODE?: string;  // 权益自助站「工会专属」口令（wrangler secret put BENEFITS_PASSCODE）
  ASSETS?: any;                // Workers Static Assets 绑定：托管前端静态文件
}

// 微信 access_token 内存缓存（单 isolate 有效；若绑定 WX_KV 则优先用 KV，跨实例共享）
let wxTokenCache: { token: string; exp: number } | null = null;

// ────────────────────────────── 常量 ──────────────────────────────

const FACILITY_LABELS: Record<string, string> = {
  drink:     '饮水',
  ac:        '空调',
  seat:      '座椅',
  charging:  '充电',
  wifi:      'Wi-Fi',
  first_aid: '急救包',
  toilet:    '厕所',
  microwave: '微波炉',
};

const STATUS_LABELS: Record<string, string> = {
  open:        '开放中',
  closed:      '已关闭',
  maintenance: '维护中',
};

const ALLOWED_STATUSES = new Set(['open', 'closed', 'maintenance']);

// 报修工单状态
const REPORT_STATUS_LABELS: Record<string, string> = {
  new:         '待处理',
  acknowledged:'处理中',
  resolved:    '已修复',
};
const ALLOWED_REPORT_STATUSES = new Set(['new', 'acknowledged', 'resolved']);

// 选址众包建议状态
const SUGGESTION_STATUS_LABELS: Record<string, string> = {
  pending:   '待审核',
  reviewing: '考察中',
  accepted:  '已采纳',
  rejected:  '未采纳',
};
const ALLOWED_SUGGESTION_STATUSES = new Set(['pending', 'reviewing', 'accepted', 'rejected']);

// 报修设施可选值（既有设施 key + 其他）
const REPORT_FACILITY_KEYS = new Set([...Object.keys(FACILITY_LABELS), 'other']);

// ───────── 权益自助站（工会专属）内容 ─────────
// 仅在校验通过（口令正确）后下发，前端源码不含明文，确保「别人抄不走」。
const BENEFITS_DEFAULT_CODE = 'YIZHAN2026';
const BENEFITS: { key: string; title: string; summary: string; who: string; how: string; tag: string }[] = [
  { key: 'allowance',  title: '高温津贴',        summary: '35℃ 以上室外作业可领高温津贴，按出勤天数计发，不得用饮料冲抵。', who: '全体室外露天作业劳动者', how: '由所在单位随工资发放；未发可向工会/劳动监察反映。', tag: '法定权益' },
  { key: 'coolkit',    title: '防暑降温物资',    summary: '工会清凉包：藿香正气水、盐汽水、毛巾、清凉油等，夏季定点发放。', who: '户外劳动者（环卫/快递/交警等）', how: '凭工牌到就近工会驿站或清凉驿站领取，先到先得。', tag: '夏季专项' },
  { key: 'checkup',    title: '免费健康体检',    summary: '工会年度公益体检，含心电、血常规、胸透等基础项目。', who: '已入会会员（含新就业形态劳动者）', how: '在「驿」路同行登记后，按短信通知时段到定点医院。', tag: '年度常态化' },
  { key: 'legal',      title: '法律援助',        summary: '劳资纠纷、工伤认定、欠薪维权免费法律咨询与代理指引。', who: '有维权需求的劳动者', how: '拨打 12351 职工服务热线，或到区总工会法律援助窗口。', tag: '兜底保障' },
  { key: 'training',   title: '技能提升培训',    summary: '免费电工、家政、收纳、短视频等职业技能课程，结课发证书。', who: '有转岗/增收意愿的劳动者', how: '在工会夜校或「豫工惠」小程序报名，名额滚动开放。', tag: '成长赋能' },
  { key: 'relief',     title: '困难职工帮扶',    summary: '大病、子女上学、突发意外可申请救助金与金秋助学。', who: '建档困难职工家庭', how: '向所在单位工会提交申请，逐级审核发放。', tag: '兜底保障' },
  { key: 'insurance',  title: '意外伤害保险',    summary: '工会为户外劳动者统一投保的免费意外险，含意外医疗与身故。', who: '已登记户外劳动者', how: '由工会批量参保，出险拨打承保公司报案电话。', tag: '年度常态化' },
  { key: 'station',    title: '驿站就近权益',    summary: '就近歇脚、免费饮水、手机充电、Wi-Fi、急救包、热饭。', who: '所有户外劳动者，无需登记', how: '打开本平台「地图」导航到最近驿站即可使用。', tag: '随时可用' },
];

// ────────────────────────────── 工具函数 ──────────────────────────────

const json = (data: any, init: ResponseInit = {}) =>
  new Response(JSON.stringify(data), {
    ...init,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...(init.headers as Record<string, string> | undefined),
    },
  });

const ok  = (data: any, message = 'ok') =>
  json({ ok: true, code: 0, message, data });

const err = (status: number, message: string, code = status) =>
  json({ ok: false, code, message, data: null }, { status });

const corsHeaders = (env: Env) => ({
  'access-control-allow-origin': env.CORS_ALLOW_ORIGIN || '*',
  'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
  'access-control-allow-headers': 'content-type, x-admin-token',
  'access-control-max-age': '86400',
});

const withCors = (res: Response, env: Env): Response => {
  const h = new Headers(res.headers);
  for (const [k, v] of Object.entries(corsHeaders(env))) h.set(k, v);
  return new Response(res.body, { status: res.status, headers: h });
};

// Haversine 距离（米）
function haversine(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
            Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function isAdmin(req: Request, env: Env): boolean {
  const t = req.headers.get('x-admin-token');
  return !!(env.ADMIN_TOKEN && t && t === env.ADMIN_TOKEN);
}

// ────────────────────────────── 微信能力（登录 + 内容安全） ──────────────────────────────

/** 获取小程序全局 access_token（带缓存，避免频繁调用触发限频） */
async function getMpAccessToken(env: Env): Promise<string> {
  if (wxTokenCache && wxTokenCache.exp > Date.now()) return wxTokenCache.token;
  if (env.WX_KV) {
    const cached = await env.WX_KV.get('wx_mp_access_token');
    if (cached) {
      wxTokenCache = { token: cached, exp: Date.now() + 7000_000 };
      return cached;
    }
  }
  const url = `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${env.WX_APPID}&secret=${env.WX_APPSECRET}`;
  const resp = await fetch(url);
  const data = await resp.json() as any;
  if (!data.access_token) throw new Error('wx token err: ' + (data.errmsg || 'unknown'));
  wxTokenCache = {
    token: data.access_token,
    exp: Date.now() + (data.expires_in ? data.expires_in * 1000 : 7000_000),
  };
  if (env.WX_KV) {
    await env.WX_KV.put('wx_mp_access_token', data.access_token, { expirationTtl: 7000 });
  }
  return data.access_token;
}

/** code2session：用 wx.login 的 code 换取用户 openid（session_key 不下发前端） */
async function callCode2Session(code: string, env: Env): Promise<{ openid: string; unionid?: string }> {
  const url = `https://api.weixin.qq.com/sns/jscode2session?appid=${env.WX_APPID}&secret=${env.WX_APPSECRET}&js_code=${code}&grant_type=authorization_code`;
  const resp = await fetch(url);
  const data = await resp.json() as any;
  if (!data.openid) throw new Error('code2session err: ' + (data.errmsg || 'unknown'));
  return { openid: data.openid, unionid: data.unionid };
}

/**
 * 微信内容安全校验（msgSecCheck 同步模式，version=1）。
 * 注意：使用同步模式「不依赖用户 openid」，前端全程匿名、不采集任何用户信息。
 * 命中敏感词返回 true。
 * 接口异常时返回 false（fail-open），避免微信侧抖动误伤用户；生产如需严格可改为 fail-closed。
 */
async function msgSecCheck(env: Env, p: { content: string }): Promise<boolean> {
  const token = await getMpAccessToken(env);
  const resp = await fetch(`https://api.weixin.qq.com/wxa/msg_sec_check?access_token=${token}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content: p.content, version: 1 }),
  });
  const data = await resp.json() as any;
  if (data.errcode === 0 && data?.result?.suggest === 'risky') return true;
  if (data.errcode && data.errcode !== 0) {
    console.error('msg_sec_check api err', data.errcode, data.errmsg);
    // 若微信侧强制要求 openid（部分账号/接口版本差异），这里 fail-open 放行，避免误伤真实反馈
  }
  return false;
}

// ────────────────────────────── 数据模型 ──────────────────────────────

interface StationRow {
  id: number;
  name: string;
  address: string;
  district: string;
  street: string | null;
  lat: number;
  lng: number;
  facilities: string;       // JSON string
  status: 'open' | 'closed' | 'maintenance';
  open_hours: string;
  contact_phone: string | null;
  manager: string | null;
  capacity: number;
  description: string | null;
  source: string;
  verified: number;
  created_at: string;
  updated_at: string;
  deleted_at: number;
}

function enrichStation(row: StationRow, origin?: { lat: number; lng: number }) {
  let facilities: string[] = [];
  try { facilities = JSON.parse(row.facilities || '[]'); } catch { facilities = []; }
  return {
    id:            row.id,
    name:          row.name,
    address:       row.address,
    district:      row.district,
    street:        row.street,
    location:      { lat: row.lat, lng: row.lng },
    facilities,
    facility_labels: facilities.map(f => ({ key: f, label: FACILITY_LABELS[f] || f })),
    status:        row.status,
    status_label:  STATUS_LABELS[row.status] || row.status,
    open_hours:    row.open_hours,
    contact_phone: row.contact_phone,
    manager:       row.manager,
    capacity:      row.capacity,
    description:   row.description,
    verified:      row.verified === 1,
    distance_m:    origin ? Math.round(haversine(origin.lat, origin.lng, row.lat, row.lng)) : null,
    updated_at:    row.updated_at,
    deleted_at:    row.deleted_at ?? 0,
    is_deleted:    (row.deleted_at ?? 0) > 0,
    created_at:    row.created_at,
  };
}

// ────────────────────────────── 路由 ──────────────────────────────

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method.toUpperCase();

    // 人脸模型文件代理：设正确的 Content-Type（无后缀 .shard1 文件）
    if (path.startsWith('/models/')) {
      try {
        const assetRes = await env.ASSETS.fetch(req);
        if (assetRes.status !== 200) return assetRes;
        const fileName = path.split('/').pop() || '';
        const contentType = fileName.endsWith('.json')
          ? 'application/json; charset=utf-8'
          : 'application/octet-stream';
        const headers = new Headers(assetRes.headers);
        headers.set('content-type', contentType);
        headers.set('access-control-allow-origin', '*');
        headers.set('cache-control', 'public, max-age=86400');
        return new Response(assetRes.body, {
          status: assetRes.status,
          statusText: assetRes.statusText,
          headers,
        });
      } catch (e) {
        // fallback: 静默降级
        return env.ASSETS.fetch(req);
      }
    }

    // 非 API 请求：由 Workers Static Assets 托管前端静态资源
    // 如果文件不存在，回退到 index.html（SPA 客户端路由）
    if (!path.startsWith('/api/')) {
      const assetRes = await env.ASSETS.fetch(req);
      if (assetRes.status === 404) {
        // SPA 回退：返回 index.html
        const spaReq = new Request(new URL('/index.html', req.url), req);
        return env.ASSETS.fetch(spaReq);
      }
      return assetRes;
    }

    // CORS 预检
    if (method === 'OPTIONS') {
      return withCors(new Response(null, { status: 204 }), env);
    }

    try {
      let res: Response;

      // 健康检查
      if (path === '/' || path === '/api/health') {
        res = ok({
          service: 'ldl-yizhan-api',
          version: env.API_VERSION || '1.0.0',
          time: new Date().toISOString(),
        }, '服务运行中');
      }
      // 元数据：设施/状态枚举
      else if (path === '/api/meta') {
        res = ok({
          facilities: Object.entries(FACILITY_LABELS).map(([key, label]) => ({ key, label })),
          statuses:   Object.entries(STATUS_LABELS).map(([key, label]) => ({ key, label })),
          report_statuses:     Object.entries(REPORT_STATUS_LABELS).map(([key, label]) => ({ key, label })),
          suggestion_statuses: Object.entries(SUGGESTION_STATUS_LABELS).map(([key, label]) => ({ key, label })),
        });
      }
      // 列表
      else if (path === '/api/stations' && method === 'GET') {
        res = await handleListStations(req, env);
      }
      // 详情
      else if (path.match(/^\/api\/stations\/\d+$/) && method === 'GET') {
        res = await handleGetStation(req, env, path);
      }
      // 改状态（需鉴权）
      else if (path.match(/^\/api\/stations\/\d+\/status$/) && method === 'POST') {
        res = await handleUpdateStatus(req, env, path);
      }
      // 反馈（公开）
      else if (path === '/api/feedback' && method === 'POST') {
        res = await handleFeedback(req, env);
      }
      // 统计
      else if (path === '/api/stats') {
        res = await handleStats(env);
      }
      // ── 小程序同步接口 /api/mp/* ──
      else if (path === '/api/mp/sync' && method === 'GET') {
        res = await handleMpSync(req, env);
      }
      else if (path === '/api/mp/stations' && method === 'GET') {
        res = await handleMpList(req, env);
      }
      else if (path.match(/^\/api\/mp\/stations\/\d+$/) && method === 'GET') {
        res = await handleMpStation(req, env, path);
      }
      else if (path === '/api/mp/nearby' && method === 'GET') {
        res = await handleMpNearby(req, env);
      }
      else if (path === '/api/mp/meta' && method === 'GET') {
        res = ok({
          facilities: Object.entries(FACILITY_LABELS).map(([key, label]) => ({ key, label })),
          statuses:   Object.entries(STATUS_LABELS).map(([key, label]) => ({ key, label })),
          report_statuses:     Object.entries(REPORT_STATUS_LABELS).map(([key, label]) => ({ key, label })),
          suggestion_statuses: Object.entries(SUGGESTION_STATUS_LABELS).map(([key, label]) => ({ key, label })),
        });
      }
      else if (path === '/api/mp/stats' && method === 'GET') {
        res = await handleMpStats(env);
      }
      else if (path === '/api/mp/version' && method === 'GET') {
        res = await handleMpVersion(env);
      }
      else if (path === '/api/mp/feedback' && method === 'POST') {
        res = await handleMpFeedback(req, env);
      }
      // 小程序登录：wx.login 的 code 换 openid（供内容安全校验使用）
      else if (path === '/api/mp/login' && method === 'POST') {
        res = await handleMpLogin(req, env);
      }
      // 新增/更新驿站（需鉴权）
      else if (path === '/api/admin/stations' && method === 'POST') {
        res = await handleCreateStation(req, env);
      }
      // 软删除驿站（需鉴权，置 deleted_at 供同步感知）
      else if (path.match(/^\/api\/admin\/stations\/\d+$/) && method === 'DELETE') {
        res = await handleDeleteStation(req, env, path);
      }
      // ── 一键报修（闭环）──
      else if (path.match(/^\/api\/stations\/\d+\/reports$/) && method === 'POST') {
        res = await handleCreateReport(req, env, path);
      }
      else if (path.match(/^\/api\/stations\/\d+\/reports$/) && method === 'GET') {
        res = await handleListStationReports(req, env, path);
      }
      else if (path === '/api/reports' && method === 'GET') {
        res = await handleListReports(req, env);
      }
      else if (path.match(/^\/api\/reports\/\d+\/status$/) && method === 'POST') {
        res = await handleUpdateReportStatus(req, env, path);
      }
      // ── 驿站选址众包 ──
      else if (path === '/api/suggestions' && method === 'POST') {
        res = await handleCreateSuggestion(req, env);
      }
      else if (path === '/api/suggestions' && method === 'GET') {
        res = await handleListSuggestions(req, env);
      }
      else if (path.match(/^\/api\/suggestions\/\d+\/status$/) && method === 'POST') {
        res = await handleUpdateSuggestionStatus(req, env, path);
      }
      // ── 数据驾驶舱（聚合，公开）──
      else if (path === '/api/dashboard' && method === 'GET') {
        res = await handleDashboard(env);
      }
      // ── 刷脸签到系统 ──
      else if (path === '/api/face/enroll' && method === 'POST') {
        res = await handleFaceEnroll(req, env);
      }
      else if (path === '/api/face/checkin' && method === 'POST') {
        res = await handleFaceCheckin(req, env);
      }
      else if (path === '/api/face/enrollments' && method === 'GET') {
        res = await handleFaceEnrollments(env);
      }
      else if (path === '/api/face/records' && method === 'GET') {
        res = await handleFaceRecords(req, env);
      }
      // ── 权益自助站（工会专属，口令校验后下发内容）──
      else if (path === '/api/benefits/verify' && method === 'POST') {
        res = await handleBenefitsVerify(req, env);
      }
      else {
        res = err(404, `路径不存在: ${method} ${path}`);
      }

      return withCors(res, env);
    } catch (e: any) {
      console.error('unhandled error', e);
      return withCors(err(500, e?.message || '服务器内部错误'), env);
    }
  },
} satisfies ExportedHandler<Env>;

// ────────────────────────────── 处理函数 ──────────────────────────────

async function handleListStations(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const status   = url.searchParams.get('status');
  const district = url.searchParams.get('district');
  const facility = url.searchParams.get('facility');
  const lat      = parseFloat(url.searchParams.get('lat') || '');
  const lng      = parseFloat(url.searchParams.get('lng') || '');
  const limit    = Math.min(parseInt(url.searchParams.get('limit') || '200', 10), 500);

  const where: string[] = [];
  const args: any[] = [];

  if (status && ALLOWED_STATUSES.has(status)) {
    where.push('status = ?'); args.push(status);
  }
  if (district) {
    where.push('district = ?'); args.push(district);
  }
  if (facility) {
    // SQLite LIKE 简单匹配 JSON 数组中元素（facilities 形如 ["drink","ac"]）
    where.push('facilities LIKE ?'); args.push(`%"${facility}"%`);
  }

  const sql = `
    SELECT * FROM stations
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY id ASC
    LIMIT ?
  `;
  args.push(limit);

  const { results } = await env.DB.prepare(sql).bind(...args).all<StationRow>();
  let list = (results || []).map(r => enrichStation(r));

  const origin = isFinite(lat) && isFinite(lng) ? { lat, lng } : undefined;
  if (origin) {
    list = list
      .map(s => ({ ...s, distance_m: Math.round(haversine(origin.lat, origin.lng, s.location.lat, s.location.lng)) }))
      .sort((a, b) => (a.distance_m ?? 0) - (b.distance_m ?? 0));
  } else {
    list = list.sort((a, b) => a.district.localeCompare(b.district, 'zh'));
  }

  return ok({
    total: list.length,
    origin: origin || null,
    items: list,
  });
}

async function handleGetStation(req: Request, env: Env, path: string): Promise<Response> {
  const id = parseInt(path.split('/')[3], 10);
  const row = await env.DB.prepare('SELECT * FROM stations WHERE id = ?').bind(id).first<StationRow>();
  if (!row) return err(404, '驿站不存在');

  const url = new URL(req.url);
  const lat = parseFloat(url.searchParams.get('lat') || '');
  const lng = parseFloat(url.searchParams.get('lng') || '');
  const origin = isFinite(lat) && isFinite(lng) ? { lat, lng } : undefined;

  return ok(enrichStation(row, origin));
}

async function handleUpdateStatus(req: Request, env: Env, path: string): Promise<Response> {
  if (!isAdmin(req, env)) return err(401, '需要管理员鉴权（X-Admin-Token）');

  const id = parseInt(path.split('/')[3], 10);
  if (!Number.isFinite(id)) return err(400, 'id 无效');

  let body: any;
  try { body = await req.json(); } catch { return err(400, '请求体不是合法 JSON'); }

  const status = String(body?.status || '');
  const note   = String(body?.note || '').slice(0, 500);

  if (!ALLOWED_STATUSES.has(status)) {
    return err(400, 'status 必须是 open / closed / maintenance 之一');
  }

  const existed = await env.DB.prepare('SELECT status FROM stations WHERE id = ?').bind(id).first<{ status: string }>();
  if (!existed) return err(404, '驿站不存在');

  await env.DB.prepare(
    'UPDATE stations SET status = ? WHERE id = ?'
  ).bind(status, id).run();

  await env.DB.prepare(
    `INSERT INTO station_events (station_id, event_type, old_value, new_value, note, source)
     VALUES (?, 'status_change', ?, ?, ?, 'admin')`
  ).bind(id, existed.status, status, note).run();

  const updated = await env.DB.prepare('SELECT * FROM stations WHERE id = ?').bind(id).first<StationRow>();
  return ok(enrichStation(updated!), '状态已更新');
}

async function handleFeedback(req: Request, env: Env): Promise<Response> {
  let body: any;
  try { body = await req.json(); } catch { return err(400, '请求体不是合法 JSON'); }

  const message = String(body?.message || '').trim();
  if (!message || message.length > 500) return err(400, 'message 不能为空且 ≤500 字');

  // 内容安全校验（微信 msgSecCheck 同步模式，不依赖 openid，前端全程匿名）
  if (env.WX_SECURITY_DISABLE !== '1' && env.WX_APPID && env.WX_APPSECRET) {
    try {
      const risky = await msgSecCheck(env, { content: message });
      if (risky) return err(403, '内容包含敏感信息，请修改后重试');
    } catch (e) {
      console.error('msgSecCheck failed, fail-open', e);
    }
  }

  const stationId = body?.station_id ? parseInt(body.station_id, 10) : null;
  const kind      = ['suggestion', 'issue', 'praise'].includes(body?.kind) ? body.kind : 'suggestion';

  // 仅存储驿站关联 + 反馈内容 + 类型，不存储任何用户信息（联系方式/ openid 均不落库）
  await env.DB.prepare(
    'INSERT INTO feedback (station_id, message, kind) VALUES (?, ?, ?)'
  ).bind(stationId, message, kind).run();

  return ok({ received: true }, '感谢您的反馈');
}

async function handleStats(env: Env): Promise<Response> {
  const total = await env.DB.prepare('SELECT COUNT(*) AS c FROM stations').first<{ c: number }>();
  const byStatus = await env.DB.prepare(
    'SELECT status, COUNT(*) AS c FROM stations GROUP BY status'
  ).all<{ status: string; c: number }>();
  const byDistrict = await env.DB.prepare(
    'SELECT district, COUNT(*) AS c FROM stations GROUP BY district ORDER BY c DESC'
  ).all<{ district: string; c: number }>();

  return ok({
    total: total?.c ?? 0,
    by_status: (byStatus.results || []).map(r => ({
      key: r.status, label: STATUS_LABELS[r.status] || r.status, count: r.c
    })),
    by_district: (byDistrict.results || []).map(r => ({ district: r.district, count: r.c })),
  });
}

async function handleCreateStation(req: Request, env: Env): Promise<Response> {
  if (!isAdmin(req, env)) return err(401, '需要管理员鉴权（X-Admin-Token）');

  let body: any;
  try { body = await req.json(); } catch { return err(400, '请求体不是合法 JSON'); }

  const required = ['name', 'address', 'district', 'lat', 'lng'] as const;
  for (const k of required) {
    if (body?.[k] === undefined || body?.[k] === null || body?.[k] === '') {
      return err(400, `缺少必填字段: ${k}`);
    }
  }

  const lat = parseFloat(body.lat), lng = parseFloat(body.lng);
  if (!isFinite(lat) || !isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return err(400, 'lat/lng 坐标非法');
  }

  const facilities = Array.isArray(body.facilities)
    ? body.facilities.filter((f: any) => typeof f === 'string')
    : [];

  const result = await env.DB.prepare(`
    INSERT INTO stations (name, address, district, street, lat, lng, facilities,
                          status, open_hours, contact_phone, manager, capacity, description, source, verified)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    String(body.name).slice(0, 100),
    String(body.address).slice(0, 200),
    String(body.district).slice(0, 30),
    body.street ? String(body.street).slice(0, 60) : null,
    lat, lng,
    JSON.stringify(facilities),
    ALLOWED_STATUSES.has(body.status) ? body.status : 'open',
    String(body.open_hours || '24小时').slice(0, 60),
    body.contact_phone ? String(body.contact_phone).slice(0, 30) : null,
    body.manager ? String(body.manager).slice(0, 60) : null,
    Number.isFinite(body.capacity) ? body.capacity : 8,
    body.description ? String(body.description).slice(0, 500) : null,
    'manual',
    1
  ).run();

  const id = result.meta?.last_rowid;
  const row = await env.DB.prepare('SELECT * FROM stations WHERE id = ?').bind(id).first<StationRow>();
  await env.DB.prepare(
    `INSERT INTO station_events (station_id, event_type, new_value, source)
     VALUES (?, 'create', ?, 'admin')`
  ).bind(id, 'manual created').run();

  return ok(enrichStation(row!), '驿站已创建', );
}

// ────────────────────────────── 小程序同步接口 ──────────────────────────────

/**
 * 增量同步核心接口。
 * 小程序首次同步传 since=0（拉全部），之后用上次返回的 server_time 作为 since。
 * 返回自 since 以来「新增/更新」以及「被软删除」的驿站，供小程序更新本地缓存。
 */
async function handleMpSync(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const since  = parseInt(url.searchParams.get('since') || '0', 10) || 0;
  const limit  = Math.min(parseInt(url.searchParams.get('limit') || '200', 10), 500);
  const offset = Math.max(parseInt(url.searchParams.get('offset') || '0', 10), 0);

  const { results } = await env.DB.prepare(`
    SELECT *, (CASE WHEN deleted_at > 0 THEN 1 ELSE 0 END) AS is_deleted
    FROM stations
    WHERE (strftime('%s', updated_at) > ? OR (deleted_at > 0 AND strftime('%s', deleted_at) > ?))
    ORDER BY (CASE WHEN deleted_at > 0 AND deleted_at > strftime('%s', updated_at)
                   THEN deleted_at ELSE strftime('%s', updated_at) END) DESC
    LIMIT ?
  `).bind(since, since, limit + 1).all<StationRow & { is_deleted: number }>();

  const all = (results || []);
  const hasMore = all.length > limit;
  const items = all.slice(0, limit).map(r => enrichStation(r));

  return ok({
    server_time: Math.floor(Date.now() / 1000),
    since,
    has_more: hasMore,
    next_offset: hasMore ? offset + limit : null,
    items,
  });
}

/** 驿站列表（全量/筛选/搜索），返回未删除的驿站，支持分页与距离排序 */
async function handleMpList(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const status   = url.searchParams.get('status');
  const district = url.searchParams.get('district');
  const keyword  = url.searchParams.get('keyword');
  const lat      = parseFloat(url.searchParams.get('lat') || '');
  const lng      = parseFloat(url.searchParams.get('lng') || '');
  const limit    = Math.min(parseInt(url.searchParams.get('limit') || '200', 10), 500);
  const offset   = Math.max(parseInt(url.searchParams.get('offset') || '0', 10), 0);

  const where: string[] = ['deleted_at = 0'];
  const args: any[] = [];

  if (status && ALLOWED_STATUSES.has(status)) {
    where.push('status = ?'); args.push(status);
  }
  if (district) {
    where.push('district = ?'); args.push(district);
  }
  if (keyword) {
    where.push('(name LIKE ? OR address LIKE ? OR street LIKE ?)');
    const kw = `%${keyword}%`;
    args.push(kw, kw, kw);
  }

  const countRow = await env.DB.prepare(
    `SELECT COUNT(*) AS c FROM stations WHERE ${where.join(' AND ')}`
  ).bind(...args).first<{ c: number }>();

  args.push(limit, offset);
  const { results } = await env.DB.prepare(`
    SELECT * FROM stations WHERE ${where.join(' AND ')}
    ORDER BY id ASC
    LIMIT ? OFFSET ?
  `).bind(...args).all<StationRow>();

  const origin = isFinite(lat) && isFinite(lng) ? { lat, lng } : undefined;
  let list = (results || []).map(r => enrichStation(r, origin));
  if (origin) {
    list = list.sort((a, b) => (a.distance_m ?? 0) - (b.distance_m ?? 0));
  }

  return ok({
    total: countRow?.c ?? 0,
    offset, limit,
    server_time: Math.floor(Date.now() / 1000),
    items: list,
  });
}

/** 驿站详情 */
async function handleMpStation(req: Request, env: Env, path: string): Promise<Response> {
  const id = parseInt(path.split('/')[3], 10);
  const row = await env.DB.prepare('SELECT * FROM stations WHERE id = ?').bind(id).first<StationRow>();
  if (!row) return err(404, '驿站不存在');
  const url = new URL(req.url);
  const lat = parseFloat(url.searchParams.get('lat') || '');
  const lng = parseFloat(url.searchParams.get('lng') || '');
  const origin = isFinite(lat) && isFinite(lng) ? { lat, lng } : undefined;
  return ok(enrichStation(row, origin));
}

/** 附近驿站（按经纬度 + 半径筛选，按距离升序） */
async function handleMpNearby(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const lat = parseFloat(url.searchParams.get('lat') || '');
  const lng = parseFloat(url.searchParams.get('lng') || '');
  if (!isFinite(lat) || !isFinite(lng)) return err(400, 'lat/lng 必填');
  const radius = Math.min(Math.max(parseInt(url.searchParams.get('radius') || '3000', 10), 100), 50000);
  const status = url.searchParams.get('status');

  const where = ['deleted_at = 0'];
  const args: any[] = [];
  if (status && ALLOWED_STATUSES.has(status)) { where.push('status = ?'); args.push(status); }

  const { results } = await env.DB.prepare(
    `SELECT * FROM stations WHERE ${where.join(' AND ')}`
  ).bind(...args).all<StationRow>();

  const items = (results || [])
    .map(r => enrichStation(r, { lat, lng }))
    .filter(s => (s.distance_m ?? Infinity) <= radius)
    .sort((a, b) => (a.distance_m ?? 0) - (b.distance_m ?? 0));

  return ok({
    origin: { lat, lng },
    radius,
    server_time: Math.floor(Date.now() / 1000),
    items,
  });
}

/** 统计（复用网站统计逻辑） */
async function handleMpStats(env: Env): Promise<Response> {
  return handleStats(env);
}

/** 轻量版本探测：返回记录总数与最新更新时间，小程序据此判断是否需全量刷新 */
async function handleMpVersion(env: Env): Promise<Response> {
  const row = await env.DB.prepare(`
    SELECT COUNT(*) AS total,
           SUM(CASE WHEN deleted_at > 0 THEN 1 ELSE 0 END) AS deleted,
           MAX(strftime('%s', updated_at)) AS max_ts
    FROM stations
  `).first<{ total: number; deleted: number | null; max_ts: number | null }>();
  return ok({
    total:   row?.total ?? 0,
    deleted: row?.deleted ?? 0,
    latest_updated_at: row?.max_ts ?? 0,
    server_time: Math.floor(Date.now() / 1000),
  });
}

/** 小程序提交反馈（复用通用反馈逻辑，已含内容安全校验） */
async function handleMpFeedback(req: Request, env: Env): Promise<Response> {
  return handleFeedback(req, env);
}

/** 小程序登录：wx.login 的 code 换 openid；未配置微信密钥时返回占位 openid 便于本地联调 */
async function handleMpLogin(req: Request, env: Env): Promise<Response> {
  if (!env.WX_APPID || !env.WX_APPSECRET) {
    return ok({ openid: 'dev_no_wx_config', mock: true });
  }
  let body: any;
  try { body = await req.json(); } catch { return err(400, '请求体不是合法 JSON'); }
  const code = String(body?.code || '');
  if (!code) return err(400, '缺少 code');
  try {
    const { openid, unionid } = await callCode2Session(code, env);
    return ok({ openid, unionid: unionid || null });
  } catch (e: any) {
    return err(500, '登录失败：' + (e?.message || ''));
  }
}

/** 软删除驿站（需管理员鉴权）；置 deleted_at 供小程序同步感知删除 */
async function handleDeleteStation(req: Request, env: Env, path: string): Promise<Response> {
  if (!isAdmin(req, env)) return err(401, '需要管理员鉴权（X-Admin-Token）');
  const id = parseInt(path.split('/')[3], 10);
  if (!Number.isFinite(id)) return err(400, 'id 无效');
  const existed = await env.DB.prepare('SELECT id FROM stations WHERE id = ? AND deleted_at = 0').bind(id).first<{ id: number }>();
  if (!existed) return err(404, '驿站不存在或已删除');
  await env.DB.prepare(
    "UPDATE stations SET deleted_at = CAST(strftime('%s', 'now') AS INTEGER) WHERE id = ?"
  ).bind(id).run();
  return ok({ id, deleted: true }, '驿站已删除（软删除）');
}

// ────────────────────────────── 报修工单（一键报修闭环） ──────────────────────────────

function reportFacilityLabel(f?: string | null): string {
  if (!f) return '其他';
  if (f === 'other') return '其他/整体';
  return FACILITY_LABELS[f] || f;
}

/** 上报接口入参校验 + 内容安全（复用 msgSecCheck） */
async function validateReportInput(body: any, env: Env): Promise<{ ok: true; value: any } | { ok: false; res: Response }> {
  const stationId = body?.station_id ? parseInt(body.station_id, 10) : null;
  const facility  = REPORT_FACILITY_KEYS.has(String(body?.facility || 'other')) ? String(body?.facility || 'other') : 'other';
  const description = String(body?.description || '').trim();
  const contact = body?.contact ? String(body.contact).slice(0, 60) : null;

  if (!stationId || !Number.isFinite(stationId)) return { ok: false, res: err(400, 'station_id 无效') };
  if (!description || description.length > 300) return { ok: false, res: err(400, '故障描述不能为空且 ≤300 字') };

  if (env.WX_SECURITY_DISABLE !== '1' && env.WX_APPID && env.WX_APPSECRET) {
    try {
      const risky = await msgSecCheck(env, { content: description });
      if (risky) return { ok: false, res: err(403, '内容包含敏感信息，请修改后重试') };
    } catch (e) { console.error('msgSecCheck failed, fail-open', e); }
  }
  return { ok: true, value: { stationId, facility, description, contact } };
}

/** 一键报修：提交工单 */
async function handleCreateReport(req: Request, env: Env, path: string): Promise<Response> {
  let body: any;
  try { body = await req.json(); } catch { return err(400, '请求体不是合法 JSON'); }
  // station_id 也可从路径取（/api/stations/:id/reports）
  const pathId = parseInt(path.split('/')[3], 10);
  if (Number.isFinite(pathId)) body.station_id = pathId;

  const v = await validateReportInput(body, env);
  if (!v.ok) return v.res;
  const { stationId, facility, description, contact } = v.value;

  const existed = await env.DB.prepare('SELECT id FROM stations WHERE id = ?').bind(stationId).first<{ id: number }>();
  if (!existed) return err(404, '关联驿站不存在');

  const result = await env.DB.prepare(`
    INSERT INTO repair_reports (station_id, facility, description, contact, status, source)
    VALUES (?, ?, ?, ?, 'new', 'web')
  `).bind(stationId, facility, description, contact).run();

  const id = result.meta?.last_rowid;
  const row = await env.DB.prepare(`
    SELECT r.*, s.name AS station_name, s.district AS station_district
    FROM repair_reports r LEFT JOIN stations s ON s.id = r.station_id
    WHERE r.id = ?
  `).bind(id).first<any>();

  await env.DB.prepare(
    `INSERT INTO station_events (station_id, event_type, new_value, note, source)
     VALUES (?, 'report', ?, ?, 'web')`
  ).bind(stationId, facility, description).run();

  return ok(enrichReport(row), '报修已提交，项目组将尽快处理');
}

/** 单个驿站的报修列表 */
async function handleListStationReports(req: Request, env: Env, path: string): Promise<Response> {
  const id = parseInt(path.split('/')[3], 10);
  const { results } = await env.DB.prepare(`
    SELECT r.*, s.name AS station_name, s.district AS station_district
    FROM repair_reports r LEFT JOIN stations s ON s.id = r.station_id
    WHERE r.station_id = ? ORDER BY r.created_at DESC
  `).bind(id).all<any>();
  return ok({ station_id: id, items: (results || []).map(enrichReport) });
}

/** 全部报修（支持 status 逗号筛选 / station_id 筛选） */
async function handleListReports(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const status = url.searchParams.get('status');
  const stationId = url.searchParams.get('station_id');

  const where: string[] = [];
  const args: any[] = [];
  if (status) {
    const list = status.split(',').filter(s => ALLOWED_REPORT_STATUSES.has(s));
    if (list.length) { where.push(`r.status IN (${list.map(() => '?').join(',')})`); args.push(...list); }
  }
  if (stationId && Number.isFinite(parseInt(stationId, 10))) {
    where.push('r.station_id = ?'); args.push(parseInt(stationId, 10));
  }

  const sql = `
    SELECT r.*, s.name AS station_name, s.district AS station_district
    FROM repair_reports r LEFT JOIN stations s ON s.id = r.station_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY r.created_at DESC
    LIMIT 200
  `;
  const { results } = await env.DB.prepare(sql).bind(...args).all<any>();
  return ok({ total: (results || []).length, items: (results || []).map(enrichReport) });
}

/** 管理员处理报修（改状态 + 备注） */
async function handleUpdateReportStatus(req: Request, env: Env, path: string): Promise<Response> {
  if (!isAdmin(req, env)) return err(401, '需要管理员鉴权（X-Admin-Token）');
  const id = parseInt(path.split('/')[3], 10);
  if (!Number.isFinite(id)) return err(400, 'id 无效');

  let body: any;
  try { body = await req.json(); } catch { return err(400, '请求体不是合法 JSON'); }
  const status = String(body?.status || '');
  const note = String(body?.note || '').slice(0, 500);
  if (!ALLOWED_REPORT_STATUSES.has(status)) return err(400, 'status 必须是 new / acknowledged / resolved 之一');

  const existed = await env.DB.prepare('SELECT status FROM repair_reports WHERE id = ?').bind(id).first<{ status: string }>();
  if (!existed) return err(404, '报修工单不存在');

  await env.DB.prepare('UPDATE repair_reports SET status = ?, admin_note = ? WHERE id = ?')
    .bind(status, note, id).run();

  const row = await env.DB.prepare(`
    SELECT r.*, s.name AS station_name, s.district AS station_district
    FROM repair_reports r LEFT JOIN stations s ON s.id = r.station_id WHERE r.id = ?
  `).bind(id).first<any>();
  return ok(enrichReport(row), '报修状态已更新');
}



function enrichReport(row: any) {
  if (!row) return null;
  return {
    id: row.id,
    station_id: row.station_id,
    station_name: row.station_name || `驿站#${row.station_id}`,
    station_district: row.station_district || '',
    facility: row.facility,
    facility_label: reportFacilityLabel(row.facility),
    description: row.description,
    contact: row.contact,
    status: row.status,
    status_label: REPORT_STATUS_LABELS[row.status] || row.status,
    admin_note: row.admin_note,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// ────────────────────────────── 驿站选址众包 ──────────────────────────────

/** 提交选址建议 */
async function handleCreateSuggestion(req: Request, env: Env): Promise<Response> {
  let body: any;
  try { body = await req.json(); } catch { return err(400, '请求体不是合法 JSON'); }

  const lat = parseFloat(body?.lat);
  const lng = parseFloat(body?.lng);
  if (!isFinite(lat) || !isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return err(400, 'lat/lng 坐标非法');
  }
  const reason = String(body?.reason || '').trim();
  if (!reason || reason.length > 300) return err(400, '推荐理由不能为空且 ≤300 字');

  if (env.WX_SECURITY_DISABLE !== '1' && env.WX_APPID && env.WX_APPSECRET) {
    try {
      const risky = await msgSecCheck(env, { content: reason });
      if (risky) return err(403, '内容包含敏感信息，请修改后重试');
    } catch (e) { console.error('msgSecCheck failed, fail-open', e); }
  }

  const address  = body?.address ? String(body.address).slice(0, 200) : null;
  const district = body?.district ? String(body.district).slice(0, 30) : null;
  const contact  = body?.contact ? String(body.contact).slice(0, 60) : null;

  const result = await env.DB.prepare(`
    INSERT INTO site_suggestions (lat, lng, address, district, reason, contact, status, source)
    VALUES (?, ?, ?, ?, ?, ?, 'pending', 'web')
  `).bind(lat, lng, address, district, reason, contact).run();

  const id = result.meta?.last_rowid;
  const row = await env.DB.prepare('SELECT * FROM site_suggestions WHERE id = ?').bind(id).first<any>();
  return ok(enrichSuggestion(row), '选址建议已提交，感谢您的众包贡献');
}

/** 选址建议列表（支持 status / district 筛选） */
async function handleListSuggestions(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const status = url.searchParams.get('status');
  const district = url.searchParams.get('district');

  const where: string[] = [];
  const args: any[] = [];
  if (status) {
    const list = status.split(',').filter(s => ALLOWED_SUGGESTION_STATUSES.has(s));
    if (list.length) { where.push(`status IN (${list.map(() => '?').join(',')})`); args.push(...list); }
  }
  if (district) { where.push('district = ?'); args.push(district); }

  const sql = `
    SELECT * FROM site_suggestions
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY created_at DESC
    LIMIT 300
  `;
  const { results } = await env.DB.prepare(sql).bind(...args).all<any>();
  return ok({ total: (results || []).length, items: (results || []).map(enrichSuggestion) });
}

/** 管理员处理选址建议 */
async function handleUpdateSuggestionStatus(req: Request, env: Env, path: string): Promise<Response> {
  if (!isAdmin(req, env)) return err(401, '需要管理员鉴权（X-Admin-Token）');
  const id = parseInt(path.split('/')[3], 10);
  if (!Number.isFinite(id)) return err(400, 'id 无效');

  let body: any;
  try { body = await req.json(); } catch { return err(400, '请求体不是合法 JSON'); }
  const status = String(body?.status || '');
  const note = String(body?.note || '').slice(0, 500);
  if (!ALLOWED_SUGGESTION_STATUSES.has(status)) return err(400, 'status 必须是 pending / reviewing / accepted / rejected 之一');

  const existed = await env.DB.prepare('SELECT id FROM site_suggestions WHERE id = ?').bind(id).first<{ id: number }>();
  if (!existed) return err(404, '选址建议不存在');

  await env.DB.prepare('UPDATE site_suggestions SET status = ?, admin_note = ? WHERE id = ?')
    .bind(status, note, id).run();
  const row = await env.DB.prepare('SELECT * FROM site_suggestions WHERE id = ?').bind(id).first<any>();
  return ok(enrichSuggestion(row), '建议状态已更新');
}

function enrichSuggestion(row: any) {
  if (!row) return null;
  return {
    id: row.id,
    location: { lat: row.lat, lng: row.lng },
    address: row.address,
    district: row.district,
    reason: row.reason,
    contact: row.contact,
    status: row.status,
    status_label: SUGGESTION_STATUS_LABELS[row.status] || row.status,
    admin_note: row.admin_note,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// ────────────────────────────── 数据驾驶舱（聚合） ──────────────────────────────

async function handleDashboard(env: Env): Promise<Response> {
  const total = await env.DB.prepare('SELECT COUNT(*) AS c FROM stations WHERE deleted_at = 0').first<{ c: number }>();
  const byStatus = await env.DB.prepare(
    'SELECT status, COUNT(*) AS c FROM stations WHERE deleted_at = 0 GROUP BY status'
  ).all<{ status: string; c: number }>();
  const byDistrict = await env.DB.prepare(
    'SELECT district, COUNT(*) AS c FROM stations WHERE deleted_at = 0 GROUP BY district ORDER BY c DESC'
  ).all<{ district: string; c: number }>();

  const repTotal = await env.DB.prepare('SELECT COUNT(*) AS c FROM repair_reports').first<{ c: number }>();
  const repByStatus = await env.DB.prepare(
    'SELECT status, COUNT(*) AS c FROM repair_reports GROUP BY status'
  ).all<{ status: string; c: number }>();
  const repOpen = await env.DB.prepare(
    "SELECT COUNT(*) AS c FROM repair_reports WHERE status IN ('new','acknowledged')"
  ).first<{ c: number }>();

  const sugTotal = await env.DB.prepare('SELECT COUNT(*) AS c FROM site_suggestions').first<{ c: number }>();
  const sugByStatus = await env.DB.prepare(
    'SELECT status, COUNT(*) AS c FROM site_suggestions GROUP BY status'
  ).all<{ status: string; c: number }>();
  const sugAccepted = await env.DB.prepare(
    "SELECT COUNT(*) AS c FROM site_suggestions WHERE status = 'accepted'"
  ).first<{ c: number }>();

  // 近期动态（报修 + 选址建议，最多 14 条）
  const repAct = await env.DB.prepare(`
    SELECT 'report' AS type, id, station_id, description AS summary, status, created_at
    FROM repair_reports ORDER BY created_at DESC LIMIT 10
  `).all<any>();
  const sugAct = await env.DB.prepare(`
    SELECT 'suggestion' AS type, id, NULL AS station_id, reason AS summary, status, created_at
    FROM site_suggestions ORDER BY created_at DESC LIMIT 10
  `).all<any>();
  const recent = [...(repAct.results || []), ...(sugAct.results || [])]
    .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))
    .slice(0, 14);

  return ok({
    generated_at: new Date().toISOString(),
    stations: {
      total: total?.c ?? 0,
      by_status: (byStatus.results || []).map(r => ({ key: r.status, label: STATUS_LABELS[r.status] || r.status, count: r.c })),
      by_district: (byDistrict.results || []).map(r => ({ district: r.district, count: r.c })),
      districts_covered: (byDistrict.results || []).length,
    },
    repairs: {
      total: repTotal?.c ?? 0,
      open: repOpen?.c ?? 0,
      resolved: (repByStatus.results || []).find(r => r.status === 'resolved')?.c ?? 0,
      by_status: (repByStatus.results || []).map(r => ({ key: r.status, label: REPORT_STATUS_LABELS[r.status] || r.status, count: r.c })),
    },
    suggestions: {
      total: sugTotal?.c ?? 0,
      accepted: sugAccepted?.c ?? 0,
      by_status: (sugByStatus.results || []).map(r => ({ key: r.status, label: SUGGESTION_STATUS_LABELS[r.status] || r.status, count: r.c })),
    },
    recent_activity: recent.map(r => ({
      type: r.type,
      id: r.id,
      station_id: r.station_id,
      summary: String(r.summary || '').slice(0, 60),
      status: r.status,
      status_label: r.type === 'report' ? (REPORT_STATUS_LABELS[r.status] || r.status) : (SUGGESTION_STATUS_LABELS[r.status] || r.status),
      created_at: r.created_at,
    })),
  });
}

// ────────────────────────────── 权益自助站（工会专属） ──────────────────────────────

async function handleBenefitsVerify(req: Request, env: Env): Promise<Response> {
  let body: any;
  try { body = await req.json(); } catch { return err(400, '请求体不是合法 JSON'); }
  const code = String(body?.code || '').trim();
  const expected = env.BENEFITS_PASSCODE || BENEFITS_DEFAULT_CODE;
  if (!code || code !== expected) return err(403, '工会专属口令不正确');
  return ok({
    unlocked: true,
    union: '郑州市总工会 · 「驿」路同行',
    benefits: BENEFITS.map(b => ({
      key: b.key, title: b.title, summary: b.summary, who: b.who, how: b.how, tag: b.tag,
    })),
  }, '口令校验通过，已解锁工会专属权益');
}

// ────────────────────────────── 刷脸签到系统 ──────────────────────────────

interface FaceEnrollmentRow {
  id: number;
  name: string;
  phone: string | null;
  company: string | null;
  station_id: number | null;
  face_descriptor: string;   // JSON array of 128 floats
  face_thumbnail: string | null;
  is_active: number;
  created_at: string;
  updated_at: string;
}

interface EntryRecordRow {
  id: number;
  face_id: number | null;
  name: string;
  station_id: number | null;
  entry_type: string;
  score: number | null;
  created_at: string;
}

/** 人脸注册：接收前端计算好的人脸描述子，存储入库 */
async function handleFaceEnroll(req: Request, env: Env): Promise<Response> {
  let body: any;
  try { body = await req.json(); } catch { return err(400, '请求体不是合法 JSON'); }

  const name = String(body?.name || '').trim();
  if (!name || name.length > 50) return err(400, '姓名不能为空且 ≤50 字');

  const descriptor = body?.descriptor;
  if (!Array.isArray(descriptor) || descriptor.length !== 128) {
    return err(400, 'descriptor 必须是 128 维浮点数组');
  }
  // 验证所有元素都是数字
  for (const v of descriptor) {
    if (typeof v !== 'number' || !isFinite(v)) {
      return err(400, 'descriptor 包含非法数值');
    }
  }

  const phone    = body?.phone ? String(body.phone).slice(0, 20) : null;
  const company  = body?.company ? String(body.company).slice(0, 100) : null;
  const stationId = body?.station_id ? parseInt(body.station_id, 10) : null;
  const thumbnail = body?.thumbnail ? String(body.thumbnail).slice(0, 20000) : null;

  const result = await env.DB.prepare(`
    INSERT INTO face_enrollments (name, phone, company, station_id, face_descriptor, face_thumbnail)
    VALUES (?, ?, ?, ?, ?, ?)
  `).bind(name, phone, company, stationId, JSON.stringify(descriptor), thumbnail).run();

  const id = result.meta?.last_rowid;
  return ok({ id, name }, '人脸注册成功');
}

/** 签到：记录一次刷脸入场 */
async function handleFaceCheckin(req: Request, env: Env): Promise<Response> {
  let body: any;
  try { body = await req.json(); } catch { return err(400, '请求体不是合法 JSON'); }

  const name = String(body?.name || '').trim();
  if (!name || name.length > 50) return err(400, '姓名不能为空');

  const faceId   = body?.face_id ? parseInt(body.face_id, 10) : null;
  const stationId = body?.station_id ? parseInt(body.station_id, 10) : null;
  const score    = body?.score !== undefined ? Math.round(parseFloat(body.score) * 100) / 100 : null;
  const entryType = body?.entry_type === 'manual' ? 'manual' : 'face';

  await env.DB.prepare(`
    INSERT INTO entry_records (face_id, name, station_id, entry_type, score)
    VALUES (?, ?, ?, ?, ?)
  `).bind(faceId, name, stationId, entryType, score).run();

  return ok({ name, time: new Date().toISOString() }, `欢迎 ${name} 入场`);
}

/** 获取所有激活的人脸注册记录（前端用于匹配比对） */
async function handleFaceEnrollments(env: Env): Promise<Response> {
  const { results } = await env.DB.prepare(`
    SELECT id, name, phone, company, station_id, face_descriptor, face_thumbnail, created_at
    FROM face_enrollments WHERE is_active = 1
    ORDER BY created_at ASC
  `).all<FaceEnrollmentRow>();

  const items = (results || []).map(row => ({
    id: row.id,
    name: row.name,
    phone: row.phone,
    company: row.company,
    station_id: row.station_id,
    descriptor: JSON.parse(row.face_descriptor), // 前端做欧氏距离匹配
    thumbnail: row.face_thumbnail,
    created_at: row.created_at,
  }));

  return ok({ total: items.length, items });
}

/** 获取签到记录（支持按驿站/日期筛选） */
async function handleFaceRecords(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const stationId = url.searchParams.get('station_id');
  const date = url.searchParams.get('date'); // YYYY-MM-DD
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '100', 10), 500);

  const where: string[] = [];
  const args: any[] = [];

  if (stationId && Number.isFinite(parseInt(stationId, 10))) {
    where.push('station_id = ?'); args.push(parseInt(stationId, 10));
  }
  if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
    where.push("date(created_at) = ?"); args.push(date);
  }

  const sql = `
    SELECT * FROM entry_records
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY created_at DESC
    LIMIT ?
  `;
  args.push(limit);

  const { results } = await env.DB.prepare(sql).bind(...args).all<EntryRecordRow>();

  // 查询关联的驿站名称
  const stationNames: Record<number, string> = {};
  const stationIds = new Set<number>();
  for (const r of results || []) {
    if (r.station_id) stationIds.add(r.station_id);
  }
  if (stationIds.size > 0) {
    const ids = Array.from(stationIds);
    const { results: stations } = await env.DB.prepare(
      `SELECT id, name FROM stations WHERE id IN (${ids.map(() => '?').join(',')})`
    ).bind(...ids).all<{ id: number; name: string }>();
    for (const s of stations || []) stationNames[s.id] = s.name;
  }

  const items = (results || []).map(r => ({
    id: r.id,
    face_id: r.face_id,
    name: r.name,
    station_name: r.station_id ? stationNames[r.station_id] || `驿站#${r.station_id}` : null,
    entry_type: r.entry_type,
    score: r.score,
    created_at: r.created_at,
  }));

  return ok({ total: items.length, items });
}