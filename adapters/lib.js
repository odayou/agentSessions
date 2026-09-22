'use strict'
// 适配器共享工具：目录内递归找 .jsonl 源文件 + 会话级主题（L2 种子）聚合。
const fs = require('node:fs')
const path = require('node:path')

// 递归列出 root 下所有 .jsonl 文件（不可读目录跳过）
function findJsonlFiles(root) {
  const out = []
  if (!fs.existsSync(root)) return out
  try {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      const p = path.join(root, entry.name)
      if (entry.isDirectory()) out.push(...findJsonlFiles(p))
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) out.push(p)
    }
  } catch { /* 跳过不可读 */ }
  return out
}

// 轮次主题 → 会话级主题列表：去重，剔除无信息量归类（other/learning_qa）
function buildSubjects(turns) {
  return turns
    .filter((t) => t.subject && t.subject !== 'other' && t.subject !== 'learning_qa')
    .reduce((acc, t) => (acc.includes(t.subject) ? acc : acc.concat(t.subject)), [])
    .map((subject) => ({ layer: 2, subject, parentId: null }))
}

module.exports = { findJsonlFiles, buildSubjects }
