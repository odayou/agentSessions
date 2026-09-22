'use strict'
// 采集编排：detect → 各已装 agent 适配器 → 统一落库（增量优先：按源文件 mtime+size 指纹跳过未变更）
const fs = require('node:fs')
const { detectAll, AGENTS } = require('./detect')
const { openStore } = require('./model')
const store = require('./store')
const config = require('./config')

// Agent → 适配器映射
const ADAPTERS = {
  opencode: './../adapters/opencode',
  'claude-code': './../adapters/claude-code',
  workbuddy: './../adapters/workbuddy',
  trae: './../adapters/trae',
  traework: './../adapters/traework',
  codebuddy: './../adapters/codebuddy',
  lingma: './../adapters/lingma',
  codex: './../adapters/codex',
}

// 把一批 session item 落库；返回 { sessions, turns }（项目 cwd 命中排除规则则跳过）
function persist(db, id, adapter, sessions, cfg) {
  const c = cfg || config.loadConfig()
  const out = { sessions: 0, turns: 0 }
  for (const item of sessions) {
    if (config.isExcluded(c, item.project.cwd)) continue // 按项目路径排除（db 源只能在此处拦）
    const projectId = store.upsertProject(db, { cwd: item.project.cwd, name: item.project.name })
    // 账号：适配器可提供 raw account 名（默认 local）；再经配置映射归一化
    const rawName = (item.session && item.session.account) || 'local'
    const acc = config.applyAccountMapping(c, id, rawName)
    const accountId = store.upsertAccount(db, { agentId: id, rawName, displayName: acc.displayName, kind: acc.kind })
    const sessionId = store.upsertSession(db, {
      id: `${id}:${item.session.agentSessionId}`,
      agentId: id,
      agentSessionId: item.session.agentSessionId,
      projectId,
      accountId,
      cwd: item.session.cwd,
      title: item.session.title,
      subject: item.subjects[0] ? item.subjects[0].subject : null,
      model: item.session.model,
      createdAt: item.session.createdAt,
      // 会话最后活动时间（适配器可提供，缺省回落到创建时间）——时间过滤/列表排序依据
      updatedAt: item.session.updatedAt || item.session.createdAt,
      turnCount: item.turns.length,
      sourceFile: item.session.sourceFile,
      rawFormat: adapter.sourceFormat || 'unknown',
      parentSubject: null,
      tags: null,
      // 来源标注折叠进 notes（trae 压缩记忆等说明）
      notes: (item.session.meta && item.session.meta.note) || null,
    })
    store.replaceTurns(db, sessionId, item.turns, item.subjects)
    out.sessions++
    out.turns += item.turns.length
  }
  return out
}

// 源文件指纹：mtime(ms)+size，未记录或变更则返回 true
// maxSizeMB > 0 时超大文件直接返回 false（跳过解析，不记指纹，调大阈值后可重新索引）
function isChanged(db, agentId, file, maxSizeMB) {
  try {
    const st = fs.statSync(file)
    if (maxSizeMB > 0 && st.size > maxSizeMB * 1024 * 1024) return false
    const mtime = st.mtimeMs
    const size = st.size
    const prev = store.getScanState(db, file)
    if (prev && prev.mtime_ms === mtime && prev.size === size) return false
    store.setScanState(db, file, agentId, mtime, size)
    return true
  } catch {
    return true // 无法 stat（如删除）→ 保守处理为变更
  }
}

// 扫描链路，返回统计；opts.cfg 可注入配置（点测用，缺省读全局配置）
function runScan(dbPath, { only, cfg } = {}) {
  const db = openStore(dbPath)
  const detected = detectAll()
  const cfg2 = cfg || config.loadConfig()
  // agentPaths 手动配置（readme §F：自定义目录优先于自动检测；路径存在的未装 agent 也纳入扫描）
  for (const [id, p] of Object.entries(cfg2.agentPaths || {})) {
    if (ADAPTERS[id] && fs.existsSync(p) && !detected.find((d) => d.id === id)) {
      detected.push({ id, label: AGENTS[id].label })
    }
  }
  const maxMB = cfg2.maxFileSizeMB
  const stats = { agents: [], sessions: 0, turns: 0 }
  try {
    // 排除规则（S8）：先清理已索引的命中存量（含指纹），再在采集时跳过命中文件
    const excluded = store.applyExcludes(db, (p) => config.isExcluded(cfg2, p))
    if (excluded > 0) stats.excluded = excluded
    for (const { id } of detected) {
      if (only && id !== only) continue
      const adapterPath = ADAPTERS[id]
      if (!adapterPath) continue
      const adapter = require(adapterPath)
      if (adapter.placeholder) {
        stats.agents.push({ id, label: adapter.label, status: 'placeholder' })
        continue
      }

      let sc = 0
      let tc = 0
      if (AGENTS[id].dbCandidates) {
        // sqlite 源（opencode）：整个库一次性扫描 + 记录该库文件指纹；手动路径优先
        const manual = (cfg2.agentPaths || {})[id]
        const candidates = [manual, ...AGENTS[id].dbCandidates()].filter(Boolean)
        const dbFile = candidates.find((p) => fs.existsSync(p))
        if (dbFile && !config.isExcluded(cfg2, dbFile) && isChanged(db, id, dbFile, maxMB)) {
          const r = persist(db, id, adapter, adapter.scan(dbFile), cfg2)
          sc = r.sessions; tc = r.turns
        }
      } else if (adapter.sources && adapter.parseFile) {
        // jsonl 目录源（workbuddy/trae）：逐文件指纹，仅解析已变更文件；手动路径优先
        const root = (cfg2.agentPaths || {})[id] || adapter.sourceDir || AGENTS[id].sourceDir()
        for (const file of adapter.sources(root)) {
          if (config.isExcluded(cfg2, file)) continue // 按源文件路径排除
          if (!isChanged(db, id, file, maxMB)) continue // 未变更/超大文件跳过
          const item = adapter.parseFile(file)
          if (item) {
            const r = persist(db, id, adapter, [item], cfg2)
            sc += r.sessions; tc += r.turns
          }
        }
      }
      stats.sessions += sc
      stats.turns += tc
      stats.agents.push({ id, label: adapter.label, status: 'ok', sessions: sc, turns: tc })
    }
    return { ok: true, stats }
  } catch (e) {
    return { ok: false, error: e.message, stats }
  } finally {
    db.close()
  }
}

module.exports = { runScan }