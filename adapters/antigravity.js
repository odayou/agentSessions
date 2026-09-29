'use strict'
// Antigravity 占位适配器（agentList §一/§2.3 演进说明）
// 探测：src/detect.js（%APPDATA%/Antigravity 或 ~/.antigravity）
// 存储位置（未解析）：复用 Gemini 演进格式——SQLite + protobuf（trajectory），旧版为 AES-GCM 加密的 .pb 文件
// 解析计划：
//   1. 社区 agy-reader 工具可解密并导出 trajectory.json sidecar——优先调研其解密流程能否内置（只读）
//   2. 若解密不可内置，考虑外部进程适配器协议（agentList §6.2 external 引擎）桥接 agy-reader
//   3. 项目归属：SQLite session 表的 cwd/项目列（待 schema 逆向确认）
//   4. 落地前不产生任何解析流量，仅探测安装状态
module.exports = {
  id: 'antigravity',
  label: 'Antigravity',
  sourceFormat: 'sqlite+protobuf/encrypted',
  placeholder: true, // 设置页显示「已安装 · 暂不支持索引」
}
