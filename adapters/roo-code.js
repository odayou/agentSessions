'use strict'
// Roo Code 适配器（agentList §2.11）：%APPDATA%/Code/User/globalStorage/rooveterinaryinc.roo-cline/tasks/
//   每任务目录含 api_conversation_history.json + ui_messages.json + history_item.json（Roo 特有历史项）
//   与 Cline 解析高度同构（扩展 ID 不同），共享 adapters/lib.js parseClineStyleTaskDir；
//   checkpoint 会在任务目录内建完整 git 仓库（可达 40GB+），listClineTaskFiles 只认
//   api_conversation_history.json，天然跳过 checkpoint 相关文件
const path = require('node:path')
const os = require('node:os')
const { parseClineStyleTaskDir, listClineTaskFiles } = require('./lib')

// VS Code 系扩展存储根（win/mac/linux）
const GLOBAL_STORAGE = process.platform === 'win32'
  ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Code', 'User', 'globalStorage')
  : (process.platform === 'darwin'
    ? path.join(os.homedir(), 'Library', 'Application Support', 'Code', 'User', 'globalStorage')
    : path.join(os.homedir(), '.config', 'Code', 'User', 'globalStorage'))

const ROO_TASKS = path.join(GLOBAL_STORAGE, 'rooveterinaryinc.roo-cline', 'tasks')

// 列出源文件（= 各任务的 api_conversation_history.json，作增量指纹）；手动 agentPaths 优先
function sources(dir) {
  return listClineTaskFiles(dir || ROO_TASKS)
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

module.exports = { scan, sources, parseFile, id: 'roo-code', label: 'Roo Code', sourceDir: ROO_TASKS, sourceFormat: 'json/roo-task' }
