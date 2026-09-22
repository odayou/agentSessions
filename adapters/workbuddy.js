'use strict'
// WorkBuddy 适配器（离线扫描）：~/.workbuddy/projects/<cwd>/<uuid>.jsonl
// Claude Code 系 JSONL transcript，实测格式：
//   {"type":"message","role":"user","content":[{"type":"input_text","text":"..."}],"sessionId":"...","cwd":"...","timestamp":...}
//   {"type":"message","role":"assistant","content":[{"type":"thinking","thinking":"..."},{"type":"text","text":"..."},{"type":"tool_use","name":"...","input":{...}}],"cwd":...,"timestamp":...}
//   {"type":"ai-title","aiTitle":"...","sessionId":"...","cwd":"...","timestamp":...}
//   message 可能带 messageId / parentMessageId；tool_result 写成 role:'user' content:[{type:'tool_result',...}]
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { classifyPurpose } = require('../src/purpose')
const { findJsonlFiles, buildSubjects } = require('./lib')

const PROJECTS_DIR = path.join(os.homedir(), '.workbuddy', 'projects')

function parseBlock(b) {
  if (!b || typeof b !== 'object') return ''
  if (b.type === 'text') return String(b.text || '')
  if (b.type === 'input_text' || b.type === 'output_text') return String(b.text || '')
  return ''
}

function parseToolUse(b) {
  try {
    const input = typeof b.input === 'string' ? b.input : (b.input != null ? JSON.stringify(b.input) : '')
    return {
      name: b.name || 'tool',
      input: (input || '').slice(0, 8000),
      output: undefined,
    }
  } catch { return null }
}

function parseThinking(b) {
  return typeof b.thinking === 'string' ? b.thinking : String(b.thinking || '')
}

// 列出源文件（增量扫描用）
function sources(sourceDir) {
  return findJsonlFiles(sourceDir || PROJECTS_DIR)
}

// 解析单个源文件为一个 UnifiedSession（增量扫描用）
function parseFile(file) {
  return parseTranscript(file)
}

// 扫描 projects 目录下所有 jsonl，返回 { session, project, turns, subjects } 数组
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

  // 统一事件流：按时间升序，user 开新轮，assistant/reasoning/function_call 归入当前轮
  const events = []

  const seenCalls = new Set() // function_call 去重（防止同 tool 多次重复入 toolInput）
  for (const line of lines) {
    let m
    try { m = JSON.parse(line) } catch { continue }
    if (!m || typeof m !== 'object') continue

    const ts = m.timestamp || null
    if (sessionId === null && m.sessionId) sessionId = m.sessionId
    if (cwd === null && m.cwd) cwd = m.cwd
    if (ts && (firstTs === null || ts < firstTs)) firstTs = ts
    if (ts && (lastTs === null || ts > lastTs)) lastTs = ts

    if (m.type === 'ai-title') {
      title = m.aiTitle || title
      continue
    }
    if (m.type === 'reasoning') {
      // 思考：rawContent[].reasoning_text 或 content[].reasoning_text
      const rc = Array.isArray(m.rawContent) ? m.rawContent : (Array.isArray(m.content) ? m.content : [])
      const thinkText = rc.map((b) => (b.type === 'reasoning_text' ? String(b.text || '') : '')).filter(Boolean).join('\n')
      if (thinkText) events.push({ ts, kind: 'asst', text: '', thinking: thinkText, tools: [] })
      continue
    }
    if (m.type === 'function_call' || m.type === 'tool_use' || m.type === 'tool_call') {
      const name = m.name || m.tool || 'tool'
      const input = typeof m.arguments === 'string' ? m.arguments
        : (m.arguments != null ? JSON.stringify(m.arguments) : (typeof m.input === 'string' ? m.input : (m.input != null ? JSON.stringify(m.input) : '')))
      const key = name + '|' + (input || '').slice(0, 120)
      if (seenCalls.has(key)) continue
      seenCalls.add(key)
      events.push({ ts, kind: 'asst', text: '', thinking: '', tools: [{ name, input }] })
      continue
    }
    if (m.type === 'function_call_result' || m.type === 'tool_result') continue
    if (m.type !== 'message') continue

    const role = m.role
    const content = Array.isArray(m.content) ? m.content : []
    if (m.model && !model) model = typeof m.model === 'string' ? m.model : (m.model?.id || null)

    if (role === 'user') {
      const text = content.map(parseBlock).filter(Boolean).join('\n')
      if (text) events.push({ ts, kind: 'user', text, thinking: '', tools: [] })
    } else if (role === 'assistant') {
      let text = ''
      let thinking = ''
      const tools = []
      for (const b of content) {
        if (b.type === 'text' || b.type === 'input_text' || b.type === 'output_text') {
          const t = parseBlock(b); if (t) text = (text ? text + '\n' : '') + t
        } else if (b.type === 'thinking') {
          const t = parseThinking(b); if (t) thinking = (thinking ? thinking + '\n' : '') + t
        } else if (b.type === 'tool_use' || b.type === 'tool') {
          const t = parseToolUse(b); if (t) tools.push(t)
        }
      }
      if (text || thinking || tools.length) events.push({ ts, kind: 'asst', text, thinking, tools })
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
      title: title || null,
      model,
      createdAt: firstTs,
      updatedAt: lastTs || firstTs, // 最后活动时间
      sourceFile: file,
    },
    project: { cwd, name: path.basename(cwd) || cwd },
    turns,
    subjects,
  }
}

module.exports = { scan, sources, parseFile, id: 'workbuddy', label: 'WorkBuddy', sourceDir: PROJECTS_DIR, sourceFormat: 'jsonl/workbuddy-transcript' }