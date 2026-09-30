import { useEffect, useState } from 'react'
import { fetchSessions, fetchProjects, fetchAccounts, fetchAgents } from '../api'
import { fmtTime } from '../lib'
import type { SessionSummary, Project, Account } from '../types'
import SearchPanel, { TIME_PRESETS, type TimePreset } from './SearchPanel'

// 会话主页（Gmail 式双态，默认视图）：空关键词=时间线分组浏览；有关键词=搜索结果态（SearchPanel）。
// 顶部搜索框常驻（热键聚焦 id=search-input），过滤条（Agent/项目/账号）两种模式共享，
// 时间预设仅搜索态显示（浏览态按更新时间自然分组）。

// 时间分组：今天 / 昨天 / 7 天内 / 本月 / 更早
function groupOf(updatedAt: number | null, now: number): string {
  if (!updatedAt) return '更早'
  const d = new Date(updatedAt)
  const t = new Date(now)
  const dayStart = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const diffDays = Math.floor((dayStart(t) - dayStart(d)) / 86400000)
  if (diffDays <= 0) return '今天'
  if (diffDays === 1) return '昨天'
  if (diffDays < 7) return '7 天内'
  if (d.getFullYear() === t.getFullYear() && d.getMonth() === t.getMonth()) return '本月'
  return '更早'
}
const GROUP_ORDER = ['今天', '昨天', '7 天内', '本月', '更早']

interface Props {
  onOpenSession: (id: string, loc?: { seq?: number | null; q?: string }) => void
  hotkeyLabel?: string
  // 经 #/search 旧链接进入时自动聚焦搜索框（App 热键路径另有兜底聚焦）
  autoFocusSearch?: boolean
}

export default function TimelineView({ onOpenSession, hotkeyLabel, autoFocusSearch }: Props) {
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [accounts, setAccounts] = useState<Account[]>([])
  const [agents, setAgents] = useState<{ agent_id: string; session_count: number }[]>([])
  const [project, setProject] = useState('')
  const [account, setAccount] = useState('')
  const [agent, setAgent] = useState('')
  // 搜索态状态：关键词 + 时间预设（仅搜索态渲染与生效）
  const [q, setQ] = useState('')
  const [time, setTime] = useState<TimePreset>('all')
  const [fromD, setFromD] = useState('')
  const [toD, setToD] = useState('')
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')

  useEffect(() => {
    fetchProjects().then(setProjects).catch(() => {})
    fetchAccounts().then(setAccounts).catch(() => {})
    fetchAgents().then(setAgents).catch(() => {})
  }, [])

  useEffect(() => {
    setLoading(true); setErr('')
    fetchSessions({
      project: project || undefined,
      account: account || undefined,
      agent: agent || undefined,
    })
      .then(setSessions)
      .catch((e) => setErr(String(e)))
      .finally(() => setLoading(false))
  }, [project, account, agent])

  // 旧链接/热键路径进入时聚焦搜索框（autoFocusSearch 保持 true，仅首次生效）
  useEffect(() => {
    if (autoFocusSearch) (document.getElementById('search-input') as HTMLInputElement | null)?.focus()
  }, [autoFocusSearch])

  // 按时间分组（列表本身按 updated_at 倒序）；搜索态不渲染分组，数据保留供清词即回
  const now = Date.now()
  const groups = new Map<string, SessionSummary[]>()
  for (const s of sessions) {
    const g = groupOf(s.updatedAt, now)
    if (!groups.has(g)) groups.set(g, [])
    groups.get(g)!.push(s)
  }
  const searching = !!q.trim()

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div className="filter-row">
        <select className="select" value={agent} onChange={(e) => setAgent(e.target.value)}>
          <option value="">所有 Agent</option>
          {agents.map((a) => <option key={a.agent_id} value={a.agent_id}>{a.agent_id}</option>)}
        </select>
        <select className="select" value={project} onChange={(e) => setProject(e.target.value)}>
          <option value="">所有项目</option>
          {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <select className="select" value={account} onChange={(e) => setAccount(e.target.value)}>
          <option value="">所有账号</option>
          {accounts.map((a) => <option key={a.id} value={a.id}>{a.displayName || a.rawName}</option>)}
        </select>
        {/* 常驻搜索框：空关键词=浏览态，有关键词=搜索态；Esc 清词回浏览态 */}
        <input
          id="search-input"
          className="search-input"
          value={q}
          placeholder={`搜索标题、主题、对话内容、思考过程…（按 ${hotkeyLabel || '/'} 聚焦）`}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && q) { e.stopPropagation(); setQ('') }
          }}
        />
        {searching && (
          <>
            <select className="select" value={time} onChange={(e) => setTime(e.target.value as TimePreset)} title="按会话更新时间过滤">
              {TIME_PRESETS.map((t) => <option key={t.v} value={t.v}>{t.label}</option>)}
            </select>
            {time === 'custom' && (
              <>
                <input className="select" type="date" value={fromD} onChange={(e) => setFromD(e.target.value)} title="起始日（含当天 00:00）" />
                <span className="hint">至</span>
                <input className="select" type="date" value={toD} onChange={(e) => setToD(e.target.value)} title="结束日（含当天 23:59）" />
              </>
            )}
          </>
        )}
        <span className="spacer" style={{ flex: 1 }} />
        {!searching && loading && <span className="status">加载中…</span>}
        {!searching && !loading && <span className="status">{sessions.length} 个会话</span>}
      </div>

      {err && !searching && <div className="error">{err}</div>}

      {searching ? (
        <SearchPanel
          q={q}
          account={account}
          project={project}
          agent={agent}
          time={time}
          fromD={fromD}
          toD={toD}
          onOpenSession={onOpenSession}
        />
      ) : (
        <div style={{ flex: 1, overflowY: 'auto', padding: '12px 20px 20px' }}>
          {sessions.length === 0 && !loading && (
            <div className="empty">暂无会话。点击右上角「扫描」，或调整过滤条件。</div>
          )}
          {GROUP_ORDER.filter((g) => groups.has(g)).map((g) => (
            <div key={g} style={{ marginBottom: 18 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '4px 0 10px' }}>
                <h3 style={{ margin: 0, fontSize: 14 }}>{g}</h3>
                <span className="badge">{groups.get(g)!.length}</span>
              </div>
              {groups.get(g)!.map((s) => (
                <div
                  className="panel"
                  key={s.id}
                  style={{ cursor: 'pointer', marginBottom: 8 }}
                  onClick={() => onOpenSession(s.id)}
                >
                  <div style={{ padding: '10px 14px' }}>
                    <div className="list-title">
                      {s.starred ? <span className="star-mark" title="已星标">★</span> : null}
                      {s.title || '(无标题)'}
                    </div>
                    <div className="meta-tags" style={{ marginTop: 6 }}>
                      <span className="meta-tag">{s.agentId}</span>
                      {s.account && <span className="meta-tag">{s.account}</span>}
                      {s.project && <span className="meta-tag" title={s.cwd || undefined}>{s.project}</span>}
                      {s.subject && <span className="meta-tag">话题：{s.subject}</span>}
                      <span className="meta-tag">{s.turnCount} 轮</span>
                      <span className="meta-tag">{fmtTime(s.updatedAt)}</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
