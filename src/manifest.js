'use strict'
// 声明式适配器清单（agentList §6.2）：新增解析器 = 一份 JSON，不改代码、不重发客户端。
// 三源合并：内置清单（adapters/manifests/，随包）+ 用户清单（~/.agentsessions/adapters/）+
// 远端清单仓库（config.manifestRepo，定时拉取、失败回退缓存）。优先级：用户 > 远端 > 内置；
// 与内置硬编码适配器同 id 的清单在 detect/scan 侧被硬编码优先覆盖。
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const https = require('node:https')

const BUILTIN_DIR = path.join(__dirname, '..', 'adapters', 'manifests')

// 用户清单目录（环境变量可覆盖，便于点测与便携部署）
function userDir() {
  return process.env.AGENTSESSIONS_MANIFEST_DIR
    || path.join(os.homedir(), '.agentsessions', 'adapters')
}

function remoteCacheFile() {
  return path.join(userDir(), '.remote-manifests.json')
}

// —— 路径工具 ——
// 展开 ~ 前缀；其余保持原样（绝对/相对均可）
function resolveRoot(p) {
  if (typeof p !== 'string' || !p) return p
  if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) {
    return path.join(os.homedir(), p.slice(1).replace(/^[\\/]/, ''))
  }
  return p
}

// SQL 标识符白名单（sqlite 清单的表/列名拼接进 SQL，必须校验防注入）
function isSqlIdent(s) {
  return typeof s === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(s)
}

// —— 清单校验：返回 null=合法，否则错误说明 ——
function validate(m) {
  if (!m || typeof m !== 'object' || Array.isArray(m)) return '清单必须是对象'
  if (m.manifestVersion !== 1) return 'manifestVersion 必须为 1'
  if (typeof m.id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(m.id)) return 'id 必须为小写 slug'
  if (typeof m.label !== 'string' || !m.label.trim()) return 'label 缺失'
  const eng = m.engine
  if (!['jsonl', 'json', 'sqlite', 'external', 'markdown'].includes(eng)) return 'engine 必须是 jsonl/json/sqlite/external/markdown'

  if (eng === 'external') {
    if (typeof m.command !== 'string' || !m.command.trim()) return 'external 需要 command'
    if (m.args !== undefined && !Array.isArray(m.args)) return 'args 必须为数组'
    return null
  }

  if (eng === 'markdown') {
    if (!m.source || typeof m.source.fileName !== 'string' || !m.source.fileName.trim()) return 'markdown 需要 source.fileName'
    if (m.source.root !== undefined && typeof m.source.root !== 'string') return 'source.root 必须为字符串'
    const c = m.markdown || {}
    if (c.runHeading !== undefined && typeof c.runHeading !== 'string') return 'markdown.runHeading 必须为字符串正则'
    if (c.headingLevel !== undefined && (!Number.isInteger(c.headingLevel) || c.headingLevel < 1)) return 'markdown.headingLevel 必须为正整数'
    if (c.roleHeadings !== undefined && (typeof c.roleHeadings !== 'object' || Array.isArray(c.roleHeadings) || typeof c.roleHeadings.user !== 'string' || typeof c.roleHeadings.assistant !== 'string')) {
      return 'markdown.roleHeadings 必须含 user/assistant 字符串'
    }
    if (c.ignoreHeadings !== undefined && !Array.isArray(c.ignoreHeadings)) return 'markdown.ignoreHeadings 必须为数组'
    // 正则合法性前置校验：非法正则若流入引擎会在构造期抛 SyntaxError（清单在加载期即拒绝）
    if (c.runHeading !== undefined) { try { new RegExp(c.runHeading) } catch { return 'markdown.runHeading 不是合法正则' } }
    if (c.filters !== undefined) {
      if (!Array.isArray(c.filters)) return 'markdown.filters 必须为数组'
      for (const f of c.filters) {
        if (typeof f !== 'string') return 'markdown.filters 项必须为字符串'
        try { new RegExp(f) } catch { return `markdown.filters 含非法正则：${f}` }
      }
    }
    return null
  }

  if (eng === 'sqlite') {
    const c = m.sqlite
    if (!c || !Array.isArray(c.candidates) || !c.candidates.length) return 'sqlite 需要 sqlite.candidates'
    if (!c.session || !isSqlIdent(c.session.table) || !isSqlIdent(c.session.id) || !isSqlIdent(c.session.cwd)) {
      return 'sqlite.session 表/列映射不合法'
    }
    if (!c.message || !isSqlIdent(c.message.table) || !isSqlIdent(c.message.sessionId) || !isSqlIdent(c.message.data)) {
      return 'sqlite.message 表/列映射不合法'
    }
    if (c.part && (!isSqlIdent(c.part.table) || !isSqlIdent(c.part.messageId) || !isSqlIdent(c.part.data))) {
      return 'sqlite.part 表/列映射不合法'
    }
    if (c.mirrorTables !== undefined) {
      if (!Array.isArray(c.mirrorTables)) return 'sqlite.mirrorTables 必须为数组'
      for (const mt of c.mirrorTables) {
        if (!mt || typeof mt !== 'object' || !isSqlIdent(mt.table) || !isSqlIdent(mt.column)) {
          return 'sqlite.mirrorTables 项必须为 {table, column} 标识符'
        }
      }
    }
    return null
  }

  // jsonl / json（记录引擎）
  if (!m.source || typeof m.source.root !== 'string' || !m.source.root.trim()) return '需要 source.root'
  if (m.source.ext !== undefined && (typeof m.source.ext !== 'string' || !m.source.ext.startsWith('.'))) return 'source.ext 必须形如 ".jsonl"'
  if (eng === 'json' && !(m.session && typeof m.session.messagesPath === 'string' && m.session.messagesPath)) {
    return 'json 引擎需要 session.messagesPath（消息数组字段路径）'
  }
  if (!Array.isArray(m.rules) || !m.rules.length) return '需要至少一条 rules'
  for (const r of m.rules) {
    if (!r || typeof r !== 'object') return 'rule 必须为对象'
    if (!['user', 'assistant', 'thinking', 'tool', 'title'].includes(r.role)) return 'rule.role 非法'
    if (r.when && (typeof r.when !== 'object' || Array.isArray(r.when))) return 'rule.when 必须为对象'
    if ((r.role === 'user' || r.role === 'assistant' || r.role === 'title') && typeof r.text !== 'string' && !Array.isArray(r.text)) {
      return `role=${r.role} 的 rule 需要 text 路径`
    }
    if (r.role === 'tool' && (typeof r.name !== 'string' || typeof r.input !== 'string')) {
      return 'role=tool 的 rule 需要 name/input 路径'
    }
    if (r.ts !== undefined && typeof r.ts !== 'string') return 'rule.ts 必须为字符串路径'
  }
  return null
}

// —— 探测规则：dirs 相对主目录（或绝对路径）任一存在；bins 任一在 PATH ——
function hasDirAbs(p) {
  try { return fs.statSync(p).isDirectory() } catch { return false }
}
function inPath(bin) {
  const exes = process.platform === 'win32' ? [`${bin}.exe`, `${bin}.cmd`, `${bin}.bat`] : [bin]
  return (process.env.PATH || '').split(path.delimiter).some((d) => d && exes.some((e) => fs.existsSync(path.join(d, e))))
}
function ruleDetect(d) {
  if (!d || typeof d !== 'object') return false
  if (Array.isArray(d.dirs) && d.dirs.some((x) => typeof x === 'string' && hasDirAbs(resolveRoot(x)))) return true
  if (Array.isArray(d.bins) && d.bins.some((x) => typeof x === 'string' && inPath(x))) return true
  return false
}

// —— 目录读取：目录下所有 *.json 清单（点开头忽略），逐个校验 ——
function readDirManifests(dir) {
  const out = []
  let names = []
  try { names = fs.readdirSync(dir) } catch { return out }
  for (const name of names) {
    if (!name.endsWith('.json') || name.startsWith('.')) continue
    try {
      const m = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'))
      const err = validate(m)
      if (err) { console.error(`[agentsessions] 清单 ${name} 无效：${err}`); continue }
      out.push(m)
    } catch (e) { console.error(`[agentsessions] 清单 ${name} 读取失败：${e.message}`) }
  }
  return out
}

// —— 远端清单仓库：非阻塞拉取（同步函数只读缓存，拉取异步回写缓存）——
// 拉取失败/超时静默保留旧缓存（agentList §6.2：失败回退内置/缓存）
// http/https 自适应 + 跟随 3xx 重定向（上限 3 跳）；仅 200 视为成功
function httpGet(url, timeoutMs, redirects = 0) {
  return new Promise((resolve, reject) => {
    let u
    try { u = new URL(url) } catch { return reject(new Error('清单仓库 URL 非法')) }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return reject(new Error('清单仓库仅支持 http/https'))
    const mod = u.protocol === 'https:' ? https : http
    const req = mod.get(u, { timeout: timeoutMs }, (res) => {
      const sc = res.statusCode || 0
      if (sc >= 300 && sc < 400 && res.headers.location) {
        res.resume()
        if (redirects >= 3) return reject(new Error('重定向次数过多'))
        return resolve(httpGet(new URL(res.headers.location, u).toString(), timeoutMs, redirects + 1))
      }
      if (sc !== 200) { res.resume(); return reject(new Error('HTTP ' + sc)) }
      let buf = ''
      res.setEncoding('utf8')
      res.on('data', (c) => {
        buf += c
        if (buf.length > 5 * 1024 * 1024) { req.destroy(); reject(new Error('清单响应过大')) }
      })
      res.on('end', () => resolve(buf))
    })
    req.on('timeout', () => { req.destroy(); reject(new Error('清单拉取超时')) })
    req.on('error', reject)
  })
}

function remoteManifests(repo, refreshMinutes) {
  const cache = remoteCacheFile()
  let prev = null
  try { prev = JSON.parse(fs.readFileSync(cache, 'utf8')) } catch { /* 无缓存 */ }
  const list = prev && Array.isArray(prev.manifests) ? prev.manifests : []
  const now = Date.now()
  const due = !prev || !prev.fetchedAt || (now - prev.fetchedAt) >= refreshMinutes * 60 * 1000
  if (due) {
    httpGet(repo, 4000).then((body) => {
      const parsed = JSON.parse(body)
      const raw = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.manifests) ? parsed.manifests : [parsed])
      const valid = []
      for (const m of raw) {
        const err = validate(m)
        if (err) { console.error(`[agentsessions] 远端清单无效：${err}`); continue }
        // 安全策略：远端来源（用户未必审阅内容的供应链）不允许声明 external 引擎，
        // 防止被入侵/劫持的仓库借扫描执行任意命令；内置/用户目录清单不受限
        if (m.engine === 'external') {
          console.error(`[agentsessions] 远端清单 ${m.id} 声明 external 引擎，已被安全策略拒绝`)
          continue
        }
        valid.push(m)
      }
      try {
        fs.mkdirSync(path.dirname(cache), { recursive: true })
        fs.writeFileSync(cache, JSON.stringify({ fetchedAt: Date.now(), manifests: valid }))
      } catch { /* 缓存写失败忽略 */ }
    }).catch((e) => {
      // 拉取失败：保留旧缓存，但记录原因便于排查（如 https 不可达/重定向/超时）
      console.error(`[agentsessions] 远端清单拉取失败：${(e && e.message) || e}`)
    })
  }
  return list
}

// —— 加载与合并（带 3s 进程内缓存，避免同一次扫描内重复读盘）——
let cache = { at: 0, key: '', list: [] }
function loadManifests(cfg) {
  const repo = cfg && typeof cfg.manifestRepo === 'string' ? cfg.manifestRepo.trim() : ''
  const refresh = cfg && Number.isFinite(Number(cfg.manifestRefreshMinutes)) ? Number(cfg.manifestRefreshMinutes) : 60
  const key = JSON.stringify([BUILTIN_DIR, userDir(), repo, refresh])
  if (cache.key === key && Date.now() - cache.at < 3000) return cache.list

  const builtin = readDirManifests(BUILTIN_DIR)
  const user = readDirManifests(userDir())
  const remote = repo && refresh > 0 ? remoteManifests(repo, refresh) : []
  const byId = new Map()
  for (const m of [...builtin, ...remote, ...user]) byId.set(m.id, m) // 用户 > 远端 > 内置
  const list = [...byId.values()]
  cache = { at: Date.now(), key, list }
  return list
}

function manifestOf(id, cfg) {
  return loadManifests(cfg).find((m) => m.id === id) || null
}
function hasAdapter(id, cfg) { return !!manifestOf(id, cfg) }
function labelOf(id, cfg) {
  const m = manifestOf(id, cfg)
  return m ? m.label : null
}
// 全部清单 id（config.js 的 knownAgents 白名单扩展用）
function manifestIds(cfg) { return loadManifests(cfg).map((m) => m.id) }

// scan.js 用的 agent 注册表条目（与 detect.js AGENTS 条目同构的子集）
function entryFor(id, cfg) {
  const m = manifestOf(id, cfg)
  if (!m) return null
  const e = { id: m.id, label: m.label, __manifest: true }
  if (m.engine === 'sqlite' && Array.isArray(m.sqlite.candidates)) {
    e.dbCandidates = () => m.sqlite.candidates.map(resolveRoot)
  }
  return e
}

module.exports = {
  BUILTIN_DIR, userDir, resolveRoot, validate, ruleDetect, httpGet,
  loadManifests, manifestOf, hasAdapter, labelOf, manifestIds, entryFor,
}
