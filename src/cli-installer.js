'use strict'
// CodeBuddy 云端组件按需下载器（设置页显式触发，进度经 /api/codebuddy/status 轮询）。
// 链路：平台元数据 json → 下载 .pkg.gz → sha256 校验 → 流式解压 → install.json 标记。
// - 组件源：本仓库 GitHub Release latest 附件（scripts/build-cli-pkg.js 随版本产出）
// - 直连失败自动回退镜像（与打包文档同款 gh-proxy 系），手动重试即可换通道
// - 零新依赖：下载 node:http/https（手动跟随重定向）、解压 node:zlib、校验 node:crypto
// - 分发格式 .pkg.gz 见 scripts/cli-pkg.js；解压到 ~/.agentsessions/cli/node_modules/
//   （codebuddy-cli.js 的 resolveEntry 第二优先级）
const http = require('node:http')
const https = require('node:https')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const zlib = require('node:zlib')
const crypto = require('node:crypto')
const { once } = require('node:events')
const { platformKey } = require('../scripts/cli-pkg')

const REPO = 'odayou/agentSessions'
// 实测可用镜像（见 readme「国内网络必备」）；空串 = GitHub 直连，永远先试
const MIRRORS = ['', 'https://gh-proxy.com/', 'https://ghproxy.net/', 'https://ghfast.top/']
const CONNECT_TIMEOUT_MS = 15000 // 连接/重定向每跳超时
const STALL_TIMEOUT_MS = 60000   // 下载流持续无数据判死（慢速但活跃的连接不受影响）

const PKG_MAGIC = Buffer.from('ASCBPKG1\n', 'utf8')
const ACTIVE_STATES = new Set(['downloading', 'verifying', 'extracting'])

// 组件根目录：默认 ~/.agentsessions/cli/（每用户可写、升级不清理、三运行形态路径恒定）；
// 可用 AGENT_SESSIONS_CLI_DIR 覆盖（测试隔离 / 自定义数据目录）
function cliRoot() {
  const custom = process.env.AGENT_SESSIONS_CLI_DIR
  return custom && path.isAbsolute(custom)
    ? path.join(custom, 'cli')
    : path.join(os.homedir(), '.agentsessions', 'cli')
}

function markerFile() {
  return path.join(cliRoot(), 'install.json')
}

function latestAssetUrl(name) {
  // releases/latest/download/<asset>：GitHub 服务端 302 到最新 release 的附件，免 API 免解析
  return `https://github.com/${REPO}/releases/latest/download/${encodeURIComponent(name)}`
}

// 单次 GET（跟随重定向）；把响应流交给调用方（含非 2xx，统一在调用方报错）
function fetchFollow(url, { timeoutMs = CONNECT_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const lib = u.protocol === 'https:' ? https : http
    const req = lib.get(u, { headers: { Accept: '*/*', 'User-Agent': 'agentsessions-cli-installer' } }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume()
        fetchFollow(new URL(res.headers.location, u).toString(), { timeoutMs }).then(resolve, reject)
        return
      }
      resolve(res)
    })
    req.setTimeout(timeoutMs, () => req.destroy(new Error('请求超时')))
    req.on('error', reject)
  })
}

function statusError(e) {
  return /HTTP \d{3}/.test(e && e.message) ? e : null
}

async function collect(res) {
  const chunks = []
  for await (const c of res) chunks.push(c)
  return Buffer.concat(chunks)
}

// 元数据小文件：直连 + 镜像逐个试，取第一个成功的
async function fetchMeta(name) {
  let lastErr = null
  for (const mirror of MIRRORS) {
    try {
      const res = await fetchFollow(mirror + latestAssetUrl(name))
      if (res.statusCode < 200 || res.statusCode >= 300) {
        const code = res.statusCode
        res.resume()
        throw new Error(code === 404 ? `HTTP 404（分发件尚未随最新版本发布）` : `HTTP ${code}`)
      }
      return JSON.parse((await collect(res)).toString('utf8'))
    } catch (e) { lastErr = e }
  }
  throw new Error(`获取元数据失败（直连 + ${MIRRORS.length - 1} 个镜像均不可用）：${lastErr ? lastErr.message : '未知错误'}`)
}

// 大文件下载：整文件级镜像回退（中途断流从头再试下一通道）；onProgress(done, total)
function downloadTo(name, dest, onProgress) {
  const attempt = (url) => new Promise((resolve, reject) => {
    let redirects = 0
    const go = (u) => {
      const lib = new URL(u).protocol === 'https:' ? https : http
      const req = lib.get(u, { headers: { 'User-Agent': 'agentsessions-cli-installer' } }, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume()
          if (++redirects > 5) { reject(new Error('重定向次数过多')); return }
          go(new URL(res.headers.location, u).toString())
          return
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const code = res.statusCode
          res.resume()
          reject(new Error(code === 404 ? 'HTTP 404（分发件尚未随最新版本发布）' : `HTTP ${code}`))
          return
        }
        const total = Number(res.headers['content-length']) || 0
        let done = 0
        const out = fs.createWriteStream(dest)
        out.on('error', reject)
        res.on('data', (c) => { done += c.length; if (onProgress) onProgress(done, total) })
        res.on('error', (e) => { out.destroy(); reject(e) })
        out.on('finish', () => resolve(total))
        res.pipe(out)
      })
      req.setTimeout(STALL_TIMEOUT_MS, () => req.destroy(new Error('下载停滞超时（60s 无数据，可重试或切换网络）')))
      req.on('error', reject)
    }
    go(url)
  })
  return (async () => {
    let lastErr = null
    for (const mirror of MIRRORS) {
      try {
        return await attempt(mirror + latestAssetUrl(name))
      } catch (e) {
        lastErr = e
        try { fs.rmSync(dest, { force: true }) } catch { /* 忽略 */ }
        if (statusError(e) && /404/.test(e.message)) throw e // 404 换镜像也没用，直接失败
      }
    }
    throw new Error(`下载失败（直连 + ${MIRRORS.length - 1} 个镜像均不可用）：${lastErr ? lastErr.message : '未知错误'}`)
  })()
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256')
    const s = fs.createReadStream(file)
    s.on('data', (c) => h.update(c))
    s.on('error', reject)
    s.on('end', () => resolve(h.digest('hex')))
  })
}

// 流式解压 .pkg.gz → destRoot（格式见 scripts/cli-pkg.js）。
// 校验每个条目路径防目录穿越；单 pending 缓冲驱动状态机（magic/header/data），
// 任何相位的余量都留在 pending 里进入下一轮，不会丢字节；gzip 反压用 pause/drain 节流。
async function extractPkg(pkgGz, destRoot, onEntry) {
  const safeJoin = (rel) => {
    const norm = path.normalize(rel)
    if (path.isAbsolute(norm) || norm === '..' || norm.split(path.sep).includes('..')) {
      throw new Error(`分发包内出现非法路径：${rel}`)
    }
    return path.join(destRoot, norm)
  }
  const stream = fs.createReadStream(pkgGz).pipe(zlib.createGunzip())
  let pending = Buffer.alloc(0) // 尚未消费的字节（跨 chunk 累积，正常只有条目间的少量余量）
  let phase = 'magic'
  let entry = null
  try {
    for await (const chunk of stream) {
      pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk])
      let again = true
      while (again) {
        again = false
        if (phase === 'magic') {
          if (pending.length < PKG_MAGIC.length) break
          if (!pending.subarray(0, PKG_MAGIC.length).equals(PKG_MAGIC)) {
            throw new Error('分发包格式不正确（magic 不匹配）')
          }
          pending = pending.subarray(PKG_MAGIC.length)
          phase = 'header'
          again = true
        } else if (phase === 'header') {
          if (pending.length < 12) break
          const pathLen = pending.readUInt32LE(0)
          if (pending.length < 12 + pathLen) break
          const mode = pending.readUInt32LE(4)
          const size = pending.readUInt32LE(8)
          const rel = pending.subarray(12, 12 + pathLen).toString('utf8')
          pending = pending.subarray(12 + pathLen)
          const dest = safeJoin(rel)
          fs.mkdirSync(path.dirname(dest), { recursive: true }) // 包内只有文件条目，父目录按需建
          entry = { rel, size, written: 0, ws: fs.createWriteStream(dest, { mode: mode || 0o644 }) }
          phase = 'data'
          again = true
        } else { // data
          if (entry.written < entry.size && pending.length === 0) break // 等下一个 chunk
          const take = pending.subarray(0, Math.min(entry.size - entry.written, pending.length))
          entry.written += take.length
          pending = pending.subarray(take.length)
          if (take.length && entry.ws.write(take) === false) {
            stream.pause()
            await once(entry.ws, 'drain')
            stream.resume()
          }
          if (entry.written === entry.size) {
            await new Promise((r) => entry.ws.end(r))
            if (onEntry) onEntry(entry)
            entry = null
            phase = 'header'
          }
          again = true
        }
      }
    }
    if (entry) throw new Error('分发包数据不完整（提前截断）')
  } finally {
    if (entry) entry.ws.destroy() // 中途出错：不留半写句柄
  }
}

// —— 安装任务状态机（进程内单例；服务重启后 task 清空，状态回落到标记文件） ——
let task = null

// 对外状态：任务进行中返回实时进度，否则读 install.json（installed=此前装过且可用）
function installState() {
  if (task) return { ...task }
  try {
    const j = JSON.parse(fs.readFileSync(markerFile(), 'utf8'))
    return { state: 'installed', version: j.version || null, bytesDone: 0, bytesTotal: 0, error: null }
  } catch {
    return { state: 'idle', version: null, bytesDone: 0, bytesTotal: 0, error: null }
  }
}

// 本地分发件安装（重装/修复用；端到点测试也走这里）。expectedSha256 可选。
async function installFromPkg(pkgGz, expectedSha256) {
  fs.mkdirSync(cliRoot(), { recursive: true })
  if (expectedSha256) {
    const sha = await sha256File(pkgGz)
    if (sha !== expectedSha256) throw new Error(`校验和不匹配（期望 ${expectedSha256.slice(0, 12)}…，实际 ${sha.slice(0, 12)}…）`)
  }
  await extractPkg(pkgGz, path.join(cliRoot(), 'node_modules')) // 包内路径相对 node_modules（见 scripts/cli-pkg.js walkFiles）
  const version = readInstalledVersion()
  writeMarker(version)
  return { ok: true, version }
}

function readInstalledVersion() {
  try {
    const pk = JSON.parse(fs.readFileSync(
      path.join(cliRoot(), 'node_modules', '@tencent-ai', 'codebuddy-code', 'package.json'), 'utf8'))
    return pk.version || null
  } catch { return null }
}

function writeMarker(version) {
  const marker = { version, platform: platformKey(), installedAt: Date.now() }
  const tmp = markerFile() + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(marker, null, 2))
  fs.renameSync(tmp, markerFile())
}

// 异步执行安装；进度实时写入 task，供 status 轮询
async function run() {
  const key = platformKey()
  const tmp = path.join(cliRoot(), `download-${key}.pkg.gz.tmp`)
  try {
    fs.mkdirSync(cliRoot(), { recursive: true })
    fs.rmSync(tmp, { force: true }) // 上次中断的残件

    // 1. 平台元数据（版本/文件名/sha256/大小）
    task.state = 'downloading'
    const meta = await fetchMeta(`codebuddy-cli-${key}.json`)
    if (!meta || !meta.file || !meta.sha256) throw new Error('平台元数据格式异常')
    task.version = meta.version || null
    task.bytesTotal = meta.size || 0

    // 2. 下载（进度节流更新：写盘事件频繁，仅整 MB 变化时刷新对象）
    let lastMb = -1
    await downloadTo(meta.file, tmp, (done, total) => {
      const mb = Math.floor(done / (1024 * 1024))
      if (mb !== lastMb) { lastMb = mb; task.bytesDone = done; if (total) task.bytesTotal = total }
    })
    task.bytesDone = task.bytesTotal = fs.statSync(tmp).size

    // 3. 校验
    task.state = 'verifying'
    const sha = await sha256File(tmp)
    if (sha !== meta.sha256) {
      throw new Error(`校验和不匹配（期望 ${meta.sha256.slice(0, 12)}…，实际 ${sha.slice(0, 12)}…），请重试`)
    }

    // 4. 解压 + 落标记
    task.state = 'extracting'
    await extractPkg(tmp, path.join(cliRoot(), 'node_modules'))
    const version = readInstalledVersion() || meta.version || null
    writeMarker(version)
    task.version = version
    task.state = 'done'
  } finally {
    try { fs.rmSync(tmp, { force: true }) } catch { /* 忽略 */ }
  }
}

// 发起安装（非阻塞）；重复调用在任务进行中返回 409 语义
function startInstall() {
  if (task && ACTIVE_STATES.has(task.state)) return { ok: false, error: '已有下载任务进行中' }
  task = { state: 'downloading', version: null, bytesDone: 0, bytesTotal: 0, error: null }
  run().catch((e) => {
    task.state = 'error'
    task.error = e.message
  })
  return { ok: true }
}

module.exports = { installState, startInstall, installFromPkg, cliRoot }
