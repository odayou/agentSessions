#!/usr/bin/env node
'use strict'
// CI 用：产出当前平台的 CodeBuddy CLI 分发件（.pkg.gz + 元数据 json）。
// 产物随版本发布挂到 GitHub Release，客户端（src/cli-installer.js）在设置页
// 显式触发按需下载、校验后安装到 ~/.agentsessions/cli/。
// 注意：optional 原生依赖在 npm install 时按当前平台过滤，因此各平台分发件
// 必须在对应平台的 runner 上构建（build.yml 的三平台矩阵各自执行本脚本）。
// 用法：node scripts/build-cli-pkg.js [--out dist-cli] [--platform win32] [--arch x64]
const path = require('node:path')
const { buildCliDist } = require('./cli-pkg')

function argVal(flag) {
  const i = process.argv.indexOf(flag)
  return i >= 0 ? process.argv[i + 1] : null
}

async function main() {
  const out = argVal('--out') || 'dist-cli'
  const platform = argVal('--platform') || process.platform
  const arch = argVal('--arch') || process.arch
  const nm = path.join(__dirname, '..', 'node_modules')
  const r = await buildCliDist(nm, path.resolve(out), { platform, arch })
  console.log(`[build-cli-pkg] ${r.key} v${r.version} -> ${r.outGz} (${(r.size / 1024 / 1024).toFixed(1)} MB, ${r.files} files, sha256 ${r.sha256.slice(0, 16)}…)`)
  console.log(`[build-cli-pkg] manifest -> ${r.manifestFile}`)
}

main().catch((e) => {
  console.error('[build-cli-pkg] 失败：' + e.message)
  process.exit(1)
})
