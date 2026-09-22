'use strict'
// Agent 探测：探测已安装的AGENTS 清单，
// 但这里是「读」会话存储的探测，只关心「数据存在何处 / 是否能索引」，

const os = require('node:os')
const fs = require('node:fs')
const path = require('node:path')

const HOME = os.homedir()
const IS_WIN = process.platform === 'win32'

function hasDir(rel) {
  try {
    return fs.statSync(path.join(HOME, rel)).isDirectory()
  } catch {
    return false
  }
}

function inPath(bin) {
  // Windows 下 npm 全局 CLI 通常是 .cmd/.bat shim，不能只查 .exe
  const exes = IS_WIN ? [`${bin}.exe`, `${bin}.cmd`, `${bin}.bat`] : [bin]
  return (process.env.PATH || '')
    .split(path.delimiter)
    .some((d) => d && exes.some((e) => fs.existsSync(path.join(d, e))))
}

// 每个 agent 的探测 + 会话/工作目录定位（只读）
// 探测覆盖两层：CLI 配置目录（~/.xxx）与桌面版数据目录（AppData\Roaming\xxx）
const AGENTS = {
  opencode: {
    label: 'OpenCode',
    detect: () => hasDir('.config/opencode') || hasDir('.local/share/opencode') || inPath('opencode'),
    // session 库的候选路径
    dbCandidates: () => [
      path.join(HOME, '.local', 'share', 'opencode', 'opencode.db'),
      path.join(HOME, '.config', 'opencode', 'opencode.db'),
    ],
  },
  'claude-code': {
    label: 'Claude Code',
    detect: () => hasDir('.claude/projects') || inPath('claude'),
    // transcript: ~/.claude/projects/<escaped-cwd>/<sessionId>.jsonl
    sourceDir: () => path.join(HOME, '.claude', 'projects'),
  },
  workbuddy: {
    label: 'WorkBuddy',
    detect: () => hasDir('.workbuddy') || inPath('workbuddy'),
    // transcript: ~/.workbuddy/projects/<cwd>/<uuid>.jsonl
    sourceDir: () => path.join(HOME, '.workbuddy', 'projects'),
  },
  trae: {
    label: 'Trae',
    // CLI（.trae-cn/.trae）或桌面版（Roaming\Trae CN / Roaming\Trae）任一存在即视为已安装
    detect: () => hasDir('.trae-cn') || hasDir('.trae')
      || hasDir('AppData/Roaming/Trae CN') || hasDir('AppData/Roaming/Trae')
      || inPath('traecli') || inPath('trae'),
    // 会话转写走 Claude 式 hook-script.js（~/.trae-cn/hooks.json）；transcript 真实路径待定
    hooks: () => path.join(HOME, '.trae-cn', 'hooks.json'),
  },
  traework: {
    label: 'TRAE SOLO',
    // TraeWork / TRAE SOLO 桌面版（会话为加密 SQLite，基础适配器）
    detect: () => hasDir('AppData/Roaming/TRAE SOLO CN') || hasDir('.traework'),
  },
  codebuddy: {
    label: 'CodeBuddy',
    // CLI 配置（~/.codebuddy）或桌面版（Roaming\CodeBuddy CN）；基础适配器
    detect: () => hasDir('.codebuddy') || hasDir('AppData/Roaming/CodeBuddy CN') || inPath('codebuddy'),
  },
  lingma: {
    label: 'Lingma',
    // 通义灵码（~/.lingma）；基础适配器
    detect: () => hasDir('.lingma'),
  },
  codex: {
    label: 'Codex',
    // Codex CLI（~/.codex）；基础适配器
    detect: () => hasDir('.codex') || inPath('codex'),
  },
}

function detectAll() {
  const out = []
  for (const [id, a] of Object.entries(AGENTS)) {
    if (a.detect()) out.push({ id, label: a.label })
  }
  return out
}

module.exports = { AGENTS, detectAll }