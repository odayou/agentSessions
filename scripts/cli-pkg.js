'use strict'
// CodeBuddy CLI 运行时分发件构建（云端组件按需下载方案的打包侧）：
// - copyCliTree(nm, staging, target)：按 package.json 依赖树把 @tencent-ai/codebuddy-code
//   复制到暂存目录（vendor 平台二进制按 target 裁剪）
// - buildPkg(staging, outGz)：打成自研 .pkg.gz 单文件——不引 zip/tar 依赖（项目约定仅
//   better-sqlite3 一个运行时依赖），用 Node 内置 zlib 流式压缩；条目格式：
//     [pathLen u32le][mode u32le][size u32le][path utf8][data]
//   两端（CI 打包 / 客户端解压）都是本项目代码，格式私有但极简，流式读写内存可控
// - buildCliDist：一步产出 <platform>-<arch> 的 .pkg.gz + 元数据 json（version/sha256/size）
// 消费方：scripts/build-cli-pkg.js（CI 手动入口）、src/cli-installer.js（客户端解压）
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const zlib = require('node:zlib')
const { once } = require('node:events')

const PKG_MAGIC = Buffer.from('ASCBPKG1\n', 'utf8')
const CLI_PKG_DIR = path.join('@tencent-ai', 'codebuddy-code')

// 平台键：win32-x64 / darwin-arm64 / linux-x64 ...（客户端与 CI 两侧同构）
function platformKey(platform = process.platform, arch = process.arch) {
  const p = platform === 'win32' ? 'win32' : platform === 'darwin' ? 'darwin' : 'linux'
  return `${p}-${arch}`
}

// 从 fromDir 出发按 Node 解析规则向上找包（包内 node_modules 优先，逐级到根）
function resolvePkg(fromDir, name, rootNm) {
  let cur = fromDir
  while (true) {
    const cand = path.join(cur, 'node_modules', name)
    if (fs.existsSync(path.join(cand, 'package.json'))) return cand
    const next = path.dirname(cur)
    if (next === cur) return null
    cur = next
    if (path.relative(rootNm, cur) === '' || path.relative(rootNm, cur).startsWith('..')) {
      const top = path.join(rootNm, name)
      return fs.existsSync(path.join(top, 'package.json')) ? top : null
    }
  }
}

// 复制 CLI 依赖树到暂存目录（保留相对路径含嵌套安装结构）。
// target 指定目标平台：vendor/<tool>/<平台> 只留当前平台二进制（COPYING 许可证保留）。
// optional 原生包（node-pty 等）npm 安装时已按当前平台过滤，天然只含对应平台——
// 因此各平台的分发件必须在对应平台的 runner 上构建。
function copyCliTree(rootNm, staging, target = { platform: process.platform, arch: process.arch }) {
  const root = path.join(rootNm, CLI_PKG_DIR)
  if (!fs.existsSync(path.join(root, 'package.json'))) {
    throw new Error(`缺少 ${CLI_PKG_DIR}，请先在根目录 npm install`)
  }
  const platKeep = {
    ripgrep: target.platform === 'win32' ? 'x64-win32'
      : target.platform === 'darwin' ? (target.arch === 'arm64' ? 'arm64-darwin' : 'x64-darwin')
      : (target.arch === 'arm64' ? 'arm64-linux' : 'x64-linux'),
    'genie-trash': target.platform === 'win32' ? 'win32-x64.exe'
      : target.platform === 'darwin' ? (target.arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64')
      : (target.arch === 'arm64' ? 'linux-arm64' : 'linux-x64'),
  }
  const ROOT_SKIP = new Set(['types', 'CHANGELOG.md', 'README.md'])
  const filter = (entry, src) => {
    if (src === root && ROOT_SKIP.has(entry.name)) return true
    const tool = path.basename(src)
    if (path.basename(path.dirname(src)) === 'vendor' && platKeep[tool]
      && entry.name !== platKeep[tool] && entry.name !== 'COPYING') return true
    return false
  }
  const seen = new Set()
  const queue = [root]
  while (queue.length) {
    const pkgDir = queue.shift()
    if (seen.has(pkgDir)) continue
    seen.add(pkgDir)
    const dest = path.join(staging, path.relative(rootNm, pkgDir))
    copyDir(pkgDir, dest, filter)
    const pk = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'))
    const deps = { ...pk.dependencies, ...pk.optionalDependencies, ...pk.peerDependencies }
    for (const name of Object.keys(deps)) {
      const r = resolvePkg(pkgDir, name, rootNm)
      if (r) queue.push(r) // 解析不到的 optional/peer 依赖直接跳过
    }
  }
}

function copyDir(src, dest, filter) {
  fs.mkdirSync(dest, { recursive: true })
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (filter && filter(entry, src)) continue
    const s = path.join(src, entry.name)
    const d = path.join(dest, entry.name)
    if (entry.isDirectory()) copyDir(s, d, filter)
    else fs.copyFileSync(s, d)
  }
}

function walkFiles(dir, relPrefix, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name)
    let rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name // 统一 / 分隔，跨平台一致
    // 包内路径约定：相对 node_modules 的扁平路径（copyCliTree 产出即如此），嵌套安装时
    // rel 会带 node_modules/ 前缀，统一剥离，保证解压端按 node_modules/<pkg> 直落
    if (rel.startsWith('node_modules/')) rel = rel.slice('node_modules/'.length)
    if (entry.isDirectory()) walkFiles(abs, rel, out)
    else out.push({ abs, rel })
  }
  return out
}

// 打包：staging 目录 → .pkg.gz（gzip 流式，条目逐个写入，backpressure 用 drain 控制）
async function buildPkg(staging, outGz) {
  const files = walkFiles(staging, '', [])
  const gz = zlib.createGzip({ level: 9 })
  const out = fs.createWriteStream(outGz)
  const failed = new Promise((_, reject) => {
    gz.once('error', reject)
    out.once('error', reject)
  })
  gz.pipe(out)
  gz.write(PKG_MAGIC)
  for (const f of files) {
    const st = fs.statSync(f.abs)
    const pb = Buffer.from(f.rel, 'utf8')
    const header = Buffer.alloc(12)
    header.writeUInt32LE(pb.length, 0)
    header.writeUInt32LE(st.mode & 0o777, 4)
    header.writeUInt32LE(st.size, 8)
    if (gz.write(header) === false) await once(gz, 'drain')
    if (gz.write(pb) === false) await once(gz, 'drain')
    const data = fs.readFileSync(f.abs) // 单文件最大十几 MB，整体读可接受
    if (data.length !== st.size) throw new Error(`文件大小变化：${f.rel}`)
    if (gz.write(data) === false) await once(gz, 'drain')
  }
  gz.end()
  await Promise.race([once(out, 'finish'), failed])
  return files.length
}

function sha256FileSync(file) {
  const h = crypto.createHash('sha256')
  h.update(fs.readFileSync(file))
  return h.digest('hex')
}

// 一步产出分发件：复制依赖树 → .pkg.gz → 元数据 json，清理暂存
async function buildCliDist(nmDir, outDir, opts = {}) {
  const key = platformKey(opts.platform, opts.arch)
  fs.mkdirSync(outDir, { recursive: true })
  const staging = path.join(outDir, `.staging-${key}`)
  fs.rmSync(staging, { recursive: true, force: true })
  try {
    copyCliTree(nmDir, staging, { platform: opts.platform || process.platform, arch: opts.arch || process.arch })
    const pk = JSON.parse(fs.readFileSync(path.join(staging, CLI_PKG_DIR, 'package.json'), 'utf8'))
    const gzName = `codebuddy-cli-${key}.pkg.gz`
    const outGz = path.join(outDir, gzName)
    const count = await buildPkg(staging, outGz)
    const size = fs.statSync(outGz).size
    const sha256 = sha256FileSync(outGz)
    const manifest = { key, version: pk.version || null, file: gzName, sha256, size, files: count, builtAt: new Date().toISOString() }
    const manifestFile = path.join(outDir, `codebuddy-cli-${key}.json`)
    fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2))
    return { key, ...manifest, outGz, manifestFile }
  } finally {
    fs.rmSync(staging, { recursive: true, force: true })
  }
}

module.exports = { PKG_MAGIC, platformKey, copyCliTree, buildPkg, buildCliDist, sha256FileSync }
