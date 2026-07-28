// 解析 public/stations-data.js 中的 window.__LOCAL_STATIONS__，
// 生成 seed_stations_live.sql：清空现有 stations 后，按真实 id 灌入 82 条，
// 字段对齐 stations 表。供线上 D1 初次/重置数据使用。
const fs = require('fs');
const path = require('path');

const dataFile = path.join(__dirname, '..', 'public', 'stations-data.js');
const src = fs.readFileSync(dataFile, 'utf8');

// 在受控作用域里执行赋值语句，拿到 window.__LOCAL_STATIONS__
const win = {};
const fn = new Function('window', src + '\n;return window.__LOCAL_STATIONS__;');
const data = fn(win);
if (!data || !Array.isArray(data.items)) {
  console.error('解析失败：未找到 __LOCAL_STATIONS__.items');
  process.exit(1);
}

const esc = (v) => {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? '1' : '0';
  return `'${String(v).replace(/'/g, "''")}'`;
};

const rows = data.items.map((s) => {
  const loc = s.location || {};
  return `INSERT INTO stations (id, name, address, district, street, lat, lng, facilities, status, open_hours, contact_phone, manager, capacity, description, verified, created_at, updated_at, deleted_at, source) VALUES (`
    + `${esc(s.id)}, ${esc(s.name)}, ${esc(s.address)}, ${esc(s.district)}, ${esc(s.street)}, `
    + `${esc(loc.lat)}, ${esc(loc.lng)}, ${esc(JSON.stringify(s.facilities || []))}, ${esc(s.status)}, `
    + `${esc(s.open_hours)}, ${esc(s.contact_phone)}, ${esc(s.manager)}, ${esc(s.capacity)}, `
    + `${esc(s.description)}, ${esc(s.verified ? 1 : 0)}, ${esc(s.created_at)}, ${esc(s.updated_at)}, ${esc(s.deleted_at || 0)}, 'import');`;
}).join('\n');

const header = `-- ============================================\n`
  + `-- 站点数据灌库（线上 D1 初次/重置）\n`
  + `-- 来源：public/stations-data.js 的 window.__LOCAL_STATIONS__（82 条真实驿站，id 54-135）\n`
  + `-- 执行：wrangler d1 execute ldl-yizhan-db --file=./seed_stations_live.sql --remote\n`
  + `-- 注意：会清空现有 stations（级联清空空表 station_events/repair_reports/feedback 置 NULL）\n`
  + `-- ============================================\n\n`
  + `DELETE FROM stations;\n\n`
  + rows + '\n';

const out = path.join(__dirname, '..', 'seed_stations_live.sql');
fs.writeFileSync(out, header);
console.log(`已生成 ${out}（${data.items.length} 条，id ${data.items[0].id}..${data.items[data.items.length-1].id}）`);
