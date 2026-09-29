'use strict'
// GitHub Copilot Chat（JetBrains 系列）占位适配器（agentList §2.9.2）
// 探测：src/detect.js（~/.config/github-copilot 或 %LOCALAPPDATA%/github-copilot）
// 存储位置（未解析）：~/.config/github-copilot/<ide>/<kind>/<storeId>/copilot-*-nitrite.db
// 格式：Nitrite（H2 MVStore），与 VS Code 的 JSONL/SQLite 完全不同，无法直读
// 解析计划：
//   1. 上游推荐路径是通过 copilot-jetbrains-exporter 导出为 JSONL（agentsview 同款做法）
//   2. 落地方式二选一：接入外部进程适配器协议（agentList §6.2 external 引擎，stdin 收
//      {"op":"scan"}、stdout 逐行 {"item":UnifiedSession}），由导出脚本桥接；
//      或用户把导出输出目录配到 agentPaths 后走通用 JSONL 引擎
//   3. <ide>/<kind>/<storeId> 路径层级可还原 IDE 与项目归属
module.exports = {
  id: 'copilot-jetbrains',
  label: 'Copilot (JetBrains)',
  sourceFormat: 'nitrite/h2-mvstore',
  placeholder: true, // 设置页显示「已安装 · 暂不支持索引」
}
