'use strict'
// 会话上下文清洗（想法.md §统一agent转交入口 的轻量形态）：
// 不做调度、不路由到具体软件——只把会话清洗成适合作为初始 prompt 的上下文文本，
// 由前端一键复制，用户自行粘贴给任意 Agent。
// 清洗规则：保留标题与用户/助手对话（含代码块）；剔除思考、工具调用、文件变更等噪音；超长截断。
const { sessionDetail } = require('./query')

function cleanContext(dbPath, sessionId) {
  const d = sessionDetail(dbPath, sessionId)
  if (!d) return null
  const L = ['你将接续一段来自其他工具的历史编码会话。请先阅读以下上下文，然后继续协助用户。', '']
  if (d.title) L.push(`会话主题：${d.title}`, '')
  if (d.cwd) L.push(`工作目录：${d.cwd}`, '')
  for (const t of d.turns) {
    if (t.userMessage) L.push('## 用户', '', t.userMessage, '')
    if (t.assistantMessage) L.push('## 助手', '', t.assistantMessage, '')
  }
  let text = L.join('\n')
  if (text.length > 120000) text = text.slice(0, 120000) + '\n…(上下文过长已截断)'
  return { ok: true, title: d.title, text }
}

module.exports = { cleanContext }
