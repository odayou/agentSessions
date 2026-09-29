'use strict'
// Windsurf 占位适配器（agentList §2.16）
// 探测：src/detect.js（%APPDATA%/Windsurf/User/globalStorage 或 ~/.codeium）
// 存储位置（未解析）：
//   - globalStorage/state.vscdb（VS Code 派生 SQLite，schema 未文档化）
//   - 旧版/补充：~/.codeium/chat_state/*.pbtxt（text-format protobuf）
//   - ~/.codeium/windsurf/session.db（SQLite）
// 障碍：Cascade 会话内容在磁盘上加密，最多只能回退到标题级别
// 解析计划：
//   1. state.vscdb 只读打开，枚举 ItemTable/cursorDiskKV 键名做 schema 调研（可先落地「标题级」索引）
//   2. ~/.codeium/windsurf/session.db 表结构逆向（与 Cursor 同源可复用解析思路）
//   3. pbtxt 文本级提取（旧版会话可能仅此可读）
//   4. 关注官方导出通道 / 社区解密工具进展，落地后替换本占位
module.exports = {
  id: 'windsurf',
  label: 'Windsurf',
  sourceFormat: 'sqlite/vscdb-encrypted',
  placeholder: true, // 设置页显示「已安装 · 暂不支持索引」
}
