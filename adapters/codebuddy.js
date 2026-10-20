'use strict'
// CodeBuddy 适配器，双形态数据源（agentList §6.1）：
// 1) CLI 版：~/.codebuddy/projects/{id}/{sessionId}.jsonl —— 每行一个 JSON 对象，含 type（message/ai-title 等）字段，完整会话正文
// 2) 桌面版（CodeBuddy CN，VS Code fork）：会话正文存于腾讯云端，本地仅存元数据，索引会话骨架（标题线索/时间/项目/文件变更），详情可能为空：
//    Roaming/CodeBuddy CN/User/globalStorage/tencent-cloud.coding-copilot/
//      genie-history/<base64url(cwd)>/conversations/<conversationId>/   空目录 = 会话占位（目录时间 ≈ 会话创建）
//      genie-history/<base64url(cwd)>/current.json                      当前会话指针 {conversationId, lastUpdated}
//      edit-sessions/<conversationId>.json                              文件 diff {conversationId, createdAt, updatedAt, fileDiffs}
//      message-queue/*.json                                             消息队列残留 {conversations:{<id>:{items:[{contentBlocks:[{text}]}]}}}
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { classifyPurpose } = require('../src/purpose')
const { findJsonlFiles, buildSubjects } = require('./lib')

const PROJECTS_DIR = path.join(os.homedir(), '.codebuddy', 'projects')
const DESKTOP_DIR = process.env.APPDATA
  ? path.join(process.env.APPDATA, 'CodeBuddy CN', 'User', 'globalStorage', 'tencent-cloud.coding-copilot')
  : path.join(os.homedir(), 'AppData', 'Roaming', 'CodeBuddy CN', 'User', 'globalStorage', 'tencent-cloud.coding-copilot')

// 解析时间戳
function parseTs(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string') {
    const n = Date.parse(v)
    if (!Number.isNaN(n)) return n
  }
  return null
}

// —— 桌面版：base64 目录名 → 项目路径 ——
// CodeBuddy 变体：标准 base64 的 '=' 填充字符被替换为 '_'（实测 22 字节路径 → 30 数据字符 + '__'，
// 与 '='→'_' 完全吻合；中部 '-'/'_' 按 URL-safe 兼容处理），解码后清洗残留控制字符。
function decodeCwd(name) {
  try {
    let s = String(name)
    const tail = s.match(/_+$/)
    const pad = tail ? tail[0].length : 0
    s = s.slice(0, s.length - pad).replace(/-/g, '+').replace(/_/g, '/') + '='.repeat(pad)
    while (s.length % 4) s += '='
    const out = Buffer.from(s, 'base64').toString('utf8')
    // 仅接受形如盘符路径的解码结果；清洗填充残留的尾部控制字符/问号
    return /^[a-zA-Z]:[\\/]/.test(out) ? out.replace(/[\x00-\x1f?]+$/, '') : null
  } catch { return null }
}

// —— 桌面版：沙箱目录归并 ——
// CodeBuddy 为无工作区的对话生成一次性沙箱 <home>/CodeBuddy/<纯数字时间戳>，
// 归并到 CodeBuddy 根项目，避免项目列表被时间戳目录刷屏；真实路径保留在会话 cwd 与备注中。
const SANDBOX_ROOT = path.join(os.homedir(), 'CodeBuddy').replace(/[\\/]+$/, '')

function sandboxRootOf(cwd) {
  if (!cwd) return null
  let p = String(cwd).trim().replace(/[\\/]+$/, '')
  if (process.platform === 'win32') p = p.replace(/\//g, '\\')
  const root = process.platform === 'win32' ? SANDBOX_ROOT.toLowerCase() : SANDBOX_ROOT
  const lower = process.platform === 'win32' ? p.toLowerCase() : p
  if (lower === root || !lower.startsWith(root + path.sep)) return null
  // 首段为纯数字时间戳才视为沙箱（用户真实项目子目录不受影响）
  return /^\d+(?:\\|\/|$)/.test(p.slice(root.length + 1)) ? SANDBOX_ROOT : null
}

// —— 桌面版：消息队列 → Map<conversationId, {text, updatedAt}>（进程内缓存一次） ——
let queueCache = null
function queueMessages() {
  if (queueCache) return queueCache
  queueCache = new Map()
  try {
    const dir = path.join(DESKTOP_DIR, 'message-queue')
    if (fs.existsSync(dir)) {
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.json')) continue
        let j
        try { j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) } catch { continue }
        const convs = j && j.conversations
        if (!convs || typeof convs !== 'object') continue
        for (const cid of Object.keys(convs)) {
          const items = Array.isArray(convs[cid] && convs[cid].items) ? convs[cid].items : []
          for (const it of items) {
            const text = (Array.isArray(it && it.contentBlocks) ? it.contentBlocks : [])
              .map((b) => (b && b.type === 'text' && typeof b.text === 'string' ? b.text : ''))
              .filter(Boolean).join('\n').trim()
            if (text && !queueCache.has(cid)) queueCache.set(cid, { text, updatedAt: convs[cid].updatedAt || null })
          }
        }
      }
    }
  } catch { /* 队列不可读时忽略 */ }
  return queueCache
}

// —— 桌面版：conversationId → {b64, cwd}（edit-sessions 入口反查项目，进程内缓存一次） ——
let cwdMapCache = null
function convCwdMap() {
  if (cwdMapCache) return cwdMapCache
  cwdMapCache = new Map()
  try {
    const gh = path.join(DESKTOP_DIR, 'genie-history')
    if (fs.existsSync(gh)) {
      for (const b64 of fs.readdirSync(gh)) {
        const cwd = decodeCwd(b64)
        const convDir = path.join(gh, b64, 'conversations')
        if (!cwd || !fs.existsSync(convDir)) continue
        for (const conv of fs.readdirSync(convDir)) {
          if (!cwdMapCache.has(conv)) cwdMapCache.set(conv, { b64, cwd })
        }
      }
    }
  } catch { /* 忽略 */ }
  return cwdMapCache
}

// —— 桌面版：聚合单个会话的本地元数据（conversations 目录 / edit-sessions 两路触发，产出一致 → 幂等覆盖） ——
function resolveDesktop(convId, b64, triggerFile) {
  if (!convId || !/^[0-9a-f]{16,}$/i.test(convId)) return null
  const gh = path.join(DESKTOP_DIR, 'genie-history')
  const hit = b64 ? { b64, cwd: decodeCwd(b64) } : convCwdMap().get(convId)
  if (!hit || !hit.cwd) return null
  const convDir = path.join(gh, hit.b64, 'conversations', convId)
  const esFile = path.join(DESKTOP_DIR, 'edit-sessions', convId + '.json')

  let createdAt = null
  let updatedAt = null
  let filesChanged = []
  try {
    const st = fs.statSync(convDir)
    createdAt = st.birthtimeMs || st.ctimeMs || st.mtimeMs
    updatedAt = st.mtimeMs
  } catch { /* 目录可能已被清理，靠 edit-sessions/队列时间兜底 */ }
  try {
    if (fs.existsSync(esFile)) {
      const es = JSON.parse(fs.readFileSync(esFile, 'utf8'))
      if (es && typeof es === 'object') {
        if (typeof es.createdAt === 'number') createdAt = createdAt == null ? es.createdAt : Math.min(createdAt, es.createdAt)
        if (typeof es.updatedAt === 'number') updatedAt = Math.max(updatedAt || 0, es.updatedAt)
        filesChanged = es.fileDiffs && typeof es.fileDiffs === 'object' ? Object.keys(es.fileDiffs) : []
      }
    }
  } catch { /* edit-sessions 损坏时忽略 */ }
  try {
    // 当前会话指针给出更精确的 lastUpdated
    const cj = JSON.parse(fs.readFileSync(path.join(gh, hit.b64, 'current.json'), 'utf8'))
    if (cj && cj.conversationId === convId && typeof cj.lastUpdated === 'string') {
      const t = Date.parse(cj.lastUpdated)
      if (!Number.isNaN(t)) updatedAt = Math.max(updatedAt || 0, t)
    }
  } catch { /* 指针缺失时忽略 */ }
  if (updatedAt == null) return null

  // 队列残留的真实用户消息 → 唯一轮次（正文全在云端，本地尽力而为）；无消息则 turns=[]（纯元数据会话）
  const q = queueMessages().get(convId) || null
  const turns = []
  if (q && q.text) {
    turns.push({
      seq: 0,
      userMessage: q.text,
      assistantMessage: null,
      thinking: null,
      toolInput: null,
      filesChanged,
      timestamp: updatedAt,
      subject: classifyPurpose(q.text, []),
    })
  }
  const nonEmpty = turns.filter((t) => t.userMessage || t.assistantMessage || t.thinking)

  // 标题：队列残留消息 > 文件变更（fileDiffs 文件名信息化）> 会话 ID 兜底
  const firstFile = filesChanged.length ? path.basename(String(filesChanged[0]).replace(/\\/g, '/')) : null
  const title = q && q.text
    ? q.text.replace(/\s+/g, ' ').slice(0, 80)
    : firstFile
      ? `修改 ${firstFile}${filesChanged.length > 1 ? ` 等 ${filesChanged.length} 个文件` : ''}`
      : `CodeBuddy 会话 ${convId.slice(0, 8)}`

  // 沙箱目录归并到 CodeBuddy 根项目（真实路径留在会话 cwd 与备注）
  const sandbox = sandboxRootOf(hit.cwd)

  return {
    session: {
      agentSessionId: convId,
      cwd: hit.cwd,
      title,
      model: null,
      createdAt: createdAt || updatedAt,
      updatedAt,
      sourceFile: b64 ? convDir : esFile,
      meta: {
        note: 'CodeBuddy 桌面版会话：正文存于云端，本地仅索引会话与文件变更'
          + (filesChanged.length ? `（${filesChanged.length} 个文件变更）` : '')
          + (sandbox ? `，沙箱目录 ${hit.cwd}` : ''),
      },
    },
    project: { cwd: sandbox || hit.cwd, name: path.basename(sandbox || hit.cwd) || sandbox || hit.cwd },
    turns: nonEmpty,
    subjects: buildSubjects(nonEmpty),
  }
}

// 列出源文件（增量扫描用）：CLI jsonl + 桌面版会话目录 + edit-sessions（两路触发同一会话聚合）
function sources(sourceDir) {
  const out = findJsonlFiles(sourceDir || PROJECTS_DIR)
  try {
    const gh = path.join(DESKTOP_DIR, 'genie-history')
    if (fs.existsSync(gh)) {
      for (const b64 of fs.readdirSync(gh)) {
        const convDir = path.join(gh, b64, 'conversations')
        if (!fs.existsSync(convDir)) continue
        for (const conv of fs.readdirSync(convDir)) {
          const p = path.join(convDir, conv)
          try { if (fs.statSync(p).isDirectory()) out.push(p) } catch { /* 跳过 */ }
        }
      }
    }
    const es = path.join(DESKTOP_DIR, 'edit-sessions')
    if (fs.existsSync(es)) {
      for (const f of fs.readdirSync(es)) {
        if (f.endsWith('.json')) out.push(path.join(es, f))
      }
    }
  } catch { /* 桌面版数据缺失/不可读时忽略 */ }
  return out
}

// 解析单个源文件：按路径特征分流 CLI 转写 / 桌面版会话
function parseFile(file) {
  const norm = String(file).replace(/\\/g, '/')
  if (norm.includes('/genie-history/') && norm.includes('/conversations/')) {
    return resolveDesktop(path.basename(file), path.basename(path.dirname(path.dirname(file))), file)
  }
  if (norm.includes('/edit-sessions/') && norm.endsWith('.json')) {
    return resolveDesktop(path.basename(file, '.json'), null, file)
  }
  return parseTranscript(file)
}

// 扫描全部源（projects jsonl + 桌面版），返回 { session, project, turns, subjects } 数组
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

// 解析单个 CLI jsonl 文件为一个 UnifiedSession
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
  const seenCalls = new Set() // function_call 去重

  for (const line of lines) {
    let m
    try { m = JSON.parse(line) } catch { continue }
    if (!m || typeof m !== 'object') continue

    const ts = parseTs(m.timestamp)
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

module.exports = { scan, sources, parseFile, id: 'codebuddy', label: 'CodeBuddy', sourceDir: PROJECTS_DIR, sourceFormat: 'jsonl/codebuddy-transcript+desktop-metadata' }
