'use strict'
// Claude Code 适配器（离线扫描）：~/.claude/projects/<escaped-cwd>/<sessionId>.jsonl
// 实测格式（每行一个 JSON 对象）：
//   {"type":"user","message":{"role":"user","content":"hi"},"sessionId":"...","cwd":"C:\\...","timestamp":"2026-08-18T08:03:43.173Z","uuid":"...","isSidechain":false}
//   {"type":"assistant","message":{"role":"assistant","content":[{"type":"thinking","thinking":"..."},{"type":"text","text":"..."},{"type":"tool_use","name":"...","input":{...}}],"model":"..."},"cwd":...,"timestamp":...}
//   {"type":"summary","summary":"..."} —— 会话摘要（作标题）
//   {"type":"file-history-snapshot"|"system"|...} —— 其他行忽略
// 细节：user 的 content 可能是字符串或数组（数组时取 text 块，跳过 tool_result 回显与 '<' 开头的命令回显）；
//       isSidechain=true 是子代理旁路对话，跳过；cwd 以行内字段为准（目录名转义不可靠）。
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { classifyPurpose } = require('../src/purpose')
const { findJsonlFiles, buildSubjects } = require('./lib')

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects')

function parseTs(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string') {
    const n = Date.parse(v)
    if (!Number.isNaN(n)) return n
  }
  return null
}

// user content → 纯文本（跳过 tool_result / 命令回显等噪音）
function userText(content) {
  if (typeof content === 'string') return content.startsWith('<') ? '' : content
  if (!Array.isArray(content)) return ''
  return content
    .map((b) => (b && b.type === 'text' ? String(b.text || '') : ''))
    .filter((t) => t && !t.startsWith('<'))
    .join('\n')
}

// 列出源文件（增量扫描用）
function sources(sourceDir) {
  return findJsonlFiles(sourceDir || PROJECTS_DIR)
}

function parseFile(file) {
  return parseTranscript(file)
}

function scan(sourceDir) {
  return sources(sourceDir).map(parseFile).filter(Boolean)
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
    if (m.isSidechain) continue // 子代理旁路，不进主对话

    const ts = parseTs(m.timestamp)
    if (sessionId === null && m.sessionId) sessionId = m.sessionId
    if (cwd === null && m.cwd) cwd = m.cwd
    if (ts != null) {
      if (firstTs === null || ts < firstTs) firstTs = ts
      if (lastTs === null || ts > lastTs) lastTs = ts
    }

    if (m.type === 'summary') {
      if (!title && m.summary) title = String(m.summary)
      continue
    }
    if (m.type !== 'user' && m.type !== 'assistant') continue

    const msg = m.message
    if (!msg || typeof msg !== 'object') continue
    if (m.type === 'user') {
      const text = userText(msg.content)
      if (text) events.push({ ts, kind: 'user', text, thinking: '', tools: [] })
      continue
    }

    // assistant
    if (!model && typeof msg.model === 'string' && !msg.model.startsWith('<')) model = msg.model
    const content = Array.isArray(msg.content) ? msg.content : []
    let text = ''
    let thinking = ''
    const tools = []
    for (const b of content) {
      if (!b || typeof b !== 'object') continue
      if (b.type === 'text' && b.text) text = text ? text + '\n' + String(b.text) : String(b.text)
      else if (b.type === 'thinking' && b.thinking) thinking = thinking ? thinking + '\n' + String(b.thinking) : String(b.thinking)
      else if (b.type === 'tool_use') {
        try {
          const input = typeof b.input === 'string' ? b.input : (b.input != null ? JSON.stringify(b.input) : '')
          const key = (b.name || 'tool') + '|' + (input || '').slice(0, 120)
          if (!seenCalls.has(key)) {
            seenCalls.add(key)
            tools.push({ name: b.name || 'tool', input: input.slice(0, 8000) })
          }
        } catch { /* 跳过异常参数 */ }
      }
    }
    if (text || thinking || tools.length) events.push({ ts, kind: 'asst', text, thinking, tools })
  }

  if (!sessionId && !cwd) return null
  cwd = cwd || path.dirname(file)

  // 组装 turns：按时间升序单遍扫描，user 开新轮，assistant 归入该轮
  const eventsSorted = events.slice().sort((x, y) => (x.ts == null ? 1 : y.ts == null ? -1 : x.ts - y.ts))
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
      if (ev.tools.length) {
        const entries = ev.tools.map((t) => JSON.stringify(t)).join('\n')
        cur.toolInput = cur.toolInput ? cur.toolInput + '\n' + entries : entries
        for (const t of ev.tools) {
          if (!t.input) continue
          try {
            const parsed = JSON.parse(t.input)
            if (parsed.file_path) cur.filesChanged.push(String(parsed.file_path))
            if (parsed.path) cur.filesChanged.push(String(parsed.path))
          } catch { /* 非 JSON 跳过 */ }
        }
      }
    }
  }

  const nonEmpty = turns.filter((t) => t.userMessage || t.assistantMessage || t.thinking)
  if (!nonEmpty.length) return null

  // 标题：summary 行优先，否则首条用户消息截断
  const firstUser = nonEmpty.find((t) => t.userMessage)
  const finalTitle = title
    || (firstUser && firstUser.userMessage ? firstUser.userMessage.replace(/\s+/g, ' ').slice(0, 80) : null)

  // 每轮主题归类 + 会话级主题聚合
  for (const turn of nonEmpty) turn.subject = classifyPurpose(turn.userMessage || '', [])
  const subjects = buildSubjects(nonEmpty)

  return {
    session: {
      agentSessionId: sessionId || path.basename(file, '.jsonl'),
      cwd,
      title: finalTitle,
      model,
      createdAt: firstTs,
      updatedAt: lastTs || firstTs, // 最后活动时间（供时间过滤/列表排序使用）
      sourceFile: file,
    },
    project: { cwd, name: path.basename(cwd) || cwd },
    turns: nonEmpty,
    subjects,
  }
}

module.exports = {
  scan, sources, parseFile,
  id: 'claude-code', label: 'Claude Code',
  sourceDir: PROJECTS_DIR,
  sourceFormat: 'jsonl/claude-code-transcript',
}
