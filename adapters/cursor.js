'use strict'
// Cursor 适配器（agentList §2.15）：SQLite cursorDiskKV（schema 未官方文档化，容错解析）
//   ~/.cursor/chats/<workspace>/<agent>/store.db（每库多会话）
//   + IDE 侧 globalStorage/state.vscdb（新版 Cursor 的 cursorDiskKV 同源结构）
//   key 模式：composerData:<uuid>（会话行）/ bubbleId:<composerId>:<msgId>（消息行）
//   workspace hash 不可逆 → cwd 取库文件所在的工作区目录名
const fs = require('node:fs')
const path = require('node:path')
const { buildSubjects, assembleTurns, finalizeTurns, mtimeMs } = require('./lib')

// ts 兼容：秒级（<10^12）→ ms
function normTs(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null
  return v > 0 && v < 1e12 ? v * 1000 : v
}

// 富文本粗剥离（bubble 无纯文本 text 时的降级）
function stripHtml(s) {
  return String(s || '').replace(/<[^>]+>/g, '').replace(/[ \t]+\n/g, '\n').trim()
}

// 扫描单个库（scan.js 的 dbCandidates 分支一次性调用；库文件指纹由 scan.js 记录）
function scan(dbFile) {
  let Database
  try { Database = require('better-sqlite3') } catch { throw new Error('better-sqlite3 不可用') }
  const db = new Database(dbFile, { readonly: true, fileMustExist: true })
  const out = []
  try {
    const hasTable = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='cursorDiskKV'`).get()
    if (!hasTable) return out
    const mt = mtimeMs(dbFile)

    // 会话行：composerData:<uuid>
    const composers = new Map() // cid -> doc
    for (const row of db.prepare(`SELECT key, value FROM cursorDiskKV WHERE key LIKE 'composerData:%'`).all()) {
      let doc
      try { doc = JSON.parse(String(row.value || '')) } catch { continue }
      if (!doc || typeof doc !== 'object') continue
      const cid = String(doc.composerId || row.key.slice('composerData:'.length))
      composers.set(cid, doc)
    }
    if (!composers.size) return out

    // 消息行：bubbleId:<cid>:<mid>，按写入序（rowid）分组
    const bubbles = new Map() // cid -> [{rid, doc}]
    for (const row of db.prepare(`SELECT rowid AS rid, key, value FROM cursorDiskKV WHERE key LIKE 'bubbleId:%'`).all()) {
      const parts = String(row.key).split(':')
      if (parts.length < 3) continue
      let doc
      try { doc = JSON.parse(String(row.value || '')) } catch { continue }
      if (!doc || typeof doc !== 'object') continue
      if (!bubbles.has(parts[1])) bubbles.set(parts[1], [])
      bubbles.get(parts[1]).push({ rid: row.rid, doc })
    }

    for (const [cid, doc] of composers) {
      // 会话消息序：优先 fullConversationHeadersOnly（官方顺序）；缺失回落写入序
      const list = bubbles.get(cid) || []
      let ordered = null
      if (Array.isArray(doc.fullConversationHeadersOnly) && doc.fullConversationHeadersOnly.length) {
        const byBubbleId = new Map()
        for (const b of list) if (b.doc.bubbleId) byBubbleId.set(String(b.doc.bubbleId), b)
        ordered = []
        for (const h of doc.fullConversationHeadersOnly) {
          const bid = typeof h === 'string' ? h : (h && h.bubbleId)
          const hit = bid ? byBubbleId.get(String(bid)) : null
          if (hit) ordered.push(hit)
        }
      }
      if (!ordered || !ordered.length) ordered = list.slice().sort((a, b) => a.rid - b.rid)

      // 事件流：type 1=用户 / 2=AI；toolFormerData=工具调用；其他 type（checkpoint/系统）跳过
      const events = []
      for (const b of ordered) {
        const d = b.doc
        const type = Number(d.type)
        const text = (typeof d.text === 'string' && d.text.trim()) ? d.text : stripHtml(d.richText)
        const tools = []
        const tfd = d.toolFormerData
        if (tfd && typeof tfd === 'object') {
          let input = tfd.params != null ? tfd.params : tfd.rawArgs
          if (input != null && typeof input !== 'string') { try { input = JSON.stringify(input) } catch { input = String(input) } }
          tools.push({ name: String(tfd.name || 'tool'), input: String(input || '').slice(0, 8000) })
        }
        if (type === 1) {
          if (text) events.push({ ts: null, kind: 'user', text, thinking: '', tools: [] })
        } else if (type === 2) {
          if (text || tools.length) events.push({ ts: null, kind: 'asst', text: text || '', thinking: '', tools })
        }
      }

      const nonEmpty = finalizeTurns(assembleTurns(events))
      if (!nonEmpty.length) continue

      // cwd：store.db 位于 ~/.cursor/chats/<workspace>/<agent>/ → 取 <workspace>；
      //      state.vscdb 位于 workspaceStorage/<hash>/ 或 globalStorage/ → 取所在目录
      let cwd = path.dirname(path.dirname(dbFile))
      if (path.basename(dbFile) === 'state.vscdb') cwd = path.dirname(dbFile)
      const createdAt = normTs(doc.createdAt) || mt
      const updatedAt = normTs(doc.lastUpdatedAt) || createdAt
      out.push({
        session: {
          agentSessionId: cid,
          cwd,
          title: (typeof doc.name === 'string' && doc.name.trim()) ? doc.name
            : (nonEmpty[0].userMessage ? nonEmpty[0].userMessage.replace(/\s+/g, ' ').slice(0, 80) : null),
          model: null,
          createdAt,
          updatedAt,
          sourceFile: dbFile,
        },
        project: { cwd, name: path.basename(cwd) || cwd },
        turns: nonEmpty,
        subjects: buildSubjects(nonEmpty),
      })
    }
    return out
  } finally {
    db.close()
  }
}

module.exports = { scan, id: 'cursor', label: 'Cursor', sourceFormat: 'sqlite/cursorDiskKV' }
