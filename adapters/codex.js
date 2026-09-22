'use strict'
// Codex 适配器：读取 ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
// 格式：每行一个 JSON 对象，包含 type（session_meta/response_item/event_msg）等字段
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { classifyPurpose } = require('../src/purpose')
const { findJsonlFiles, buildSubjects } = require('./lib')

const SESSIONS_DIR = path.join(os.homedir(), '.codex', 'sessions')

// 解析时间戳
function parseTs(v) {
  if (typeof v === 'string') {
    const n = Date.parse(v)
    if (!Number.isNaN(n)) return n
  }
  return null
}

// 列出源文件（增量扫描用）
function sources(sourceDir) {
  return findJsonlFiles(sourceDir || SESSIONS_DIR)
}

// 解析单个源文件为一个 UnifiedSession（增量扫描用）
function parseFile(file) {
  return parseTranscript(file)
}

// 扫描 sessions 目录下所有 jsonl，返回 { session, project, turns, subjects } 数组
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

// 解析单个 rollout jsonl 文件为一个 UnifiedSession
function parseTranscript(file) {
  let lines
  try {
    lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim())
  } catch { return null }
  if (lines.length < 2) return null

  let sessionId = null
  let cwd = null
  let model = null
  let firstTs = null
  let lastTs = null

  // 统一事件流：user 开新轮，assistant 的 text/thinking/tool_use 归入当前轮
  const events = []
  const seenCalls = new Set() // tool_use 去重

  for (const line of lines) {
    let m
    try { m = JSON.parse(line) } catch { continue }
    if (!m || typeof m !== 'object') continue

    const ts = parseTs(m.timestamp)
    if (firstTs === null || (ts != null && ts < firstTs)) firstTs = ts
    if (lastTs === null || (ts != null && ts > lastTs)) lastTs = ts

    // session_meta → 提取 sessionId, cwd, model
    if (m.type === 'session_meta' && m.payload) {
      if (!sessionId && m.payload.session_id) sessionId = m.payload.session_id
      if (!cwd && m.payload.cwd) cwd = m.payload.cwd
      if (!model && m.payload.model) model = m.payload.model
      continue
    }

    // response_item → 对话内容
    if (m.type === 'response_item' && m.payload) {
      const p = m.payload
      if (p.type === 'message' || p.role) {
        const role = p.role
        const content = Array.isArray(p.content) ? p.content : []
        
        if (role === 'user') {
          // 用户消息
          const text = content
            .map((b) => {
              if (!b || typeof b !== 'object') return ''
              if (b.type === 'input_text' || b.type === 'text') return String(b.text || '')
              return ''
            })
            .filter(Boolean)
            .join('\n')
          if (text) events.push({ ts, kind: 'user', text, thinking: '', tools: [] })
        } else if (role === 'assistant') {
          // 助手消息
          let text = ''
          let thinking = ''
          const tools = []
          for (const b of content) {
            if (!b || typeof b !== 'object') continue
            if (b.type === 'text' && b.text) {
              text = text ? text + '\n' + String(b.text) : String(b.text)
            } else if (b.type === 'reasoning' && b.text) {
              thinking = thinking ? thinking + '\n' + String(b.text) : String(b.text)
            } else if (b.type === 'function_call' || b.type === 'tool_use') {
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
            events.push({ ts, kind: 'asst', text, thinking, tools })
          }
        }
      }
      continue
    }

    // event_msg → 事件消息
    if (m.type === 'event_msg' && m.payload) {
      const p = m.payload
      if (p.type === 'user_message' && p.message) {
        const text = typeof p.message === 'string' ? p.message : JSON.stringify(p.message)
        if (text) events.push({ ts, kind: 'user', text, thinking: '', tools: [] })
      } else if (p.type === 'agent_reasoning' && p.message) {
        const thinking = typeof p.message === 'string' ? p.message : JSON.stringify(p.message)
        if (thinking) events.push({ ts, kind: 'asst', text: '', thinking, tools: [] })
      } else if (p.type === 'agent_message' && p.message) {
        const text = typeof p.message === 'string' ? p.message : JSON.stringify(p.message)
        if (text) events.push({ ts, kind: 'asst', text, thinking: '', tools: [] })
      }
      continue
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
      title: nonEmpty[0].userMessage ? nonEmpty[0].userMessage.replace(/\s+/g, ' ').slice(0, 80) : null,
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

module.exports = { scan, sources, parseFile, id: 'codex', label: 'Codex', sourceDir: SESSIONS_DIR, sourceFormat: 'jsonl/codex-rollout' }
