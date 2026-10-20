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
const cli = require('../src/codebuddy-cli')
const cloud = require('../src/codebuddy-cloud')

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

// —— 内容块解析助手（CLI jsonl transcript 用，与 workbuddy.js 同一格式族） ——
function parseBlock(b) {
  if (!b || typeof b !== 'object') return ''
  if (b.type === 'text' || b.type === 'input_text' || b.type === 'output_text') return String(b.text || '')
  return ''
}

function parseToolUse(b) {
  try {
    const input = typeof b.input === 'string' ? b.input : (b.input != null ? JSON.stringify(b.input) : '')
    return { name: b.name || 'tool', input: (input || '').slice(0, 8000), output: undefined }
  } catch { return null }
}

function parseThinking(b) {
  return typeof b.thinking === 'string' ? b.thinking : String(b.thinking || '')
}

// 列出源文件（增量扫描用）：CLI jsonl + 桌面版会话目录 + edit-sessions + 桌面版本地消息目录。
// 单写者原则：有本地消息正文的会话由 messages 目录独家产出，其 genie-history 占位目录与
// edit-sessions 不再作为源——upsert 冲突分支后写者胜，元数据空轮次会覆盖已升级的正文轮次。
function sources(sourceDir) {
  const out = findJsonlFiles(sourceDir || PROJECTS_DIR)
  try {
    // 桌面版本地消息（正文全文）：messages 目录为源（目录指纹捕获新增消息；消息文件一次性写入不回改）
    const fullConvs = new Set()
    for (const c of cloud.listConversations()) {
      if (c.hasMessages) { fullConvs.add(c.convId); out.push(c.msgDir) }
    }
    const gh = path.join(DESKTOP_DIR, 'genie-history')
    if (fs.existsSync(gh)) {
      for (const b64 of fs.readdirSync(gh)) {
        const convDir = path.join(gh, b64, 'conversations')
        if (!fs.existsSync(convDir)) continue
        for (const conv of fs.readdirSync(convDir)) {
          if (fullConvs.has(conv)) continue // 正文通道接管
          const p = path.join(convDir, conv)
          try { if (fs.statSync(p).isDirectory()) out.push(p) } catch { /* 跳过 */ }
        }
      }
    }
    const es = path.join(DESKTOP_DIR, 'edit-sessions')
    if (fs.existsSync(es)) {
      for (const f of fs.readdirSync(es)) {
        if (f.endsWith('.json') && !fullConvs.has(f.slice(0, -5))) out.push(path.join(es, f))
      }
    }
  } catch { /* 桌面版数据缺失/不可读时忽略 */ }
  return out
}

// 解析单个源文件：按路径特征分流 CLI 转写 / 桌面版会话 / 桌面版本地消息正文
function parseFile(file) {
  const norm = String(file).replace(/\\/g, '/')
  if (norm.includes('/CodeBuddyExtension/Data/') && norm.includes('/CodeBuddyIDE/') && norm.endsWith('/messages')) {
    return parseDesktopMessages(file)
  }
  if (norm.includes('/genie-history/') && norm.includes('/conversations/')) {
    return resolveDesktop(path.basename(file), path.basename(path.dirname(path.dirname(file))), file)
  }
  if (norm.includes('/edit-sessions/') && norm.endsWith('.json')) {
    return resolveDesktop(path.basename(file, '.json'), null, file)
  }
  return parseTranscript(file)
}

// 桌面版本地消息正文：.../history/<hash>/<convId>/messages → 全量解析该会话
function parseDesktopMessages(file) {
  const convDir = path.dirname(file)
  const hashDir = path.dirname(convDir)
  const convId = path.basename(convDir)
  const hit = convCwdMap().get(convId)
  const conv = cloud.convMetaOf(hashDir, convId)
  if (!conv || !hit || !hit.cwd) return null
  const item = cloud.buildSessionItem(conv, hit.cwd, sandboxRootOf)
  if (item) item.subjects = buildSubjects(item.turns)
  return item
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

// —— 云端通道（阶段 1c）：CLI serve → sessions → replay，与文件通道并存 ——
// 增量：按库内 cloud: 源会话的 updatedAt 比对；失败静默（记 cloudState 供设置页展示），不影响文件通道

let cloudState = { ok: null, reason: null, checkedAt: null, total: 0, pulled: 0 }
function getCloudState() {
  return { ...cloudState }
}

// replay（ACP 事件流）→ turns；规则与 parseTranscript 一致：user_message_chunk 开轮，agent/工具归轮
function replayToTurns(events) {
  const evs = []
  for (const e of Array.isArray(events) ? events : []) {
    const u = e && e.update
    if (!u || typeof u !== 'object' || typeof u.sessionUpdate !== 'string') continue
    const ts = parseTs(e._meta && e._meta.timestamp)
    const blocks = Array.isArray(u.content) ? u.content : (u.content ? [u.content] : [])
    const text = blocks.map((b) => (b && (b.type === 'text' || b.type === 'input_text' || b.type === 'output_text') && typeof b.text === 'string' ? b.text : '')).filter(Boolean).join('\n')
    if (u.sessionUpdate === 'user_message_chunk') {
      if (text) evs.push({ ts, kind: 'user', text })
    } else if (u.sessionUpdate === 'agent_message_chunk') {
      if (text) evs.push({ ts, kind: 'asst', text, thinking: '', tools: [] })
    } else if (u.sessionUpdate === 'tool_call') {
      const tools = []
      if (u.rawInput != null) tools.push({ name: u.title || u.kind || 'tool', input: typeof u.rawInput === 'string' ? u.rawInput : JSON.stringify(u.rawInput) })
      const files = (Array.isArray(u.locations) ? u.locations : []).map((l) => (l && l.path) || '').filter(Boolean)
      if (tools.length || files.length) evs.push({ ts, kind: 'asst', text: '', thinking: '', tools, files })
    }
    // tool_call_update / session_info_update / available_commands_update 等不进正文
  }

  const turns = []
  let cur = null
  for (const ev of evs) {
    if (ev.kind === 'user') {
      cur = { seq: turns.length, userMessage: ev.text, assistantMessage: null, thinking: null, toolInput: null, filesChanged: [], timestamp: ev.ts, subject: null }
      turns.push(cur)
    } else if (cur) {
      if (ev.text) cur.assistantMessage = (cur.assistantMessage ? cur.assistantMessage + '\n' : '') + ev.text
      if (ev.thinking) cur.thinking = (cur.thinking ? cur.thinking + '\n' : '') + ev.thinking
      if (ev.tools && ev.tools.length) {
        const entries = ev.tools.map((t) => JSON.stringify(t)).join('\n')
        cur.toolInput = cur.toolInput ? cur.toolInput + '\n' + entries : entries
        for (const t of ev.tools) {
          try {
            const parsed = JSON.parse(t.input)
            if (parsed.file_path) cur.filesChanged.push(String(parsed.file_path))
            if (parsed.path) cur.filesChanged.push(String(parsed.path))
          } catch { /* 非 JSON 跳过 */ }
        }
      }
      if (ev.files) {
        for (const f of ev.files) if (!cur.filesChanged.includes(f)) cur.filesChanged.push(f)
      }
    }
  }
  for (const t of turns) t.subject = classifyPurpose(t.userMessage || '', [])
  return turns.filter((t) => t.userMessage || t.assistantMessage || t.thinking)
}

// history 降级：replay 失败/无正文时用 userInput + finalReply（≤500 截断）组轮
async function historyTurns(handle, s) {
  try {
    const r = await cli.api(handle, `/api/v1/sessions/${s.id}/history`, { query: { cwd: s.cwd } })
    const reqs = r && Array.isArray(r.requests) ? r.requests : []
    const turns = []
    for (const q of reqs) {
      if (!q || (!q.userInput && !q.finalReply)) continue
      turns.push({
        seq: turns.length,
        userMessage: q.userInput || null,
        assistantMessage: q.finalReply || null,
        thinking: null,
        toolInput: null,
        filesChanged: [],
        timestamp: s.updatedAt || s.createdAt || null,
        subject: classifyPurpose(q.userInput || '', []),
      })
    }
    return turns
  } catch { return [] }
}

// 云端拉取：serve → sessions?cwd=* → 增量比对库内 cloud 会话 updatedAt → replay（history 降级）→ UnifiedSession
async function scanAll(db) {
  const out = []
  cloudState = { ok: false, reason: null, checkedAt: Date.now(), total: 0, pulled: 0 }
  try {
    const st = cli.credentialState()
    if (!st.authenticated) {
      cloudState.reason = st.installed ? '授权已过期，需重新授权' : '未授权（设置页 CodeBuddy 卡片授权）'
      return out
    }
    if (!cli.resolveEntry()) {
      cloudState.reason = 'CLI 未集成（缺少 @tencent-ai/codebuddy-code）'
      return out
    }
    const handle = await cli.serve({ timeoutMs: 30000 })
    try {
      const listed = await cli.api(handle, '/api/v1/sessions', { query: { cwd: '*' } })
      const sessions = listed && Array.isArray(listed.sessions) ? listed.sessions : []
      cloudState.total = sessions.length

      // 库内已有会话 → 增量（按 agentSessionId 精确比对 updatedAt）。不依赖 source_file：
      // upsertSession 冲突分支不更新 source_file，jsonl 通道先落库同一会话时 cloud: 前缀不存在
      const known = new Map()
      const ids = sessions.map((s) => s && s.id).filter(Boolean)
      if (db && ids.length) {
        try {
          for (let i = 0; i < ids.length; i += 500) {
            const chunk = ids.slice(i, i + 500)
            const ph = chunk.map(() => '?').join(',')
            for (const r of db.prepare(`SELECT agent_session_id AS sid, updated_at FROM sessions WHERE agent_id = 'codebuddy' AND agent_session_id IN (${ph})`).all(...chunk)) {
              known.set(r.sid, r.updated_at)
            }
          }
        } catch { /* 查询异常时退化为全量拉取 */ }
      }

      for (const s of sessions) {
        if (!s || !s.id || !s.cwd) continue
        const prev = known.get(s.id)
        if (prev != null && !(typeof s.updatedAt === 'number' && s.updatedAt > prev)) continue // 未变更

        let turns = []
        try {
          const rp = await cli.api(handle, `/api/v1/sessions/${s.id}/replay`, { query: { cwd: s.cwd } })
          turns = replayToTurns(rp && rp.events)
        } catch { /* replay 失败走 history 降级 */ }
        if (!turns.length) turns = await historyTurns(handle, s)
        if (!turns.length) continue // 无正文的空壳会话（playground 等）不入库，下次扫描重试

        const sandbox = sandboxRootOf(s.cwd)
        const title = (s.name && String(s.name).trim()) || (turns[0].userMessage ? turns[0].userMessage.replace(/\s+/g, ' ').slice(0, 80) : `CodeBuddy 会话 ${s.id.slice(0, 8)}`)
        out.push({
          session: {
            agentSessionId: s.id,
            cwd: s.cwd,
            title,
            model: null,
            createdAt: s.createdAt || s.updatedAt || null,
            updatedAt: s.updatedAt || s.createdAt || null,
            sourceFile: `cloud:${s.id}`,
            meta: { note: 'CodeBuddy CLI 云端会话（serve 拉取' + (sandbox ? `，沙箱目录 ${s.cwd}` : '') + '）' },
          },
          project: { cwd: sandbox || s.cwd, name: path.basename(sandbox || s.cwd) || s.cwd },
          turns,
          subjects: buildSubjects(turns),
        })
        cloudState.pulled++
      }
    } finally {
      handle.stop()
    }
  } catch (e) {
    cloudState.reason = e.message
    return out
  }
  cloudState.ok = true
  return out
}

module.exports = { scan, sources, parseFile, scanAll, getCloudState, id: 'codebuddy', label: 'CodeBuddy', sourceDir: PROJECTS_DIR, sourceFormat: 'jsonl/codebuddy-transcript+desktop-metadata+cloud-scan' }
