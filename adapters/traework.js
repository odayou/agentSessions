'use strict'
// TRAE SOLO（TraeWork）适配器：尝试读取会话文件
// 注意：TraeWork 使用加密的 SQLite 数据库（database.db），此适配器提供基础支持
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { classifyPurpose } = require('../src/purpose')
const { findJsonlFiles, buildSubjects } = require('./lib')

// TraeWork 数据目录
const TRAEWORK_DIR = path.join(os.homedir(), 'AppData', 'Roaming', 'TRAE SOLO CN')

// 查找可能的会话文件（JSONL 格式）
function findSessionFiles(root) {
  const out = []
  if (!fs.existsSync(root)) return out
  
  // 尝试查找 JSONL 文件
  try {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      const p = path.join(root, entry.name)
      if (entry.isDirectory()) {
        // 递归搜索子目录
        out.push(...findSessionFiles(p))
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        out.push(p)
      }
    }
  } catch { /* 跳过不可读 */ }
  
  return out
}

// 列出源文件（增量扫描用）
function sources(sourceDir) {
  return findSessionFiles(sourceDir || TRAEWORK_DIR)
}

// 解析单个源文件为一个 UnifiedSession（增量扫描用）
function parseFile(file) {
  return parseTranscript(file)
}

// 扫描目录下所有会话文件，返回 { session, project, turns, subjects } 数组
function scan(sourceDir) {
  const files = sources(sourceDir)
  if (!files.length) return []

  const out = []
  for (const file of files) {
    const turn = parseFile(file)
    if (turn) out.push(turn)
  }
  return out
}

// 解析单个 jsonl 文件为一个 UnifiedSession
function parseTranscript(file) {
  let lines
  try {
    lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim())
  } catch { return null }
  if (lines.length < 2) return null

  let sessionId = null
  let cwd = null
  let title = null
  let firstTs = null
  let lastTs = null
  let model = null

  // 统一事件流：按时间升序，user 开新轮，assistant 归入当前轮
  const events = []
  const seenCalls = new Set() // tool_use 去重

  for (const line of lines) {
    let m
    try { m = JSON.parse(line) } catch { continue }
    if (!m || typeof m !== 'object') continue

    // 尝试提取常见字段
    const ts = m.timestamp || m.time || m.created_at || null
    const parsedTs = typeof ts === 'number' ? ts : (typeof ts === 'string' ? Date.parse(ts) : null)
    
    if (sessionId === null && m.sessionId) sessionId = m.sessionId
    if (cwd === null && m.cwd) cwd = m.cwd
    if (parsedTs && (firstTs === null || parsedTs < firstTs)) firstTs = parsedTs
    if (parsedTs && (lastTs === null || parsedTs > lastTs)) lastTs = parsedTs

    // 尝试解析不同类型的消息
    if (m.type === 'message' || m.role) {
      const role = m.role
      const content = Array.isArray(m.content) ? m.content : []
      
      if (role === 'user') {
        const text = content
          .map((b) => {
            if (!b || typeof b !== 'object') return ''
            if (b.type === 'text' || b.type === 'input_text') return String(b.text || '')
            return ''
          })
          .filter(Boolean)
          .join('\n')
        if (text) events.push({ ts: parsedTs, kind: 'user', text, thinking: '', tools: [] })
      } else if (role === 'assistant') {
        let text = ''
        let thinking = ''
        const tools = []
        for (const b of content) {
          if (!b || typeof b !== 'object') continue
          if (b.type === 'text' && b.text) {
            text = text ? text + '\n' + String(b.text) : String(b.text)
          } else if (b.type === 'thinking' && b.thinking) {
            thinking = thinking ? thinking + '\n' + String(b.thinking) : String(b.thinking)
          } else if (b.type === 'tool_use' || b.type === 'function_call') {
            const name = b.name || b.tool || 'tool'
            const input = typeof b.arguments === 'string' ? b.arguments
              : (b.arguments != null ? JSON.stringify(b.arguments) : (typeof b.input === 'string' ? b.input : (b.input != null ? JSON.stringify(b.input) : '')))
            const key = name + '|' + (input || '').slice(0, 120)
            if (!seenCalls.has(key)) {
              seenCalls.add(key)
              tools.push({ name, input: (input || '').slice(0, 8000) })
            }
          }
        }
        if (text || thinking || tools.length) {
          events.push({ ts: parsedTs, kind: 'asst', text, thinking, tools })
        }
      }
    }
  }

  if (!sessionId && !cwd) return null
  cwd = cwd || path.dirname(file)

  // 组装 turns：按时间升序单遍扫描，user 消息开启新轮，其后 assistant 归入该轮
  const eventsSorted = events.slice().sort((x, y) => (x.ts === y.ts ? 0 : x.ts == null ? 1 : y.ts == null ? -1 : (x.ts - y.ts)))

  const turns = []
  let cur = null
  for (const ev of eventsSorted) {
    if (ev.kind === 'user') {
      cur = {
        seq: turns.length,
        userMessage: ev.text || null,
        assistantMessage: null,
        thinking: null,
        toolInput: null,
        filesChanged: [],
        timestamp: ev.ts,
        subject: null,
      }
      turns.push(cur)
    } else if (cur) {
      if (ev.text) cur.assistantMessage = (cur.assistantMessage ? cur.assistantMessage + '\n' : '') + ev.text
      if (ev.thinking) cur.thinking = (cur.thinking ? cur.thinking + '\n' : '') + ev.thinking
      if (ev.tools && ev.tools.length) {
        const entries = ev.tools.map((t) => JSON.stringify(t)).join('\n')
        cur.toolInput = cur.toolInput ? cur.toolInput + '\n' + entries : entries
        for (const t of ev.tools) {
          if (t.input) {
            try {
              const parsed = JSON.parse(t.input)
              if (parsed.file_path) cur.filesChanged.push(String(parsed.file_path))
              if (parsed.path) cur.filesChanged.push(String(parsed.path))
            } catch { /* 非 JSON 跳过 */ }
          }
        }
      }
    }
  }

  // 计算每轮主题（L2 种子）：用当轮 userMessage 归类
  for (const turn of turns) {
    turn.subject = classifyPurpose(turn.userMessage || '', [])
  }
  const nonEmpty = turns.filter((t) => t.userMessage || t.assistantMessage || t.thinking)
  if (!nonEmpty.length) return null

  const subjects = buildSubjects(nonEmpty)

  return {
    session: {
      agentSessionId: sessionId || path.basename(file, '.jsonl'),
      cwd,
      title: title || (nonEmpty[0].userMessage ? nonEmpty[0].userMessage.replace(/\s+/g, ' ').slice(0, 80) : null),
      model,
      createdAt: firstTs,
      updatedAt: lastTs || firstTs,
      sourceFile: file,
    },
    project: { cwd, name: path.basename(cwd) || cwd },
    turns: nonEmpty,
    subjects,
  }
}

module.exports = { scan, sources, parseFile, id: 'traework', label: 'TRAE SOLO', sourceDir: TRAEWORK_DIR, sourceFormat: 'jsonl/traework-transcript' }
