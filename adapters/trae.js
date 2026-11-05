'use strict'
// 可离线读取的是 ~/.trae-cn/memory/projects/<proj>/<date>/session_memory_<sid>.jsonl —— 逐 message
// 压缩记忆（intent / actions / outcome / learned / message_summary_time），降级为「正文」索引：
//   userMessage←intent(或原文/标题)、assistantMessage←actions+outcome、思考←learned、主题←classifyPurpose(intent)
//   项目←所在 projects/<proj> 目录路径。命中即视为「发现该活在哪」，满足 S1。
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { classifyPurpose } = require('../src/purpose')
const { findJsonlFiles, buildSubjects } = require('./lib')

const MEMORY_ROOT = path.join(os.homedir(), '.trae-cn', 'memory', 'projects')

function joinArr(a) {
  return Array.isArray(a) ? a.filter(Boolean).join('\n') : (a ? String(a) : '')
}

// 列出源文件（增量扫描用）
function sources(sourceDir) {
  return findJsonlFiles(sourceDir || MEMORY_ROOT)
}

// 解析单个源文件为一个 UnifiedSession（增量扫描用）
function parseFile(file) {
  return parseMemoryFile(file)
}

// 扫描 memory 目录，返回 { session, project, turns, subjects } 数组
// 同一会话可能按日期写成多份文件，parseFile 已按 sessionId 合并；这里按 sessionId 去重
function scan(sourceDir) {
  const out = []
  const seen = new Set()
  for (const file of sources(sourceDir)) {
    const sess = parseFile(file)
    if (!sess) continue
    const sid = sess.session.agentSessionId
    if (seen.has(sid)) continue
    seen.add(sid)
    out.push(sess)
  }
  return out
}

// 真实 sessionId 来自文件名：session_memory_<sid>.jsonl（同一天内一个会话一个文件）
function sessionIdOf(file) {
  const base = path.basename(file, '.jsonl')
  const prefix = 'session_memory_'
  return base.startsWith(prefix) ? base.slice(prefix.length) : base
}

// 项目目录：<root>/<proj>/<date>/xxx.jsonl → 返回 <root>/<proj>
function projectDirOf(file) {
  const segs = file.split(path.sep)
  // 从文件往前找最近一层 8 位日期目录，避免项目名恰好是 8 位数字时误判
  let dateIdx = -1
  for (let i = segs.length - 2; i >= 0; i--) {
    if (/^\d{8}$/.test(segs[i])) { dateIdx = i; break }
  }
  if (dateIdx >= 1) return segs.slice(0, dateIdx).join(path.sep)
  return path.dirname(file)
}

// 同一 session 的日期分片可能落在多个项目目录：默认在整个 memory 根下合并；
// 手动配置的目录只在对应项目内合并（避免把手动目录之外的无关文件纳入）
function groupSessionFiles(file) {
  const root = file.toLowerCase().startsWith(MEMORY_ROOT.toLowerCase())
    ? MEMORY_ROOT
    : projectDirOf(file)
  const name = path.basename(file)
  return findJsonlFiles(root).filter((f) => path.basename(f) === name)
}

function projectOfFile(file) {
  const cwd = decodeProjKey(path.basename(projectDirOf(file)))
  // 4 级降级链末级（readme §5.4）：cwd 无法识别 → 归「未分类」而非丢弃
  if (!cwd) return { cwd: null, project: { cwd: '__unclassified__', name: '未分类' } }
  return { cwd, project: { cwd, name: path.basename(cwd) || cwd } }
}

function parseMemoryFile(file) {
  const sid = sessionIdOf(file)
  // 同一 stem 的所有日期文件（含跨项目目录）一起解析；按 message_id 去重、按时间升序
  const files = groupSessionFiles(file)
  const records = []
  let order = 0
  for (const f of files) {
    for (const line of readableLines(f)) {
      let m
      try { m = JSON.parse(line) } catch { continue }
      if (!m || typeof m !== 'object') continue
      const ts = m.message_summary_time ? msFromFmt(m.message_summary_time) : null
      records.push({ m, ts, file: f, order: order++ })
    }
  }

  const deduped = new Map()
  for (const r of records) {
    const key = r.m.message_id ? `id:${r.m.message_id}` : `row:${r.file}:${r.order}`
    if (!deduped.has(key)) deduped.set(key, r)
  }
  const list = [...deduped.values()].sort((a, b) => {
    if (a.ts !== null && b.ts !== null) {
      return (a.ts - b.ts) || a.file.localeCompare(b.file) || (a.order - b.order)
    }
    if (a.ts !== null) return -1
    if (b.ts !== null) return 1
    return (a.file.localeCompare(b.file)) || (a.order - b.order)
  })
  if (!list.length) return null

  let tsMin = null
  let tsMax = null
  const turns = []
  for (const r of list) {
    const m = r.m
    if (r.ts !== null) {
      if (tsMin === null || r.ts < tsMin) tsMin = r.ts
      if (tsMax === null || r.ts > tsMax) tsMax = r.ts
    }
    // 单条 message 记忆 → 一轮
    const userIntent = m.intent || m.user_input || m.question || m.title || null
    const asstBody = [joinArr(m.actions), joinArr(m.outcome)]
      .filter(Boolean).join('\n')
    const thinking = joinArr(m.learned)
    const subject = userIntent ? classifyPurpose(userIntent, []) : null
    turns.push({
      seq: turns.length,
      userMessage: userIntent,
      assistantMessage: asstBody || null,
      thinking: thinking || null,
      toolInput: null,
      filesChanged: [],
      timestamp: r.ts,
      subject,
    })
  }

  const subjects = buildSubjects(turns)
  const firstUser = turns.find((t) => t.userMessage)
  // 会话起点 = 最早一条记录所在文件；项目也取该文件所在项目目录
  const earliest = list.find((r) => r.ts !== null) || list[0]
  const proj = projectOfFile(earliest.file)

  return {
    session: {
      agentSessionId: sid,
      cwd: proj.cwd,
      // 标题取合并后最早一条记录的 intent；无则兜底文件名 stem
      title: firstUser ? firstUser.userMessage : sid,
      model: null,
      createdAt: tsMin,
      updatedAt: tsMax,
      sourceFile: earliest.file,
      // 来源说明：这些是 Trae/IDE 工具压缩后的会话记忆摘要，非全文 transcript
      meta: { provenance: 'compressed-memory', note: 'Trae 会话记忆摘要（工具压缩，非完整对话）' },
    },
    project: proj.project,
    turns,
    subjects,
  }
}

// memory 文件名 date 形如 YYYYMMDD，格式 "2026-08-21 18:04:33" → ms
function msFromFmt(s) {
  const d = new Date(String(s).replace(' ', 'T'))
  return isNaN(d.getTime()) ? null : d.getTime()
}

// 项目 key 的真实生成规则（已核对本机 workspaceStorage / solo-lite 数据）：
//   盘符小写，':'、'\'、'/'、'.'、'_' 都转成 '-'，保留原目录中的 '-' 与大小写；
//   部分 key 追加 '--p2-<hash>' 后缀（同一项目不同会话入口）。
// 例：D:\javaCode\t8t-mid-wom → -d-javaCode-t8t-mid-wom--p2-xxx
// 例：C:\Users\tomy.li\.trae-cn\assistant → -c-Users-tomy-li--trae-cn-assistant--p2-xxx
// 例：D:\AiCode\ai-external-brain-system\ai_assistant_master_pack
//     → -d-AiCode-ai-external-brain-system-ai-assistant-master-pack
// 反解存在歧义（'-' 既可能是分隔符，也可能是原目录中的 '-'），因此优先用 Trae 自己记录的
// 真实目录做映射（workspaceStorage/workspace.json + globalStorage 的 solo-lite 项目列表），
// 未命中时才只还原盘符、保留其余 '-'，避免把未知项目名猜坏。
let projFolderMap = null

function projectFolderMap() {
  if (projFolderMap) return projFolderMap
  projFolderMap = new Map()
  if (process.platform !== 'win32') return projFolderMap
  const folders = new Set()
  const roaming = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
  let appDirs = []
  try {
    appDirs = fs.readdirSync(roaming, { withFileTypes: true })
      .filter((e) => {
        if (!/trae/i.test(e.name)) return false
        // 'Trae CN' 在本机是指向 'Trae' 的符号链接，Dirent.isDirectory() 为 false，需 stat 跟随
        try { return fs.statSync(path.join(roaming, e.name)).isDirectory() } catch { return false }
      })
      .map((e) => path.join(roaming, e.name))
  } catch {}
  for (const appDir of appDirs) {
    const wsRoot = path.join(appDir, 'User', 'workspaceStorage')
    try {
      for (const ent of fs.readdirSync(wsRoot, { withFileTypes: true })) {
        if (!ent.isDirectory()) continue
        const wj = path.join(wsRoot, ent.name, 'workspace.json')
        if (!fs.existsSync(wj)) continue
        try {
          const o = JSON.parse(fs.readFileSync(wj, 'utf8'))
          const p = uriToFolder(o && o.folder)
          if (p) folders.add(p)
        } catch {}
      }
    } catch {}
    const gs = path.join(appDir, 'User', 'globalStorage', 'state.vscdb')
    if (!fs.existsSync(gs)) continue
    let db
    try {
      db = require('better-sqlite3')(gs, { readonly: true, fileMustExist: true })
      for (const key of ['solo-lite.local-project-folders', 'solo-lite.project-workspace-cache']) {
        const row = db.prepare('SELECT value FROM ItemTable WHERE key = ?').get(key)
        if (!row) continue
        let o
        try { o = JSON.parse(String(row.value)) } catch { continue }
        for (const v of Object.values(o || {})) {
          if (typeof v === 'string') folders.add(v)
          else if (v && typeof v === 'object') {
            if (v.identity) folders.add(v.identity)
            if (Array.isArray(v.folders)) for (const f of v.folders) folders.add(f)
          }
        }
      }
    } catch {} finally {
      try { if (db) db.close() } catch {}
    }
  }
  // Trae 内部助手工作区不在 workspaceStorage 中，单独补上
  for (const p of [path.join(os.homedir(), '.trae-cn', 'assistant'), path.join(os.homedir(), '.trae', 'assistant')]) {
    if (fs.existsSync(p)) folders.add(p)
  }
  for (const f of folders) {
    const k = encodeProjFolder(f)
    if (k && !projFolderMap.has(k.toLowerCase())) projFolderMap.set(k.toLowerCase(), f)
  }
  return projFolderMap
}

function uriToFolder(uri) {
  if (!uri || !/^file:\/\/\//i.test(String(uri))) return null
  let p = String(uri).replace(/^file:\/\/\//i, '')
  try { p = decodeURIComponent(p) } catch {}
  return p.replace(/\//g, '\\').replace(/\\+$/, '')
}

function encodeProjFolder(folder) {
  const p = String(folder).replace(/\//g, '\\').replace(/\\+$/, '')
  const m = /^([a-zA-Z]):\\(.*)$/.exec(p)
  if (!m) return null
  return '-' + m[1].toLowerCase() + '-' + m[2].replace(/[\\/._]/g, '-')
}

function decodeProjKey(key) {
  const base = String(key).replace(/--p2-[0-9a-f]+$/i, '')
  const hit = projectFolderMap().get(base.toLowerCase())
  if (hit) return hit
  // 未命中：只还原盘符，其余原样保留（不做 '-'→'\' 猜测，避免破坏含 '-' 的项目名）
  const m = /^-([a-zA-Z])-/.exec(base)
  if (m) return m[1].toUpperCase() + ':\\' + base.slice(3)
  if (/^-([a-zA-Z]):/.test(base)) return base.replace(/^-([a-zA-Z]):/, (_, ch) => ch.toUpperCase() + ':')
  return base
}

function readableLines(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n')
  } catch { return [] }
}

module.exports = { scan, sources, parseFile, id: 'trae', label: 'Trae', sourceDir: MEMORY_ROOT, sourceFormat: 'jsonl/trae-memory(compressed)' }