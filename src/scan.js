'use strict'
// 采集编排：detect → 各已装 agent 适配器 → 统一落库（增量优先：按源文件 mtime+size 指纹跳过未变更）
const fs = require('node:fs')
const { detectAll, AGENTS } = require('./detect')
const manifest = require('./manifest')
const engines = require('./engines')
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
  gemini: './../adapters/gemini',
  'copilot-cli': './../adapters/copilot-cli',
  cline: './../adapters/cline',
  'roo-code': './../adapters/roo-code',
  kiro: './../adapters/kiro',
  cursor: './../adapters/cursor',
  windsurf: './../adapters/windsurf',
  'copilot-vscode': './../adapters/copilot-vscode',
  'copilot-jetbrains': './../adapters/copilot-jetbrains',
  antigravity: './../adapters/antigravity',
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
// maxSizeMB > 0 时超大文件直接返回 false（跳过解析，不记指纹，调大阈值后可重新索引）；
// oversized 传入时收集被跳过的大文件（供统计与告警，跳过不再静默）。
// enforceMaxSize=false 用于 SQLite 主通道库（opencode/kiro/cursor）：单库承载该 agent 全部会话，
// 库体积增长是常态，按大小阈值跳过等于整个 agent 永久失效（只按 mtime+size 指纹增量）
function isChanged(db, agentId, file, maxSizeMB, oversized, enforceMaxSize = true) {
  try {
    const st = fs.statSync(file)
    if (enforceMaxSize && maxSizeMB > 0 && st.size > maxSizeMB * 1024 * 1024) {
      if (oversized) oversized.push({ agentId, file, sizeMB: Math.round(st.size / 1024 / 1024) })
      return false
    }
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
  const cfg2 = cfg || config.loadConfig()
  const detected = detectAll(cfg2)
  // agentPaths 手动配置（readme §F：自定义目录优先于自动检测；路径存在的未装 agent 也纳入扫描，
  // 支持清单声明的 agent id——agentList §6.2）
  for (const [id, p] of Object.entries(cfg2.agentPaths || {})) {
    if ((ADAPTERS[id] || manifest.hasAdapter(id, cfg2)) && fs.existsSync(p) && !detected.find((d) => d.id === id)) {
      detected.push({ id, label: (AGENTS[id] && AGENTS[id].label) || manifest.labelOf(id, cfg2) || id })
    }
  }
  const maxMB = cfg2.maxFileSizeMB
  const stats = { agents: [], sessions: 0, turns: 0 }
  const oversized = [] // 被大文件阈值跳过的源文件（主通道库不受限，仅逐会话文件）
  try {
    // 排除规则（S8）：先清理已索引的命中存量（含指纹），再在采集时跳过命中文件
    const excluded = store.applyExcludes(db, (p) => config.isExcluded(cfg2, p))
    if (excluded > 0) stats.excluded = excluded
    for (const { id } of detected) {
      if (only && id !== only) continue
      // agent 注册表条目：硬编码 AGENTS 优先，清单 agent 补位（agentList §6.2）
      const ag = AGENTS[id] || manifest.entryFor(id, cfg2) || {}
      // 适配器解析：硬编码模块优先；无硬编码时按清单经通用格式引擎驱动。
      // per-agent 隔离：单个清单/适配器构造失败（如非法正则）只降级该 agent，不中断整次扫描
      let adapter = null
      try {
        if (ADAPTERS[id]) adapter = require(ADAPTERS[id])
        else {
          const m = manifest.manifestOf(id, cfg2)
          if (m) adapter = engines.adapterFor(m)
        }
      } catch (e) {
        stats.agents.push({ id, label: ag.label || id, status: 'error', error: '适配器加载失败：' + e.message })
        continue
      }
      if (!adapter) continue
      if (adapter.placeholder) {
        stats.agents.push({ id, label: adapter.label, status: 'placeholder' })
        continue
      }

      let sc = 0
      let tc = 0
      if (ag.dbCandidates) {
        // sqlite 源（opencode/cursor/kiro）：遍历全部存在的候选库逐库扫描 + 记录各库文件指纹；
        // 每库可含多个会话（cursor/kiro），手动路径优先；单库解析失败（schema 漂移/损坏）
        // 不中断整体扫描，降级记录错误（agentList §五：解析失败时容错降级）
        const manual = (cfg2.agentPaths || {})[id]
        const candidates = [manual, ...ag.dbCandidates()].filter(Boolean)
        let scanErr = null
        for (const dbFile of candidates) {
          if (!fs.existsSync(dbFile) || config.isExcluded(cfg2, dbFile)) continue
          // 主通道库不受 maxFileSizeMB 限制（单库承载全 agent 会话，见 isChanged 注释）
          if (!isChanged(db, id, dbFile, maxMB, null, false)) continue // 未变更跳过
          try {
            const r = persist(db, id, adapter, adapter.scan(dbFile), cfg2)
            sc += r.sessions; tc += r.turns
          } catch (e) {
            scanErr = e.message
          }
        }
        if (scanErr && !sc && !tc) {
          stats.agents.push({ id, label: adapter.label, status: 'error', error: scanErr })
          continue
        }
      } else if (adapter.scanAll) {
        // 外部进程源（agentList §6.2 协议）：一次性扫描，无文件指纹可增量；失败不中断整体扫描
        try {
          const r = persist(db, id, adapter, adapter.scanAll(), cfg2)
          sc = r.sessions; tc = r.turns
        } catch (e) {
          stats.agents.push({ id, label: adapter.label, status: 'error', error: e.message })
          continue
        }
      } else if (adapter.sources && adapter.parseFile) {
        // jsonl/json 目录源（claude-code/workbuddy/cline/aider 等）：逐文件指纹，仅解析已变更文件；
        // parseFile 可返回单会话或会话数组（aider 单文件多运行 → 多会话）；手动路径优先
        const root = (cfg2.agentPaths || {})[id] || adapter.sourceDir || (ag.sourceDir ? ag.sourceDir() : null)
        for (const file of (root ? adapter.sources(root) : [])) {
          if (config.isExcluded(cfg2, file)) continue // 按源文件路径排除
          if (!isChanged(db, id, file, maxMB, oversized)) continue // 未变更/超大文件跳过
          // per-file 隔离：单文件解析抛错只跳过该文件（记日志），不拖垮整次扫描
          let out = null
          try { out = adapter.parseFile(file) } catch (e) {
            console.error(`[agentsessions] ${id} 解析源文件失败 ${file}：${e.message}`)
            continue
          }
          for (const item of (Array.isArray(out) ? out : (out ? [out] : []))) {
            const r = persist(db, id, adapter, [item], cfg2)
            sc += r.sessions; tc += r.turns
          }
        }
      }
      stats.sessions += sc
      stats.turns += tc
      stats.agents.push({ id, label: adapter.label, status: 'ok', sessions: sc, turns: tc })
    }
    // 超大文件跳过可见化：写入统计 + 控制台告警（避免"静默不索引"难排查）
    if (oversized.length) {
      stats.oversized = oversized.slice(0, 20)
      console.warn(`[agentsessions] ${oversized.length} 个源文件超过 maxFileSizeMB=${maxMB} 被跳过（可在设置页调大阈值或设为 0 不限制）：` +
        oversized.slice(0, 5).map((x) => `${x.agentId}:${x.file}(${x.sizeMB}MB)`).join('，') + (oversized.length > 5 ? ' 等' : ''))
    }
    return { ok: true, stats }
  } catch (e) {
    return { ok: false, error: e.message, stats }
  } finally {
    db.close()
  }
}

module.exports = { runScan }