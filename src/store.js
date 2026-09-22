'use strict'
// 统一落库：projects/accounts/sessions/turns（幂等 upsert）
const { normalizeCwd, projectId, accountId } = require('./model')

function upsertProject(db, { cwd, name, meta }) {
  const id = projectId(cwd)
  const now = Date.now()
  db.prepare(`
    INSERT INTO projects(id, path, name, first_seen, last_seen, meta)
    VALUES(?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      last_seen = excluded.last_seen,
      meta = COALESCE(excluded.meta, projects.meta)
  `).run(id, normalizeCwd(cwd), name, now, now, JSON.stringify(meta || {}))
  return id
}

function upsertAccount(db, { agentId, rawName, displayName, kind }) {
  const id = accountId(agentId, rawName)
  db.prepare(`
    INSERT INTO accounts(id, agent_id, raw_name, display_name, kind)
    VALUES(?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      display_name = COALESCE(excluded.display_name, accounts.display_name),
      kind = COALESCE(excluded.kind, accounts.kind)
  `).run(id, agentId, rawName, displayName || null, kind || null)
  return id
}

// session 幂等：UNIQUE(agent_id, agent_session_id) 冲突则更新可变字段，返回真实落库 id（RETURNING）
function upsertSession(db, s) {
  const res = db.prepare(`
    INSERT INTO sessions(
      id, agent_id, agent_session_id, project_id, account_id, cwd,
      title, subject, parent_subject, model, created_at, updated_at,
      turn_count, source_file, raw_format, starred, tags, notes
    ) VALUES(
      @id, @agentId, @agentSessionId, @projectId, @accountId, @cwd,
      @title, @subject, @parentSubject, @model, @createdAt, @updatedAt,
      @turnCount, @sourceFile, @rawFormat, 0, @tags, @notes
    )
    ON CONFLICT(agent_id, agent_session_id) DO UPDATE SET
      title = excluded.title,
      subject = COALESCE(excluded.subject, sessions.subject),
      parent_subject = COALESCE(excluded.parent_subject, sessions.parent_subject),
      updated_at = excluded.updated_at,
      turn_count = excluded.turn_count,
      model = COALESCE(excluded.model, sessions.model)
    RETURNING id
  `).get(s)
  return res ? res.id : s.id
}

// 清空某 session 的旧 turns 后重建（简化增量：整会话覆盖）
// turns: [{seq, userMessage, assistantMessage, thinking, toolInput, filesChanged, timestamp}]
// subjects: [{layer, subject, parentId}]
function replaceTurns(db, sessionId, turns, subjects = []) {
  db.prepare('DELETE FROM turns WHERE session_id = ?').run(sessionId)
  db.prepare('DELETE FROM subjects WHERE session_id = ?').run(sessionId)
  const insTurn = db.prepare(`
    INSERT INTO turns(session_id, seq, user_message, assistant_message, thinking, tool_input, files_changed, timestamp)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const insSubject = db.prepare('INSERT INTO subjects(session_id, layer, subject, parent_id) VALUES(?, ?, ?, ?)')
  const tx = db.transaction(() => {
    for (const t of turns) {
      insTurn.run(
        sessionId, t.seq, t.userMessage || null, t.assistantMessage || null,
        t.thinking || null, t.toolInput || null, JSON.stringify(t.filesChanged || []), t.timestamp || null
      )
    }
    for (const su of subjects) {
      insSubject.run(sessionId, su.layer, su.subject, su.parentId || null)
    }
  })
  tx()
  return turns.length
}

// 增量扫描指纹读写
function getScanState(db, sourceFile) {
  return db.prepare('SELECT mtime_ms, size FROM scan_state WHERE source_file = ?').get(sourceFile)
}
function setScanState(db, sourceFile, agentId, mtimeMs, size) {
  db.prepare(`
    INSERT INTO scan_state(source_file, agent_id, mtime_ms, size, scanned_at)
    VALUES(?, ?, ?, ?, ?)
    ON CONFLICT(source_file) DO UPDATE SET
      agent_id = excluded.agent_id, mtime_ms = excluded.mtime_ms,
      size = excluded.size, scanned_at = excluded.scanned_at
  `).run(sourceFile, agentId, mtimeMs, size, Date.now())
}

// 级联删除单个会话（turns/subjects/sessions）
function deleteSessionCascade(db, sessionId) {
  db.prepare('DELETE FROM turns WHERE session_id = ?').run(sessionId)
  db.prepare('DELETE FROM subjects WHERE session_id = ?').run(sessionId)
  db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId)
}

// 应用排除规则（场景 S8）：删除源文件路径或项目 cwd 命中规则的已索引会话，
// 并清掉对应 scan_state 指纹（否则移除规则后未变更的文件不会被重新索引）。返回删除的会话数。
function applyExcludes(db, match) {
  let removed = 0
  const sess = db.prepare('SELECT id, source_file, cwd FROM sessions').all()
  const fp = db.prepare('SELECT source_file FROM scan_state').all()
  const delFp = db.prepare('DELETE FROM scan_state WHERE source_file = ?')
  const tx = db.transaction(() => {
    for (const r of sess) {
      if (match(r.source_file) || match(r.cwd)) { deleteSessionCascade(db, r.id); removed++ }
    }
    for (const r of fp) {
      if (match(r.source_file)) delFp.run(r.source_file)
    }
  })
  tx()
  return removed
}

// 自定义项目名（name 为 null 时恢复自动命名）；项目不存在静默返回
function setProjectName(db, projectId, name) {
  db.prepare('UPDATE projects SET custom_name = ? WHERE id = ?').run(name || null, projectId)
}

// 切换会话星标；返回切换后的值，会话不存在返回 null
function toggleStar(db, sessionId) {
  const r = db.prepare('UPDATE sessions SET starred = 1 - starred WHERE id = ?').run(sessionId)
  if (r.changes === 0) return null
  return db.prepare('SELECT starred FROM sessions WHERE id = ?').get(sessionId).starred
}

module.exports = { upsertProject, upsertAccount, upsertSession, replaceTurns, getScanState, setScanState, deleteSessionCascade, applyExcludes, setProjectName, toggleStar }