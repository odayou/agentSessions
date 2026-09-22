// 统一 API 客户端：封装的本地桥。
// dev：走 Vite proxy(/api→127.0.0.1:18778)；prod(Tauri 内)：直连桥。
import type {
  Project, Account, AgentStat, SessionSummary, SessionDetail, SearchHit, ScanResult,
  ExportResult, Stats, AppConfig, DetectedAgent,
} from './types'

const BASE = import.meta.env.DEV ? '/api' : 'http://127.0.0.1:18778/api'

async function get<T>(path: string): Promise<T> {
  // 桌面版后端由主进程拉起，可能比窗口就绪慢零点几秒：网络层失败短暂重试
  let r: Response | null = null
  for (let i = 0; i < 4; i++) {
    try {
      r = await fetch(BASE + path)
      break
    } catch {
      await new Promise((ok) => setTimeout(ok, 400))
    }
  }
  if (!r) throw new Error('本地服务未启动')
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return r.json() as Promise<T>
}

export function fetchProjects() { return get<{ projects: Project[] }>('/projects').then(d => d.projects) }
export function fetchAccounts() { return get<{ accounts: Account[] }>('/accounts').then(d => d.accounts) }
export function fetchAgents() { return get<{ agents: AgentStat[] }>('/agents').then(d => d.agents) }

export function fetchSessions(f: { project?: string; account?: string; agent?: string; q?: string } = {}) {
  const p = new URLSearchParams()
  if (f.project) p.set('project', f.project)
  if (f.account) p.set('account', f.account)
  if (f.agent) p.set('agent', f.agent)
  if (f.q) p.set('q', f.q)
  return get<{ sessions: SessionSummary[] }>(`/sessions?${p.toString()}`).then(d => d.sessions)
}

export function fetchSession(id: string) {
  return get<{ session: SessionDetail }>(`/session?id=${encodeURIComponent(id)}`).then(d => d.session)
}

export function doSearch(f: { q: string; depth: number; account?: string; project?: string; agent?: string; from?: number; to?: number; auto?: boolean; minResults?: number }) {
  const p = new URLSearchParams()
  if (f.q) p.set('q', f.q)
  p.set('depth', String(f.depth))
  if (f.account) p.set('account', f.account)
  if (f.project) p.set('project', f.project)
  if (f.agent) p.set('agent', f.agent)
  if (f.from) p.set('from', String(f.from))
  if (f.to) p.set('to', String(f.to))
  if (f.auto) { p.set('auto', '1'); p.set('minResults', String(f.minResults ?? 8)) }
  return get<{ hits: SearchHit[]; total: number; depth?: number; escalated?: boolean }>(`/search?${p.toString()}`)
}

export async function doScan() {
  const r = await fetch(`${BASE}/scan`, { method: 'POST' })
  const d = await r.json()
  if (!r.ok || !d.ok) throw new Error(d.error || 'scan failed')
  return d as ScanResult
}

export function fetchExport(id: string, format: 'md' | 'json') {
  return get<ExportResult>(`/export?id=${encodeURIComponent(id)}&format=${format}`)
}

export function fetchContext(id: string) {
  return get<{ ok: boolean; title: string | null; text: string }>(`/context?id=${encodeURIComponent(id)}`)
}

// M4 统计
export function fetchStats(days = 30) {
  return get<{ stats: Stats; lastScanAt: number; agents: DetectedAgent[] }>(`/stats?days=${days}`)
}

// 项目自定义命名（name 为空 = 恢复自动命名）
export async function renameProject(id: string, name: string) {
  const r = await fetch(`${BASE}/project/rename`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, name }),
  })
  const d = await r.json()
  if (!r.ok || !d.ok) throw new Error(d.error || 'rename failed')
}

// 切换会话星标，返回切换后的状态
export async function toggleStar(id: string) {
  const r = await fetch(`${BASE}/session/star`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id }),
  })
  const d = await r.json()
  if (!r.ok || !d.ok) throw new Error(d.error || 'star failed')
  return d.starred as number
}

// M4 配置读写
export function fetchConfig() {
  return get<{ config: AppConfig }>('/config').then(d => d.config)
}

export async function saveConfig(patch: Partial<AppConfig>) {
  const r = await fetch(`${BASE}/config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  })
  const d = await r.json()
  if (!r.ok || !d.ok) throw new Error(d.error || 'save failed')
  return d.config as AppConfig
}

export async function ping() {
  const r = await fetch(`${BASE}/ping`)
  return r.ok
}