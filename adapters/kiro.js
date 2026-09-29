'use strict'
// Kiro 适配器（agentList §2.8）：CLI 主通道 SQLite conversations_v2
//   ~/.local/share/kiro-cli/data.sqlite3（Windows: %LOCALAPPDATA%/kiro-cli/data.sqlite3）
//   行结构：key=工作目录路径，value=JSON（含 history 数组）
//   ~/.kiro/sessions 的 JSONL / 目录格式为次要通道，schema 未文档化，暂不覆盖（后续版本补充）
const fs = require('node:fs')
const path = require('node:path')
const { buildSubjects, assembleTurns, finalizeTurns, mtimeMs, looksLikeAbsPath, findPathLike, firstNumber } = require('./lib')

// value JSON 的 history 数组 → 事件流（条目形状容错：user/assistant 键对、role/content、type/text）。
// 条目级时间戳尽力提取（字段名跨版本不定，取首个可解析者），供会话级 createdAt/updatedAt 聚合
function extractEvents(history) {
  const events = []
  for (const e of history) {
    if (!e || typeof e !== 'object') continue
    const ts = firstNumber(e, ['ts', 'timestamp', 'time', 'created_at', 'createdAt'])
    if (typeof e.user === 'string' && e.user.trim()) {
      events.push({ ts, kind: 'user', text: e.user, thinking: '', tools: [] })
      const a = typeof e.assistant === 'string' ? e.assistant : ''
      if (a.trim()) events.push({ ts, kind: 'asst', text: a, thinking: '', tools: [] })
      continue
    }
    const role = String(e.role || e.type || '').toLowerCase()
    const raw = e.content != null ? e.content : (e.text != null ? e.text : (e.message != null ? e.message : ''))
    const text = typeof raw === 'string'
      ? raw
      : (Array.isArray(raw)
        ? raw.map((b) => (typeof b === 'string' ? b : (b && (b.text || b.content)) || '')).filter(Boolean).join('\n')
        : '')
    if (!text) continue
    if (role === 'user' || role === 'human') events.push({ ts, kind: 'user', text, thinking: '', tools: [] })
    else if (role === 'assistant' || role === 'ai' || role === 'bot' || !role) events.push({ ts, kind: 'asst', text, thinking: '', tools: [] })
  }
  return events
}

// 扫描整个库（scan.js 的 dbCandidates 分支一次性调用；库文件指纹由 scan.js 记录）
function scan(dbFile) {
  let Database
  try { Database = require('better-sqlite3') } catch { throw new Error('better-sqlite3 不可用') }
  const db = new Database(dbFile, { readonly: true, fileMustExist: true })
  const out = []
  try {
    const hasTable = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='conversations_v2'`).get()
    if (!hasTable) return out
    const mt = mtimeMs(dbFile)
    const rows = db.prepare('SELECT rowid AS rid, key, value FROM conversations_v2 ORDER BY rowid').all()
    for (const row of rows) {
      let rawVal = row.value
      if (Buffer.isBuffer(rawVal)) rawVal = rawVal.toString('utf8')
      let doc
      try { doc = JSON.parse(String(rawVal || '')) } catch { continue }
      const history = doc && typeof doc === 'object'
        ? (Array.isArray(doc.history) ? doc.history
          : (doc.conversation && Array.isArray(doc.conversation.history) ? doc.conversation.history : null))
        : (Array.isArray(doc) ? doc : null)
      if (!history || !history.length) continue

      const events = extractEvents(history)
      const nonEmpty = finalizeTurns(assembleTurns(events))
      if (!nonEmpty.length) continue

      // cwd：key 为工作目录路径（路径样才采信）；否则 JSON 内路径字段兜底；最后回落库所在目录
      let cwd = typeof row.key === 'string' && looksLikeAbsPath(row.key) ? row.key : null
      if (!cwd && doc && typeof doc === 'object') cwd = findPathLike(doc)
      if (!cwd) cwd = path.dirname(dbFile)
      const sid = (doc && (doc.conversationId || doc.sessionId || doc.id))
        ? String(doc.conversationId || doc.sessionId || doc.id)
        : `kiro-${row.rid}`
      const session0 = doc && typeof doc === 'object' ? doc : {}
      // 会话级时间：条目时间戳聚合优先 → 文档级时间字段 → 库文件 mtime 兜底
      // （避免全库会话共享同一 mtime，时间过滤/排序失真）
      const evTs = events.map((x) => x.ts).filter((t) => Number.isFinite(t))
      const docTs = doc && typeof doc === 'object'
        ? firstNumber(doc, ['ts', 'timestamp', 'createdAt', 'created_at', 'time', 'lastActivity'])
        : null
      const createdAt = docTs || (evTs.length ? Math.min(...evTs) : mt)
      const updatedAt = evTs.length ? Math.max(...evTs) : (docTs || mt)
      out.push({
        session: {
          agentSessionId: sid,
          cwd,
          title: (typeof session0.title === 'string' && session0.title) ? session0.title
            : (nonEmpty[0].userMessage ? nonEmpty[0].userMessage.replace(/\s+/g, ' ').slice(0, 80) : null),
          model: typeof session0.model === 'string' ? session0.model : null,
          createdAt,
          updatedAt,
          sourceFile: dbFile,
        },
        project: { cwd, name: path.basename(cwd) || cwd },
        turns: nonEmpty, // finalizeTurns 已为每轮写入 subject
        subjects: buildSubjects(nonEmpty),
      })
    }
    return out
  } finally {
    db.close()
  }
}

module.exports = { scan, id: 'kiro', label: 'Kiro', sourceFormat: 'sqlite/kiro-conversations' }
