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
    if (filter && filter(entry)) continue
    const s = path.join(src, entry.name)
    const d = path.join(dest, entry.name)
    if (entry.isDirectory()) copyDir(s, d, filter)
    else fs.copyFileSync(s, d)
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

function main() {
  fs.rmSync(OUT, { recursive: true, force: true })
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

  // 3. Node 运行时（与上面原生模块的编译 ABI 一致）
  const nodeExe = process.execPath
  fs.copyFileSync(nodeExe, path.join(OUT, 'node.exe'))

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
