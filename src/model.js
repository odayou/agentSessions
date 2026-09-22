'use strict'
// SQLite 存储层（better-sqlite3）+ 统一会话模型 DDL（含账号/分层字段）
const path = require('node:path')
const fs = require('node:fs')
const crypto = require('node:crypto')

// DDL 对齐《产品规划.md》§7（projects/accounts/sessions/turns/subjects + FTS5）
const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  id          TEXT PRIMARY KEY,
  path        TEXT NOT NULL,
  name        TEXT NOT NULL,
  custom_name TEXT,
  first_seen  INTEGER,
  last_seen   INTEGER,
  meta        TEXT
);

CREATE TABLE IF NOT EXISTS accounts (
  id           TEXT PRIMARY KEY,
  agent_id     TEXT NOT NULL,
  raw_name     TEXT NOT NULL,
  display_name TEXT,
  kind         TEXT,
  UNIQUE(agent_id, raw_name)
);

CREATE TABLE IF NOT EXISTS sessions (
  id               TEXT PRIMARY KEY,
  agent_id         TEXT NOT NULL,
  agent_session_id TEXT NOT NULL,
  project_id       TEXT REFERENCES projects(id),
  account_id       TEXT REFERENCES accounts(id),
  cwd              TEXT,
  title            TEXT,
  subject          TEXT,
  parent_subject   TEXT,
  model            TEXT,
  created_at       INTEGER,
  updated_at       INTEGER,
  turn_count       INTEGER,
  source_file      TEXT,
  raw_format       TEXT,
  starred          INTEGER DEFAULT 0,
  tags             TEXT,
  notes            TEXT,
  UNIQUE(agent_id, agent_session_id)
);

CREATE TABLE IF NOT EXISTS turns (
  id               INTEGER PRIMARY KEY,
  session_id       TEXT REFERENCES sessions(id),
  seq              INTEGER,
  user_message     TEXT,
  assistant_message TEXT,
  thinking         TEXT,
  tool_input       TEXT,
  files_changed    TEXT,
  timestamp        INTEGER,
  UNIQUE(session_id, seq)
);

CREATE TABLE IF NOT EXISTS subjects (
  id         INTEGER PRIMARY KEY,
  session_id TEXT REFERENCES sessions(id),
  layer      INTEGER NOT NULL,
  subject    TEXT NOT NULL,
  parent_id  INTEGER
);

CREATE VIRTUAL TABLE IF NOT EXISTS turns_fts USING fts5(
  user_message, assistant_message, thinking, tool_input,
  content='turns', content_rowid='id'
);

CREATE INDEX IF NOT EXISTS idx_sess_l1      ON sessions(title);
CREATE INDEX IF NOT EXISTS idx_sess_subject ON sessions(subject);
CREATE INDEX IF NOT EXISTS idx_sess_project ON sessions(project_id);
CREATE INDEX IF NOT EXISTS idx_sess_account ON sessions(account_id);
CREATE INDEX IF NOT EXISTS idx_turns_session ON turns(session_id);

CREATE TABLE IF NOT EXISTS scan_state (   -- 增量扫描指纹：源文件 mtime+size
  source_file TEXT PRIMARY KEY,
  agent_id    TEXT NOT NULL,
  mtime_ms    INTEGER,
  size        INTEGER,
  scanned_at  INTEGER
);
`

// ---- 触发式维护 FTS（turns 改动时同步 turns_fts）----
const FTS_TRIGGERS = `
CREATE TRIGGER IF NOT EXISTS turns_ai AFTER INSERT ON turns BEGIN
  INSERT INTO turns_fts(rowid, user_message, assistant_message, thinking, tool_input)
  VALUES (new.id, new.user_message, new.assistant_message, new.thinking, new.tool_input);
END;
CREATE TRIGGER IF NOT EXISTS turns_ad AFTER DELETE ON turns BEGIN
  INSERT INTO turns_fts(turns_fts, rowid, user_message, assistant_message, thinking, tool_input)
  VALUES ('delete', old.id, old.user_message, old.assistant_message, old.thinking, old.tool_input);
END;
CREATE TRIGGER IF NOT EXISTS turns_au AFTER UPDATE ON turns BEGIN
  INSERT INTO turns_fts(turns_fts, rowid, user_message, assistant_message, thinking, tool_input)
  VALUES ('delete', old.id, old.user_message, old.assistant_message, old.thinking, old.tool_input);
  INSERT INTO turns_fts(rowid, user_message, assistant_message, thinking, tool_input)
  VALUES (new.id, new.user_message, new.assistant_message, new.thinking, new.tool_input);
END;
`

function normalizeCwd(cwd) {
  if (!cwd) return ''
  let p = cwd.trim()
  if (!p) return ''
  // Windows 大小写/尾斜杠/盘符统一
  if (process.platform === 'win32') p = p.replace(/\//g, '\\')
  p = p.replace(/[\\/]+$/, '')
  return (process.platform === 'win32' ? p.toLowerCase() : p)
}

// project_id = sha1(normalize(cwd))[0:16]
function projectId(cwd) {
  return crypto.createHash('sha1').update(normalizeCwd(cwd) || 'unknown').digest('hex').slice(0, 16)
}

function accountId(agentId, rawName) {
  return crypto.createHash('sha1').update(`${agentId}\u0000${rawName}`).digest('hex').slice(0, 16)
}

// 迁移：若 sessions 表为旧 schema（UNIQUE(agent_id, source_file)），重建索引表。
// 旧表无法被 CREATE TABLE IF NOT EXISTS 升级约束，本地索引数据可直接重建。
function migrateSchema(db) {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='sessions'").get()
  if (row && row.sql && /UNIQUE\s*\(\s*agent_id\s*,\s*source_file\s*\)/.test(row.sql)) {
    db.exec(`
      DROP TRIGGER IF EXISTS turns_ai;
      DROP TRIGGER IF EXISTS turns_ad;
      DROP TRIGGER IF EXISTS turns_au;
      DROP TABLE IF EXISTS turns_fts;
      DROP TABLE IF EXISTS turns;
      DROP TABLE IF EXISTS subjects;
      DROP TABLE IF EXISTS sessions;
    `)
  }
}

function openStore(dbPath) {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true })
  const db = require('better-sqlite3')(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  migrateSchema(db)
  db.exec(SCHEMA)
  db.exec(FTS_TRIGGERS)
  return db
}

module.exports = { openStore, normalizeCwd, projectId, accountId }