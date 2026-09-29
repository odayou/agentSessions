'use strict'
// 通用格式引擎（agentList §6.2）：把声明式清单驱动为与硬编码适配器同构的可扫描适配器。
// 四类引擎：jsonl（逐行 JSON 记录）/ json（单文件结构 + 消息数组）/ sqlite（库直读，OpenCode 兼容
// schema）/ external（外部进程 stdin/stdout JSONL 协议）。引擎随客户端发版，新增解析器通常只需一份清单。
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const manifest = require('./manifest')
const { classifyPurpose } = require('./purpose')
const { buildSubjects, assembleTurns, mtimeMs } = require('../adapters/lib')

// —— 工具 ——
// 点路径取值：'a.b.0.c' → obj.a.b[0].c
function pathGet(obj, p) {
  if (!p || typeof p !== 'string') return undefined
  let cur = obj
  for (const k of p.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined
    cur = cur[k]
  }
  return cur
}

// 内容统一为文本：string 原样；数组递归拼接；对象取 .text
function asText(v) {
  if (typeof v === 'string') return v
  if (Array.isArray(v)) return v.map(asText).filter(Boolean).join('\n')
  if (v && typeof v === 'object') return typeof v.text === 'string' ? v.text : ''
  return v == null ? '' : String(v)
}

// 时间戳解析：数字原样（ms），字符串 Date.parse
function parseTs(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string') {
    const n = Date.parse(v)
    if (!Number.isNaN(n)) return n
  }
  return null
}

// 递归列出 root 下指定扩展名的文件（不可读目录跳过；ext 形如 ".jsonl"，大小写不敏感）
function findFilesByExt(root, ext) {
  const out = []
  const e = String(ext || '').toLowerCase()
  if (!e || !root) return out
  ;(function walk(dir) {
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const ent of entries) {
      const p = path.join(dir, ent.name)
      if (ent.isDirectory()) walk(p)
      else if (ent.isFile() && ent.name.toLowerCase().endsWith(e)) out.push(p)
    }
  })(root)
  return out
}

// 多路径取文本：text 允许单路径或路径数组（首个命中非空者生效）
function pickPaths(rec, spec) {
  for (const p of (Array.isArray(spec) ? spec : [spec])) {
    if (typeof p !== 'string') continue
    const t = asText(pathGet(rec, p))
    if (t) return t
  }
  return ''
}

// —— 事件流 → 轮次：实现移至 adapters/lib.js（assembleTurns，供引擎与硬编码适配器共用）——

// 轮次收尾公共步骤：主题归类（L2 种子）→ 剔除空轮 → subjects
function finalizeTurns(turns) {
  for (const t of turns) t.subject = classifyPurpose(t.userMessage || '', [])
  const nonEmpty = turns.filter((t) => t.userMessage || t.assistantMessage || t.thinking)
  return { nonEmpty, subjects: buildSubjects(nonEmpty) }
}

// —— 记录引擎（jsonl / json 共用）：清单 rules 把记录流转为统一事件流 ——
// 清单字段：source{root,ext,cwdFromPath} + session{id,cwd,model,title,ts,messagesPath} + rules[]
function recordAdapter(m) {
  const root = manifest.resolveRoot(m.source.root)
  const ext = m.source.ext || (m.engine === 'jsonl' ? '.jsonl' : '.json')
  const cwdFromPath = !!(m.source && m.source.cwdFromPath)

  // 列出源文件（增量扫描用；scan.js 会传 agentPaths 手动目录覆盖）
  function sources(dir) { return findFilesByExt(dir || root, ext) }

  // 解析单个源文件为一个 UnifiedSession（增量扫描用）
  function parseFile(file) {
    let doc = null
    let records
    try {
      const raw = fs.readFileSync(file, 'utf8')
      if (m.engine === 'jsonl') {
        records = raw.split('\n').map((l) => l.trim()).filter(Boolean)
          .map((l) => { try { return JSON.parse(l) } catch { return null } })
          .filter((x) => x && typeof x === 'object')
      } else {
        doc = JSON.parse(raw)
        const arr = pathGet(doc, m.session.messagesPath)
        records = Array.isArray(arr) ? arr.filter((x) => x && typeof x === 'object') : []
      }
    } catch { return null }

    // 会话级字段查找域：json 引擎优先取文档根字段（如 workspaceDirectory），再回落到消息记录
    const scope = (m.engine === 'json' && doc && typeof doc === 'object') ? [doc, ...records] : records
    const fieldOf = (key) => {
      const p = m.session && m.session[key]
      if (!p) return null
      for (const s of scope) {
        const v = pathGet(s, p)
        if (v != null && v !== '') return typeof v === 'string' ? v : String(v)
      }
      return null
    }

    const events = []
    let title = null
    for (const rec of records) {
      const ts = m.session && m.session.ts ? parseTs(pathGet(rec, m.session.ts)) : null
      for (const rule of m.rules) {
        // when 全字段匹配（字符串化比较，兼容数字/字符串差异）
        if (rule.when) {
          let hit = true
          for (const [k, want] of Object.entries(rule.when)) {
            if (String(pathGet(rec, k)) !== String(want)) { hit = false; break }
          }
          if (!hit) continue
        }
        if (rule.role === 'user' || rule.role === 'assistant') {
          const text = pickPaths(rec, rule.text)
          if (text) events.push({ ts, kind: rule.role, text, thinking: '', tools: [] })
        } else if (rule.role === 'thinking') {
          const t = pickPaths(rec, rule.text)
          if (t) events.push({ ts, kind: 'asst', text: '', thinking: t, tools: [] })
        } else if (rule.role === 'tool') {
          const name = String(pathGet(rec, rule.name) || 'tool')
          let input = pathGet(rec, rule.input)
          if (input != null && typeof input !== 'string') { try { input = JSON.stringify(input) } catch { input = String(input) } }
          events.push({ ts, kind: 'asst', text: '', thinking: '', tools: [{ name, input: String(input || '').slice(0, 8000) }] })
        } else if (rule.role === 'title') {
          const t = pickPaths(rec, rule.text)
          if (t) title = t
        }
        break // 一条记录至多被一条规则消费，避免二次归类
      }
    }

    // cwd 回退链：记录字段 → cwdFromPath（root 下第一段目录名）→ 文件所在目录
    const sessionId = fieldOf('id')
    let cwd = fieldOf('cwd')
    if (!cwd && cwdFromPath) {
      const seg = path.relative(root, file).split(path.sep)[0]
      if (seg && seg !== '..') cwd = seg
    }
    if (!cwd) cwd = path.dirname(file)

    const { nonEmpty, subjects } = finalizeTurns(assembleTurns(events))
    if (!nonEmpty.length) return null

    // 时间：事件时间戳优先，缺省回落文件 mtime
    let mtimeMs = null
    try { mtimeMs = Math.round(fs.statSync(file).mtimeMs) } catch { /* 忽略 */ }
    const evTs = events.map((e) => e.ts).filter((t) => Number.isFinite(t))
    const createdAt = evTs.length ? Math.min(...evTs) : mtimeMs
    const updatedAt = evTs.length ? Math.max(...evTs) : mtimeMs

    return {
      session: {
        agentSessionId: sessionId || path.basename(file, ext),
        cwd,
        // 标题：清单 session.title 字段（json 引擎的文档根标题）→ title 规则 → 首条用户消息
        title: fieldOf('title') || title || (nonEmpty[0].userMessage ? nonEmpty[0].userMessage.replace(/\s+/g, ' ').slice(0, 80) : null),
        model: fieldOf('model'),
        createdAt,
        updatedAt: updatedAt || createdAt,
        sourceFile: file,
      },
      project: { cwd, name: path.basename(cwd) || cwd },
      turns: nonEmpty,
      subjects,
    }
  }

  return { id: m.id, label: m.label, sourceFormat: m.sourceFormat || m.engine, sources, parseFile, sourceDir: root }
}

// —— SQLite 引擎（OpenCode 兼容 schema，只读直读）——
// 清单字段：sqlite{candidates,session{table,id,cwd,title,model,createdAt,updatedAt},
//   message{table,id,sessionId,data,time},part{table,messageId,data,textTypes,thinkTypes,toolTypes}}
function sqliteAdapter(m) {
  const conf = m.sqlite
  const TEXT_TYPES = conf.part && Array.isArray(conf.part.textTypes) ? conf.part.textTypes : ['text']
  const THINK_TYPES = conf.part && Array.isArray(conf.part.thinkTypes) ? conf.part.thinkTypes : ['reasoning']
  const TOOL_TYPES = conf.part && Array.isArray(conf.part.toolTypes) ? conf.part.toolTypes : ['tool']

  // 扫描整个库（scan.js 的 dbCandidates 分支一次性调用；库文件指纹由 scan.js 记录）
  function scan(dbFile) {
    let Database
    try { Database = require('better-sqlite3') } catch { throw new Error('better-sqlite3 不可用') }
    const db = new Database(dbFile, { readonly: true, fileMustExist: true })
    const out = []
    try {
      // message 行键：清单声明主键列则用之，否则用 rowid（part 表经 part.messageId 关联）
      const msgSql = conf.message.id
        ? `SELECT "${conf.message.id}" AS __mid, * FROM "${conf.message.table}" WHERE "${conf.message.sessionId}" = ? ORDER BY rowid`
        : `SELECT rowid AS __mid, * FROM "${conf.message.table}" WHERE "${conf.message.sessionId}" = ? ORDER BY rowid`
      const msgStmt = db.prepare(msgSql)
      const partStmt = conf.part
        ? db.prepare(`SELECT * FROM "${conf.part.table}" WHERE "${conf.part.messageId}" = ? ORDER BY rowid`)
        : null

      // 镜像会话登记表（agentList §2.19 镜像过滤）：表中登记的会话不计入，避免与源工具重复索引；
      // 登记表缺失（版本差异）静默跳过
      const mirrorIds = new Set()
      for (const mt of (Array.isArray(conf.mirrorTables) ? conf.mirrorTables : [])) {
        try {
          const has = db.prepare('SELECT name FROM sqlite_master WHERE type=\'table\' AND name=?').get(mt.table)
          if (!has) continue
          for (const row of db.prepare(`SELECT "${mt.column}" AS mid FROM "${mt.table}"`).all()) {
            if (row.mid != null && row.mid !== '') mirrorIds.add(String(row.mid))
          }
        } catch { /* 登记表不可读：不排除任何会话 */ }
      }

      for (const s of db.prepare(`SELECT * FROM "${conf.session.table}"`).all()) {
        const sid = s[conf.session.id] != null ? String(s[conf.session.id]) : ''
        const cwd = s[conf.session.cwd] != null ? String(s[conf.session.cwd]) : ''
        if (!sid || !cwd) continue
        if (mirrorIds.size && mirrorIds.has(sid)) continue // 镜像登记（如 MiMo 的 claude_import/external_import）不计入，避免重复索引

        const events = []
        for (const row of msgStmt.all(sid)) {
          let data = {}
          try { data = JSON.parse(row[conf.message.data] || '{}') } catch { /* 空对象 */ }
          const role = String(data.role || '')
          const tsRaw = conf.message.time ? row[conf.message.time] : (data.time && data.time.created)
          const ts = parseTs(tsRaw != null ? tsRaw : (data.time && data.time.created))

          let text = ''
          let thinking = ''
          const tools = []
          if (partStmt) {
            for (const p of partStmt.all(row.__mid)) {
              let pd
              try { pd = JSON.parse(p[conf.part.data] || '{}') } catch { continue }
              const type = String(pd.type || '')
              if (TEXT_TYPES.includes(type)) text = (text ? text + '\n' : '') + String(pd.text || '')
              else if (THINK_TYPES.includes(type)) thinking = (thinking ? thinking + '\n' : '') + String(pd.text || '')
              else if (TOOL_TYPES.includes(type)) {
                let input = pd.state ? pd.state.input : pd.input
                if (input != null && typeof input !== 'string') { try { input = JSON.stringify(input) } catch { /* 保留原值 */ } }
                tools.push({ name: String(pd.tool || pd.name || 'tool'), input: String(input || '').slice(0, 8000) })
              }
            }
          } else {
            text = asText(data.content)
          }
          if (role === 'user' && text) events.push({ ts, kind: 'user', text, thinking: '', tools: [] })
          else if (role === 'assistant' && (text || thinking || tools.length)) events.push({ ts, kind: 'asst', text, thinking, tools })
        }

        const turns = assembleTurns(events)
        if (!turns.length) continue
        for (const t of turns) t.subject = classifyPurpose(t.userMessage || '', [])

        const model0 = conf.session.model && s[conf.session.model] != null ? String(s[conf.session.model]) : null
        out.push({
          session: {
            agentSessionId: sid,
            cwd,
            title: conf.session.title && s[conf.session.title] != null ? String(s[conf.session.title]) : null,
            model: model0,
            createdAt: conf.session.createdAt ? parseTs(s[conf.session.createdAt]) : null,
            updatedAt: conf.session.updatedAt ? parseTs(s[conf.session.updatedAt]) : null,
            sourceFile: dbFile,
          },
          project: { cwd, name: path.basename(cwd) || cwd },
          turns,
          subjects: buildSubjects(turns),
        })
      }
      return out
    } finally {
      db.close()
    }
  }

  return { id: m.id, label: m.label, sourceFormat: m.sourceFormat || 'sqlite', scan }
}

// —— 外部进程引擎：stdin 收 {"op":"scan"}，stdout 逐行 {"item":UnifiedSession}（agentList §6.2 协议）——
// 执行约束：只读约定、超时（默认 15s）、输出限额（默认 20MB）、隐藏窗口
function externalAdapter(m) {
  function scanAll() {
    const r = spawnSync(m.command, m.args || [], {
      input: JSON.stringify({ op: 'scan' }) + '\n',
      encoding: 'utf8',
      timeout: m.timeoutMs || 15000,
      maxBuffer: (m.maxOutputMB || 20) * 1024 * 1024,
      windowsHide: true,
      shell: process.platform === 'win32', // Windows 下 .cmd/.bat shim 需要 shell
    })
    if (r.error) throw r.error
    if (!r.stdout || !String(r.stdout).trim()) {
      throw new Error(`外部适配器无输出（退出码 ${r.status}）${r.stderr ? '：' + String(r.stderr).slice(0, 200) : ''}`)
    }
    const items = []
    for (const line of String(r.stdout).split('\n')) {
      const l = line.trim()
      if (!l) continue
      try {
        const o = JSON.parse(l)
        if (o && o.item) items.push(o.item)
      } catch { /* 非 JSON 行忽略 */ }
    }
    return items
  }
  return { id: m.id, label: m.label, sourceFormat: m.sourceFormat || 'external', scanAll }
}

// —— Markdown 分段引擎（第五引擎，agentList §6.2）：聊天历史型 Markdown → 会话 ——
// 清单字段：source{fileName,root?} + markdown{runHeading?,headingLevel?,roleHeadings?,
//   ignoreHeadings?,filters?}。行为（经 Aider 真实格式沉淀，2026-09）：
//   - sources：按 fileName 精确文件名递归枚举（防止其他 .md 误触发），入参可为文件本身
//   - runHeading 命中行 = 一次运行 = 一个会话（单文件多运行 → 多会话）；无 runHeading 则整文件一会话
//   - headingLevel 级标题为消息边界：文本命中 roleHeadings.user → 用户模式、assistant → 助手模式、
//     ignoreHeadings（如 system/空标题）忽略；其余标题视为「旧式排版」——标题文本即用户消息，其后纯文本为助手回复
//   - filters 正则命中的行剔除（成本统计等噪音）
//   - cwd = 文件所在目录（此类日志天然位于项目/仓库根）；时间取 runHeading 捕获组，缺省回落文件 mtime
function markdownAdapter(m) {
  const conf = m.markdown || {}
  const fileName = m.source && typeof m.source.fileName === 'string' && m.source.fileName ? m.source.fileName : '.md'
  const level = Number.isInteger(conf.headingLevel) && conf.headingLevel > 0 ? conf.headingLevel : 4
  const headRe = new RegExp(`^#{${level}}\\s?(.*)$`)
  const runRe = conf.runHeading ? new RegExp(conf.runHeading) : null
  const roles = conf.roleHeadings && typeof conf.roleHeadings === 'object' ? conf.roleHeadings : {}
  const userRole = String(roles.user || 'user').toLowerCase()
  const asstRole = String(roles.assistant || 'assistant').toLowerCase()
  const ignores = new Set((Array.isArray(conf.ignoreHeadings) ? conf.ignoreHeadings : ['system']).map((x) => String(x).toLowerCase()))
  const filters = (Array.isArray(conf.filters) ? conf.filters : []).map((x) => new RegExp(x))
  const root = m.source && m.source.root ? manifest.resolveRoot(m.source.root) : null

  function sources(dir) {
    const d = dir || root
    if (!d) return []
    let st = null
    try { st = fs.statSync(d) } catch { return [] }
    if (st.isFile()) return path.basename(d) === fileName ? [d] : []
    const out = []
    ;(function walk(dd) {
      let entries
      try { entries = fs.readdirSync(dd, { withFileTypes: true }) } catch { return }
      for (const ent of entries) {
        const p = path.join(dd, ent.name)
        if (ent.isDirectory()) walk(p)
        else if (ent.isFile() && ent.name === fileName) out.push(p)
      }
    })(d)
    return out
  }

  // 标题行分流 → 事件流：模式间文本归属当前模式（旧式排版：标题即用户消息）
  function runEvents(lines, ts) {
    const events = []
    let mode = 'asst'
    let buf = []
    const flush = () => {
      const text = buf.join('\n').trim()
      buf = []
      if (text) events.push({ ts, kind: mode === 'user' ? 'user' : 'asst', text, thinking: '', tools: [] })
    }
    for (const raw of lines) {
      const h = headRe.exec(raw)
      if (h) {
        flush()
        const head = h[1].trim()
        const low = head.toLowerCase()
        if (low === userRole) mode = 'user'
        else if (low === asstRole) mode = 'asst'
        else if (ignores.has(low) || !head) mode = 'asst'
        else { mode = 'asst'; events.push({ ts, kind: 'user', text: head, thinking: '', tools: [] }) } // 旧式
        continue
      }
      if (filters.some((r) => r.test(raw.trim()))) continue
      buf.push(raw)
    }
    flush()
    return events
  }

  function buildSession(file, events, ts, isLast, index, multiRun) {
    const { nonEmpty, subjects } = finalizeTurns(assembleTurns(events))
    if (!nonEmpty.length) return null
    const mt = mtimeMs(file)
    const createdAt = Number.isFinite(ts) ? ts : mt
    // 末次运行用文件 mtime 兜底（append-only，后续活动只反映在 mtime）
    const updatedAt = isLast && mt && (!createdAt || mt > createdAt) ? mt : createdAt
    const cwd = path.dirname(file)
    return {
      session: {
        // 会话 ID：多运行文件用「文件路径#运行序号」（append-only 序号稳定 → 增量幂等），否则文件名去扩展
        agentSessionId: multiRun ? `${file.replace(/\\/g, '/')}#${index}` : path.basename(file, path.extname(fileName)),
        cwd,
        title: nonEmpty[0].userMessage ? nonEmpty[0].userMessage.replace(/\s+/g, ' ').slice(0, 80) : null,
        model: null,
        createdAt,
        updatedAt,
        sourceFile: file,
      },
      project: { cwd, name: path.basename(cwd) || cwd },
      turns: nonEmpty,
      subjects,
    }
  }

  // 解析单个源文件：返回 UnifiedSession 或其数组（多运行文件 → 多会话）
  function parseFile(file) {
    let text
    try { text = fs.readFileSync(file, 'utf8') } catch { return null }
    const lines = text.split(/\r?\n/) // 行尾归一（项目硬约束：\r 残留会导致解析异常）
    if (!runRe) return buildSession(file, runEvents(lines, null), null, true, 0, false)
    const runs = []
    for (const line of lines) {
      const mm = runRe.exec(line.trim())
      if (mm) runs.push({ ts: parseTs(mm[1] ? String(mm[1]).trim() : null), lines: [] })
      else if (runs.length) runs[runs.length - 1].lines.push(line)
    }
    if (!runs.length) return null
    const out = []
    for (let i = 0; i < runs.length; i++) {
      const s = buildSession(file, runEvents(runs[i].lines, runs[i].ts), runs[i].ts, i === runs.length - 1, i, true)
      if (s) out.push(s)
    }
    return out.length ? out : null
  }

  return { id: m.id, label: m.label, sourceFormat: m.sourceFormat || 'markdown', sources, parseFile, sourceDir: root }
}

// 按引擎分发为可扫描适配器（与硬编码适配器同构的接口子集）
function adapterFor(m) {
  if (m.engine === 'sqlite') return sqliteAdapter(m)
  if (m.engine === 'external') return externalAdapter(m)
  if (m.engine === 'markdown') return markdownAdapter(m)
  return recordAdapter(m) // jsonl / json
}

module.exports = { adapterFor, pathGet, asText, parseTs, findFilesByExt, assembleTurns }
