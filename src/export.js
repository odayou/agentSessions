'use strict'
// 会话导出：按会话导出 Markdown / JSON。只读，会话读取复用 query.sessionDetail。
const { sessionDetail } = require('./query')

function baseName(s, ext) {
  const safe = (s.title || `${s.agentId}-${s.agentSessionId}`)
    .replace(/[\\/:*?"<>|]/g, '_').slice(0, 80)
  return `${safe}${ext}`
}

function toMarkdown(d) {
  const L = []
  L.push(`# ${d.title || '(无标题)'}`)
  L.push('')
  const meta = []
  if (d.agentId) meta.push(`- **Agent**: ${d.agentId}`)
  if (d.account) meta.push(`- **账号**: ${d.account}`)
  if (d.project) meta.push(`- **项目**: ${d.project}`)
  if (d.model) meta.push(`- **模型**: ${d.model}`)
  if (d.rawFormat) meta.push(`- **原格式**: ${d.rawFormat}`)
  if (d.sourceNote) meta.push(`- **说明**: ${d.sourceNote}`)
  if (d.cwd) meta.push(`- **工作目录**: \`${d.cwd}\``)
  if (d.createdAt) meta.push(`- **创建**: ${new Date(d.createdAt).toLocaleString('zh-CN')}`)
  if (d.updatedAt) meta.push(`- **更新**: ${new Date(d.updatedAt).toLocaleString('zh-CN')}`)
  if (meta.length) { L.push(...meta); L.push('') }
  if (d.subject) { L.push(`**会话主题**: ${d.subject}`); L.push('') }
  if (d.subjects && d.subjects.length) {
    L.push('## 主题')
    L.push('')
    L.push(d.subjects.map((s) => `- ${s.subject}`).join('\n'))
    L.push('')
  }
  L.push('## 对话')
  for (const t of d.turns) {
    L.push('')
    if (t.userMessage) {
      L.push('### 用户')
      L.push('')
      L.push(t.userMessage)
    }
    if (t.thinking) {
      L.push('')
      L.push('<details>')
      L.push('<summary>思考过程</summary>')
      L.push('')
      L.push(t.thinking)
      L.push('</details>')
    }
    if (t.assistantMessage) {
      L.push('')
      L.push('### 助手')
      L.push('')
      L.push(t.assistantMessage)
    }
    if (t.toolInput) {
      L.push('')
      L.push('### 工具调用')
      L.push('')
      L.push('```json')
      L.push(t.toolInput)
      L.push('```')
    }
  }
  return L.join('\n')
}

// format: 'md' | 'json'
function exportSession(dbPath, sessionId, format = 'md') {
  const d = sessionDetail(dbPath, sessionId)
  if (!d) return null
  if (format === 'json') {
    return { format: 'json', name: baseName(d, '.json'), content: JSON.stringify(d, null, 2) }
  }
  return { format: 'md', name: baseName(d, '.md'), content: toMarkdown(d) }
}

module.exports = { exportSession }
