'use strict'
// Cline 适配器（agentList §2.10）：~/.cline/data/tasks/<taskId>/（VS Code / CLI / JetBrains 三端共用）
//   每任务目录含 api_conversation_history.json（Anthropic 原始消息数组）+ task_metadata.json + ui_messages.json
//   旧版存储回落 VS Code globalStorage saoudrizwan.claude-dev/tasks/（§2.10 异常说明）
//   共享解析逻辑见 adapters/lib.js parseClineStyleTaskDir（Roo Code 同构复用）
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { parseClineStyleTaskDir, listClineTaskFiles } = require('./lib')

const DATA_TASKS = path.join(os.homedir(), '.cline', 'data', 'tasks')
// 旧版 VS Code 扩展存储（新版已迁移 ~/.cline/data/）
const LEGACY_TASKS = process.platform === 'win32'
  ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev', 'tasks')
  : (process.platform === 'darwin'
    ? path.join(os.homedir(), 'Library', 'Application Support', 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev', 'tasks')
    : path.join(os.homedir(), '.config', 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev', 'tasks'))

// 列出源文件（= 各任务的 api_conversation_history.json，作增量指纹）；手动 agentPaths 优先。
// 默认根（未手动指定，或指定为默认目录）时新旧双位置都扫：
// scan.js 会传 adapter.sourceDir（恒为 DATA_TASKS），不能以「dir 有值」判定为手动覆盖，
// 否则旧版 VS Code globalStorage 分支（LEGACY_TASKS）永远不可达
function sources(dir) {
  const roots = !dir || dir === DATA_TASKS ? [DATA_TASKS, LEGACY_TASKS] : [dir]
  const out = []
  for (const root of roots) out.push(...listClineTaskFiles(root))
  return out
}

// 解析单个源文件为一个 UnifiedSession（增量扫描用）
function parseFile(file) {
  return parseClineStyleTaskDir(path.dirname(file))
}

// 扫描任务目录（保留与其他适配器一致的 scan 接口）
function scan(sourceDir) {
  const out = []
  for (const file of sources(sourceDir)) {
    const item = parseFile(file)
    if (item) out.push(item)
  }
  return out
}

module.exports = { scan, sources, parseFile, id: 'cline', label: 'Cline', sourceDir: DATA_TASKS, sourceFormat: 'json/cline-task' }
