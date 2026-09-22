'use strict'
// 只读查询层：为 UI/搜索提供项目聚合、账号、会话列表、会话详情。
// 独立于写入(store)与检索(search)，全部走普通索引与联表，复用 openStore。
const { openStore } = require('./model')

// 项目聚合列表：会话数、agent 分布、账号分布、最近活动
function listProjects(dbPath) {
  const db = openStore(dbPath)
  try {
    const rows = db.prepare(`
      SELECT
        p.id, p.path, p.name, p.custom_name, p.first_seen, p.last_seen,
        COUNT(s.id) AS session_count,
        COALESCE(SUM(s.turn_count), 0) AS turn_count
      FROM projects p
      LEFT JOIN sessions s ON s.project_id = p.id
      GROUP BY p.id
      ORDER BY p.last_seen DESC
    `).all()
    // 每个项目的 agent 分布与账号分布（二次查询，避免 GROUP_CONCAT 复杂化）
    const agents = db.prepare(`
      SELECT project_id, agent_id, COUNT(*) AS n
      FROM sessions WHERE project_id IN (SELECT id FROM projects)
      GROUP BY project_id, agent_id
    `).all()
    const accounts = db.prepare(`
      SELECT s.project_id, s.agent_id, a.display_name, a.raw_name, a.kind, COUNT(*) AS n
      FROM sessions s JOIN accounts a ON a.id = s.account_id
      GROUP BY s.project_id, a.agent_id, a.id
    `).all()
    const byProject = (arr, key) => {
      const m = new Map()
      for (const r of arr) {
        if (!m.has(r[key])) m.set(r[key], [])
        m.get(r[key]).push(r)
      }
      return m
    }
    const agentMap = byProject(agents, 'project_id')
    const accountMap = byProject(accounts, 'project_id')
    return rows.map((p) => {
      const disp = projectDisplay(p)
      return {
        id: p.id, path: p.path, name: disp.name, drive: disp.drive,
        customName: p.custom_name || null,
        firstSeen: p.first_seen, lastSeen: p.last_seen,
        sessionCount: p.session_count, turnCount: p.turn_count,
        agents: (agentMap.get(p.id) || []).map((a) => ({ agent: a.agent_id, n: a.n })),
        accounts: (accountMap.get(p.id) || []).map((a) => ({
          agent: a.agent_id, name: a.display_name || a.raw_name, kind: a.kind, n: a.n,
        })),
      }
    })
  } finally {
    db.close()
  }
}

// 账号列表（全局）
function listAccounts(dbPath) {
  const db = openStore(dbPath)
  try {
    return db.prepare(`
      SELECT a.id, a.agent_id, a.raw_name, a.display_name, a.kind,
             (SELECT COUNT(*) FROM sessions s WHERE s.account_id = a.id) AS session_count
      FROM accounts a
      ORDER BY a.agent_id, a.raw_name
    `).all().map((a) => ({
      id: a.id, agentId: a.agent_id, rawName: a.raw_name,
      displayName: a.display_name, kind: a.kind, sessionCount: a.session_count,
    }))
  } finally {
    db.close()
  }
}

// agent 列表（全局）
function listAgents(dbPath) {
  const db = openStore(dbPath)
  try {
    return db.prepare(`
      SELECT agent_id, COUNT(*) AS session_count
      FROM sessions GROUP BY agent_id ORDER BY session_count DESC
    `).all()
  } finally {
    db.close()
  }
}

// 会话列表：按 project/account/agent 过滤，返回摘要字段
function listSessions(dbPath, { projectId, accountId, agentId, q, limit = 200 } = {}) {
  const db = openStore(dbPath)
  try {
    const where = []
    const params = { limit }
    if (projectId) { where.push('s.project_id = @projectId'); params.projectId = projectId }
    if (accountId) { where.push('s.account_id = @accountId'); params.accountId = accountId }
    if (agentId) { where.push('s.agent_id = @agentId'); params.agentId = agentId }
    if (q) { where.push('(s.title LIKE @q OR s.subject LIKE @q)'); params.q = `%${q}%` }
    const baseWhere = where.length ? 'WHERE ' + where.join(' AND ') : ''
    const rows = db.prepare(`
      SELECT s.id, s.agent_id, s.agent_session_id, s.title, s.subject, s.parent_subject,
             s.model, s.created_at, s.updated_at, s.turn_count, s.cwd, s.starred,
             s.project_id, p.name AS project,
             a.display_name AS account_name, a.raw_name AS account_raw
      FROM sessions s
      LEFT JOIN projects p ON p.id = s.project_id
      LEFT JOIN accounts a ON a.id = s.account_id
      ${baseWhere}
      ORDER BY s.updated_at DESC
      LIMIT @limit
    `).all(params)
    return rows.map((r) => ({
      id: r.id, agentId: r.agent_id, agentSessionId: r.agent_session_id,
      title: r.title, subject: r.subject, parentSubject: r.parent_subject,
      model: r.model, createdAt: r.created_at, updatedAt: r.updated_at,
      turnCount: r.turn_count, cwd: r.cwd, starred: r.starred,
      projectId: r.project_id, project: r.project,
      account: r.account_name || r.account_raw,
    }))
  } finally {
    db.close()
  }
}

// 会话详情：turns + subjects
function sessionDetail(dbPath, sessionId) {
  const db = openStore(dbPath)
  try {
    const sess = db.prepare(`
      SELECT s.id, s.agent_id, s.agent_session_id, s.title, s.subject, s.parent_subject,
             s.model, s.created_at, s.updated_at, s.turn_count, s.cwd, s.starred,
             s.raw_format, s.notes, p.name AS project, a.display_name AS account_name,
             a.raw_name AS account_raw, a.kind AS account_kind
      FROM sessions s
      LEFT JOIN projects p ON p.id = s.project_id
      LEFT JOIN accounts a ON a.id = s.account_id
      WHERE s.id = ?
    `).get(sessionId)
    if (!sess) return null
    const turns = db.prepare(`
      SELECT seq, user_message, assistant_message, thinking, tool_input, files_changed, timestamp
      FROM turns WHERE session_id = ? ORDER BY seq
    `).all(sessionId).map((t) => ({
      seq: t.seq,
      userMessage: t.user_message,
      assistantMessage: t.assistant_message,
      thinking: t.thinking,
      toolInput: t.tool_input,
      filesChanged: safeJson(t.files_changed),
      timestamp: t.timestamp,
    }))
    const subjects = db.prepare(`
      SELECT layer, subject, parent_id FROM subjects WHERE session_id = ? ORDER BY id
    `).all(sessionId)
    return {
      id: sess.id, agentId: sess.agent_id, agentSessionId: sess.agent_session_id,
      title: sess.title, subject: sess.subject, parentSubject: sess.parent_subject,
      model: sess.model, createdAt: sess.created_at, updatedAt: sess.updated_at,
      turnCount: sess.turn_count, cwd: sess.cwd, starred: sess.starred,
      rawFormat: sess.raw_format, sourceNote: sess.notes, project: sess.project,
      account: sess.account_name || sess.account_raw, accountKind: sess.account_kind,
      turns, subjects,
    }
  } finally {
    db.close()
  }
}

function safeJson(s) {
  if (!s) return []
  try { return JSON.parse(s) } catch { return [] }
}

// 取路径末段作为项目名（兼容 Windows/Linux）；尾斜杠先去除
function baseName(s) {
  if (!s) return s
  const m = /[\\/]*([^\\/]+)[\\/]*$/.exec(String(s))
  return m ? m[1] : s
}

// 提取盘符（Windows，如 "C:"），其余平台返回 null
function driveLetter(path) {
  if (!path) return null
  const m = /^([a-zA-Z]+:)/.exec(String(path))
  return m ? m[1] : null
}

// 项目展示名 + 盘符：不同工具落库的 name/path 格式不同，只在需要时改写，干净短名原样保留。
//  - opencode：name 已是干净短名（如 "t8t-scm-ncs"）→ 直接用，盘符从 path 取。
//  - workbuddy：name 已是 basename(cwd)→ 原样；仅盘符从 path 补。
//  - trae：name/path 是被 '-' 转义、盘符未还原的目录 key（如 -d-phpCode-t8t-tbt-obiz，
//    无 '/' '\\' 分隔符，baseName 切不出来）→ 剥离盘符前缀、剩余整体作名。
function projectDisplay(p) {
  if (p.custom_name) return { name: p.custom_name, drive: driveLetter(p.path) }
  const raw = p.name
  // 含真实路径分隔符 → 取末段
  if (typeof raw === 'string' && /[\\/]/.test(raw)) {
    return { name: baseName(raw), drive: driveLetter(p.path) || driveLetter(raw) }
  }
  // trae 式转义 key：以 '-<盘符>' 开头（-d-phpCode-t8t-tbt-obiz）。
  // 结构为 -<盘符>-<父目录>-<项目名>：盘符另列，父目录（phpCode/javaCode 等）去掉，
  // 其余作为项目名整体保留——因为项目名本身可能含连字符（如 t8t-tbt-obiz），不可再细分。
  if (typeof raw === 'string') {
    const m = /^-([a-zA-Z])[-:.](.+)$/.exec(raw)
    if (m) {
      const body = m[2].replace(/^[-:.\s]+/, '')
      const i = body.indexOf('-')
      const name = i === -1 ? body : body.slice(i + 1)
      if (name) return { name, drive: m[1] + ':' }
    }
  }
  // 已是干净短名（opencode 等）→ 原样；盘符尽可能从 path 取
  return { name: raw || baseName(p.path), drive: driveLetter(p.path) }
}

// 数据统计（M4）：总量、按 agent/账号分布、近 N 天活跃趋势（按天分组）
function stats(dbPath, { days = 30 } = {}) {
  const db = openStore(dbPath)
  try {
    const totals = db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM sessions) AS sessions,
        (SELECT COUNT(*) FROM turns) AS turns,
        (SELECT COUNT(*) FROM projects) AS projects,
        (SELECT COUNT(*) FROM accounts) AS accounts
    `).get()
    const byAgent = db.prepare(`
      SELECT s.agent_id AS agent, COUNT(*) AS sessions, COALESCE(SUM(s.turn_count), 0) AS turns
      FROM sessions s GROUP BY s.agent_id ORDER BY sessions DESC
    `).all()
    const byAccount = db.prepare(`
      SELECT COALESCE(a.display_name, a.raw_name) AS name, a.kind, COUNT(*) AS sessions,
             COALESCE(SUM(s.turn_count), 0) AS turns
      FROM sessions s JOIN accounts a ON a.id = s.account_id
      GROUP BY a.id ORDER BY sessions DESC
    `).all()
    const byDay = db.prepare(`
      SELECT strftime('%Y-%m-%d', updated_at / 1000, 'unixepoch', 'localtime') AS day, COUNT(*) AS n
      FROM sessions
      WHERE updated_at IS NOT NULL AND updated_at >= ?
      GROUP BY day ORDER BY day
    `).all(Date.now() - days * 86400000)
    return {
      totalSessions: totals.sessions,
      totalTurns: totals.turns,
      totalProjects: totals.projects,
      totalAccounts: totals.accounts,
      byAgent, byAccount, byDay,
    }
  } finally {
    db.close()
  }
}

module.exports = { listProjects, listAccounts, listAgents, listSessions, sessionDetail, stats }