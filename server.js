'use strict'
// 本地 REST 桥：把采集/检索核心暴露成 HTTP，供 UI(浏览器/Vite) 调用。
// 仅绑定 127.0.0.1，无鉴权但不可被外网访问。
const http = require('node:http')
const path = require('node:path')
const { defaultDbPath } = require('./src/index')
const { runScan } = require('./src/scan')
const { search } = require('./src/search')
const { detectAll } = require('./src/detect')
const { cleanContext } = require('./src/handoff')
const { exportSession } = require('./src/export')
const config = require('./src/config')
const store = require('./src/store')
const q = require('./src/query')

const PORT = Number(process.env.AGENTSESSIONS_PORT) || 18778
const DB_PATH = process.env.AGENTSESSIONS_DB || defaultDbPath()

// —— 自动增量扫描（M4，规划 §三F「自动更新索引」）：启动即扫一次 + 按配置间隔定时 ——
// 间隔读 config.autoScanMinutes（分钟，0=关闭），每次 tick 重读配置，改配置即时生效（无需重启）。
let lastAutoScanAt = 0
let lastScanAt = 0 // 最近一次扫描完成时间（手动/自动/配置触发均更新，供状态栏展示）
let lastAgents = [] // 最近一次扫描的 agent 明细（含 placeholder"已安装未索引"），供设置页展示
let autoScanning = false
function autoScan(trigger) {
  if (autoScanning) return
  autoScanning = true
  try {
    const r = runScan(DB_PATH)
    lastAutoScanAt = Date.now()
    lastScanAt = lastAutoScanAt
    if (r.ok) lastAgents = r.stats.agents || []
    if (!r.ok) console.error(`[agentsessions] 自动扫描失败：${r.error}`)
    else if (r.stats.sessions > 0) {
      console.log(`[agentsessions] ${trigger}增量扫描：新收录 ${r.stats.sessions} 会话`)
    }
  } catch (e) {
    console.error(`[agentsessions] 自动扫描异常：${e.message}`)
  } finally {
    autoScanning = false
  }
}

function send(res, code, data) {
  const body = JSON.stringify(data)
  // CORS：桌面版(Tauri webview, http://tauri.localhost)直连本桥属于跨域，需放行
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
  })
  res.end(body)
}

// 读取 POST body（JSON，限长 1MB）
function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = ''
    req.on('data', (c) => {
      buf += c
      if (buf.length > 1024 * 1024) { reject(new Error('body too large')); req.destroy(); return }
    })
    req.on('end', () => {
      if (!buf) return resolve({})
      try { resolve(JSON.parse(buf)) } catch { reject(new Error('invalid json body')) }
    })
    req.on('error', reject)
  })
}

function getQuery(url) {
  const i = url.indexOf('?')
  const raw = i >= 0 ? url.slice(i + 1) : ''
  const out = {}
  for (const part of raw.split('&')) {
    if (!part) continue
    const [k, v] = part.split('=')
    if (k) out[decodeURIComponent(k)] = v === undefined ? '' : decodeURIComponent(v)
  }
  return out
}

async function handle(req, res) {
  const url = req.url || '/'
  const qs = getQuery(url)
  const p = url.split('?')[0]
  // 预检请求（POST JSON 会触发）：放行跨域来源（桌面版 webview）
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    })
    res.end()
    return
  }
  try {
    switch (p) {
      case '/api/detect': {
        const detected = detectAll()
        send(res, 200, { ok: true, agents: detected })
        return
      }
      case '/api/scan': {
        // POST 触发扫描（异步走会耗时，这里同步完成）
        const res2 = runScan(DB_PATH, { only: qs.only })
        lastScanAt = Date.now()
        if (res2.ok) lastAgents = res2.stats.agents || []
        if (!res2.ok) { send(res, 500, { ok: false, error: res2.error, stats: res2.stats }); return }
        send(res, 200, { ok: true, stats: res2.stats })
        return
      }
      case '/api/search': {
        const r = search(DB_PATH, {
          q: qs.q || '',
          depth: Number(qs.depth) || 2,
          account: qs.account,
          projectId: qs.project,
          agentId: qs.agent,
          from: qs.from ? Number(qs.from) : undefined,
          to: qs.to ? Number(qs.to) : undefined,
          limit: Number(qs.limit) || 50,
          auto: qs.auto === '1',
          minResults: Number(qs.minResults) || 8,
        })
        send(res, 200, r)
        return
      }
      case '/api/projects':
        send(res, 200, { ok: true, projects: q.listProjects(DB_PATH) })
        return
      case '/api/accounts':
        send(res, 200, { ok: true, accounts: q.listAccounts(DB_PATH) })
        return
      case '/api/agents':
        send(res, 200, { ok: true, agents: q.listAgents(DB_PATH) })
        return
      case '/api/sessions':
        send(res, 200, { ok: true, sessions: q.listSessions(DB_PATH, {
          projectId: qs.project, accountId: qs.account, agentId: qs.agent, q: qs.q,
          limit: Number(qs.limit) || 500,
        }) })
        return
      case '/api/session': {
        const id = qs.id
        if (!id) { send(res, 400, { ok: false, error: 'missing id' }); return }
        const d = q.sessionDetail(DB_PATH, id)
        if (!d) { send(res, 404, { ok: false, error: 'not found' }); return }
        send(res, 200, { ok: true, session: d })
        return
      }
      case '/api/export': {
        const id = qs.id
        if (!id) { send(res, 400, { ok: false, error: 'missing id' }); return }
        const fmt = qs.format === 'json' ? 'json' : 'md'
        const e = exportSession(DB_PATH, id, fmt)
        if (!e) { send(res, 404, { ok: false, error: 'not found' }); return }
        send(res, 200, { ok: true, name: e.name, content: e.content, format: e.format })
        return
      }
      case '/api/context': {
        // 清洗后的会话上下文（供"复制上下文"转交给其他 Agent）
        const id = qs.id
        if (!id) { send(res, 400, { ok: false, error: 'missing id' }); return }
        const c = cleanContext(DB_PATH, id)
        if (!c) { send(res, 404, { ok: false, error: 'not found' }); return }
        send(res, 200, c)
        return
      }
      case '/api/stats': {
        const days = Math.min(Math.max(Number(qs.days) || 30, 1), 365)
        // agents：最近一次扫描的探测明细（ok=已索引，placeholder=已安装暂不支持索引）
        send(res, 200, { ok: true, stats: q.stats(DB_PATH, { days }), lastScanAt, agents: lastAgents })
        return
      }
      case '/api/project/rename': {
        // POST { id, name }：自定义项目名（name 空 = 恢复自动命名）
        if (req.method !== 'POST') { send(res, 405, { ok: false, error: 'POST only' }); return }
        const body = await readBody(req)
        if (!body.id) { send(res, 400, { ok: false, error: 'missing id' }); return }
        const db = require('./src/model').openStore(DB_PATH)
        try {
          store.setProjectName(db, String(body.id), body.name ? String(body.name).trim() : null)
          send(res, 200, { ok: true })
        } finally { db.close() }
        return
      }
      case '/api/session/star': {
        // POST { id }：切换星标，返回切换后的状态
        if (req.method !== 'POST') { send(res, 405, { ok: false, error: 'POST only' }); return }
        const body = await readBody(req)
        if (!body.id) { send(res, 400, { ok: false, error: 'missing id' }); return }
        const db = require('./src/model').openStore(DB_PATH)
        try {
          const starred = store.toggleStar(db, String(body.id))
          if (starred === null) { send(res, 404, { ok: false, error: 'not found' }); return }
          send(res, 200, { ok: true, starred })
        } finally { db.close() }
        return
      }
      case '/api/config':
        if (req.method === 'POST') {
          const body = await readBody(req)
          const saved = config.saveConfig(body)
          // 排除规则变更后立即重扫一次，让存量清理马上生效
          autoScan('配置变更后')
          send(res, 200, { ok: true, config: saved })
          return
        }
        send(res, 200, { ok: true, config: config.loadConfig() })
        return
      case '/api/ping':
        send(res, 200, { ok: true, db: DB_PATH })
        return
      default:
        send(res, 404, { ok: false, error: 'not found: ' + p })
    }
  } catch (e) {
    send(res, 500, { ok: false, error: e.message })
  }
}

const server = http.createServer(handle)
server.listen(PORT, '127.0.0.1', () => {
  console.log(`[agentsessions] 本地桥已启动  http://127.0.0.1:${PORT}`)
  console.log(`[agentsessions] 数据库 ${DB_PATH}`)
  // 启动即异步首扫（不阻塞监听）；之后每 30s 检查一次是否到达配置间隔
  setTimeout(() => autoScan('启动'), 300)
  setInterval(() => {
    const cfg = config.loadConfig()
    const ms = (cfg.autoScanMinutes || 0) * 60 * 1000
    if (ms > 0 && Date.now() - lastAutoScanAt >= ms) autoScan('定时')
  }, 30 * 1000)
})