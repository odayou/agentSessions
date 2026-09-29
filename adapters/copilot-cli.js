'use strict'
// GitHub Copilot CLI 适配器（agentList §2.7）：~/.copilot/session-state/<uuid>/events.jsonl
//   - events.jsonl 为完整事件流（优先）；session-store.db 仅派生索引（多步轮次被折叠，不读）
//   - workspace.yaml（简单 key: value 子集）提供会话名称与 cwd（项目关联）
//   - 事件 schema 未完全文档化：字段提取多形状容错（SDK 消息流 content blocks / 扁平消息）
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { buildSubjects, assembleTurns, finalizeTurns, mtimeMs } = require('./lib')
const { parseTs } = require('../src/engines')

const STATE_DIR = path.join(os.homedir(), '.copilot', 'session-state')

// 递归查找 events.jsonl（增量扫描用）
function sources(dir) {
  const root = dir || STATE_DIR
  const out = []
  ;(function walk(d) {
    let entries
    try { entries = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const ent of entries) {
      const p = path.join(d, ent.name)
      if (ent.isDirectory()) walk(p)
      else if (ent.isFile() && ent.name === 'events.jsonl') out.push(p)
    }
  })(root)
  return out
}

// workspace.yaml 极简解析：只取顶层 cwd / name（标量字符串，剥离引号）
function readWorkspaceMeta(sessionDir) {
  const meta = {}
  let text
  try { text = fs.readFileSync(path.join(sessionDir, 'workspace.yaml'), 'utf8') } catch { return meta }
  for (const line of text.split(/\r?\n/)) {
    const m = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line)
    if (!m) continue
    const v = m[2].trim().replace(/^["']|["']$/g, '')
    if (!v || v.startsWith('{') || v.startsWith('[')) continue
    if (m[1] === 'cwd' && !meta.cwd) meta.cwd = v
    if ((m[1] === 'name' || m[1] === 'title') && !meta.title) meta.title = v
  }
  return meta
}

// 内容提取：兼容 字符串 / 文本块数组（SDK content blocks）
function extractText(v) {
  if (typeof v === 'string') return v
  if (Array.isArray(v)) {
    return v.map((b) => {
      if (typeof b === 'string') return b
      if (b && typeof b === 'object' && (b.type === 'text' || b.type === 'input_text' || b.type === 'output_text')) return String(b.text || '')
      return ''
    }).filter(Boolean).join('\n')
  }
  return v == null ? '' : String(v)
}

function extractThinking(rec) {
  for (const c of [rec.thinking, rec.reasoning, rec.thought]) {
    const t = extractText(c)
    if (t) return t
  }
  // SDK 块：message.content 中的 thinking/reasoning 块
  const content = rec.message && rec.message.content
  if (Array.isArray(content)) {
    return content
      .filter((b) => b && typeof b === 'object' && (b.type === 'thinking' || b.type === 'reasoning'))
      .map((b) => String(b.thinking || b.text || '')).filter(Boolean).join('\n')
  }
  return ''
}

function toolToEntry(name, input) {
  if (input != null && typeof input !== 'string') { try { input = JSON.stringify(input) } catch { input = String(input) } }
  return { name: String(name || 'tool'), input: String(input || '').slice(0, 8000) }
}

// 解析单个 events.jsonl 为一个 UnifiedSession（增量扫描用）
function parseFile(file) {
  let lines = []
  try { lines = fs.readFileSync(file, 'utf8').split(/\r?\n/) } catch { return null }
  const sessionDir = path.dirname(file)
  const meta = readWorkspaceMeta(sessionDir)

  const events = []
  let model = null
  let sessionId = null
  for (const line of lines) {
    const l = line.trim()
    if (!l) continue
    let rec
    try { rec = JSON.parse(l) } catch { continue }
    if (!rec || typeof rec !== 'object') continue
    if (sessionId === null && rec.sessionId) sessionId = String(rec.sessionId)
    if (!model && rec.model) model = typeof rec.model === 'string' ? rec.model : (rec.model.id ? String(rec.model.id) : null)
    const ts = parseTs(rec.timestamp != null ? rec.timestamp : (rec.ts != null ? rec.ts : rec.created_at))
    const type = String(rec.type || '').toLowerCase()
    const role = String(rec.role || (rec.message && rec.message.role) || '').toLowerCase()
    const msgContent = rec.message && rec.message.content !== undefined ? rec.message.content : rec.content

    if (type === 'user' || type === 'user_message' || role === 'user') {
      const text = extractText(msgContent != null ? msgContent : rec.text)
      if (text) events.push({ ts, kind: 'user', text, thinking: '', tools: [] })
    } else if (type === 'assistant' || type === 'assistant_message' || role === 'assistant') {
      const text = extractText(msgContent != null ? msgContent : rec.text)
      const thinking = extractThinking(rec)
      const tools = []
      if (Array.isArray(msgContent)) {
        for (const b of msgContent) {
          if (b && typeof b === 'object' && (b.type === 'tool_use' || b.type === 'tool_call')) {
            tools.push(toolToEntry(b.name, b.input != null ? b.input : b.arguments))
          }
        }
      }
      if (text || thinking || tools.length) events.push({ ts, kind: 'asst', text, thinking, tools })
    } else if (type === 'tool_call' || type === 'tool_use' || type === 'tool') {
      // 扁平事件形状的独立工具调用
      events.push({ ts, kind: 'asst', text: '', thinking: '', tools: [toolToEntry(rec.name || rec.tool, rec.input != null ? rec.input : rec.arguments)] })
    }
    // system/result/error/info 等事件不进入对话时间线
  }

  const nonEmpty = finalizeTurns(assembleTurns(events))
  if (!nonEmpty.length) return null

  const mt = mtimeMs(file)
  const evTs = events.map((e) => e.ts).filter((t) => Number.isFinite(t))
  const createdAt = evTs.length ? Math.min(...evTs) : mt
  const updatedAt = evTs.length ? Math.max(...evTs) : mt
  const cwd = meta.cwd || sessionDir
  return {
    session: {
      agentSessionId: sessionId || path.basename(sessionDir),
      cwd,
      title: meta.title || (nonEmpty[0].userMessage ? nonEmpty[0].userMessage.replace(/\s+/g, ' ').slice(0, 80) : null),
      model,
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

module.exports = { scan, sources, parseFile, id: 'copilot-cli', label: 'Copilot CLI', sourceDir: STATE_DIR, sourceFormat: 'jsonl/copilot-events' }
