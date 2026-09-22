'use strict'
// 层级化检索：L1 标题 / L2 主题 / L3 正文 / L4 思考；账号(L5)/项目/agent/时间等作为正交过滤。
// 分层性能：L1/L2 走普通索引；L3/L4 仅在达到该深度时触发 FTS。
// 渐进披露：auto=true 时，浅层(L1/L2)命中不足(minResults)才逐级加深（最多到 depth）。
// 结果统一带账号（display/raw）与命中层级；L3/L4 额外带轮次 seq 供详情定位跳转。
const { openStore } = require('./model')

// depth: 1..4；filters: { account, projectId, agentId, from, to }（from/to 为 ms 时间戳，作用于 s.updated_at）
// auto: 结果不足自动加深；minResults: 触发加深的命中数阈值
function search(dbPath, { q, depth = 2, account, projectId, agentId, from, to, limit = 50, auto = false, minResults = 8 }) {
  const db = openStore(dbPath)
  try {
    // 共享过滤条件：l1 拼 WHERE 列表；l2/l3/l4 内联 AND 片段
    const where = []
    const shared = []
    const params = {}
    if (account) { where.push('s.account_id = @account'); shared.push('AND s.account_id = @account'); params.account = account }
    if (projectId) { where.push('s.project_id = @projectId'); shared.push('AND s.project_id = @projectId'); params.projectId = projectId }
    if (agentId) { where.push('s.agent_id = @agentId'); shared.push('AND s.agent_id = @agentId'); params.agentId = agentId }
    if (from) { where.push('s.updated_at >= @from'); shared.push('AND s.updated_at >= @from'); params.from = Number(from) }
    if (to) { where.push('s.updated_at <= @to'); shared.push('AND s.updated_at <= @to'); params.to = Number(to) }
    const sharedSql = shared.join(' ')
    // 账号列（S1：结果要能直接回答"哪个账号干的"）
    const accJoin = 'LEFT JOIN accounts a ON a.id = s.account_id'
    const accCols = 'a.display_name AS account_name, a.raw_name AS account_raw'

    // L1 标题（普通索引，like + 前缀）—— 显式拼接 WHERE，避免空过滤时条件挂到 JOIN ON 上
    const likeQ = `%${q}%`
    const l1 = db.prepare(`
      SELECT s.id, s.agent_id, s.title, s.subject, s.created_at, s.cwd, p.name AS project, ${accCols}
      FROM sessions s
      LEFT JOIN projects p ON p.id = s.project_id
      ${accJoin}
      WHERE ${[...where, 's.title LIKE @likeQ'].join(' AND ')}
      ORDER BY s.updated_at DESC LIMIT @limit
    `).all({ ...params, likeQ, limit })

    // L2 主题
    const l2 = db.prepare(`
      SELECT DISTINCT s.id, s.agent_id, s.title, s.subject, su.subject AS subj, s.created_at, s.cwd, p.name AS project, ${accCols}
      FROM subjects su
      JOIN sessions s ON s.id = su.session_id
      LEFT JOIN projects p ON p.id = s.project_id
      ${accJoin}
      WHERE su.subject LIKE @likeQ
        ${sharedSql}
      ORDER BY s.updated_at DESC LIMIT @limit
    `).all({ ...params, likeQ, limit })

    // L3 正文 + L4 思考（FTS，优先级低匹配）—— 惰性构建，仅在需要时求值
    const ftsMatch = q ? (() => {
      try {
        const m = q.replace(/"/g, '').split(/\s+/).filter(Boolean).map((w) => `"${w}"*`).join(' AND ')
        return m || '"*"'
      } catch { return '' }
    })() : ''
    const l3_stmt = ftsMatch ? db.prepare(`
      SELECT DISTINCT t.session_id AS id, s.agent_id, s.title, s.subject, t.seq, t.user_message, t.assistant_message, t.timestamp, s.cwd, p.name AS project, ${accCols}
      FROM turns_fts tf
      JOIN turns t ON t.id = tf.rowid
      JOIN sessions s ON s.id = t.session_id
      LEFT JOIN projects p ON p.id = s.project_id
      ${accJoin}
      WHERE turns_fts MATCH @qMatch AND (t.user_message LIKE @likeQ2 OR t.assistant_message LIKE @likeQ2)
        ${sharedSql}
      ORDER BY t.timestamp DESC LIMIT @limit
    `) : null
    const l4_stmt = ftsMatch ? db.prepare(`
      SELECT DISTINCT t.session_id AS id, s.agent_id, s.title, s.subject, t.seq, t.thinking, t.timestamp, s.cwd, p.name AS project, ${accCols}
      FROM turns_fts tf
      JOIN turns t ON t.id = tf.rowid
      JOIN sessions s ON s.id = t.session_id
      LEFT JOIN projects p ON p.id = s.project_id
      ${accJoin}
      WHERE turns_fts MATCH @qMatch AND t.thinking LIKE @likeQ2
        ${sharedSql}
      ORDER BY t.timestamp DESC LIMIT @limit
    `) : null
    const ftsParams = { ...params, qMatch: ftsMatch, likeQ2: `%${q}%`, limit }

    // 合并去重、渐进展开；layer 标注命中层级（L1/L2 会话级，L3/L4 轮次级带 seq）
    const seen = new Set()
    const hits = []
    const add = (arr, layer) => {
      for (const h of arr) {
        if (seen.has(h.id)) continue
        seen.add(h.id)
        hits.push({ ...h, layer })
      }
    }
    const insufficient = () => hits.length < minResults && hits.length < limit

    let actualDepth = 0
    if (auto) {
      // 渐进：基线浅层 L1/L2，不足才加深
      let d = 0
      if (d < depth) { add(l1, 1); d = 1 }
      if (d < depth && (insufficient() || d < 2)) { add(l2, 2); d = 2 }
      if (d < depth && insufficient()) { add(l3_stmt ? l3_stmt.all(ftsParams) : [], 3); d = 3 }
      if (d < depth && insufficient()) { add(l4_stmt ? l4_stmt.all(ftsParams) : [], 4); d = 4 }
      actualDepth = d
    } else {
      add(l1, 1)
      if (depth >= 2) add(l2, 2)
      if (depth >= 3 && l3_stmt) add(l3_stmt.all(ftsParams), 3)
      if (depth >= 4 && l4_stmt) add(l4_stmt.all(ftsParams), 4)
      actualDepth = depth
    }

    return { hits: hits.slice(0, limit), total: hits.length, depth: actualDepth, escalated: auto && actualDepth > 2 }
  } finally {
    db.close()
  }
}

module.exports = { search }
