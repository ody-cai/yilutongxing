/* ============================================================
   「驿」路同行 — 环卫工人歇脚驿站地图 · 前端逻辑
   ============================================================
   - 与后端 API 通信：所有数据校验由后端完成
   - 写操作（反馈/管理员改状态）需用户触发并经 API
   - 地图：使用高德地图 JS API v1.4（无需安全密钥，规避 2.0 瓦片白名单问题）
   - 状态：用户位置缓存在 localStorage，刷新前复用
   ============================================================ */

(() => {
  'use strict';

  // ───────────── 配置 ─────────────
  const CONFIG = {
    AMAP_KEY: window.__AMAP_KEY__ || 'YOUR_AMAP_JS_API_KEY',
    AMAP_SECURITY: window.__AMAP_SECURITY__ || '',
    API_BASE: window.__API_BASE__ || '',
    // 郑州中心点
    DEFAULT_CENTER: [113.6253, 34.7466],
    DEFAULT_ZOOM: 12,
    USER_ZOOM: 14,
    LS_LOCATION: 'ldl.user.location',
    LS_ADMIN_TOKEN: 'ldl.admin.token',
    TOAST_DURATION: 2200,
  };

  // ───────────── 状态 ─────────────
  const state = {
    stations: [],
    filtered: [],
    meta: { facilities: [], statuses: [] },
    center: CONFIG.DEFAULT_CENTER,
    userLocation: null,        // { lat, lng, ts }
    activeId: null,
    map: null,
    markers: new Map(),        // id -> AMap.Marker
    userMarker: null,          // 用户定位标记
    currentInfoWindow: null,
    filter: { district: '', facility: '', status: 'open' },
    // ── 新功能状态 ──
    tab: 'map',
    openReportsByStation: {},  // stationId -> 待处理报修数（用于徽标）
    reports: [],
    suggestions: [],
    dashboard: null,
    benefitsUnlocked: false,
    dashMap: null,
    dashMarker: null,
    suggestPick: null,         // { lat, lng }
    expProducts: [],           // 到期报废商品列表
    expMap: null,              // 报废位置地图实例
    expMapMarker: null,        // 选中商品的地图标记
  };

  // 报修工单 / 选址建议 状态标签（前端展示用，与后端枚举一致）
  const REPORT_STATUS = { new: '待处理', acknowledged: '处理中', resolved: '已修复' };
  const REPORT_STATUS_CLASS = { new: 'is-new', acknowledged: 'is-doing', resolved: 'is-done' };
  const SUGGESTION_STATUS = { pending: '待审核', reviewing: '考察中', accepted: '已采纳', rejected: '未采纳' };
  const SUGGESTION_STATUS_CLASS = { pending: 'is-new', reviewing: 'is-doing', accepted: 'is-done', rejected: 'is-reject' };

  const formatTime = (s) => {
    if (!s) return '';
    // "2026-07-27 08:00:00" -> "07-27 08:00"
    const m = String(s).match(/(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
    if (m) return `${m[2]}-${m[3]} ${m[4]}:${m[5]}`;
    return String(s).slice(0, 16);
  };

  const statusPill = (label, cls) =>
    `<span class="status-pill ${cls || ''}">${escapeHtml(label)}</span>`;

  // ───────────── 工具 ─────────────
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));
  const escHtml = (s) => { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; };

  // ───────────── 诊断条 ─────────────
  const diag = { amap: '…', data: '…', err: '' };
  function setDiag() {
    const el = $('#debug-banner');
    if (!el) return;
    const parts = [
      `协议 <b>${location.protocol}</b>`,
      `站点 <b>${location.host || '(本地文件)'}</b>`,
      `高德引擎 ${diag.amap}`,
      `数据 ${diag.data}`,
    ];
    if (diag.err) parts.push(`<span class="dbg-err">⚠ ${escapeHtml(diag.err)}</span>`);
    el.innerHTML = '🔧 诊断：' + parts.join(' ｜ ');
    // 有错误时标红
    el.classList.toggle('is-error', !!diag.err);
  }
  function diagFatal(msg) {
    diag.err = msg;
    setDiag();
    const box = $('#map-error');
    if (box && box.hidden) { box.hidden = false; box.innerHTML = `<div class="map-error-inner"><div class="map-error-title">页面初始化失败</div><div class="map-error-detail">${escapeHtml(msg)}</div></div>`; }
  }

  const api = async (path, opts = {}) => {
    const base = CONFIG.API_BASE;
    const url = base ? `${base}${path}` : path;
    // 3 秒超时：API 不在线时快速回退，不卡页面
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 3000);
    try {
      const res = await fetch(url, {
        ...opts,
        signal: ctrl.signal,
        headers: {
          'content-type': 'application/json',
          ...(opts.headers || {}),
        },
      });
      clearTimeout(timer);
      let json;
      try { json = await res.json(); }
      catch { throw new Error(`服务器返回异常（${res.status}）`); }
      if (!json.ok) throw new Error(json.message || '请求失败');
      return json.data;
    } finally {
      clearTimeout(timer);
    }
  };

  const escapeHtml = (s) =>
    String(s ?? '').replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const formatDistance = (m) => {
    if (m == null) return '';
    if (m < 1000) return `${m} m`;
    return `${(m / 1000).toFixed(1)} km`;
  };

  const toast = (msg, type = '') => {
    const el = $('#toast');
    el.textContent = msg;
    el.className = `toast ${type ? 'is-' + type : ''}`;
    el.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { el.hidden = true; }, CONFIG.TOAST_DURATION);
  };

  // 设施图标（极简 SVG）
  const FACILITY_SVG = {
    drink:     '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M8 2h8v6a4 4 0 0 1-4 4 4 4 0 0 1-4-4V2z"/><path d="M6 22h12"/><path d="M12 12v10"/></svg>',
    ac:        '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 6h18M3 12h18M3 18h18"/><path d="M7 3v3M12 3v3M17 3v3M7 18v3M12 18v3M17 18v3"/></svg>',
    seat:      '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 4v8h12V4M6 12v8M18 12v8"/></svg>',
    charging:  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M13 2L4 14h7l-1 8 9-12h-7l1-8z"/></svg>',
    wifi:      '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M2 9a16 16 0 0 1 20 0M5 13a11 11 0 0 1 14 0M9 17a6 6 0 0 1 6 0"/></svg>',
    first_aid: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="4" y="6" width="16" height="14" rx="2"/><path d="M12 10v6M9 13h6"/></svg>',
    toilet:    '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="6" r="2"/><path d="M9 22l1-7h4l1 7M10 12h4"/></svg>',
    microwave: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="14" cy="12" r="3"/></svg>',
  };

  const FACILITY_LABEL = {
    drink: '饮水', ac: '空调', seat: '座椅', charging: '充电',
    wifi: 'Wi-Fi', first_aid: '急救包', toilet: '厕所', microwave: '微波炉',
  };

  const STATUS_LABEL = { open: '开放中', closed: '已关闭', maintenance: '维护中' };

  // 「降温友好」：同时具备空调 + 饮水，最适合缓解高温下的身体疲劳
  const isCoolFriendly = (s) =>
    Array.isArray(s.facilities) && s.facilities.includes('ac') && s.facilities.includes('drink');

  // ───────────── 地图错误诊断 ─────────────
  function showMapError(title, detail) {
    const box = $('#map-error');
    $('#map-loading').hidden = true;
    box.hidden = false;
    box.innerHTML = `
      <div class="map-error-inner">
        <div class="map-error-title">${escapeHtml(title)}</div>
        <div class="map-error-detail">${escapeHtml(detail)}</div>
        <div class="map-error-host">当前站点：${escapeHtml(location.hostname)}</div>
      </div>`;
  }

  // 把高德错误码翻译成可操作的中文提示
  function diagnoseAmapError(raw) {
    const msg = String(raw || '');
    if (/INVALID_USER_DOMAIN|绑定域名无效|domain/i.test(msg)) {
      return ['高德 Key 域名白名单未放行本站点',
        `请将当前站点加入高德 Key 的「域名白名单」：\n  ${location.protocol}//${location.hostname}\n` +
        '操作：高德开放平台 → 我的应用 → 该 Key → 域名白名单 → 添加上面地址（可临时留空以放开所有域名）。保存后刷新本页。'];
    }
    if (/INVALID_USER_SCODE|安全码|securityJsCode/i.test(msg)) {
      return ['高德安全密钥（securityJsCode）校验未通过',
        '请确认 index.html 中 window.__AMAP_SECURITY__ 填写的「安全密钥」与当前 Key 配套，且与高德控制台一致。'];
    }
    if (/USERKEY_PLAT_NOMATCH|绑定平台不符|平台不符/i.test(msg)) {
      return ['高德 Key 类型不匹配',
        '当前网站须用「Web端（JS API）」Key。请到高德控制台确认该 Key 的绑定服务是「Web端 (JS API)」，而非「Web服务」。'];
    }
    if (/INVALID_USER_KEY|key不正确|key不正确或过期/i.test(msg)) {
      return ['高德 Key 不正确或已过期',
        '请到高德控制台核对 Key，并确认 index.html 中 window.__AMAP_KEY__ 填写无误。'];
    }
    return ['地图加载失败',
      '请打开浏览器开发者工具（F12）→ Console 查看具体错误码，并核对高德 Key 与白名单配置。'];
  }

  // ───────────── 地图 ─────────────
  function initMap() {
    if (!window.AMap) {
      diag.amap = '❌ 未加载（Key/网络问题）';
      setDiag();
      showMapError('高德地图 JS 未加载', '请检查 index.html 中的高德 Key 与网络，或确认高德脚本标签已正确加载。');
      return null;
    }
    diag.amap = '✅ 已加载 (v1.4)';
    setDiag();
    let errored = false;
    try {
      const map = new AMap.Map('map', {
        zoom: CONFIG.DEFAULT_ZOOM,
        center: CONFIG.DEFAULT_CENTER,
        // 1.4 默认即 2D 路网样式，无需 viewMode / securityJsCode
      });
      map.on('complete', () => { $('#map-loading').hidden = true; });
      map.on('error', (e) => {
        errored = true;
        console.error('AMap map error', e);
        const detail = e ? JSON.stringify({ message: e.message || '', info: e.info || '', type: e.type || '', code: e.code || '' }) : 'null';
        diag.err = 'AMap错误: ' + detail;
        setDiag();
        const [t, d] = diagnoseAmapError(e && (e.message || e.info || JSON.stringify(e)));
        showMapError(t + ' [详情: ' + detail + ']', d);
      });
      state.map = map;

      // 兜底：即使瓦片加载较慢、或 complete 事件偶发未触发，
      // 2.5s 后也隐藏「加载中」，露出已打点的地图（marker 不依赖瓦片渲染）。
      // 若已发生真实 AMap 错误（#map-error 可见），则不触碰，保留错误提示。
      setTimeout(() => {
        if ($('#map-error').hidden) $('#map-loading').hidden = true;
      }, 2500);

      return map;
    } catch (e) {
      console.error('initMap failed', e);
      const [t, d] = diagnoseAmapError(e && e.message);
      showMapError(t, d);
      return null;
    }
  }

  // 捕获高德在加载/渲染阶段抛出的全局错误
  function onGlobalError(ev) {
    const txt = (ev && ev.message || '') + ' ' + (ev && ev.filename || '');
    if (/AMap|高德|INVALID_USER|USERKEY|DOMAIN|SCODE/i.test(txt)) {
      const [t, d] = diagnoseAmapError(txt);
      showMapError(t, d);
    }
  }

  function buildMarkerContent(station, hasReport) {
    const cls = station.status === 'open' ? '' :
                station.status === 'closed' ? 'is-closed' : 'is-maintenance';
    const el = document.createElement('div');
    el.className = `amap-marker-station ${cls}${hasReport ? ' has-report' : ''}`;
    el.innerHTML = `<div class="marker-pin ${cls}"></div>${hasReport ? '<span class="report-dot" title="有报修"></span>' : ''}`;
    return el;
  }

  function placeMarkers(stations) {
    const map = state.map;
    if (!map) return;

    // 清除旧 marker
    try { state.markers.forEach(m => map.remove(m)); } catch {}
    state.markers.clear();

    stations.forEach((s) => {
      try {
        const hasReport = !!state.openReportsByStation[s.id];
        const marker = new AMap.Marker({
          position: [s.location.lng, s.location.lat],
          content: buildMarkerContent(s, hasReport),
          offset: new AMap.Pixel(-18, -42),
          title: s.name,
          extData: { id: s.id },
          zIndex: hasReport ? 120 : 100,
        });
        marker.on('click', () => openDetail(s.id, { fromMap: true }));
        marker.setMap(map);
        state.markers.set(s.id, marker);
      } catch (e) {
        console.warn('placeMarkers: skip station', s.id, e);
      }
    });

    // 自适应视野
    try {
      if (stations.length > 0) {
        const bounds = new AMap.Bounds();
        stations.forEach(s => bounds.extend([s.location.lng, s.location.lat]));
        if (state.userLocation) {
          bounds.extend([state.userLocation.lng, state.userLocation.lat]);
        }
        map.setBounds(bounds, false, [40, 40, 80, 40]);
      }
    } catch (e) {
      console.warn('placeMarkers: setBounds failed', e);
    }
  }

  function focusMarker(id) {
    const marker = state.markers.get(id);
    if (marker && state.map) {
      state.map.setCenter(marker.getPosition());
      // 高亮（简单做法：替换 content）
      const s = state.stations.find(x => x.id === id);
      if (s) marker.setContent(buildMarkerContent({ ...s, status: s.status }));
    }
  }

  // 在地图上画「我的位置」蓝色标记
  function drawUserMarker(loc) {
    const map = state.map;
    if (!map) return;
    if (state.userMarker) state.userMarker.setMap(null);
    state.userMarker = new AMap.Marker({
      position: [loc.lng, loc.lat],
      content: '<div class="user-loc-dot"></div>',
      offset: new AMap.Pixel(-10, -10),
      zIndex: 200,
      title: '我的位置',
    });
    state.userMarker.setMap(map);
  }

  // ───────────── 列表 ─────────────
  function renderList() {
    const ul = $('#station-list');
    const list = state.filtered;

    if (!list.length) {
      ul.innerHTML = '';
      $('#list-empty').hidden = false;
      $('#list-count').textContent = '0 个结果';
      return;
    }
    $('#list-empty').hidden = true;
    $('#list-count').textContent = `${list.length} 个驿站`;

    const useDistance = !!state.userLocation;
    $('#list-sort').textContent = useDistance ? '按距离排序' : '按区域排序';

    ul.innerHTML = list.map((s, i) => {
      const facChips = s.facility_labels.slice(0, 5).map(f => `
        <span class="facility-chip">${FACILITY_SVG[f.key] || ''}${escapeHtml(f.label)}</span>
      `).join('');

      const dist = useDistance && s.distance_m != null
        ? `<span class="station-distance">${formatDistance(s.distance_m)}</span>`
        : '';

      return `
        <li class="station-card ${state.activeId === s.id ? 'is-active' : ''}"
            data-id="${s.id}" tabindex="0" role="button"
            aria-label="${escapeHtml(s.name)}, ${escapeHtml(s.address)}">
          <div class="station-name">
            <span>${i + 1}. ${escapeHtml(s.name)}</span>
            <span class="station-status status-${s.status}">${escapeHtml(STATUS_LABEL[s.status] || s.status)}</span>
            ${state.openReportsByStation[s.id] ? '<span class="station-status status-report">报修中</span>' : ''}
            ${isCoolFriendly(s) ? '<span class="station-status status-cool">降温友好</span>' : ''}
            ${dist}
          </div>
          <div class="station-address">${escapeHtml(s.address)} · ${escapeHtml(s.district)}</div>
          <div class="station-facilities">${facChips}</div>
          <div class="station-actions">
            <button class="btn btn-primary" data-act="nav" data-id="${s.id}">导航</button>
            <button class="btn" data-act="detail" data-id="${s.id}">详情</button>
          </div>
        </li>
      `;
    }).join('');

    // 绑定列表项点击
    ul.querySelectorAll('.station-card').forEach(card => {
      card.addEventListener('click', (e) => {
        const actBtn = e.target.closest('button[data-act]');
        const id = parseInt(card.dataset.id, 10);
        if (actBtn) {
          e.stopPropagation();
          if (actBtn.dataset.act === 'nav') openNavigation(id);
          else openDetail(id);
          return;
        }
        openDetail(id);
      });
      card.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          openDetail(parseInt(card.dataset.id, 10));
        }
      });
    });
  }

  // ───────────── 详情抽屉 ─────────────
  function openDetail(id, opts = {}) {
    const s = state.stations.find(x => x.id === id);
    if (!s) return;

    state.activeId = id;
    renderList(); // 更新激活态

    const adminToken = localStorage.getItem(CONFIG.LS_ADMIN_TOKEN) || '';
    const adminBlock = `
      <div class="admin-only">
        <strong>管理员操作（凭 token 切换状态）</strong>
        <input type="password" id="admin-token-input" placeholder="管理员 token（不保存到云端）" value="${escapeHtml(adminToken)}" autocomplete="off" />
        <div class="status-btns" data-station-id="${id}">
          <button data-status="open" class="${s.status === 'open' ? 'is-active' : ''}">开放</button>
          <button data-status="closed" class="${s.status === 'closed' ? 'is-active' : ''}">关闭</button>
          <button data-status="maintenance" class="${s.status === 'maintenance' ? 'is-active' : ''}">维护</button>
        </div>
      </div>
    `;

    const facChips = s.facility_labels.map(f => `
      <span class="facility-chip">${FACILITY_SVG[f.key] || ''}${escapeHtml(f.label)}</span>
    `).join('');

    const verifiedTag = s.verified ? '<span class="station-status status-open">已实地核实</span>' : '';
    const coolTag = isCoolFriendly(s) ? '<span class="station-status status-cool">降温友好 · 可降暑缓疲劳</span>' : '';

    $('#detail-body').innerHTML = `
      <h2 class="drawer-title" id="detail-title">${escapeHtml(s.name)}</h2>
      <div class="drawer-subtitle">
        <span class="station-status status-${s.status}">${escapeHtml(STATUS_LABEL[s.status] || s.status)}</span>
        ${verifiedTag}
        ${coolTag}
        · 开放时间：${escapeHtml(s.open_hours || '24小时')}
      </div>

      <div class="detail-section">
        <h3>位置</h3>
        <div class="detail-row">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 10c0 7-9 13-9 13S3 17 3 10a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>
          <span>${escapeHtml(s.address)}（${escapeHtml(s.district)}）</span>
        </div>
        ${s.contact_phone ? `
        <div class="detail-row">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M22 16.92V21a1 1 0 0 1-1.11 1A19 19 0 0 1 2 4.11 1 1 0 0 1 3 3h4.09a1 1 0 0 1 1 .75l1 4a1 1 0 0 1-.29 1L7 10.5a16 16 0 0 0 6.5 6.5l1.75-1.79a1 1 0 0 1 1-.29l4 1a1 1 0 0 1 .75 1z"/></svg>
          <a href="tel:${escapeHtml(s.contact_phone)}">${escapeHtml(s.contact_phone)}</a>
        </div>` : ''}
        ${s.manager ? `
        <div class="detail-row">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 21v-2a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
          <span>${escapeHtml(s.manager)}</span>
        </div>` : ''}
        ${s.description ? `<div class="detail-row" style="color: var(--c-text-2);">${escapeHtml(s.description)}</div>` : ''}
      </div>

      <div class="detail-section">
        <h3>设施</h3>
        <div class="detail-facilities">${facChips || '<span style="color:var(--c-text-3);font-size:13px;">暂无标注</span>'}</div>
        <div style="margin-top:8px; font-size:13px; color:var(--c-text-2);">
          容量：约 ${s.capacity} 人同时休息
        </div>
      </div>

      <div class="detail-actions">
        <button class="btn btn-primary" id="detail-nav">前往导航</button>
        <button class="btn" id="detail-share">分享位置</button>
      </div>

      <div class="detail-section">
        <button class="btn btn-report" id="detail-report" style="width:100%;min-height:46px;margin-bottom:10px;">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18v3h3l6.3-6.3a4 4 0 0 0 5.4-5.4l-2.6 2.6-2-2 2.6-2.6z"/></svg>
          一键报修
        </button>
        <div id="detail-reports-section" class="detail-reports" hidden>
          <h3>设施报修进度</h3>
          <ul id="detail-reports" class="report-mini-list"></ul>
        </div>
      </div>

      <div class="detail-section">
        <h3>驿站不准 / 想反馈？</h3>
        <button class="btn btn-ghost" id="detail-feedback" style="width:100%;min-height:44px;">提交反馈</button>
        ${adminBlock}
      </div>

      <p style="margin-top:14px; font-size:12px; color:var(--c-text-3);">
        数据更新于 ${escapeHtml(s.updated_at)}
      </p>
    `;

    showDrawer();

    // 绑定详情内按钮
    $('#detail-nav')?.addEventListener('click', () => openNavigation(id));
    $('#detail-share')?.addEventListener('click', () => shareStation(s));
    $('#detail-report')?.addEventListener('click', () => openReportModal(id));
    $('#detail-feedback')?.addEventListener('click', () => {
      $('#fb-station').value = id;
      openFeedbackModal();
    });

    // 加载该驿站的报修进度（闭环可见）
    loadStationReports(id);

    // 管理员状态按钮
    document.querySelectorAll('.status-btns button').forEach(btn => {
      btn.addEventListener('click', async () => {
        const token = $('#admin-token-input')?.value.trim();
        if (!token) { toast('请先输入管理员 token', 'error'); return; }
        try {
          await api(`/api/stations/${id}/status`, {
            method: 'POST',
            headers: { 'x-admin-token': token },
            body: JSON.stringify({ status: btn.dataset.status, note: '前端切换' }),
          });
          localStorage.setItem(CONFIG.LS_ADMIN_TOKEN, token);
          toast('状态已更新', 'success');
          await loadAll(); // 刷新
          openDetail(id); // 重新打开
        } catch (e) {
          toast(e.message || '更新失败', 'error');
        }
      });
    });

    if (opts.fromMap && state.map) {
      // 从地图点过来时，移动到该位置
      state.map.setCenter([s.location.lng, s.location.lat]);
    }
  }

  function showDrawer() {
    $('#detail-drawer').classList.add('is-open');
    $('#detail-drawer').setAttribute('aria-hidden', 'false');
    $('#drawer-backdrop').hidden = false;
  }
  function hideDrawer() {
    $('#detail-drawer').classList.remove('is-open');
    $('#detail-drawer').setAttribute('aria-hidden', 'true');
    $('#drawer-backdrop').hidden = true;
    state.activeId = null;
    renderList();
  }

  // ───────────── 导航 ─────────────
  function openNavigation(id) {
    const s = state.stations.find(x => x.id === id);
    if (!s) return;
    const { lat, lng } = s.location;
    // 高德地图 URL Scheme（唤起高德 App / Web）
    const url = `https://uri.amap.com/navigation?to=${lng},${lat},${encodeURIComponent(s.name)}&mode=walk&policy=1&src=ldl-yizhan&coordinate=gaode`;
    window.open(url, '_blank', 'noopener');
  }

  function shareStation(s) {
    const text = `${s.name}\n地址：${s.address}\n状态：${STATUS_LABEL[s.status]}\n${CONFIG.API_BASE ? '' : ''}坐标：${s.location.lat.toFixed(5)}, ${s.location.lng.toFixed(5)}`;
    if (navigator.share) {
      navigator.share({ title: s.name, text }).catch(() => {});
    } else if (navigator.clipboard) {
      navigator.clipboard.writeText(text).then(() => toast('已复制到剪贴板', 'success'));
    } else {
      toast(text, '');
    }
  }

  // ───────────── 反馈 ─────────────
  function openFeedbackModal() {
    hideDrawer();
    $('#feedback-modal').hidden = false;
    populateFeedbackStations();
    setTimeout(() => $('#fb-message').focus(), 100);
  }
  function closeFeedbackModal() {
    $('#feedback-modal').hidden = true;
    $('#fb-status').hidden = true;
  }

  function populateFeedbackStations() {
    const sel = $('#fb-station');
    const cur = sel.value;
    sel.innerHTML = '<option value="">不关联</option>' +
      state.stations.map(s => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join('');
    sel.value = cur;
  }

  async function submitFeedback() {
    const message = $('#fb-message').value.trim();
    if (!message) { toast('请填写反馈内容', 'error'); return; }
    const payload = {
      station_id: $('#fb-station').value || null,
      kind: $('#fb-kind').value,
      contact: $('#fb-contact').value.trim(),
      message,
    };
    const btn = $('#fb-submit');
    btn.disabled = true; btn.textContent = '提交中…';
    try {
      await api('/api/feedback', { method: 'POST', body: JSON.stringify(payload) });
      $('#fb-status').hidden = false;
      $('#fb-status').classList.remove('is-error');
      $('#fb-status').textContent = '感谢反馈！项目组会尽快汇总处理。';
      $('#fb-message').value = '';
      $('#fb-contact').value = '';
      setTimeout(closeFeedbackModal, 1500);
    } catch (e) {
      $('#fb-status').hidden = false;
      $('#fb-status').classList.add('is-error');
      $('#fb-status').textContent = e.message || '提交失败，请稍后重试';
    } finally {
      btn.disabled = false; btn.textContent = '提交';
    }
  }

  // ───────────── 数据 ─────────────
  // 优先读取前端打包的静态 JSON（避免 workers.dev 在部分网络不可达），
  // 失败时回退到远程 API。返回的是 data 形态（已解包）。
  async function loadDataLocalFirst(path, params) {
    // 1) 优先用内联全局（<script> 引入，file:// 下也能用，不受 fetch 限制）
    const inlineKey = { '/stations': '__LOCAL_STATIONS__', '/meta': '__LOCAL_META__', '/stats': '__LOCAL_STATS__' }[path];
    if (inlineKey && window[inlineKey]) {
      const j = window[inlineKey];
      const n = Array.isArray(j.items) ? j.items.length : (j.total != null ? j.total : '?');
      if (path === '/stations') diag.data = `✅ 内联数据（${n} 条）`;
      setDiag();
      return j;
    }
    // 2) 回退：fetch 本地 JSON（需 http(s) 环境）
    const localName = path.replace(/^\//, '') + '.json'; // '/stations' -> 'stations.json'
    try {
      const res = await fetch(localName, { cache: 'no-store' });
      if (res.ok) {
        const j = await res.json();
        if (j && j.ok === true && 'data' in j) {
          diag.data = `✅ 本地 ${localName}（${Array.isArray(j.data.items) ? j.data.items.length : '?'} 条）`;
          setDiag();
          return j.data; // 兼容 API 包装
        }
        const n = Array.isArray(j.items) ? j.items.length : (Array.isArray(j) ? j.length : '?');
        diag.data = `✅ 本地 ${localName}（${n} 条）`;
        setDiag();
        return j; // 本地直接是 data 形态
      }
      diag.data = `⚠ 本地 ${localName} 返回 ${res.status}，回退 API`;
      setDiag();
    } catch (e) {
      diag.data = `⚠ 本地 ${localName} 读取失败（${e.message}），回退 API`;
      setDiag();
      console.warn(`[local] 读取 ${localName} 失败，回退 API：`, e);
    }
    return api(`/api${path}?${params}`); // api() 内部已解包为 data
  }

  async function loadMeta() {
    try {
      const meta = await loadDataLocalFirst('/meta', new URLSearchParams());
      state.meta = meta;
      // 填充筛选
      const districts = [...new Set(state.stations.map(s => s.district))].sort((a, b) => a.localeCompare(b, 'zh'));
      $('#filter-district').innerHTML = '<option value="">全部区域</option>' +
        districts.map(d => `<option value="${escapeHtml(d)}">${escapeHtml(d)}</option>`).join('');
      $('#filter-facility').innerHTML = '<option value="">全部设施</option>' +
        '<option value="__cool__">降温友好</option>' +
        (meta.facilities || []).map(f => `<option value="${f.key}">${escapeHtml(f.label)}</option>`).join('');
      // 同步当前筛选态（如从指南页跳转进来时已选「降温友好」）
      $('#filter-facility').value = state.filter.facility || '';
    } catch (e) {
      console.warn('loadMeta failed', e);
    }
  }

  async function loadStations() {
    try {
      const params = new URLSearchParams();
      if (state.filter.status) params.set('status', state.filter.status);
      if (state.filter.district) params.set('district', state.filter.district);
      if (state.filter.facility) params.set('facility', state.filter.facility);
      if (state.userLocation) {
        params.set('lat', state.userLocation.lat);
        params.set('lng', state.userLocation.lng);
      }
      const data = await loadDataLocalFirst('/stations', params);
      // 本地数据需在前端按筛选条件过滤（对齐 API 行为）
      let items = Array.isArray(data.items) ? data.items : [];
      if (state.filter.status)    items = items.filter(s => s.status === state.filter.status);
      if (state.filter.district)  items = items.filter(s => s.district === state.filter.district);
      if (state.filter.facility) {
        if (state.filter.facility === '__cool__') {
          items = items.filter(s => isCoolFriendly(s));
        } else {
          items = items.filter(s => (s.facilities || []).includes(state.filter.facility));
        }
      }
      state.stations = items;
      state.filtered = items;
      try { renderList(); } catch (e) { console.warn('renderList failed:', e); }
      try {
        placeMarkers(state.filtered);
      } catch (markerErr) {
        // 地图标记失败不应当清空已加载的数据 — 列表依然可用
        console.warn('placeMarkers failed, list intact:', markerErr);
      }
      return data;
    } catch (e) {
      console.error('loadStations failed', e);
      diag.err = `数据加载失败：${e.message}`;
      setDiag();
      state.stations = [];
      state.filtered = [];
    }
  }

  async function loadStats() {
    try {
      const s = await loadDataLocalFirst('/stats', new URLSearchParams());
      $('#stat-total').textContent = s.total;
      const open = (s.by_status.find(x => x.key === 'open') || { count: 0 }).count;
      $('#stat-open').textContent = open;
      $('#stat-districts').textContent = s.by_district.length;
    } catch (e) {
      console.warn('loadStats failed', e);
    }
  }

  async function loadAll() {
    try {
      await loadStations();
      await loadOpenReports();
      await loadMeta();
      await loadStats();
    } catch (e) {
      console.error('loadAll unexpected error', e);
    }
  }

  // ───────────── 底部导航 / 视图切换 ─────────────
  function switchTab(name) {
    state.tab = name;
    $$('.view').forEach(v => { v.hidden = (v.id !== 'view-' + name); });
    $$('.nav-item').forEach(b => b.classList.toggle('is-active', b.dataset.tab === name));
    if (name === 'map' && state.map) { try { state.map.resize && state.map.resize(); } catch (e) {} }
    if (name === 'repair') loadRepairs();
    if (name === 'dash') { initDashMap(); if (state.dashMap) { try { state.dashMap.resize(); } catch (e) {} } loadDashboard(); loadSuggestions(); }
    if (name === 'map') loadOpenReports();
    if (name === 'expiry') renderExpList();
    if (name === 'about') { /* 静态页面 */ }
  }

  // ───────────── 一键报修（闭环） ─────────────
  async function loadOpenReports() {
    try {
      const data = await api('/api/reports?status=new,acknowledged');
      state.openReportsByStation = {};
      (data.items || []).forEach(r => {
        state.openReportsByStation[r.station_id] = (state.openReportsByStation[r.station_id] || 0) + 1;
      });
    } catch (e) { /* 离线：无徽标 */ }
    if (state.tab === 'map') { try { renderList(); placeMarkers(state.filtered); } catch (e) { console.warn('loadOpenReports render/placeMarkers failed:', e); } }
  }

  function openReportModal(stationId) {
    hideDrawer();
    const sel = $('#rp-station');
    sel.innerHTML = '<option value="">请选择驿站</option>' +
      state.stations.map(s => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join('');
    if (stationId) sel.value = stationId;
    renderReportFacilities(stationId);
    $('#rp-desc').value = '';
    $('#rp-contact').value = '';
    $('#rp-status').hidden = true;
    $('#report-modal').hidden = false;
    setTimeout(() => $('#rp-desc').focus(), 100);
  }
  function closeReportModal() { $('#report-modal').hidden = true; }

  function renderReportFacilities(stationId) {
    const box = $('#rp-facilities');
    const st = state.stations.find(s => String(s.id) === String(stationId));
    let items = st ? st.facility_labels
                   : Object.keys(FACILITY_LABEL).map(k => ({ key: k, label: FACILITY_LABEL[k] }));
    items = items.concat([{ key: 'other', label: '其他/整体' }]);
    box.innerHTML = items.map(f =>
      `<button type="button" class="chip-pick-item" data-key="${f.key}">${escapeHtml(f.label)}</button>`
    ).join('');
    $('#rp-facility').value = 'other';
    box.querySelectorAll('.chip-pick-item').forEach(b => {
      b.addEventListener('click', () => {
        box.querySelectorAll('.chip-pick-item').forEach(x => x.classList.remove('is-on'));
        b.classList.add('is-on');
        $('#rp-facility').value = b.dataset.key;
      });
    });
    const first = box.querySelector('.chip-pick-item');
    if (first) first.click();
  }

  async function submitReport() {
    const stationId = $('#rp-station').value;
    const desc = $('#rp-desc').value.trim();
    if (!stationId) { toast('请选择关联驿站', 'error'); return; }
    if (!desc) { toast('请填写故障描述', 'error'); return; }
    const payload = {
      station_id: parseInt(stationId, 10),
      facility: $('#rp-facility').value || 'other',
      description: desc,
      contact: $('#rp-contact').value.trim() || null,
    };
    const btn = $('#rp-submit'); btn.disabled = true; btn.textContent = '提交中…';
    try {
      await api(`/api/stations/${stationId}/reports`, { method: 'POST', body: JSON.stringify(payload) });
      $('#rp-status').hidden = false; $('#rp-status').classList.remove('is-error');
      $('#rp-status').textContent = '报修已提交！进度可在「报修」页查看，闭环处理后会更新状态。';
      setTimeout(() => { closeReportModal(); }, 1500);
      await loadOpenReports();
      await loadRepairs();
    } catch (e) {
      $('#rp-status').hidden = false; $('#rp-status').classList.add('is-error');
      $('#rp-status').textContent = e.message || '提交失败，请稍后重试';
    } finally { btn.disabled = false; btn.textContent = '提交报修'; }
  }

  async function loadStationReports(id) {
    const sec = $('#detail-reports-section'); const ul = $('#detail-reports');
    if (!sec || !ul) return;
    try {
      const data = await api(`/api/stations/${id}/reports`);
      const items = (data.items || []).filter(r => r.status !== 'resolved');
      if (!items.length) { sec.hidden = true; return; }
      ul.innerHTML = items.map(r => `
        <li class="report-mini">
          <span class="report-mini-fac">${escapeHtml(r.facility_label)}</span>
          ${statusPill(r.status_label, REPORT_STATUS_CLASS[r.status])}
          <span class="report-mini-desc">${escapeHtml(r.description)}</span>
        </li>`).join('');
      sec.hidden = false;
    } catch (e) { sec.hidden = true; }
  }

  async function loadRepairs() {
    try {
      const data = await api('/api/reports');
      state.reports = data.items || [];
    } catch (e) { state.reports = []; }
    renderRepairList();
  }

  function renderRepairList() {
    const ul = $('#repair-list'); const empty = $('#repair-empty'); const count = $('#repair-count');
    if (!ul) return;
    const list = state.reports;
    count.textContent = list.length ? `${list.length} 条工单` : '—';
    if (!list.length) { ul.innerHTML = ''; empty.hidden = false; return; }
    empty.hidden = true;
    const adminToken = localStorage.getItem(CONFIG.LS_ADMIN_TOKEN) || '';
    ul.innerHTML = list.map(r => `
      <li class="repair-card">
        <div class="repair-head">
          <span class="repair-station">${escapeHtml(r.station_name)}</span>
          ${statusPill(r.status_label, REPORT_STATUS_CLASS[r.status])}
        </div>
        <div class="repair-fac">${escapeHtml(r.facility_label)}</div>
        <div class="repair-desc">${escapeHtml(r.description)}</div>
        <div class="repair-foot">
          <span class="repair-time">${formatTime(r.created_at)}</span>
          ${adminToken && r.status !== 'resolved' ? `<button class="btn btn-mini" data-resolve="${r.id}">标记已修复</button>` : ''}
        </div>
      </li>`).join('');
    if (adminToken) {
      ul.querySelectorAll('[data-resolve]').forEach(b => {
        b.addEventListener('click', () => resolveReport(parseInt(b.dataset.resolve, 10), b));
      });
    }
  }

  async function resolveReport(id, btn) {
    const token = localStorage.getItem(CONFIG.LS_ADMIN_TOKEN) || '';
    if (!token) { toast('需管理员 token', 'error'); return; }
    if (btn) { btn.disabled = true; btn.textContent = '处理中…'; }
    try {
      await api(`/api/reports/${id}/status`, {
        method: 'POST', headers: { 'x-admin-token': token },
        body: JSON.stringify({ status: 'resolved', note: '前端闭环处理' }),
      });
      toast('已标记为已修复', 'success');
      await loadRepairs();
      await loadOpenReports();
    } catch (e) {
      toast(e.message || '操作失败', 'error');
      if (btn) { btn.disabled = false; btn.textContent = '标记已修复'; }
    }
  }

  // ───────────── 权益自助站（工会专属） ─────────────
  async function verifyBenefits() {
    const code = $('#benefits-code').value.trim();
    if (!code) { showBenefitsStatus('请输入口令', true); return; }
    const btn = $('#benefits-unlock'); btn.disabled = true; btn.textContent = '校验中…';
    try {
      const data = await api('/api/benefits/verify', { method: 'POST', body: JSON.stringify({ code }) });
      state.benefitsUnlocked = true;
      $('#benefits-lock').hidden = true;
      renderBenefits(data.benefits);
      $('#benefits-list').hidden = false;
    } catch (e) {
      showBenefitsStatus(e.message || '口令不正确', true);
    } finally { btn.disabled = false; btn.textContent = '验证'; }
  }
  function showBenefitsStatus(msg, isErr) {
    const el = $('#benefits-lock-status'); el.hidden = false;
    el.classList.toggle('is-error', !!isErr); el.textContent = msg;
  }
  function renderBenefits(benefits) {
    const grid = $('#benefits-list');
    grid.innerHTML = (benefits || []).map(b => `
      <div class="benefit-card">
        <div class="benefit-top">
          <h3 class="benefit-title">${escapeHtml(b.title)}</h3>
          <span class="benefit-tag">${escapeHtml(b.tag)}</span>
        </div>
        <p class="benefit-summary">${escapeHtml(b.summary)}</p>
        <div class="benefit-meta">
          <div><span class="bm-label">适用对象</span><span class="bm-val">${escapeHtml(b.who)}</span></div>
          <div><span class="bm-label">办理方式</span><span class="bm-val">${escapeHtml(b.how)}</span></div>
        </div>
      </div>`).join('');
  }

  // ───────────── 数据驾驶舱 + 选址众包 ─────────────
  let dashSuggestionMarkers = [];
  function initDashMap() {
    if (state.dashMap || !window.AMap) return;
    const map = new AMap.Map('dash-map', { zoom: 11, center: CONFIG.DEFAULT_CENTER });
    map.on('click', (e) => {
      const lng = e.lnglat.getLng(), lat = e.lnglat.getLat();
      state.suggestPick = { lat, lng };
      if (state.dashMarker) state.dashMap.remove(state.dashMarker);
      state.dashMarker = new AMap.Marker({
        position: [lng, lat], content: '<div class="user-loc-dot"></div>',
        offset: new AMap.Pixel(-10, -10), zIndex: 200,
      });
      state.dashMarker.setMap(map);
      const tip = $('#dash-map-tip');
      tip.textContent = `已选点：${lat.toFixed(5)}, ${lng.toFixed(5)}（可重新点击调整）`;
      tip.classList.add('is-set');
    });
    state.dashMap = map;
    loadSuggestions();
  }
  function plotSuggestionMarkers() {
    if (!state.dashMap) return;
    dashSuggestionMarkers.forEach(m => state.dashMap.remove(m));
    dashSuggestionMarkers = [];
    state.suggestions.forEach(sg => {
      const m = new AMap.Marker({
        position: [sg.location.lng, sg.location.lat],
        content: '<div class="suggest-pin"></div>', offset: new AMap.Pixel(-9, -18), zIndex: 50,
      });
      m.setMap(state.dashMap); dashSuggestionMarkers.push(m);
    });
  }

  async function loadDashboard() {
    try {
      const d = await api('/api/dashboard');
      state.dashboard = d;
      renderDashboard(d);
    } catch (e) {
      $('#dash-kpi').innerHTML = '<div class="dash-offline">（需联网加载驾驶舱数据）</div>';
    }
  }
  function renderDashboard(d) {
    const s = d.stations, r = d.repairs, sg = d.suggestions;
    const sc = (key) => key === 'open' ? 'var(--c-success)' : key === 'maintenance' ? 'var(--c-warning)' : 'var(--c-text-3)';
    const rc = (key) => key === 'resolved' ? 'var(--c-success)' : key === 'new' ? 'var(--c-danger)' : 'var(--c-warning)';
    renderKpiRow($('#dash-kpi'), [
      { num: s.total, label: '驿站总数', color: 'var(--c-accent)' },
      { num: (s.by_status.find(x => x.key === 'open') || {}).count || 0, label: '正在开放', color: 'var(--c-success)' },
      { num: r.open, label: '报修待处理', color: 'var(--c-danger)' },
      { num: sg.total, label: '选址建议', color: 'var(--c-primary-deep)' },
    ]);
    renderBarList($('#dash-station-status'), s.by_status.map(x => ({ label: x.label, count: x.count, color: sc(x.key) })));
    renderBarList($('#dash-district'), s.by_district.slice(0, 8).map(x => ({ label: x.district, count: x.count })));
    renderBarList($('#dash-repair'), r.by_status.map(x => ({ label: x.label, count: x.count, color: rc(x.key) })));
    renderBarList($('#dash-suggest'), sg.by_status.map(x => ({ label: x.label, count: x.count })));
    renderActivity($('#dash-activity'), d.recent_activity);
  }
  function renderKpiRow(el, items) {
    if (!el) return;
    el.innerHTML = items.map(it => `
      <div class="kpi">
        <div class="kpi-num" style="color:${it.color || 'var(--c-text)'}">${it.num}</div>
        <div class="kpi-label">${escapeHtml(it.label)}</div>
      </div>`).join('');
  }
  function renderBarList(el, items) {
    if (!el) return;
    if (!items || !items.length) { el.innerHTML = '<div class="bar-empty">暂无数据</div>'; return; }
    const max = Math.max(...items.map(i => i.count), 1);
    el.innerHTML = items.map(it => {
      const pct = Math.round((it.count / max) * 100);
      const color = it.color || 'var(--c-primary)';
      return `
        <div class="bar-row">
          <span class="bar-label">${escapeHtml(it.label)}</span>
          <span class="bar-track"><span class="bar-fill" style="width:${pct}%;background:${color}"></span></span>
          <span class="bar-num">${it.count}</span>
        </div>`;
    }).join('');
  }
  function renderActivity(el, items) {
    if (!el) return;
    if (!items || !items.length) { el.innerHTML = '<li class="act-empty">暂无动态</li>'; return; }
    el.innerHTML = items.map(a => {
      const isReport = a.type === 'report';
      const icon = isReport ? '🛠️' : '📍';
      const cls = isReport ? (REPORT_STATUS_CLASS[a.status] || '') : (SUGGESTION_STATUS_CLASS[a.status] || '');
      return `
        <li class="act-item">
          <span class="act-icon">${icon}</span>
          <span class="act-body">
            <span class="act-summary">${escapeHtml(a.summary)}</span>
            <span class="act-time">${formatTime(a.created_at)}</span>
          </span>
          ${statusPill(a.status_label, cls)}
        </li>`;
    }).join('');
  }

  async function loadSuggestions() {
    try {
      const data = await api('/api/suggestions');
      state.suggestions = data.items || [];
      renderSuggestions(state.suggestions);
      plotSuggestionMarkers();
    } catch (e) { /* 离线：不绘制 */ }
  }
  function renderSuggestions(list) {
    const ul = $('#dash-suggest-list');
    if (!ul) return;
    if (!list.length) { ul.innerHTML = '<li class="suggest-empty">暂无建议，快来众包推荐选址！</li>'; return; }
    ul.innerHTML = list.map(sg => `
      <li class="suggest-item">
        <div class="suggest-head">
          <span class="suggest-addr">${escapeHtml(sg.address || (sg.location.lat.toFixed(4) + ', ' + sg.location.lng.toFixed(4)))}</span>
          ${statusPill(sg.status_label, SUGGESTION_STATUS_CLASS[sg.status])}
        </div>
        <div class="suggest-reason">${escapeHtml(sg.reason)}</div>
      </li>`).join('');
  }
  async function submitSuggestion() {
    const reason = $('#sg-reason').value.trim();
    if (!reason) { toast('请填写推荐理由', 'error'); return; }
    if (!state.suggestPick) { toast('请在地图上点选推荐位置', 'error'); return; }
    const payload = {
      lat: state.suggestPick.lat, lng: state.suggestPick.lng,
      reason,
      address: $('#sg-address').value.trim() || null,
      contact: $('#sg-contact').value.trim() || null,
    };
    const btn = $('#sg-submit'); btn.disabled = true; btn.textContent = '提交中…';
    try {
      await api('/api/suggestions', { method: 'POST', body: JSON.stringify(payload) });
      $('#sg-status').hidden = false; $('#sg-status').classList.remove('is-error');
      $('#sg-status').textContent = '感谢众包！建议已提交，项目组将实地考察。';
      $('#sg-reason').value = ''; $('#sg-address').value = ''; $('#sg-contact').value = '';
      state.suggestPick = null;
      if (state.dashMarker) { state.dashMap.remove(state.dashMarker); state.dashMarker = null; }
      const tip = $('#dash-map-tip'); tip.textContent = '点击地图选择推荐点位'; tip.classList.remove('is-set');
      await loadSuggestions(); await loadDashboard();
      setTimeout(() => { $('#sg-status').hidden = true; }, 2000);
    } catch (e) {
      $('#sg-status').hidden = false; $('#sg-status').classList.add('is-error');
      $('#sg-status').textContent = e.message || '提交失败，请稍后重试';
    } finally { btn.disabled = false; btn.textContent = '提交选址建议'; }
  }

  // ───────────── 定位 ─────────────
  function locateUser() {
    if (!navigator.geolocation) { toast('当前设备不支持定位', 'error'); return; }
    const btn = $('#locate-btn');
    btn.disabled = true;
    navigator.geolocation.getCurrentPosition((pos) => {
      const loc = { lat: pos.coords.latitude, lng: pos.coords.longitude, ts: Date.now() };
      state.userLocation = loc;
      localStorage.setItem(CONFIG.LS_LOCATION, JSON.stringify(loc));
      state.center = [loc.lng, loc.lat];
      if (state.map) {
        state.map.setCenter(state.center);
        drawUserMarker(loc);
      }
      toast('已定位，正在按距离排序', 'success');
      btn.disabled = false;
      loadAll();
    }, (err) => {
      btn.disabled = false;
      toast('定位失败：' + (err.message || '请允许浏览器定位权限'), 'error');
    }, { enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 });
  }

  function restoreLocation() {
    try {
      const raw = localStorage.getItem(CONFIG.LS_LOCATION);
      if (!raw) return;
      const loc = JSON.parse(raw);
      if (Date.now() - (loc.ts || 0) < 30 * 60 * 1000) {
        state.userLocation = loc;
      }
    } catch {}
  }

  // ───────────── 到期报废管理 ─────────────
  const EXP_STORAGE_KEY = 'yizhan_exp_products_v1';

  function loadExpProducts() {
    try {
      const raw = localStorage.getItem(EXP_STORAGE_KEY);
      state.expProducts = raw ? JSON.parse(raw) : [];
    } catch (e) {
      state.expProducts = [];
    }
  }

  function saveExpProducts() {
    try {
      localStorage.setItem(EXP_STORAGE_KEY, JSON.stringify(state.expProducts));
    } catch (e) {
      console.warn('saveExpProducts failed', e);
    }
  }

  /** 判断到期状态 */
  function getExpStatus(expiryDate) {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const exp = new Date(expiryDate); exp.setHours(0, 0, 0, 0);
    const diff = (exp - today) / (1000 * 60 * 60 * 24);
    if (diff < 0) return 'expired';          // 已过期
    if (diff <= 7) return 'soon';            // 7 天内到期
    return 'ok';
  }

  function renderExpList() {
    loadExpProducts();
    const list = $('#exp-list');
    const empty = $('#exp-empty');
    const countEl = $('#exp-count');
    const mapWrap = $('#exp-map-wrap');

    if (!state.expProducts.length) {
      list.innerHTML = '';
      empty.hidden = false;
      countEl.textContent = '0 件商品';
      mapWrap.hidden = true;
      return;
    }

    empty.hidden = true;
    const active = state.expProducts.filter(p => !p.disposed);
    const expired = active.filter(p => getExpStatus(p.expiryDate) === 'expired');
    countEl.textContent = active.length + ' 件在库（' + expired.length + ' 件已过期）';

    // 排序：已过期 > 即将到期 > 正常
    const sorted = [...active].sort((a, b) => {
      const sa = getExpStatus(a.expiryDate);
      const sb = getExpStatus(b.expiryDate);
      const order = { expired: 0, soon: 1, ok: 2 };
      return (order[sa] || 99) - (order[sb] || 99);
    });

    list.innerHTML = sorted.map(p => {
      const status = getExpStatus(p.expiryDate);
      const cls = p.disposed ? 'is-disposed' : (status === 'expired' ? 'is-expired' : (status === 'soon' ? 'is-soon' : ''));
      const dateCls = 'exp-' + status;
      const dateLabel = status === 'expired' ? '已过期 ' + p.expiryDate :
                        status === 'soon' ? '即将到期 ' + p.expiryDate :
                        '到期日 ' + p.expiryDate;
      return `<li class="exp-card ${cls}">
        <div class="exp-card-row">
          <span class="exp-card-name">${escHtml(p.name)}</span>
          <span class="exp-card-qty">${p.qty} 件</span>
        </div>
        <div class="exp-card-date ${dateCls}">${dateLabel}</div>
        <div class="exp-card-loc">📍 ${escHtml(p.locationName || '未指定位置')}</div>
        <div class="exp-card-actions">
          <button class="btn-mini btn-warn" data-exp-locate="${p.id}">📍 查看位置</button>
          <button class="btn-mini btn-danger" data-exp-dispose="${p.id}">🗑 确认报废</button>
        </div>
      </li>`;
    }).join('');

    // 显示/隐藏过期商品地图
    if (expired.length > 0) {
      mapWrap.hidden = false;
      $('#exp-map-tip').textContent = expired.length + ' 件商品已过期，请及时到以下位置处理报废。';
      setTimeout(() => initExpMap(expired), 100);
    } else {
      mapWrap.hidden = true;
    }
  }

  function initExpMap(expiredProducts) {
    const container = $('#exp-map');
    if (!state.expMap) {
      state.expMap = new AMap.Map(container, {
        zoom: 12,
        center: [113.65, 34.76], // 郑州中心
      });
    }
    const map = state.expMap;
    map.clearMap();
    if (expiredProducts.length === 0) return;

    // 按位置去重聚类显示
    const locMap = {};
    expiredProducts.forEach(p => {
      if (p.lat && p.lng) {
        const key = p.lat.toFixed(4) + ',' + p.lng.toFixed(4);
        if (!locMap[key]) locMap[key] = { lat: p.lat, lng: p.lng, items: [] };
        locMap[key].items.push(p);
      }
    });

    const markers = [];
    Object.values(locMap).forEach(loc => {
      const marker = new AMap.Marker({
        position: [loc.lng, loc.lat],
        title: loc.items.map(i => i.name).join('、'),
        label: { content: loc.items.length + '件', offset: new AMap.Pixel(0, -20) },
      });
      markers.push(marker);
    });
    map.add(markers);
    map.setFitView(null, false, [60, 60, 60, 60]);
  }

  function addExpProduct(name, qty, expiryDate, locationName, lat, lng) {
    loadExpProducts();
    state.expProducts.push({
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      name: name.trim(),
      qty: parseInt(qty) || 1,
      expiryDate: expiryDate,
      locationName: locationName || '',
      lat: lat || null,
      lng: lng || null,
      disposed: false,
      disposedAt: null,
      createdAt: new Date().toISOString(),
    });
    saveExpProducts();
  }

  function disposeProduct(id) {
    loadExpProducts();
    const p = state.expProducts.find(p => p.id === id);
    if (p && !p.disposed) {
      p.disposed = true;
      p.disposedAt = new Date().toISOString();
      saveExpProducts();
    }
  }

  function showExpForm() {
    const form = document.createElement('div');
    form.className = 'exp-form';
    form.id = 'exp-input-form';
    form.innerHTML = `
      <div class="exp-form-row">
        <label class="form-label"><span>商品名称 *</span>
          <input id="exp-name" type="text" placeholder="如：矿泉水、面包" maxlength="20" /></label>
        <label class="form-label"><span>数量</span>
          <input id="exp-qty" type="number" value="1" min="1" max="9999" style="width:70px" /></label>
      </div>
      <label class="form-label"><span>到期日期 *</span>
        <input id="exp-date" type="date" /></label>
      <label class="form-label"><span>存放位置（可选）</span>
        <input id="exp-loc" type="text" placeholder="如：金水区花园路驿站1号柜" maxlength="50" /></label>
      <div class="exp-form-row">
        <label class="form-label"><span>纬度（可选）</span>
          <input id="exp-lat" type="number" step="any" placeholder="如 34.76" /></label>
        <label class="form-label"><span>经度（可选）</span>
          <input id="exp-lng" type="number" step="any" placeholder="如 113.65" /></label>
      </div>
      <div class="exp-form-actions">
        <button id="exp-cancel-btn" class="btn-mini" type="button">取消</button>
        <button id="exp-save-btn" class="btn-mini btn-primary" type="button">保存</button>
      </div>
    `;

    const list = $('#exp-list');
    list.parentNode.insertBefore(form, list);
    form.style.display = 'block';
    $('#exp-add-btn').disabled = true;

    // 默认到期日设为 30 天后
    const defDate = new Date();
    defDate.setDate(defDate.getDate() + 30);
    $('#exp-date').value = defDate.toISOString().slice(0, 10);

    $('#exp-cancel-btn').addEventListener('click', () => {
      form.remove();
      $('#exp-add-btn').disabled = false;
    });

    $('#exp-save-btn').addEventListener('click', () => {
      const name = $('#exp-name').value.trim();
      const qty = parseInt($('#exp-qty').value) || 1;
      const expiryDate = $('#exp-date').value;
      const loc = $('#exp-loc').value.trim();
      const lat = parseFloat($('#exp-lat').value) || null;
      const lng = parseFloat($('#exp-lng').value) || null;

      if (!name) { alert('请输入商品名称'); return; }
      if (!expiryDate) { alert('请选择到期日期'); return; }

      addExpProduct(name, qty, expiryDate, loc, lat, lng);
      renderExpList();
      form.remove();
      $('#exp-add-btn').disabled = false;
    });
  }

  // 委托事件：报废 + 位置
  $('#exp-list').addEventListener('click', function(e) {
    const disposeBtn = e.target.closest('[data-exp-dispose]');
    const locateBtn = e.target.closest('[data-exp-locate]');

    if (disposeBtn) {
      const id = disposeBtn.dataset.expDispose;
      if (confirm('确认将此商品标记为"已报废"？')) {
        disposeProduct(id);
        renderExpList();
      }
    }

    if (locateBtn) {
      const id = locateBtn.dataset.expLocate;
      const p = state.expProducts.find(x => x.id === id);
      if (p && p.lat && p.lng && state.expMap) {
        state.expMap.setZoomAndCenter(15, [p.lng, p.lat]);
        // 闪烁高亮
        if (state.expMapMarker) state.expMap.remove(state.expMapMarker);
        state.expMapMarker = new AMap.Marker({
          position: [p.lng, p.lat],
          animation: 'AMAP_ANIMATION_DROP',
        });
        state.expMap.add(state.expMapMarker);
      } else if (p && !p.lat) {
        alert('该商品未记录经纬度，无法定位');
      }
    }
  });

  $('#exp-add-btn').addEventListener('click', showExpForm);

  // ───────────── 事件绑定 ─────────────
  function bindEvents() {
    $('#locate-btn').addEventListener('click', locateUser);
    $('#detail-close').addEventListener('click', hideDrawer);
    $('#drawer-backdrop').addEventListener('click', hideDrawer);

    $('#feedback-btn').addEventListener('click', openFeedbackModal);
    $('#fb-cancel').addEventListener('click', closeFeedbackModal);
    $('#fb-submit').addEventListener('click', submitFeedback);

    $('#filter-district').addEventListener('change', (e) => {
      state.filter.district = e.target.value;
      loadStations();
    });
    $('#filter-facility').addEventListener('change', (e) => {
      state.filter.facility = e.target.value;
      loadStations();
    });
    $('#filter-status').addEventListener('change', (e) => {
      state.filter.status = e.target.value;
      loadStations();
    });

    $('#map-refresh').addEventListener('click', () => {
      loadAll();
      toast('已刷新', 'success');
    });

    // ── 底部导航（签到跳转独立页，其余切 tab）──
    $$('.nav-item').forEach(b => {
      if (b.dataset.tab === 'checkin') {
        b.addEventListener('click', () => { window.location.href = './face-checkin.html'; });
      } else {
        b.addEventListener('click', () => switchTab(b.dataset.tab));
      }
    });

    // 指南页：「找最近降温友好驿站」→ 切到地图并应用筛选 + 定位
    $('#guide-find-btn')?.addEventListener('click', () => {
      state.filter.facility = '__cool__';
      const sel = $('#filter-facility');
      if (sel) sel.value = '__cool__';
      switchTab('map');
      if (state.userLocation) loadAll();
      else { loadStations(); locateUser(); }
    });

    // 指南页：「刷脸签到」→ 跳转刷脸页面
    $('#btn-face-checkin')?.addEventListener('click', () => {
      const url = './face-checkin.html';
      // 尝试优先在当前窗口（移动端 PWA 体验），兜底新窗口
      const a = document.createElement('a');
      a.href = url;
      a.target = window.navigator.standalone ? '_self' : '_self';
      a.click();
    });


    // ── 一键报修 ──
    $('#repair-new-btn').addEventListener('click', () => openReportModal());
    $('#rp-cancel').addEventListener('click', closeReportModal);
    $('#rp-submit').addEventListener('click', submitReport);
    $('#rp-station').addEventListener('change', (e) => renderReportFacilities(e.target.value));

    // ── 权益自助站 ──
    $('#benefits-unlock').addEventListener('click', verifyBenefits);
    $('#benefits-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') verifyBenefits(); });

    // ── 选址众包 ──
    $('#sg-submit').addEventListener('click', submitSuggestion);

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (!$('#report-modal').hidden) closeReportModal();
        else if (!$('#feedback-modal').hidden) closeFeedbackModal();
        else hideDrawer();
      }
    });
  }

  // ───────────── 启动 ─────────────
  async function main() {
    // 协议自检：file:// 下 fetch 本地 JSON 会被浏览器拦截，必须走 http(s)
    if (location.protocol === 'file:') {
      diagFatal('检测到用 file:// 直接打开页面！浏览器会禁止读取本地 stations.json，高德地图也需要 http 环境。请用本地服务器或部署后访问，例如：在项目目录执行 `python3 -m http.server 8080` 然后打开 http://localhost:8080');
      return;
    }
    try {
      setDiag();
      bindEvents();
      window.addEventListener('error', onGlobalError, true);
      restoreLocation();
      initMap();
      await loadAll();
      if (state.stations.length === 0 && !diag.err) {
        diag.err = '数据加载异常：驿站列表为空（内联数据缺失或加载失败）。请刷新页面，若持续出现请反馈';
        setDiag();
      }
    } catch (e) {
      console.error('main crashed', e);
      diagFatal((e && e.message) || String(e));
    }
  }

  // DOM 就绪后启动
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', main);
  } else {
    main();
  }
})();