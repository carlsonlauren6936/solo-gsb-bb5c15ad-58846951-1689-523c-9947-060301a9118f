const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'cues.db');

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS scripts (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  title           TEXT    NOT NULL,
  content         TEXT    NOT NULL DEFAULT '',
  current_version INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS script_versions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  script_id  INTEGER NOT NULL REFERENCES scripts(id) ON DELETE CASCADE,
  version    INTEGER NOT NULL,
  title      TEXT    NOT NULL,
  content    TEXT    NOT NULL,
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS cues (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  script_id      INTEGER NOT NULL REFERENCES scripts(id) ON DELETE CASCADE,
  type           TEXT    NOT NULL CHECK (type IN ('light', 'sound')),
  label          TEXT    NOT NULL,
  note           TEXT    NOT NULL DEFAULT '',
  version        INTEGER NOT NULL DEFAULT 1,
  line_no        INTEGER,
  line_text      TEXT,
  anchor_index   INTEGER,
  anchor_text    TEXT,
  context_before TEXT    NOT NULL DEFAULT '',
  context_after  TEXT    NOT NULL DEFAULT '',
  anchor_status  TEXT    NOT NULL DEFAULT 'bound' CHECK (anchor_status IN ('bound', 'pending')),
  issue_type     TEXT,
  issue_detail   TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_cues_script ON cues(script_id);
CREATE INDEX IF NOT EXISTS idx_versions_script ON script_versions(script_id);

-- 排练场次：从剧本当前版本创建，创建时刻冻结条目快照
CREATE TABLE IF NOT EXISTS sessions (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  script_id        INTEGER NOT NULL REFERENCES scripts(id) ON DELETE CASCADE,
  name             TEXT    NOT NULL,
  script_version   INTEGER NOT NULL,            -- 创建时剧本当前版本（冻结）
  total            INTEGER NOT NULL DEFAULT 0,  -- 冻结的可执行条目数
  excluded_pending INTEGER NOT NULL DEFAULT 0,  -- 创建时被排除的待确认提示数
  created_at       TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- 场次条目：冻结提示的行号/类型/内容/备注（及锚点台词文本，便于执行时对照）
-- cue_id 仅作来源追溯，不与 cues 建外键：提示日后被编辑/删除不影响既有场次
CREATE TABLE IF NOT EXISTS session_items (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq        INTEGER NOT NULL,   -- 队列序号，从 1 开始（按行号、提示 ID 排序）
  cue_id     INTEGER,
  line_no    INTEGER NOT NULL,
  type       TEXT    NOT NULL,
  label      TEXT    NOT NULL,
  note       TEXT    NOT NULL DEFAULT '',
  line_text  TEXT    NOT NULL DEFAULT '',
  UNIQUE (session_id, seq)
);

-- 执行记录：只能按队首顺序追加；撤回即删除最后一条
CREATE TABLE IF NOT EXISTS session_executions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  item_id     INTEGER NOT NULL REFERENCES session_items(id) ON DELETE CASCADE,
  seq         INTEGER NOT NULL,
  executed_at TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (session_id, item_id)
);

CREATE INDEX IF NOT EXISTS idx_sessions_script ON sessions(script_id);
CREATE INDEX IF NOT EXISTS idx_session_items_session ON session_items(session_id);
CREATE INDEX IF NOT EXISTS idx_session_exec_session ON session_executions(session_id);
`);

module.exports = db;
module.exports.DB_PATH = DB_PATH;
