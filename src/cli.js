#!/usr/bin/env node
'use strict'
// CLI 入口：scan / search / list
const { runScan } = require('./scan')
const { search } = require('./search')
const { detectAll } = require('./detect')
const { defaultDbPath } = require('./index')

function usage() {
  console.log(`用法：
  node src/cli.js detect                 # 列出探测到的 agent
  node src/cli.js scan [--only <agent>] [--db <path>]
  node src/cli.js search <关键词> [--depth 1|2|3|4] [--account <id>] [--project <id>] [--agent <id>] [--limit N] [--db <path>]`)
}

function main() {
  const [, , cmd, ...rest] = process.argv
  const opt = {}
  const positional = []
  for (let i = 0; i < rest.length; i++) {
    if (rest[i].startsWith('--')) {
      const key = rest[i].slice(2)
      const val = rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[++i] : true
      opt[key] = val
    } else positional.push(rest[i])
  }
  const dbPath = opt.db || defaultDbPath()

  switch (cmd) {
    case 'detect': {
      const d = detectAll()
      console.log('检测到 agent：', d.length ? d.map((a) => a.label).join(', ') : '（无）')
      break
    }
    case 'scan': {
      console.log(`数据库：${dbPath}`)
      const res = runScan(dbPath, { only: opt.only })
      if (!res.ok) { console.error('扫描失败：', res.error); process.exit(1) }
      for (const a of res.stats.agents) {
        console.log(`  ${a.label.padEnd(12)} ${a.status}${a.sessions != null ? ` (${a.sessions} 会话)` : ''}`)
      }
      console.log(`共 ${res.stats.sessions} 会话, ${res.stats.turns} 轮次`)
      break
    }
    case 'search': {
      const q = positional[0]
      if (!q) { console.error('search 需要关键词'); usage(); process.exit(1) }
      const depth = Number(opt.depth) || 2
      const res = search(dbPath, {
        q,
        depth,
        account: opt.account,
        projectId: opt.project,
        agentId: opt.agent,
        limit: Number(opt.limit) || 30,
      })
      console.log(`搜索「${q}」 depth=${depth}，命中 ${res.total}：`)
      for (const h of res.hits) {
        console.log(`  [${h.agent_id}] ${h.title || '(无标题)'}  <${h.project}>`)
        if (h.subject || h.subj) console.log(`      主题: ${h.subject || h.subj}`)
        if (h.assistant_message) console.log(`      正文: ${String(h.assistant_message).slice(0, 80)}`)
      }
      break
    }
    default:
      usage()
      if (cmd) process.exit(1)
  }
}

main()