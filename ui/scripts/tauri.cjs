'use strict'
// tauri CLI 包装脚本（package.json 的 "tauri" 指向这里，用法不变）：
// `npm run tauri dev` 时自动挑选空闲端口，并让 vite（环境变量）与 Tauri 壳（--config 覆盖 devUrl）
// 使用同一端口——避免 5173 被其他项目占用时"串场"或反复死磕杀进程。
// 其他子命令（build 等）原样透传。手动指定端口：npm run tauri dev -- --port 9000
const fs = require('node:fs')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')

const BASE_PORT = 5173
const ROOT = path.resolve(__dirname, '..', '..') // 项目根（src-tauri 所在处，与原 `cd .. && tauri` 一致）

// 探测端口是否空闲（bind 成功即空闲，测完立刻关闭）。
// Windows 上其他进程可能只绑 IPv6（::1）或 IPv4，双栈都空闲才算空闲——只测单边会误报。
function isFree(port, host) {
  return new Promise((resolve) => {
    const srv = net.createServer()
    srv.once('error', () => resolve(false))
    srv.once('listening', () => srv.close(() => resolve(true)))
    srv.listen(port, host)
  })
}

async function isFreeAll(port) {
  return (await isFree(port, '127.0.0.1')) && (await isFree(port, '::1'))
}

async function pickPort(preferred) {
  if (preferred) {
    if (!(await isFreeAll(preferred))) throw new Error(`端口 ${preferred} 被占用，请换一个`)
    return preferred
  }
  for (let p = BASE_PORT; p < BASE_PORT + 10; p++) {
    if (await isFreeAll(p)) return p
  }
  throw new Error(`端口 ${BASE_PORT}~${BASE_PORT + 9} 均被占用，请用 --port 指定或释放一个`)
}

// 从参数中提取 --port N / --port=N（手动指定端口用），其余原样保留
function extractPort(args) {
  let port = null
  const rest = []
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port') { port = Number(args[++i]); continue }
    const m = /^--port=(\d+)$/.exec(args[i])
    if (m) { port = Number(m[1]); continue }
    rest.push(args[i])
  }
  return { port: port && Number.isFinite(port) ? port : null, rest }
}

async function main() {
  const args = process.argv.slice(2)
  // CLI 入口是 bin 指向的 tauri.js（main.js 只是库，require 不会执行命令）
  const cliJs = require.resolve('@tauri-apps/cli/tauri.js') // ui/node_modules/@tauri-apps/cli/tauri.js

  if (args[0] !== 'dev') {
    // build / add 等子命令原样透传
    const child = spawn(process.execPath, [cliJs, ...args], { stdio: 'inherit', cwd: ROOT })
    child.on('exit', (code) => { process.exitCode = code ?? 0 })
    return
  }

  const { port: manual, rest } = extractPort(args.slice(1))
  const port = await pickPort(manual)
  if (port !== BASE_PORT) console.log(`[agentsessions] ${BASE_PORT} 被占用，本次 dev 顺延使用端口 ${port}`)

  // devUrl 覆盖写到临时文件：--config 内联 JSON 在 Windows shell 下引号不可靠，文件路径最稳
  const overrideFile = path.join(os.tmpdir(), `agentsessions-tauri-dev-${process.pid}.json`)
  fs.writeFileSync(overrideFile, JSON.stringify({ build: { devUrl: `http://localhost:${port}` } }))
  process.on('exit', () => { try { fs.unlinkSync(overrideFile) } catch { /* 已清理则忽略 */ } })

  // beforeDevCommand（cd ui && npm run dev）由 tauri CLI 继承本进程 env → vite 读到同端口
  const env = { ...process.env, AGENTSSESSIONS_PORT: String(port) }
  const child = spawn(process.execPath, [cliJs, 'dev', '--config', overrideFile, ...rest], { stdio: 'inherit', cwd: ROOT, env })
  child.on('exit', (code) => { process.exitCode = code ?? 0 })
}

main().catch((e) => { console.error('[agentsessions]', e.message); process.exitCode = 1 })
