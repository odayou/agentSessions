'use strict'
// Agent 探测：探测已安装的AGENTS 清单，
// 但这里是「读」会话存储的探测，只关心「数据存在何处 / 是否能索引」，

const os = require('node:os')
const fs = require('node:fs')
const path = require('node:path')
const manifest = require('./manifest')

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

// VS Code 系编辑器扩展存储根（…/<editor>/User/globalStorage）：win %APPDATA% / mac Library / linux .config
function globalStorageDir(editor) {
  if (IS_WIN) return path.join(process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming'), editor, 'User', 'globalStorage')
  if (process.platform === 'darwin') return path.join(HOME, 'Library', 'Application Support', editor, 'User', 'globalStorage')
  return path.join(HOME, '.config', editor, 'User', 'globalStorage')
}

// 递归查找名为 <name> 的文件（深度限制 4 层，结果追加到 out）
function walkFiles(root, name, out, depth = 0) {
  if (depth > 4) return
  let entries
  try { entries = fs.readdirSync(root, { withFileTypes: true }) } catch { return }
  for (const ent of entries) {
    const p = path.join(root, ent.name)
    if (ent.isDirectory()) walkFiles(p, name, out, depth + 1)
    else if (ent.isFile() && ent.name === name) out.push(p)
  }
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
  gemini: {
    label: 'Gemini CLI',
    // Gemini CLI（~/.gemini）；新旧双格式（JSONL + 旧版信封 JSON）
    detect: () => hasDir('.gemini/tmp') || hasDir('.gemini') || inPath('gemini'),
    // transcript: ~/.gemini/tmp/<project-hash>/chats/*.json[l]
    sourceDir: () => path.join(HOME, '.gemini', 'tmp'),
  },
  aider: {
    label: 'Aider',
    // Aider 无中心存储（历史 .md 分散在各仓库内）：仅在 PATH 可探测时列出；
    // 实际扫描需用户在设置页 agentPaths.aider 指向仓库/仓库父目录（避免全盘递归）
    detect: () => inPath('aider') || inPath('aider-chat'),
  },
  'copilot-cli': {
    label: 'Copilot CLI',
    // GitHub Copilot CLI（~/.copilot/session-state/<uuid>/events.jsonl + workspace.yaml）
    detect: () => hasDir('.copilot/session-state') || hasDir('.copilot') || inPath('copilot'),
    sourceDir: () => path.join(HOME, '.copilot', 'session-state'),
  },
  cline: {
    label: 'Cline',
    // Cline（~/.cline/data/tasks，三端共用）；旧版 VS Code globalStorage 兜底
    detect: () => hasDir('.cline')
      || fs.existsSync(path.join(globalStorageDir('Code'), 'saoudrizwan.claude-dev')),
  },
  'roo-code': {
    label: 'Roo Code',
    // Roo Code（Cline fork，globalStorage/rooveterinaryinc.roo-cline/tasks）
    detect: () => fs.existsSync(path.join(globalStorageDir('Code'), 'rooveterinaryinc.roo-cline')),
  },
  kiro: {
    label: 'Kiro',
    // Kiro CLI（conversations_v2 SQLite 主通道；~/.kiro/sessions 次要通道暂不覆盖）
    detect: () => hasDir('.kiro') || hasDir('.local/share/kiro-cli') || hasDir('AppData/Local/kiro-cli')
      || inPath('kiro') || inPath('kiro-cli'),
    // CLI SQLite 库候选路径
    dbCandidates: () => [
      path.join(HOME, '.local', 'share', 'kiro-cli', 'data.sqlite3'),
      path.join(HOME, 'AppData', 'Local', 'kiro-cli', 'data.sqlite3'),
    ],
  },
  cursor: {
    label: 'Cursor',
    // Cursor（CLI/IDE）；cursorDiskKV SQLite：~/.cursor/chats/**/store.db + IDE globalStorage state.vscdb
    detect: () => hasDir('.cursor/chats') || hasDir('.cursor')
      || hasDir('AppData/Roaming/Cursor') || hasDir('AppData/Local/Cursor')
      || inPath('cursor') || inPath('cursor-agent'),
    // 每库多会话；scan.js 会遍历全部存在的候选库
    dbCandidates: () => {
      const out = []
      walkFiles(path.join(HOME, '.cursor', 'chats'), 'store.db', out)
      out.push(path.join(HOME, 'AppData', 'Roaming', 'Cursor', 'User', 'globalStorage', 'state.vscdb'))
      out.push(path.join(HOME, 'AppData', 'Local', 'Cursor', 'User', 'globalStorage', 'state.vscdb'))
      out.push(path.join(HOME, '.config', 'Cursor', 'User', 'globalStorage', 'state.vscdb'))
      out.push(path.join(HOME, 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state.vscdb'))
      return out
    },
  },
  'copilot-vscode': {
    label: 'Copilot (VS Code)',
    // GitHub Copilot Chat VS Code 扩展：chatSessions delta journal（OTel agent-traces.db 未见本地实例，待后续）
    detect: () => ['Code', 'Code - OSS', 'VSCodium'].some((ed) => fs.existsSync(path.join(globalStorageDir(ed), 'github.copilot-chat'))),
    // <editor>/User 根：workspaceStorage/<hash>/chatSessions/*.jsonl + globalStorage/emptyWindowChatSessions/*.jsonl
    sourceDir: () => {
      for (const ed of ['Code', 'Code - OSS', 'VSCodium']) {
        const userDir = path.dirname(globalStorageDir(ed));
        if (fs.existsSync(path.join(userDir, 'workspaceStorage'))) return userDir;
      }
      return null;
    },
  },
  'copilot-jetbrains': {
    label: 'Copilot (JetBrains)',
    // GitHub Copilot JetBrains 插件（Nitrite/H2）；占位适配器
    detect: () => hasDir('.config/github-copilot') || hasDir('AppData/Local/github-copilot')
      || hasDir('AppData/Roaming/github-copilot') || hasDir('Library/Application Support/github-copilot'),
  },
  windsurf: {
    label: 'Windsurf',
    // Windsurf（Cascade 内容加密）；占位适配器
    detect: () => hasDir('.codeium') || hasDir('AppData/Roaming/Windsurf/User/globalStorage')
      || hasDir('AppData/Local/Windsurf/User/globalStorage') || hasDir('Library/Application Support/Windsurf/User/globalStorage'),
  },
  antigravity: {
    label: 'Antigravity',
    // Antigravity IDE（加密 SQLite+protobuf）；占位适配器
    detect: () => hasDir('.antigravity') || hasDir('AppData/Roaming/Antigravity')
      || hasDir('AppData/Local/Antigravity') || hasDir('Library/Application Support/Antigravity'),
  },
}

function detectAll(cfg) {
  const out = []
  for (const [id, a] of Object.entries(AGENTS)) {
    if (a.detect()) out.push({ id, label: a.label })
  }
  // 声明式清单 agent（agentList §6.2）：硬编码优先，清单只补位；探测规则走清单 detect.dirs/bins
  for (const m of manifest.loadManifests(cfg)) {
    if (AGENTS[m.id] || out.some((x) => x.id === m.id)) continue
    if (manifest.ruleDetect(m.detect)) out.push({ id: m.id, label: m.label })
  }
  return out
}

// 全量 agent 注册表（设置页 agentPaths 配置列表用）：硬编码 AGENTS 在前，清单 agent 补位，
// 不按探测结果过滤（未安装的也要露出配置行）；运行期新增清单即时可见
function agentRegistry(cfg) {
  const out = []
  for (const [id, a] of Object.entries(AGENTS)) out.push({ id, label: a.label })
  for (const m of manifest.loadManifests(cfg)) {
    if (out.some((x) => x.id === m.id)) continue
    out.push({ id: m.id, label: m.label })
  }
  return out
}

module.exports = { AGENTS, detectAll, agentRegistry }