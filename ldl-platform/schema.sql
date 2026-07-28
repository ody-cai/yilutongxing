-- ============================================
-- 「驿」路同行 — 环卫工人歇脚驿站平台
-- Cloudflare D1 (SQLite) 数据库结构
-- ============================================

-- 驿站主表
CREATE TABLE IF NOT EXISTS stations (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT    NOT NULL,                    -- 驿站名称
  address         TEXT    NOT NULL,                    -- 详细地址
  district        TEXT    NOT NULL,                    -- 所在区（金水区/二七区/中原区…）
  street          TEXT,                                -- 街道/路名
  lat             REAL    NOT NULL,                    -- 纬度（WGS-84）
  lng             REAL    NOT NULL,                    -- 经度（WGS-84）

  -- 设施能力（JSON 数组，键值见 FACILITY_KEYS）
  facilities      TEXT    NOT NULL DEFAULT '[]',

  -- 状态: open / closed / maintenance
  status          TEXT    NOT NULL DEFAULT 'open'
                  CHECK (status IN ('open','closed','maintenance')),

  -- 营业/开放信息
  open_hours      TEXT    NOT NULL DEFAULT '24小时',   -- 如 "08:00-20:00"
  contact_phone   TEXT,                                -- 联系电话
  manager         TEXT,                                -- 管理员/责任方

  -- 容量与说明
  capacity        INTEGER DEFAULT 8,                   -- 可同时容纳人数（估算）
  description     TEXT,                                -- 备注/说明

  -- 来源信息
  source          TEXT    DEFAULT 'manual',            -- manual / seed / import
  verified        INTEGER DEFAULT 0,                   -- 是否经实地核实（0/1）

  created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT    NOT NULL DEFAULT (datetime('now')),

  -- 软删除时间戳（Unix 秒，UTC）；0 表示未删除。
  -- 用于小程序增量同步时感知「删除」操作（deleted_at > since 即已被删）
  deleted_at      INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_stations_status  ON stations(status);
CREATE INDEX IF NOT EXISTS idx_stations_district ON stations(district);
CREATE INDEX IF NOT EXISTS idx_stations_geo     ON stations(lat, lng);

-- 状态变更日志（仅记录重要写操作，便于审计与回溯）
CREATE TABLE IF NOT EXISTS station_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  station_id  INTEGER NOT NULL,
  event_type  TEXT    NOT NULL,        -- status_change / report / create / update
  old_value   TEXT,
  new_value   TEXT,
  note        TEXT,
  source      TEXT    DEFAULT 'web',  -- web / admin / system
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (station_id) REFERENCES stations(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_events_station ON station_events(station_id, created_at);

-- 用户反馈（环卫工人可匿名上报）
CREATE TABLE IF NOT EXISTS feedback (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  station_id  INTEGER,
  contact     TEXT,
  message     TEXT    NOT NULL,
  kind        TEXT    DEFAULT 'suggestion',  -- suggestion / issue / praise
  status      TEXT    DEFAULT 'new',          -- new / read / handled
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (station_id) REFERENCES stations(id) ON DELETE SET NULL
);

-- 触发器：自动维护 updated_at
CREATE TRIGGER IF NOT EXISTS trg_stations_updated_at
AFTER UPDATE ON stations
FOR EACH ROW
BEGIN
  UPDATE stations SET updated_at = datetime('now') WHERE id = OLD.id;
END;

-- ============================================
-- 一键报修工单（闭环：上报 → 处理中 → 已修复）
-- ============================================
CREATE TABLE IF NOT EXISTS repair_reports (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  station_id  INTEGER NOT NULL,
  facility    TEXT,                                  -- 报修设施 key（drink/ac/...）或 'other'
  description TEXT    NOT NULL,                      -- 故障描述
  contact     TEXT,                                  -- 上报人联系方式（可选，用于回访）
  status      TEXT    NOT NULL DEFAULT 'new'
              CHECK (status IN ('new','acknowledged','resolved')),
  admin_note  TEXT,                                  -- 处理备注（管理员填写）
  source      TEXT    DEFAULT 'web',                 -- web / admin / system
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (station_id) REFERENCES stations(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_reports_station ON repair_reports(station_id, status);
CREATE INDEX IF NOT EXISTS idx_reports_status  ON repair_reports(status);

-- ============================================
-- 驿站选址众包建议（市民/劳动者推荐新点位）
-- ============================================
CREATE TABLE IF NOT EXISTS site_suggestions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  lat         REAL    NOT NULL,
  lng         REAL    NOT NULL,
  address     TEXT,                                  -- 推荐地址（可空，由经纬度反推）
  district    TEXT,                                  -- 推荐所属区（可选）
  reason      TEXT    NOT NULL,                      -- 推荐理由
  contact     TEXT,                                  -- 推荐人联系方式（可选）
  status      TEXT    NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending','reviewing','accepted','rejected')),
  admin_note  TEXT,                                  -- 审核备注
  source      TEXT    DEFAULT 'web',                 -- web / admin / system
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_suggestions_status ON site_suggestions(status);
CREATE INDEX IF NOT EXISTS idx_suggestions_geo   ON site_suggestions(lat, lng);