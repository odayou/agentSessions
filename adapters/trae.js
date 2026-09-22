'use strict'
// 可离线读取的是 ~/.trae-cn/memory/projects/<proj>/<date>/session_memory_<sid>.jsonl —— 逐 message
// 压缩记忆（intent / actions / outcome / learned / message_summary_time），降级为「正文」索引：
//   userMessage←intent(或原文/标题)、assistantMessage←actions+outcome、思考←learned、主题←classifyPurpose(intent)
//   项目←所在 projects/<proj> 目录路径。命中即视为「发现该活在哪」，满足 S1。
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { classifyPurpose } = require('../src/purpose')
const { findJsonlFiles, buildSubjects } = require('./lib')

const MEMORY_ROOT = path.join(os.homedir(), '.trae-cn', 'memory', 'projects')

function joinArr(a) {
  return Array.isArray(a) ? a.filter(Boolean).join('\n') : (a ? String(a) : '')
}

// 列出源文件（增量扫描用）
function sources(sourceDir) {
  return findJsonlFiles(sourceDir || MEMORY_ROOT)
}

// 解析单个源文件为一个 UnifiedSession（增量扫描用）
function parseFile(file) {
  return parseMemoryFile(file)
}

// 扫描 memory 目录，返回 { session, project, turns, subjects } 数组
function scan(sourceDir) {
  const out = []
  for (const file of sources(sourceDir)) {
    const sess = parseFile(file)
    if (sess) out.push(sess)
  }
  return out
}

function parseMemoryFile(file) {
  // 项目目录：<root>/<proj>/<date>/xxx.jsonl → proj 在两段父级上
  const segs = file.split(path.sep)
  const dateIdx = segs.findIndex((s) => /^\d{8}$/.test(s))
  let cwd = null
  if (dateIdx >= 1) {
    // 项目目录名如 -c-Users-tomy-li--trae-cn-assistant--p2-xxx，转回近似路径
    const projKey = segs[dateIdx - 1]
    cwd = decodeProjKey(projKey)
  }
  // 4 级降级链末级（readme §5.4）：cwd 无法识别 → 归「未分类」而非丢弃
  const project = cwd
    ? { cwd, name: path.basename(cwd) || cwd }
    : { cwd: '__unclassified__', name: '未分类' }

  let sessionId = null
  let tsMin = null
  const turns = []
  let seq = 0
  for (const line of readableLines(file)) {
    let m
    try { m = JSON.parse(line) } catch { continue }
    if (!m || typeof m !== 'object') continue
    if (!sessionId && m.message_id) {
      const mm = m.message_id
      sessionId = mm.length > 32 ? mm.slice(0, 32) : mm
    }
    const t = m.message_summary_time ? msFromFmt(m.message_summary_time) : null
    if (t && (tsMin === null || t < tsMin)) tsMin = t

    // 单条 message 记忆 → 一轮
    const userIntent = m.intent || m.user_input || m.question || m.title || null
    const asstBody = [joinArr(m.actions), joinArr(m.outcome)]
      .filter(Boolean).join('\n')
    const thinking = joinArr(m.learned)
    const subject = userIntent ? classifyPurpose(userIntent, []) : null
    turns.push({
      seq: seq++,
      userMessage: userIntent,
      assistantMessage: asstBody || null,
      thinking: thinking || null,
      toolInput: null,
      filesChanged: [],
      timestamp: t,
      subject,
    })
  }

  if (!turns.length) return null

  const subjects = buildSubjects(turns)
  const firstUser = turns.find((t) => t.userMessage)

  return {
    session: {
      agentSessionId: sessionId || path.basename(file, '.jsonl'),
      cwd,
      title: firstUser ? firstUser.userMessage : null,
      model: null,
      createdAt: tsMin,
      sourceFile: file,
      // 来源说明：这些是 Trae/IDE 工具压缩后的会话记忆摘要，非全文 transcript
      meta: { provenance: 'compressed-memory', note: 'Trae 会话记忆摘要（工具压缩，非完整对话）' },
    },
    project,
    turns,
    subjects,
  }
}

// memory 文件名 date 形如 YYYYMMDD，格式 "2026-08-21 18:04:33" → ms
function msFromFmt(s) {
  const d = new Date(String(s).replace(' ', 'T'))
  return isNaN(d.getTime()) ? null : d.getTime()
}

// 项目 key（-c-Users-tomy-li--trae-cn-assistant--p2-xxx）→ 近似路径（cwd 主键用）
// 仅用于分组展示；原目录用 '-' 转义 '/'，映射回盘符根形式
function decodeProjKey(key) {
  let p = String(key)
  if (/^-([a-zA-Z]):/i.test(p)) {
    // -c-... → C:\...
    p = p.replace(/^-([a-zA-Z]):/i, (_, ch) => ch.toUpperCase() + ':')
  }
  // '--' → '' 是转义，'_'-连接
  return p.replace(/-{2,}/g, '\\')
}

function readableLines(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n')
  } catch { return [] }
}

module.exports = { scan, sources, parseFile, id: 'trae', label: 'Trae', sourceDir: MEMORY_ROOT, sourceFormat: 'jsonl/trae-memory(compressed)' }