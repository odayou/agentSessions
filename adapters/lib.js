'use strict'
// 适配器共享工具：目录内递归找 .jsonl 源文件 + 会话级主题（L2 种子）聚合 + 事件流组装 +
// Cline/Roo 任务目录共享解析（agentList §2.10/§2.11）。
// 注意：本文件不可反向依赖 src/engines.js（engines 顶层 require 本文件，避免循环引用）。
const fs = require('node:fs')
const path = require('node:path')
const { classifyPurpose } = require('../src/purpose')

// 递归列出 root 下所有 .jsonl 文件（不可读目录跳过）
function findJsonlFiles(root) {
  const out = []
  if (!fs.existsSync(root)) return out
  try {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      const p = path.join(root, entry.name)
      if (entry.isDirectory()) out.push(...findJsonlFiles(p))
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) out.push(p)
    }
  } catch { /* 跳过不可读 */ }
  return out
}

// 递归列出 root 下所有「含 api_conversation_history.json 的任务目录」的该文件路径
// （以文件而非目录作源文件，增量指纹 mtime+size 才能感知内容变更）
function listClineTaskFiles(root) {
  const out = []
  let entries
  try { entries = fs.readdirSync(root, { withFileTypes: true }) } catch { return out }
  for (const ent of entries) {
    if (!ent.isDirectory()) continue
    const f = path.join(root, ent.name, 'api_conversation_history.json')
    if (fs.existsSync(f)) out.push(f)
  }
  return out
}

// 事件流 → 轮次：按时间升序；任一侧缺 ts 时保持原始顺序（只对两侧都有 ts 的事件做时间比较，
// 避免「部分事件无时间戳」的会话把无 ts 事件全部挤到队尾、回复并入错误轮次）
function assembleTurns(events) {
  const sorted = events
    .map((ev, i) => ({ ev, i }))
    .sort((a, b) => {
      const at = a.ev.ts
      const bt = b.ev.ts
      if (at != null && bt != null && at !== bt) return at - bt
      return a.i - b.i
    })
    .map((x) => x.ev)
  const turns = []
  let cur = null
  for (const ev of sorted) {
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
        const entries = []
        for (const t of ev.tools) {
          entries.push(JSON.stringify(t))
          if (t.input) {
            try {
              const parsed = JSON.parse(t.input)
              if (parsed.file_path) cur.filesChanged.push(String(parsed.file_path))
              if (parsed.path) cur.filesChanged.push(String(parsed.path))
            } catch { /* 非 JSON 跳过 */ }
          }
        }
        const joined = entries.join('\n')
        cur.toolInput = cur.toolInput ? cur.toolInput + '\n' + joined : joined
      }
    }
  }
  return turns
}

// 轮次收尾：每轮主题归类（L2 种子）→ 剔除空轮
function finalizeTurns(turns) {
  for (const t of turns) t.subject = classifyPurpose(t.userMessage || '', [])
  return turns.filter((t) => t.userMessage || t.assistantMessage || t.thinking)
}

// 文件 mtime(ms)（不可读返回 null）
function mtimeMs(file) {
  try { return Math.round(fs.statSync(file).mtimeMs) } catch { return null }
}

// —— 「路径样」字符串启发式（cwd 字段跨版本/跨工具字段名不定时的兜底）——
function looksLikeAbsPath(v) {
  return typeof v === 'string' && v.length > 2 && v.length < 500 && !/[\n\r]/.test(v)
    && (/^[A-Za-z]:[\\/]/.test(v) || v.startsWith('/') || v.startsWith('~') || v.startsWith('\\\\'))
}

// 对象内按常见键名找「路径样」字符串（深度限制 3 层）
function findPathLike(obj) {
  const keys = ['cwd', 'workspace', 'workspacePath', 'projectPath', 'rootPath', 'folder', 'path']
  const seen = new Set()
  const visit = (o, depth) => {
    if (!o || typeof o !== 'object' || depth > 3) return null
    for (const k of keys) {
      const v = o[k]
      if (typeof v === 'string' && looksLikeAbsPath(v)) return v
    }
    for (const v of Object.values(o)) {
      if (v && typeof v === 'object' && !Array.isArray(v) && !seen.has(v)) {
        seen.add(v)
        const r = visit(v, depth + 1)
        if (r) return r
      }
    }
    return null
  }
  return visit(obj, 0)
}

function firstString(obj, keys) {
  for (const k of keys) if (obj && typeof obj[k] === 'string' && obj[k].trim()) return obj[k]
  return null
}

function firstNumber(obj, keys) {
  for (const k of keys) {
    const v = obj ? obj[k] : null
    if (typeof v === 'number' && Number.isFinite(v)) return v
    if (typeof v === 'string') {
      const n = Date.parse(v)
      if (!Number.isNaN(n)) return n
    }
  }
  return null
}

// —— Cline / Roo Code 共享任务目录解析 ——
// 任务目录：<taskDir>/api_conversation_history.json（Anthropic 原始消息数组，必查）
//   + task_metadata.json（Cline 元数据）/ history_item.json（Roo 特有历史项）
//   + ui_messages.json（UI 展示消息，不参与解析）
// cwd/title/ts 字段名跨版本不定 → 元数据文件容错读取 + 路径值启发式
function parseClineStyleTaskDir(taskDir, fallbackCwd) {
  const histFile = path.join(taskDir, 'api_conversation_history.json')
  let msgs
  try { msgs = JSON.parse(fs.readFileSync(histFile, 'utf8')) } catch { return null }
  if (!Array.isArray(msgs) || !msgs.length) return null

  const meta = {}
  for (const name of ['task_metadata.json', 'history_item.json', 'metadata.json']) {
    let d
    try { d = JSON.parse(fs.readFileSync(path.join(taskDir, name), 'utf8')) } catch { continue }
    if (!d || typeof d !== 'object' || Array.isArray(d)) continue
    if (!meta.cwd) meta.cwd = findPathLike(d)
    if (!meta.title) meta.title = firstString(d, ['task', 'name', 'title'])
    if (!meta.ts) meta.ts = firstNumber(d, ['ts', 'timestamp', 'createdAt', 'created_at'])
    if (meta.cwd && meta.title && meta.ts) break
  }

  // Anthropic 消息数组 → 事件流：user 文本开新轮；tool_result 型 user 消息是工具回执，不建轮
  const events = []
  let model = null
  for (const m of msgs) {
    if (!m || typeof m !== 'object') continue
    const role = String(m.role || '').toLowerCase()
    if (!model && m.model) model = String(m.model)
    const content = Array.isArray(m.content) ? m.content : (typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : [])
    if (role === 'user') {
      if (content.some((b) => b && b.type === 'tool_result')) continue
      const text = content.map((b) => (b && b.type === 'text' ? String(b.text || '') : '')).filter(Boolean).join('\n')
      if (text) events.push({ ts: null, kind: 'user', text, thinking: '', tools: [] })
    } else if (role === 'assistant') {
      let text = ''
      let thinking = ''
      const tools = []
      for (const b of content) {
        if (!b || typeof b !== 'object') continue
        if (b.type === 'text' && b.text) text = (text ? text + '\n' : '') + String(b.text)
        else if (b.type === 'thinking' && (b.thinking || b.text)) thinking = (thinking ? thinking + '\n' : '') + String(b.thinking || b.text)
        else if (b.type === 'tool_use') {
          const name = String(b.name || 'tool')
          let input = b.input
          if (input != null && typeof input !== 'string') { try { input = JSON.stringify(input) } catch { input = String(input) } }
          tools.push({ name, input: String(input || '').slice(0, 8000) })
        }
      }
      if (text || thinking || tools.length) events.push({ ts: null, kind: 'asst', text, thinking, tools })
    }
  }

  const nonEmpty = finalizeTurns(assembleTurns(events))
  if (!nonEmpty.length) return null

  const mt = mtimeMs(histFile)
  const createdAt = meta.ts || mt
  const cwd = meta.cwd || fallbackCwd || taskDir
  return {
    session: {
      agentSessionId: path.basename(taskDir),
      cwd,
      title: meta.title || (nonEmpty[0].userMessage ? nonEmpty[0].userMessage.replace(/\s+/g, ' ').slice(0, 80) : null),
      model,
      createdAt,
      updatedAt: mt || createdAt,
      sourceFile: histFile,
    },
    project: { cwd, name: path.basename(cwd) || cwd },
    turns: nonEmpty,
    subjects: buildSubjects(nonEmpty),
  }
}

// 轮次主题 → 会话级主题列表：去重，剔除无信息量归类（other/learning_qa）
function buildSubjects(turns) {
  return turns
    .filter((t) => t.subject && t.subject !== 'other' && t.subject !== 'learning_qa')
    .reduce((acc, t) => (acc.includes(t.subject) ? acc : acc.concat(t.subject)), [])
    .map((subject) => ({ layer: 2, subject, parentId: null }))
}

module.exports = {
  findJsonlFiles, listClineTaskFiles, assembleTurns, finalizeTurns, mtimeMs,
  looksLikeAbsPath, findPathLike, firstString, firstNumber, parseClineStyleTaskDir, buildSubjects,
}
