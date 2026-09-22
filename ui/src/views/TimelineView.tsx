import { useEffect, useState } from 'react'
import { fetchSessions, fetchProjects, fetchAccounts, fetchAgents } from '../api'
import { fmtTime } from '../lib'
import type { SessionSummary, Project, Account } from '../types'

// 会话时间线（默认视图）：会话是主体，时间分组浏览；项目/工具/账号是会话的自然属性徽标。
// 找回路径：先看到"活"，卡片上自然知道时间、工具、项目、账号、话题。

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

export default function TimelineView({ onOpenSession }: { onOpenSession: (id: string) => void }) {
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [accounts, setAccounts] = useState<Account[]>([])
  const [agents, setAgents] = useState<{ agent_id: string; session_count: number }[]>([])
  const [project, setProject] = useState('')
  const [account, setAccount] = useState('')
  const [agent, setAgent] = useState('')
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

  // 按时间分组（列表本身按 updated_at 倒序）
  const now = Date.now()
  const groups = new Map<string, SessionSummary[]>()
  for (const s of sessions) {
    const g = groupOf(s.updatedAt, now)
    if (!groups.has(g)) groups.set(g, [])
    groups.get(g)!.push(s)
  }

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div className="filter-row" style={{ padding: '12px 20px 0' }}>
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
        <span className="spacer" style={{ flex: 1 }} />
        {loading && <span className="status">加载中…</span>}
        {!loading && <span className="status">{sessions.length} 个会话</span>}
      </div>

      {err && <div className="error">{err}</div>}

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
    </div>
  )
}
