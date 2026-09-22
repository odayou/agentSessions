'use strict'
// OpenCode 适配器：只读打开 ~/.local/share/opencode/opencode.db（或 ~/.config/opencode/opencode.db），
// 遍历 session → 按 project(cwd) 聚合 → 组装 UnifiedSession(Turns) → 写 AgentSessions SQLite。
// 数据结构（已实测 _probe3.py）：
//   project  表: id, worktree(=cwd), name, vcs
//   session  表: id, project_id, directory(=cwd), title, agent, model(JSON), slug, time_created
//   message  表: data(JSON) role∈{user,assistant}; assistant 带 parentID→对应用户消息、path.cwd、time.created/completed、finish
//   part     表: data(JSON) type∈{text,reasoning,tool,step-start,step-finish,patch,compaction}
//              user 消息文本=其 text part；assistant: text→正文, reasoning→思考(L4), tool→工具调用(input/output)
//   账号: 本机无登录(account/account_state rows=0) → raw_name 记为 'local'

const path = require('node:path')
const { classifyPurpose } = require('../src/purpose')
const { buildSubjects } = require('./lib')

// 取字符串：兼容对象或字符串
function str(v) {
  if (v == null) return null
  if (typeof v === 'string') return v
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

// tool part → {name, input, output}
function parseTool(d) {
  try {
    const out = { name: d.tool, input: undefined, output: undefined }
    if (d.state) {
      out.input = str(d.state.input)
      // 截断超长 output，控制库体积
      const o = str(d.state.output)
      if (o && o.length > 4000) out.output = o.slice(0, 4000) + '[...truncated]'
      else out.output = o
    }
    return out
  } catch {
    return null
  }
}

// 扫描 opencode.db，返回 { session, project, turns, subjects } 数组
function scan(dbPath) {
  const db = require('better-sqlite3')(dbPath, { readonly: true, fileMustExist: true })
  const out = []
  try {
    // 作者：以 project 维度聚合
    const sessions = db.prepare(`
      SELECT id, project_id, directory, title, agent, model, time_created, slug
      FROM session ORDER BY time_created
    `).all()

    const msgStmt = db.prepare('SELECT id, data FROM message WHERE session_id = ? ORDER BY time_created')
    const partStmt = db.prepare('SELECT message_id, data FROM part WHERE session_id = ? ORDER BY time_created')
    const projectStmt = db.prepare('SELECT id, worktree, name, vcs FROM project WHERE id = ?')

    for (const s of sessions) {
      const proj = projectStmt.get(s.project_id) || { worktree: s.directory, name: s.directory, vcs: null }
      const cwd = s.directory || proj.worktree || null
      if (!cwd) continue

      // 收集消息 + part
      const msgs = new Map() // id -> {d, parentID, role, time}
      const msgOrder = []
      for (const m of msgStmt.all(s.id)) {
        let d
        try { d = JSON.parse(m.data) } catch { continue }
        msgs.set(m.id, { id: m.id, d, parentID: d.parentID || null, role: d.role, time: d.time || {} })
        msgOrder.push(m.id)
      }
      // 每个 message 的 parts 分组
      const partsByMsg = new Map()
      for (const p of partStmt.all(s.id)) {
        let d
        try { d = JSON.parse(p.data) } catch { continue }
        if (!partsByMsg.has(p.message_id)) partsByMsg.set(p.message_id, [])
        partsByMsg.get(p.message_id).push(d)
      }

      // 组装 turns：user 消息为轮次起点；其 text part→userMessage；
      // parentID=该 user 的 assistant 消息 → assistantMessage(concat text)/thinking(concat reasoning)/toolInput(concat tool)
      const turns = []
      let seq = 0
      for (const mid of msgOrder) {
        const m = msgs.get(mid)
        if (m.role !== 'user') continue // only user starts a turn
        const parts = partsByMsg.get(mid) || []
        let userMessage = ''
        for (const p of parts) if (p.type === 'text') userMessage = (userMessage ? userMessage + '\n' : '') + (p.text || '')

        // 找对应 assistant（parentID = mid）
        let assistantMessage = ''
        let thinking = ''
        let toolInput = null
        const toolNames = []
        const filesChanged = []
        const childrenMsgs = msgOrder.map((id2) => msgs.get(id2)).filter((m2) => m2 && m2.parentID === mid)
        for (const am of childrenMsgs) {
          const aparts = partsByMsg.get(am.id) || []
          for (const p of aparts) {
            if (p.type === 'text') assistantMessage = (assistantMessage ? assistantMessage + '\n' : '') + (p.text || '')
            else if (p.type === 'reasoning') thinking = (thinking ? thinking + '\n' : '') + (p.text || '')
            else if (p.type === 'tool') {
              const t = parseTool(p)
              if (t) {
                toolNames.push(t.name)
                const entry = JSON.stringify(t)
                toolInput = toolInput ? toolInput + '\n' + entry : entry
              }
            } else if (p.type === 'patch' || p.type === 'file' || p.type === 'step-finish') {
              // step-finish/patch 里常含 filePath/file；尽力提取
              if (p.filePath) filesChanged.push(p.filePath)
              if (p.state && p.state.filePath) filesChanged.push(str(p.state.filePath))
            }
          }
        }

        // L2 主题种子：由本轮回执 classifyPurpose
        const subject = classifyPurpose(userMessage, toolNames)

        turns.push({
          seq: seq++,
          userMessage: userMessage || null,
          assistantMessage: assistantMessage || null,
          thinking: thinking || null,
          toolInput: toolInput || null,
          filesChanged: [...new Set(filesChanged.filter(Boolean))],
          timestamp: m.time.created || null,
          subject,
        })
      }

      // session.model: session.model 是 JSON {id, providerID}
      let model = s.model
      if (model && typeof model === 'string') {
        try {
          const mm = JSON.parse(model)
          model = [mm.providerID, mm.id].filter(Boolean).join('/') || null
        } catch { model = s.model }
      }

      out.push({
        session: {
          agentSessionId: s.id,
          cwd,
          title: s.title || null,
          model,
          createdAt: s.time_created || null,
          sourceFile: dbPath, // 来源库
        },
        project: { cwd, name: proj.name || path.basename(cwd) || cwd },
        turns,
        subjects: buildSubjects(turns),
      })
    }
    return out
  } finally {
    db.close()
  }
}

module.exports = { scan, id: 'opencode', label: 'OpenCode', sourceFormat: 'sqlite/opencode' }