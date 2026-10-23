'use strict'
// CodeBuddy CLI（@tencent-ai/codebuddy-code）跨平台运行器（规划 .trae/documents/codebuddy-cloud-pull.md 阶段 1b）：
// - resolveEntry()：定位内嵌 CLI 入口（dev 与打包布局通用：__dirname/../node_modules）
// - serve()：spawn `node <pkg>/bin/codebuddy --serve --auth none --port N --host 127.0.0.1`，轮询 /api/v1/health 就绪
// - api()：本地 serve 的 HTTP 客户端，自动带 X-CodeBuddy-Request: 1，解 {data} 信封
// - 登录协议（直连，不走 spawn login —— TUI 无 stdout 不可控）：POST /v2/auth/state → 前端开 authUrl →
//   轮询 /v2/auth/token?state= → 写凭据文件（CLI 对该文件有 watcher，外部写入合法 JSON 会被接管）
// 凭据为明文 JSON：一切输出禁止打印 token/refreshToken
const http = require('node:http')
const https = require('node:https')
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const safeParse = (t) => { try { return JSON.parse(t) } catch { return null } }
// {data:{...}} 信封只剥一层；无信封原样返回（auth/status 等接口有/无信封两种形态都兼容）
function unwrap(j) {
  return j && typeof j === 'object' && !Array.isArray(j) && 'data' in j ? j.data : j
}

// —— CLI 入口 ——
// 打包布局：src/ 复制到 src-tauri/backend/src/，node_modules 在 backend/ 下 → ../node_modules 两端通用
function resolveEntry() {
  const pkg = path.join(__dirname, '..', 'node_modules', '@tencent-ai', 'codebuddy-code')
  const entry = path.join(pkg, 'bin', 'codebuddy')
  if (!fs.existsSync(entry)) return null
  let version = null
  let prefixPath = ''
  try {
    const prod = JSON.parse(fs.readFileSync(path.join(pkg, 'product.json'), 'utf8'))
    version = prod.version || null
    // 认证 API 前缀（实测 /v2/plugin/auth/state；从 product.json 读，CLI 升级自动适配）
    prefixPath = (prod.authentication && prod.authentication.attributes && prod.authentication.attributes.prefixPath) || ''
  } catch { /* 缺文件时用默认 */ }
  try {
    const pk = JSON.parse(fs.readFileSync(path.join(pkg, 'package.json'), 'utf8'))
    version = version || pk.version || null
  } catch { /* 忽略 */ }
  return { pkg, entry, version, prefixPath }
}

// —— HTTP 客户端（http/https 通用，Node 18 无原生 fetch 依赖顾虑） ——
function request(url, { method = 'GET', headers = {}, body, timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const lib = u.protocol === 'https:' ? https : http
    const data = body == null ? null : Buffer.from(JSON.stringify(body))
    const req = lib.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method,
      headers: {
        Accept: 'application/json',
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}),
        ...headers,
      },
    }, (res) => {
      let buf = ''
      res.setEncoding('utf8')
      res.on('data', (c) => { buf += c; if (buf.length > 64 * 1024 * 1024) { res.destroy(); reject(new Error('CodeBuddy 响应过大')) } })
      res.on('end', () => resolve({ status: res.statusCode, text: buf }))
    })
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`CodeBuddy 请求超时：${method} ${u.pathname}`)))
    req.on('error', reject)
    if (data) req.write(data)
    req.end()
  })
}

// —— serve 进程管理 ——
function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port
      srv.close(() => resolve(port))
    })
  })
}

// 杀进程树：win 用 taskkill /T /F（实测干净）；其他平台 SIGTERM（serve 无子进程，主进程退出即净）
function killTree(child) {
  if (!child || child.exitCode !== null) return
  if (process.platform === 'win32') {
    try { spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }) } catch { /* 忽略 */ }
  } else {
    try { child.kill('SIGTERM') } catch { /* 忽略 */ }
  }
}

// —— serve 进程启动 ——
// Windows 必须经 cmd 桥起（实测 node 直接 spawn 时 CLI bundle 级命令一律静默 exit 0——连 --help 都无
// 输出；cmd / powershell 父进程下一切正常，沙箱链路内外均复现）。/d /s /c + 整体引号是 cmd 规范形态，
// 兼容带空格的安装路径。unix 直接 spawn（无 Job 容器层，不存在该问题）。
function serveSpawn(nodeExe, entry, args) {
  if (process.platform === 'win32') {
    return spawn('cmd.exe', ['/d', '/s', '/c', `""${nodeExe}" "${entry}" ${args}"`], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      windowsVerbatimArguments: true,
    })
  }
  return spawn(nodeExe, [entry, ...args.split(' ')], { stdio: ['pipe', 'pipe', 'pipe'] })
}

// 起 serve 并等就绪；返回 {port, baseUrl, version, child, stderrTail, stop}
async function serve(opts = {}) {
  const entry = resolveEntry()
  if (!entry) throw new Error('CodeBuddy CLI 未集成（缺少 @tencent-ai/codebuddy-code），请重新安装')
  const host = opts.host || '127.0.0.1'
  const port = opts.port || (await findFreePort())
  const child = serveSpawn(process.execPath, entry.entry, `--serve --auth none --port ${port} --host ${host}`)
  let stderrTail = ''
  child.stderr.on('data', (c) => { stderrTail = (stderrTail + c).slice(-4000) })
  const baseUrl = `http://${host}:${port}`
  const startedAt = Date.now()
  while (Date.now() - startedAt < (opts.timeoutMs || 30000)) {
    if (child.exitCode !== null) {
      throw new Error(`codebuddy serve 启动即退出（code ${child.exitCode}）：${stderrTail.split('\n').filter(Boolean).slice(-2).join(' | ') || '无输出'}`)
    }
    try {
      const r = await request(`${baseUrl}/api/v1/health`, { headers: { 'X-CodeBuddy-Request': '1' }, timeoutMs: 2000 })
      if (r.status === 200) {
        return { port, baseUrl, version: entry.version, child, stderrTail: () => stderrTail, stop: () => killTree(child) }
      }
    } catch { /* 未就绪，继续等 */ }
    await sleep(300)
  }
  killTree(child)
  throw new Error('codebuddy serve 启动超时（30s）：' + stderrTail.split('\n').filter(Boolean).slice(-2).join(' | '))
}

// —— serve API 客户端 ——
async function api(handle, pathname, { method = 'GET', query, body, timeoutMs = 30000 } = {}) {
  const qs = query
    ? '?' + Object.entries(query)
      .filter(([, v]) => v != null)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&')
    : ''
  const r = await request(handle.baseUrl + pathname + qs, {
    method,
    body,
    headers: { 'X-CodeBuddy-Request': '1' },
    timeoutMs,
  })
  if (r.status < 200 || r.status >= 300) {
    const snippet = (r.text || '').replace(/\s+/g, ' ').slice(0, 200)
    throw new Error(`CodeBuddy CLI API ${r.status} ${pathname}${snippet ? '：' + snippet : ''}`)
  }
  return unwrap(safeParse(r.text))
}

// —— 凭据文件（CLI 与各桌面端共享，明文 JSON：{account, auth, accounts}） ——
// 文件名为 <客户端产品名>.info，各客户端一份：实测 Windows
// %LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\ 下既有 Tencent-Cloud.coding-copilot.info
// （旧版 CLI），也有 workbuddy-desktop.info（WorkBuddy 桌面端，自动刷新 token）。
// 因此不能写死单一文件名：读取时扫目录择优，写入时仍用旧版固定名（不碰其他客户端的文件）。
// darwin/linux 沿用 VS Code 式 userData 目录名（跨平台目录名常量待实测）
function credentialDir() {
  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'CodeBuddyExtension', 'Data', 'Public', 'auth')
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'CodeBuddyExtension', 'Data', 'Public', 'auth')
  }
  return path.join(os.homedir(), '.local', 'share', 'CodeBuddyExtension', 'Data', 'Public', 'auth')
}

function credentialPath() {
  return path.join(credentialDir(), 'Tencent-Cloud.coding-copilot.info')
}

// 读凭据：扫描凭据目录下所有 *.info（各客户端产品一份），解析出含 accessToken 的凭据择优：
// 未过期优先（expiresAt 更晚者胜），过期文件按修改时间新者胜。目录不可读/无候选时回退旧版固定名。
// 返回 {file, json} 或 null；从不把 token 带出（调用方只取 account/expiresAt 等元信息）
function discoverCredentialFile() {
  const legacy = credentialPath()
  const dir = path.dirname(legacy)
  const now = Date.now()
  let best = null // {file, mtimeMs, expiresAt}
  // 择优序：未过期 > 已过期；同组内 expiresAt 大者胜；再平按 mtime 新者胜
  const betterThan = (a, b) => {
    if (!b) return true
    const av = a.expiresAt > now ? 1 : 0
    const bv = b.expiresAt > now ? 1 : 0
    if (av !== bv) return av > bv
    if (a.expiresAt !== b.expiresAt) return a.expiresAt > b.expiresAt
    return a.mtimeMs > b.mtimeMs
  }
  try {
    if (fs.existsSync(dir)) {
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.info')) continue
        const p = path.join(dir, f)
        let json
        try { json = JSON.parse(fs.readFileSync(p, 'utf8')) } catch { continue }
        const auth = json && typeof json === 'object' ? json.auth : null
        if (!hasCredentialToken(auth)) continue
        let mtimeMs = 0
        try { mtimeMs = fs.statSync(p).mtimeMs } catch { /* 取不到 mtime 按 0 */ }
        const cand = { file: p, mtimeMs, expiresAt: typeof auth.expiresAt === 'number' ? auth.expiresAt : 0 }
        if (betterThan(cand, best)) best = cand
      }
    }
  } catch { /* 目录不可读时走回退 */ }
  return best ? best.file : legacy
}

function readCredential() {
  const file = discoverCredentialFile()
  if (!fs.existsSync(file)) return null
  try {
    const json = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!json || typeof json !== 'object' || !json.auth) return null
    return { file, json }
  } catch { return null }
}

// 展示字段净化：凭据里的 nickname/type 可能是客户端加密信封对象（实测 { $wbEncrypted: 1, envelope }），
// 只把纯字符串带给上层，其余按未知处理
const plainText = (v) => (typeof v === 'string' && v ? v : null)

// accessToken 存在性：明文字符串（旧版 CLI / 本应用写入）或客户端加密信封对象（WorkBuddy 桌面端，
// token 密文 + 明文 expiresAt）都算有凭据——这里只做登录态判断、从不带出 token 本体
const hasCredentialToken = (auth) =>
  !!auth && !!auth.accessToken && (typeof auth.accessToken === 'string' || typeof auth.accessToken === 'object')

// 登录态（不依赖 serve，纯文件判断）：authenticated=有 accessToken 且未过期；
// stale=refresh 也过期（彻底失效，须重新授权）。accounts 为账号档案注册表摘要（实测无 token，
// 仅 uid/nickname/type/lastLogin），供多账号展示；serve 拉取始终用顶层 account/auth（当前账号），
// 用户在 CodeBuddy 侧切换账号后文件随之变化，下次扫描自然拉新账号（agentSessionId 全局唯一，增量跨账号安全）
function credentialState() {
  const c = readCredential()
  if (!c) return { installed: false, authenticated: false, stale: false, file: credentialPath(), account: null, accounts: [], expiresAt: null, refreshExpiresAt: null }
  const auth = c.json.auth || {}
  const now = Date.now()
  const hasToken = hasCredentialToken(auth)
  return {
    installed: true,
    file: c.file,
    authenticated: hasToken && typeof auth.expiresAt === 'number' && auth.expiresAt > now,
    stale: !hasToken || (typeof auth.refreshExpiresAt === 'number' && auth.refreshExpiresAt < now),
    account: c.json.account ? { uid: c.json.account.uid, nickname: plainText(c.json.account.nickname), type: plainText(c.json.account.type) } : null,
    accounts: Array.isArray(c.json.accounts)
      ? c.json.accounts
        .filter((a) => a && typeof a.uid === 'string' && a.uid)
        .map((a) => ({ uid: a.uid, nickname: plainText(a.nickname), type: plainText(a.type), lastLogin: !!a.lastLogin }))
      : [],
    expiresAt: typeof auth.expiresAt === 'number' ? auth.expiresAt : null,
    refreshExpiresAt: typeof auth.refreshExpiresAt === 'number' ? auth.refreshExpiresAt : null,
  }
}

// 登录态聚合：无 serve 句柄时纯文件判断；有句柄时叠加 CLI 自报（复核 watcher 是否接管了外部写入）
async function authStatus(handle) {
  const state = credentialState()
  if (!handle) return state
  try {
    const r = await api(handle, '/api/v1/auth/status', { timeoutMs: 5000 })
    return { ...state, serve: { authEnabled: !!(r && r.authEnabled), authenticated: !!(r && r.authenticated) } }
  } catch (e) {
    return { ...state, serve: { error: e.message } }
  }
}

// —— 登录协议（CLI 与桌面版同一套，Keycloak behind copilot.tencent.com；prefixPath 取自 CLI product.json，实测 /plugin） ——
const ENDPOINT = 'https://copilot.tencent.com'
const NO_AUTH_HEADERS = {
  'X-No-Authorization': 'true',
  'X-No-User-Id': 'true',
  'X-No-Enterprise-Id': 'true',
  'X-No-Department-Info': 'true',
}

// 第一步：创建授权会话，返回 {authUrl, state}（前端开 authUrl，轮询由 pollLogin 接手）
async function beginLogin() {
  const entry = resolveEntry()
  const prefix = (entry && entry.prefixPath) || ''
  const r = await request(`${ENDPOINT}/v2${prefix}/auth/state?platform=CLI`, { method: 'POST', headers: NO_AUTH_HEADERS, timeoutMs: 15000 })
  if (r.status < 200 || r.status >= 300) throw new Error(`CodeBuddy 登录发起失败（HTTP ${r.status}）`)
  const j = safeParse(r.text)
  // 实测信封 {code,msg,requestId,data:{state,authUrl}}
  const payload = j && j.data && j.data.data ? j.data.data : unwrap(j)
  if (!payload || !payload.authUrl || !payload.state) throw new Error('CodeBuddy 登录响应缺少 authUrl/state：' + (r.text || '').replace(/\s+/g, ' ').slice(0, 200))
  return { authUrl: payload.authUrl, state: payload.state }
}

// 由 token 响应构造凭据 JSON（纯函数，便于点测）；expiresAt 按 calculateExpiresAt 语义本地补齐
function buildCredential(data) {
  const now = Date.now()
  const a = (data && data.auth) || {}
  if (!a.accessToken) throw new Error('CodeBuddy 登录响应缺少 accessToken')
  const auth = {
    ...a,
    tokenType: a.tokenType || 'Bearer',
    domain: a.domain || 'www.codebuddy.cn', // 实测凭据文件 domain 值（Keycloak issuer host），服务端正常都会下发
  }
  if (typeof auth.expiresIn === 'number' && typeof auth.expiresAt !== 'number') auth.expiresAt = now + auth.expiresIn * 1000
  if (typeof auth.refreshExpiresIn === 'number' && typeof auth.refreshExpiresAt !== 'number') auth.refreshExpiresAt = now + auth.refreshExpiresIn * 1000
  const account = data.account || data.user || null
  return {
    account,
    auth,
    accounts: Array.isArray(data.accounts) ? data.accounts : (account ? [account] : []),
  }
}

// 多账号合并（纯函数，便于点测）：accounts 是账号档案注册表（实测不含 token），登录落盘必须按 uid
// 合并而非整体覆盖——换号重登时保留 CodeBuddy 桌面端账号切换器里的其他账号档案。
// 同 uid 后写者胜（档案取最新）；顶层 account/auth 用本次登录的当前账号。
function mergeCredential(existing, incoming) {
  const byUid = new Map()
  const push = (a) => { if (a && typeof a.uid === 'string' && a.uid) byUid.set(a.uid, a) }
  if (existing) {
    push(existing.account) // 兼容 account 不在 accounts 注册表的旧形态
    for (const a of (Array.isArray(existing.accounts) ? existing.accounts : [])) push(a)
  }
  for (const a of (Array.isArray(incoming.accounts) ? incoming.accounts : [])) push(a)
  push(incoming.account)
  return { ...incoming, accounts: [...byUid.values()] }
}

// 读凭据原始 JSON（合并用：不要求 auth 存在，只取 accounts 注册表；读当前择优文件，
// 使重登时能合并到其他客户端文件里的账号档案）
function readCredentialRaw() {
  const file = discoverCredentialFile()
  try {
    if (!fs.existsSync(file)) return null
    const j = JSON.parse(fs.readFileSync(file, 'utf8'))
    return j && typeof j === 'object' ? j : null
  } catch { return null }
}

function writeCredentialFile(cred) {
  const p = credentialPath()
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, JSON.stringify(cred, null, 2))
  return p
}

// 单次 token 查询：pending（用户未完成浏览器授权）或 done（拿到 token，与既有账号档案合并后写凭据文件，
// CLI watcher 自动接管）
async function checkLogin(state) {
  const entry = resolveEntry()
  const prefix = (entry && entry.prefixPath) || ''
  const r = await request(`${ENDPOINT}/v2${prefix}/auth/token?state=${encodeURIComponent(state)}`, { headers: { 'X-No-Authorization': 'true' }, timeoutMs: 10000 })
  if (r.status >= 200 && r.status < 300) {
    const j = safeParse(r.text)
    const data = j && j.data ? j.data : j
    const auth = data && data.auth ? data.auth : null
    if (auth && auth.accessToken) {
      const cred = mergeCredential(readCredentialRaw(), buildCredential(data))
      const file = writeCredentialFile(cred)
      return { done: true, file, account: cred.account ? { uid: cred.account.uid, nickname: plainText(cred.account.nickname), type: plainText(cred.account.type) } : null, accountCount: cred.accounts.length }
    }
  }
  return { pending: true } // pending 时网关返回 200 + {code:11217, msg:"login ing..."}
}

// 轮询至完成（1s 间隔、300s 上限，与 CLI 同参数）；独立长轮询场景用（服务端点改用 checkLogin 短轮询）
async function pollLogin(state, opts = {}) {
  const intervalMs = opts.intervalMs || 1000
  const deadline = Date.now() + (opts.timeoutMs || 300000)
  while (Date.now() < deadline) {
    if (opts.signal && opts.signal.aborted) throw new Error('授权已取消')
    try {
      const r = await checkLogin(state)
      if (r.done) return r
    } catch { /* 轮询瞬时错误（网络抖动等）继续 */ }
    await sleep(intervalMs)
  }
  throw new Error('CodeBuddy 授权超时：300 秒内未完成浏览器登录')
}

module.exports = {
  resolveEntry,
  serve,
  api,
  killTree,
  credentialPath,
  discoverCredentialFile,
  readCredential,
  credentialState,
  authStatus,
  beginLogin,
  checkLogin,
  pollLogin,
  buildCredential,
  mergeCredential,
  writeCredentialFile,
}
