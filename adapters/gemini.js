'use strict'
// Gemini CLI 适配器（agentList §2.3）：兼容新旧两种会话格式
//   旧版：~/.gemini/tmp/<hash>/chats/session-*.json（信封对象 {sessionId, projectHash, startTime, messages:[...]}）
//   新版：同目录 *.jsonl（append-only 流式记录，首行为会话元数据，后续消息逐条追加）
// 项目识别：project_hash 不可逆 → cwd 回落到 tmp/<hash> 目录本身（项目名即 hash）
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { buildSubjects, assembleTurns, finalizeTurns, mtimeMs } = require('./lib')
const { parseTs } = require('../src/engines')

const GEMINI_TMP = path.join(os.homedir(), '.gemini', 'tmp')

// 列出 tmp/<hash>/chats/ 下的 .json/.jsonl 源文件（增量扫描用）
function sources(dir) {
  const root = dir || GEMINI_TMP
  const out = []
  let hashes = []
  try {
    hashes = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
  } catch { return out }
  for (const h of hashes) {
    let files = []
    try { files = fs.readdirSync(path.join(root, h, 'chats')) } catch { continue }
    for (const f of files) {
      const low = f.toLowerCase()
      if (low.endsWith('.jsonl') || low.endsWith('.json')) out.push(path.join(root, h, 'chats', f))
    }
  }
  return out
}

// 从记录中提取会话元数据字段（sessionId/startTime/projectHash/name/title）
function pickMeta(o, meta) {
  if (!o || typeof o !== 'object') return
  for (const k of ['sessionId', 'startTime', 'projectHash', 'name', 'title']) {
    if (!meta[k] && o[k] != null && o[k] !== '') meta[k] = String(o[k])
  }
}

// 解析单个源文件为一个 UnifiedSession（增量扫描用）
function parseFile(file) {
  const records = []
  const meta = {}
  try {
    const raw = fs.readFileSync(file, 'utf8')
    if (file.toLowerCase().endsWith('.jsonl')) {
      // 新版：逐行 JSON（崩溃截断行跳过）
      for (const line of raw.split('\n')) {
        const l = line.trim()
        if (!l) continue
        let o
        try { o = JSON.parse(l) } catch { continue }
        if (!o || typeof o !== 'object') continue
        if (o.type === 'session' || (!o.type && (o.messages || (!o.text && (o.sessionId || o.startTime))))) {
          pickMeta(o, meta) // 元数据行
          if (Array.isArray(o.messages)) records.push(...o.messages.filter((x) => x && typeof x === 'object'))
          continue
        }
        pickMeta(o, meta) // 消息记录若携带 sessionId 也用于兜底
        records.push(o)
      }
    } else {
      // 旧版：信封对象
      const doc = JSON.parse(raw)
      if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return null
      pickMeta(doc, meta)
      if (Array.isArray(doc.messages)) records.push(...doc.messages.filter((x) => x && typeof x === 'object'))
    }
  } catch { return null }
  if (!records.length && !meta.sessionId) return null

  // 事件流：user=用户消息；gemini/assistant=回复（thoughts→思考，toolCalls→工具）
  const events = []
  for (const rec of records) {
    const type = String(rec.type || '').toLowerCase()
    const ts = parseTs(rec.timestamp != null ? rec.timestamp : rec.ts)
    if (type === 'user') {
      const text = typeof rec.text === 'string' ? rec.text : (typeof rec.message === 'string' ? rec.message : '')
      if (text) events.push({ ts, kind: 'user', text, thinking: '', tools: [] })
    } else if (type === 'gemini' || type === 'assistant' || type === 'model') {
      const text = typeof rec.text === 'string' ? rec.text : ''
      let thinking = ''
      if (Array.isArray(rec.thoughts)) {
        thinking = rec.thoughts
          .map((t) => (t && typeof t === 'object' ? String(t.description || t.text || t.subject || '') : String(t || '')))
          .filter(Boolean).join('\n')
      } else if (typeof rec.thought === 'string') thinking = rec.thought
      const tools = []
      if (Array.isArray(rec.toolCalls)) {
        for (const tc of rec.toolCalls) {
          if (!tc || typeof tc !== 'object') continue
          const name = String(tc.name || 'tool')
          let input = tc.args
          if (input != null && typeof input !== 'string') { try { input = JSON.stringify(input) } catch { input = String(input) } }
          tools.push({ name, input: String(input || '').slice(0, 8000) })
        }
      }
      if (text || thinking || tools.length) events.push({ ts, kind: 'asst', text, thinking, tools })
    }
    // info/error/warning/compression/stats 等系统记录不进入对话时间线
  }

  const nonEmpty = finalizeTurns(assembleTurns(events))
  if (!nonEmpty.length) return null

  const mt = mtimeMs(file)
  const evTs = events.map((e) => e.ts).filter((t) => Number.isFinite(t))
  const createdAt = parseTs(meta.startTime) || (evTs.length ? Math.min(...evTs) : mt)
  const updatedAt = evTs.length ? Math.max(...evTs) : mt
  // project_hash 不可逆：cwd 回落到所属 hash 目录（tmp/<hash>）
  const cwd = path.dirname(path.dirname(file))
  return {
    session: {
      agentSessionId: meta.sessionId || path.basename(file).replace(/\.[^.]+$/, ''),
      cwd,
      title: meta.name || meta.title || (nonEmpty[0].userMessage ? nonEmpty[0].userMessage.replace(/\s+/g, ' ').slice(0, 80) : null),
      model: null,
      createdAt,
      updatedAt: updatedAt || createdAt,
      sourceFile: file,
    },
    project: { cwd, name: path.basename(cwd) || cwd },
    turns: nonEmpty,
    subjects: buildSubjects(nonEmpty),
  }
}

// 扫描目录下所有会话文件（保留与其他适配器一致的 scan 接口）
function scan(sourceDir) {
  const out = []
  for (const file of sources(sourceDir)) {
    const item = parseFile(file)
    if (item) out.push(item)
  }
  return out
}

module.exports = { scan, sources, parseFile, id: 'gemini', label: 'Gemini CLI', sourceDir: GEMINI_TMP, sourceFormat: 'jsonl/gemini' }
