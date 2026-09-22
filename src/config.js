'use strict'
// 轻量配置：~/.agentsessions/config.json
// 支持字段：
//   accountMapping  账号映射表（归一化/人工修正）
//     { accountMapping: { "<agentId>::<rawName>": { displayName: "工作号", kind: "work" } } }
//   excludes        排除规则（场景 S8：不索引指定路径）
//     规则为字符串数组，按「源文件路径」与「项目 cwd」匹配：
//     - 含通配符（* ?）：按 glob 匹配整条路径（** 跨目录、* 单段内、大小写不敏感）
//     - 不含通配符：按路径包含匹配（贴一个目录即可排除其下所有会话）
//     例：["D:\\private", "**/playground/**", "**/node_modules/**"]
//   autoScanMinutes 自动增量扫描间隔（分钟，0=关闭；server.js 读取并调度）
//   agentPaths     Agent 会话目录手动配置（readme §F/风险表：自定义目录检测不到时可指定）
//     { agentPaths: { trae: "D:\\custom\\trae\\projects", workbuddy: "...", opencode: "D:\\x\\opencode.db" } }
//     路径存在即生效（未安装该 agent 也会纳入扫描）；仅支持已知 agent id
//   maxFileSizeMB  大文件保护阈值（MB，超过跳过不索引；0=关闭；默认 50）
//   searchHotkey   搜索快捷键（热键字符串：'/'、'f3'、'ctrl+k'；默认 '/'；设置页录入）
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')

// saveConfig 允许写入的白名单键（防止越权字段混入）
const WRITABLE_KEYS = ['accountMapping', 'excludes', 'autoScanMinutes', 'agentPaths', 'maxFileSizeMB', 'searchHotkey']
// 支持手动配置会话目录的 agent（与 src/detect.js 的 AGENTS 清单保持一致）
const KNOWN_AGENTS = ['opencode', 'claude-code', 'workbuddy', 'trae', 'traework', 'codebuddy', 'lingma', 'codex']

function configPath() {
  return path.join(os.homedir(), '.agentsessions', 'config.json')
}

// 读取配置；文件不存在/解析失败返回缺省（不抛错）
function loadConfig() {
  try {
    const c = JSON.parse(fs.readFileSync(configPath(), 'utf8'))
    if (c && typeof c === 'object') {
      return normalize(c)
    }
  } catch { /* 缺省 */ }
  return normalize({})
}

// 归一化任意输入为完整配置对象（未知键丢弃，类型兜底）
function normalize(c) {
  const paths = {}
  if (c.agentPaths && typeof c.agentPaths === 'object' && !Array.isArray(c.agentPaths)) {
    for (const k of KNOWN_AGENTS) {
      const v = c.agentPaths[k]
      if (typeof v === 'string' && v.trim()) paths[k] = v.trim()
    }
  }
  return {
    accountMapping: (c.accountMapping && typeof c.accountMapping === 'object' && !Array.isArray(c.accountMapping)) ? c.accountMapping : {},
    excludes: Array.isArray(c.excludes) ? c.excludes.filter((x) => typeof x === 'string' && x.trim()) : [],
    autoScanMinutes: Number.isFinite(Number(c.autoScanMinutes)) && Number(c.autoScanMinutes) >= 0 ? Number(c.autoScanMinutes) : 5,
    agentPaths: paths,
    maxFileSizeMB: Number.isFinite(Number(c.maxFileSizeMB)) && Number(c.maxFileSizeMB) >= 0 ? Number(c.maxFileSizeMB) : 50,
    searchHotkey: (typeof c.searchHotkey === 'string' && c.searchHotkey.trim()) ? c.searchHotkey.trim().toLowerCase().slice(0, 40) : '/',
  }
}

// 保存配置：与现配置浅合并，只接受白名单键；返回保存后的完整配置
function saveConfig(patch) {
  const next = loadConfig()
  const clean = normalize(patch || {})
  for (const k of WRITABLE_KEYS) {
    if (patch && Object.prototype.hasOwnProperty.call(patch, k)) next[k] = clean[k]
  }
  const dir = path.dirname(configPath())
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(configPath(), JSON.stringify(next, null, 2), 'utf8')
  return next
}

// glob → RegExp：** 跨目录（含分隔符）、* 单段内、? 单字符；分隔符统一 /，大小写不敏感（Windows 路径）
function globToRegExp(pattern) {
  const p = String(pattern).replace(/\\/g, '/')
  const esc = (s) => s.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  let re = ''
  let i = 0
  while (i < p.length) {
    const c = p[i]
    if (c === '*') {
      if (p[i + 1] === '*') {
        re += '.*'
        i += 2
        while (p[i] === '/') i++ // "**/" 吞掉分隔符
      } else {
        re += '[^/]*'
        i++
      }
    } else if (c === '?') {
      re += '[^/]'
      i++
    } else {
      re += esc(c)
      i++
    }
  }
  return new RegExp('^' + re + '$', 'i')
}

// 判断路径是否命中排除规则（源文件路径与项目 cwd 共用同一套规则）
function isExcluded(cfg, p) {
  const rules = cfg && Array.isArray(cfg.excludes) ? cfg.excludes : []
  if (!p || !rules.length) return false
  const norm = String(p).replace(/\\/g, '/')
  const lower = norm.toLowerCase()
  for (const rule of rules) {
    if (!rule) continue
    if (/[*?]/.test(rule)) {
      if (globToRegExp(rule).test(norm)) return true
    } else if (lower.includes(rule.replace(/\\/g, '/').toLowerCase())) {
      return true // 无通配符：路径包含即排除（目录级）
    }
  }
  return false
}

// 应用账号映射：返回 { displayName, kind }（未命中则默认本机/other）
function applyAccountMapping(config, agentId, rawName) {
  const m = (config.accountMapping || {})[`${agentId}::${rawName}`]
  if (m) return { displayName: m.displayName || rawName, kind: m.kind || 'other' }
  // 默认：local → 本机，其余 → 原样
  if (rawName === 'local') return { displayName: '本机', kind: 'other' }
  return { displayName: rawName, kind: 'other' }
}

module.exports = { configPath, loadConfig, saveConfig, normalize, isExcluded, applyAccountMapping }
