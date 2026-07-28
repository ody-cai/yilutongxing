-- ============================================
-- 「驿」路同行 — 增量迁移脚本（仅新增表）
-- 适用于已上线的 D1 数据库（stations / feedback / station_events 已存在）。
-- 执行：
--   wrangler d1 execute ldl-yizhan-db --file=./migrate.sql --env=production
-- 本脚本幂等（IF NOT EXISTS），可重复执行，不会破坏现有数据。
-- ============================================

-- 一键报修工单
CREATE TABLE IF NOT EXISTS repair_reports (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  station_id  INTEGER NOT NULL,
  facility    TEXT,
  description TEXT    NOT NULL,
  contact     TEXT,
  status      TEXT    NOT NULL DEFAULT 'new'
              CHECK (status IN ('new','acknowledged','resolved')),
  admin_note  TEXT,
  source      TEXT    DEFAULT 'web',
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (station_id) REFERENCES stations(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_reports_station ON repair_reports(station_id, status);
CREATE INDEX IF NOT EXISTS idx_reports_status  ON repair_reports(status);

-- 驿站选址众包建议
CREATE TABLE IF NOT EXISTS site_suggestions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  lat         REAL    NOT NULL,
  lng         REAL    NOT NULL,
  address     TEXT,
  district    TEXT,
  reason      TEXT    NOT NULL,
  contact     TEXT,
  status      TEXT    NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending','reviewing','accepted','rejected')),
  admin_note  TEXT,
  source      TEXT    DEFAULT 'web',
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_suggestions_status ON site_suggestions(status);
CREATE INDEX IF NOT EXISTS idx_suggestions_geo   ON site_suggestions(lat, lng);

-- ============================================
-- 第三期：刷脸签到系统
-- ============================================

-- 人脸注册表（存储工人人脸特征描述子 + 基本信息）
CREATE TABLE IF NOT EXISTS face_enrollments (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT    NOT NULL,
  phone           TEXT,
  company         TEXT,             -- 所属公司/单位
  station_id      INTEGER,          -- 常驻驿站
  face_descriptor TEXT    NOT NULL,  -- 人脸描述子(128维Float32Array序列化为JSON数组)
  face_thumbnail  TEXT,              -- 人脸缩略图(base64, 小图仅用于界面展示)
  is_active       INTEGER NOT NULL DEFAULT 1,  -- 1=有效 0=已注销
  created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (station_id) REFERENCES stations(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_face_name     ON face_enrollments(name);
CREATE INDEX IF NOT EXISTS idx_face_active   ON face_enrollments(is_active);

-- 签到记录表
CREATE TABLE IF NOT EXISTS entry_records (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  face_id     INTEGER,              -- 关联的人脸ID(null表示手动登记)
  name        TEXT    NOT NULL,      -- 签到人姓名
  station_id  INTEGER,              -- 签到驿站ID
  entry_type  TEXT    NOT NULL DEFAULT 'face' CHECK (entry_type IN ('face','manual','qr')),
  score       REAL,                  -- 人脸匹配得分(0-1)
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (face_id) REFERENCES face_enrollments(id) ON DELETE SET NULL,
  FOREIGN KEY (station_id) REFERENCES stations(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_entry_face     ON entry_records(face_id, created_at);
CREATE INDEX IF NOT EXISTS idx_entry_station  ON entry_records(station_id, created_at);
CREATE INDEX IF NOT EXISTS idx_entry_date     ON entry_records(created_at);
