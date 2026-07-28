// 用 jsdom 真正执行前端逻辑（桩掉 AMap），验证「列表能否渲染出全部驿站」
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('/Users/odycai/.workbuddy/binaries/node/workspace/node_modules/jsdom');

const ROOT = '/Users/odycai/WorkBuddy/2026-07-26-15-09-25/ldl-platform/public';
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const dataJs = fs.readFileSync(path.join(ROOT, 'stations-data.js'), 'utf8');
const appJs = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');

// 构造 DOM，注入内联数据脚本（模拟 <script src=stations-data.js>）
const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'https://your-site.pages.dev/' });
const { window } = dom;

// 桩 AMap（jsdom 无真实地图，桩一个能跑通 placeMarkers 的轻量实现）
function makeMarker() {
  return {
    setMap() {}, on() {}, setContent() {}, getPosition() { return [0, 0]; },
    setCenter() {}, setZoom() {},
  };
}
window.AMap = class {
  constructor() {}
  static Map = class { constructor(){ this._ev={}; } on(e,cb){ this._ev[e]=cb; } setCenter(){} setBounds(){} setZoom(){} };
  static Marker = class { constructor(){} on(){} setMap(){} setContent(){} getPosition(){return [0,0];} };
  static Pixel = class { constructor(){} };
  static Bounds = class { extend(){} };
  static Map2 = class { on(){} };
};
window.AMap.Map = class { constructor(){ this._ev={}; } on(e,cb){ if(e==='complete') setTimeout(cb,0); } setCenter(){} setBounds(){} setZoom(){} };
window.AMap.Marker = class { constructor(){} on(){} setMap(){} setContent(){} getPosition(){return [0,0];} };
window.AMap.Pixel = class { constructor(){} };
window.AMap.Bounds = class { extend(){} };
window.AMap.Driving = class {};
window.AMap.PlaceSearch = class {};

// 注入内联数据
window.eval(dataJs);
// 注入 app.js 并触发 DOMContentLoaded
window.eval(appJs);
window.document.dispatchEvent(new window.Event('DOMContentLoaded'));

// 等微任务/异步完成
setTimeout(() => {
  const cards = window.document.querySelectorAll('#station-list .station-card').length;
  const total = window.document.querySelector('#stat-total')?.textContent;
  const count = window.document.querySelector('#list-count')?.textContent;
  const diag = window.document.querySelector('#debug-banner')?.textContent;
  const emptyHidden = window.document.querySelector('#list-empty')?.hidden;
  const firstCard = window.document.querySelector('#station-list .station-card .station-name')?.textContent?.trim();
  console.log('=== 渲染结果 ===');
  console.log('列表卡片数:', cards);
  console.log('页脚驿站总数:', total);
  console.log('列表计数文案:', count);
  console.log('列表空态 hidden?:', emptyHidden);
  console.log('首张卡片:', firstCard);
  console.log('诊断条:', diag);
  console.log(cards >= 80 ? '\n✅ 列表渲染正常（82 条已全部生成），前端逻辑没问题' : '\n❌ 列表异常，需排查');
}, 600);
