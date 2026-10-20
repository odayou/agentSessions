'use strict'
// CodeBuddy 桌面版（IDE）会话正文读取（阶段 2）。
// 侦察修正（2026-10-20）：桌面版新版把会话消息明文落本地，无需 state.vscdb/DPAPI 与云端 API 逆向——
//   %LOCALAPPDATA%\CodeBuddyExtension\Data\<uid>\CodeBuddyIDE\<uid>\history\<md5(win 反斜杠 cwd)>\<convId>\messages\<msgId>.json
//   消息文件：{role:'user'|'assistant'|'tool', message:'<JSON 串>', id, references?, extra:'<JSON 串>', createdAt:ISO}
//   message.content 块类型：user:text / assistant:reasoning|text|tool-call{toolCallId,toolName,args} / tool:tool-result
//   history\<hash>\index.json：{conversations:[{id,type,name,createdAt,lastMessageAt}],current}；hash=md5(反斜杠 cwd)
//   convId（32 hex）与 genie-history 元数据目录同空间（实测 19/19 重叠）→ 适配器按同 agentSessionId 合并升级
// 隐私：仅读本机文件，不上传；tool-result 块（单条可达百 KB）不落库。

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { classifyPurpose } = require('./purpose')

// 多账号枚举：Data/<uid>/CodeBuddyIDE/<uid>/history（uid 取自目录结构，不依赖登录态——凭据过期正文照样可读）
function desktopHistoryRoots() {
  const out = []
  try {
    const dataDir = path.join(os.homedir(), 'AppData', 'Local', 'CodeBuddyExtension', 'Data')
    if (!fs.existsSync(dataDir)) return out
    for (const uid of fs.readdirSync(dataDir)) {
      const h = path.join(dataDir, uid, 'CodeBuddyIDE', uid, 'history')
      try { if (fs.statSync(h).isDirectory()) out.push(h) } catch { /* 跳过非目录/无权限 */ }
    }
  } catch { /* 桌面版未安装时静默 */ }
  return out
}

// 会话清单：[{convId, msgDir, name, type, createdAt, lastMessageAt, hasMessages}]
function listConversations() {
  const out = []
  for (const root of desktopHistoryRoots()) {
    for (const hash of safeReaddir(root)) {
      const hd = path.join(root, hash)
      let idx = null
      try { idx = JSON.parse(fs.readFileSync(path.join(hd, 'index.json'), 'utf8')) } catch { continue }
      const convs = idx && Array.isArray(idx.conversations) ? idx.conversations : []
      for (const c of convs) {
        if (!c || typeof c.id !== 'string') continue
        const msgDir = path.join(hd, c.id, 'messages')
        let hasMessages = false
        try { hasMessages = fs.statSync(msgDir).isDirectory() && fs.readdirSync(msgDir).some((f) => f.endsWith('.json')) } catch { /* 无消息目录 */ }
        out.push({
          convId: c.id,
          msgDir,
          name: typeof c.name === 'string' ? c.name : '',
          type: c.type || null,
          createdAt: parseIso(c.createdAt),
          lastMessageAt: parseIso(c.lastMessageAt),
          hasMessages,
        })
      }
    }
  }
  return out
}

function safeReaddir(dir) {
  try { return fs.readdirSync(dir).filter((n) => { try { return fs.statSync(path.join(dir, n)).isDirectory() } catch { return false } }) } catch { return [] }
}

function parseIso(v) {
  if (typeof v !== 'string') return null
  const t = Date.parse(v)
  return Number.isNaN(t) ? null : t
}

// 解析单个消息文件 → {role, blocks, ts, model}；message/extra 均为 JSON 串需二次解析
function parseMessageFile(file) {
  let j
  try { j = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
  if (!j || typeof j !== 'object' || typeof j.role !== 'string') return null
  let msg = null
  try { msg = JSON.parse(j.message) } catch { return null }
  const blocks = Array.isArray(msg && msg.content) ? msg.content.filter((b) => b && typeof b === 'object') : []
  let model = null
  try { const ex = JSON.parse(j.extra); if (ex && typeof ex.modelName === 'string' && ex.modelName) model = ex.modelName } catch { /* extra 缺失不致命 */ }
  return { role: j.role, blocks, ts: parseIso(j.createdAt), model }
}

// 块 → 文本（text 形态；reasoning/tool-call 走专用提取）
function blockText(b) {
  return b && (b.type === 'text') && typeof b.text === 'string' ? b.text : ''
}

// 用户消息剥壳：桌面版把 <user_info>/<additional_data>（环境/记忆注入）拼在正文前，
// 真实指令在 <user_query> 块里（可能不在开头）。优先取 user_query；否则剥掉开头的注入块；全包装时保留原文。
function unwrapUserMessage(text) {
  const qm = text.match(/<user_query>([\s\S]*?)<\/user_query>/)
  if (qm && qm[1].trim()) return qm[1].trim()
  let t = text
  let prev = null
  while (prev !== t) {
    prev = t
    t = t.replace(/^<(user_info|additional_data|environment_details|context)>([\s\S]*?)<\/\1>\s*/i, '')
  }
  return t.trim() || text.trim()
}

// 消息序列 → turns：user 开轮，assistant 归轮（reasoning→thinking/text→assistantMessage/tool-call→toolInput）；tool 角色为结果回执不落库
function buildTurns(messages) {
  const ms = messages.slice().sort((a, b) => ((a.ts || 0) - (b.ts || 0)) || String(a.id || '').localeCompare(String(b.id || '')))
  const turns = []
  let cur = null
  for (const m of ms) {
    if (m.role === 'user') {
      const text = unwrapUserMessage(m.blocks.map(blockText).filter(Boolean).join('\n'))
      if (!text) continue
      cur = {
        seq: turns.length,
        userMessage: text,
        assistantMessage: null,
        thinking: null,
        toolInput: null,
        filesChanged: [],
        timestamp: m.ts,
        subject: classifyPurpose(text, []),
      }
      turns.push(cur)
      continue
    }
    if (m.role !== 'assistant' || !cur) continue
    for (const b of m.blocks) {
      if (b.type === 'reasoning' && typeof b.text === 'string' && b.text) {
        cur.thinking = cur.thinking ? cur.thinking + '\n' + b.text : b.text
      } else if (b.type === 'text' && typeof b.text === 'string' && b.text) {
        cur.assistantMessage = cur.assistantMessage ? cur.assistantMessage + '\n' + b.text : b.text
      } else if (b.type === 'tool-call') {
        const input = b.args != null ? (typeof b.args === 'string' ? b.args : JSON.stringify(b.args)) : ''
        const entry = JSON.stringify({ name: b.toolName || 'tool', input: (input || '').slice(0, 8000) })
        cur.toolInput = cur.toolInput ? cur.toolInput + '\n' + entry : entry
        for (const k of ['file_path', 'path']) {
          if (b.args && typeof b.args === 'object' && typeof b.args[k] === 'string' && !cur.filesChanged.includes(b.args[k])) {
            cur.filesChanged.push(b.args[k])
          }
        }
      }
    }
  }
  return turns.filter((t) => t.userMessage || t.assistantMessage || t.thinking)
}

// 会话级 model：取消息里出现最多的 modelName（Auto 为自动路由非真实模型，有其他候选时排除）
function sessionModelOf(messages) {
  const count = new Map()
  for (const m of messages) if (m.model) count.set(m.model, (count.get(m.model) || 0) + 1)
  const real = [...count].filter(([k]) => k.toLowerCase() !== 'auto')
  const pool = real.length ? real : [...count]
  pool.sort((a, b) => b[1] - a[1])
  return pool.length ? pool[0][0] : null
}

// 读一个会话的全部消息
function readMessages(msgDir) {
  const out = []
  let files = []
  try { files = fs.readdirSync(msgDir).filter((f) => f.endsWith('.json')) } catch { return out }
  for (const f of files) {
    const m = parseMessageFile(path.join(msgDir, f))
    if (m) out.push(m)
  }
  return out
}

// 组装 UnifiedSession item：cwd 由适配器从 genie-history 元数据反查提供（hash=md5 不可逆）
// 返回 null = 无正文/无归属（纯元数据会话走适配器原有 genie-history 路径）
function buildSessionItem(conv, cwd, sandboxRootOf) {
  if (!cwd) return null
  const messages = readMessages(conv.msgDir)
  if (!messages.length) return null
  const turns = buildTurns(messages)
  if (!turns.length) return null

  const first = turns[0]
  const title = conv.name.trim()
    || first.userMessage.replace(/\s+/g, ' ').slice(0, 80)
    || `CodeBuddy 会话 ${conv.convId.slice(0, 8)}`
  const ts = messages.map((m) => m.ts).filter(Boolean)
  const sandbox = sandboxRootOf ? sandboxRootOf(cwd) : null

  return {
    session: {
      agentSessionId: conv.convId,
      cwd,
      title,
      model: sessionModelOf(messages),
      createdAt: conv.createdAt || ts[0] || null,
      updatedAt: conv.lastMessageAt || ts[ts.length - 1] || conv.createdAt || null,
      sourceFile: conv.msgDir,
      meta: { note: 'CodeBuddy 桌面版会话（本地消息全文' + (sandbox ? `，沙箱目录 ${cwd}` : '') + '）' },
    },
    project: { cwd: sandbox || cwd, name: path.basename(sandbox || cwd) || cwd },
    turns,
    subjects: null, // 由适配器统一 buildSubjects（依赖 adapters/lib）
  }
}

// 单会话元信息（按 hashDir+convId 直读 index.json，供适配器解析单源时免全量枚举）
function convMetaOf(hashDir, convId) {
  try {
    const idx = JSON.parse(fs.readFileSync(path.join(hashDir, 'index.json'), 'utf8'))
    const c = (idx && Array.isArray(idx.conversations) ? idx.conversations : []).find((x) => x && x.id === convId)
    if (!c) return null
    const msgDir = path.join(hashDir, convId, 'messages')
    let hasMessages = false
    try { hasMessages = fs.statSync(msgDir).isDirectory() && fs.readdirSync(msgDir).some((f) => f.endsWith('.json')) } catch { /* 无消息 */ }
    return {
      convId,
      msgDir,
      name: typeof c.name === 'string' ? c.name : '',
      type: c.type || null,
      createdAt: parseIso(c.createdAt),
      lastMessageAt: parseIso(c.lastMessageAt),
      hasMessages,
    }
  } catch { return null }
}

module.exports = { desktopHistoryRoots, listConversations, convMetaOf, readMessages, buildSessionItem, buildTurns }
