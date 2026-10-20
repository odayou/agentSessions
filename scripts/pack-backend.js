'use strict'
// 组装桌面版后端载荷 → src-tauri/backend/
// 内容：node.exe(当前运行时) + server.js + src/ + adapters/ + 运行时 node_modules
// 由 tauri.conf.json 的 beforeBuildCommand 自动调用；产物目录已 gitignore。
// 自带 node.exe 使安装包零依赖（且与 better-sqlite3 原生模块 ABI 严格一致）。
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const OUT = path.join(ROOT, 'src-tauri', 'backend')

// better-sqlite3 运行时只需 build/Release/better_sqlite3.node 与 js 入口，
// 裁掉 sqlite 源码 amalgamation 等大件（deps/ 约 10MB+）
const PRUNE_DIRS = new Set(['deps', 'src', 'docs', 'benchmark', 'prebuilds', 'test'])
const PRUNE_FILES = new Set(['.github', '.bin'])

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

// Windows 清理竞态兜底：刚写入的文件可能被杀软/索引器短暂持有句柄，rmSync 偶发
// ENOTEMPTY/EBUSY/EPERM——短退避重试（构建脚本场景足够）
function rmTree(p, tries = 5) {
  for (let i = 0; ; i++) {
    try {
      fs.rmSync(p, { recursive: true, force: true })
      return
    } catch (e) {
      if (i >= tries - 1 || !['ENOTEMPTY', 'EBUSY', 'EPERM', 'EACCES'].includes(e.code)) throw e
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100 * (i + 1))
    }
  }
}

function dirSize(p) {
  let total = 0
  for (const entry of fs.readdirSync(p, { withFileTypes: true })) {
    const f = path.join(p, entry.name)
    total += entry.isDirectory() ? dirSize(f) : fs.statSync(f).size
  }
  return total
}

// —— CodeBuddy CLI（@tencent-ai/codebuddy-code）依赖树复制 ——
// 从 CLI 包出发，按各包 package.json 的 dependencies/optionalDependencies/peerDependencies
// 递归解析（Node 解析规则：包内 node_modules 优先，逐级向上到根 node_modules）并复制，
// 保留相对路径（含嵌套安装结构）。optional 原生包（node-pty/sandbox-cli）npm 安装时已按
// 平台过滤，天然只含当前平台。
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

function copyCliTree(rootNm, outNm) {
  const root = path.join(rootNm, '@tencent-ai', 'codebuddy-code')
  if (!fs.existsSync(path.join(root, 'package.json'))) {
    console.error('[pack-backend] 缺少 @tencent-ai/codebuddy-code，请先在根目录 npm install')
    process.exit(1)
  }
  // 复制期裁剪（替代"复制后再删除"）：Windows 上删除刚写入的文件存在杀软/索引器持句柄竞态
  //（实测 rmSync 对新复制文件偶发 ENOTEMPTY/EPERM 且重试难愈），复制时直接跳过，竞态窗口不复存在
  const plat = process.platform
  const arch = process.arch
  const ROOT_SKIP = new Set(['types', 'CHANGELOG.md', 'README.md'])
  const platKeep = {
    ripgrep: plat === 'win32' ? 'x64-win32' : plat === 'darwin' ? (arch === 'arm64' ? 'arm64-darwin' : 'x64-darwin') : (arch === 'arm64' ? 'arm64-linux' : 'x64-linux'),
    'genie-trash': plat === 'win32' ? 'win32-x64.exe' : plat === 'darwin' ? (arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64') : (arch === 'arm64' ? 'linux-arm64' : 'linux-x64'),
  }
  const filter = (entry, src) => {
    // CLI 根包：非运行时文件不复制
    if (src === root && ROOT_SKIP.has(entry.name)) return true
    // vendor 平台裁剪：<pkg>/vendor/<tool>/<platform>，非当前平台二进制不复制（COPYING 许可证保留）
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
    const dest = path.join(outNm, path.relative(rootNm, pkgDir))
    copyDir(pkgDir, dest, filter)
    const pk = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'))
    const deps = { ...pk.dependencies, ...pk.optionalDependencies, ...pk.peerDependencies }
    for (const name of Object.keys(deps)) {
      const r = resolvePkg(pkgDir, name, rootNm)
      if (r) queue.push(r) // 解析不到的 optional/peer 依赖直接跳过
    }
  }
}

function main() {
  rmTree(OUT)
  fs.mkdirSync(OUT, { recursive: true })

  // 1. 后端代码
  fs.copyFileSync(path.join(ROOT, 'server.js'), path.join(OUT, 'server.js'))
  fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(OUT, 'package.json'))
  copyDir(path.join(ROOT, 'src'), path.join(OUT, 'src'))
  copyDir(path.join(ROOT, 'adapters'), path.join(OUT, 'adapters'))

  // 2. 运行时依赖（better-sqlite3 裁剪，bindings/file-uri-to-path 原样）
  const nm = path.join(ROOT, 'node_modules')
  const outNm = path.join(OUT, 'node_modules')
  copyDir(path.join(nm, 'better-sqlite3'), path.join(outNm, 'better-sqlite3'),
    (e) => e.isDirectory() && PRUNE_DIRS.has(e.name))
  copyDir(path.join(nm, 'bindings'), path.join(outNm, 'bindings'))
  copyDir(path.join(nm, 'file-uri-to-path'), path.join(outNm, 'file-uri-to-path'))
  // 2.5 CodeBuddy CLI 及其依赖树（vendor 按平台裁剪）
  copyCliTree(nm, outNm)

  // 3. Node 运行时（与上面原生模块的编译 ABI 一致）
  const nodeExe = process.execPath
  fs.copyFileSync(nodeExe, path.join(OUT, 'node.exe'))
  // mac/linux 产物需保留可执行位（copyFileSync 不保证），否则安装包内的 node 无法启动
  if (process.platform !== 'win32') fs.chmodSync(path.join(OUT, 'node.exe'), 0o755)

  // 4. 自检：原生模块必须在
  const native = path.join(outNm, 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node')
  if (!fs.existsSync(native)) {
    console.error('[pack-backend] 缺少 better_sqlite3.node，请先在根目录 npm install')
    process.exit(1)
  }

  const mb = (dirSize(OUT) / 1024 / 1024).toFixed(1)
  console.log(`[pack-backend] 后端载荷已生成 src-tauri/backend/（${mb} MB，node ${process.version}）`)
}

main()
