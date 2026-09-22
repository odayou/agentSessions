import { useEffect, useState } from 'react'
import { fetchStats } from '../api'
import type { Stats } from '../types'

// 统计视图（M4，规划 §三F「数据统计」）：总量卡 + agent/账号分布 + 近30天活跃趋势。
// 全部纯 CSS 呈现，零图表依赖，与本地轻量定位一致。
export default function StatsView() {
  const [stats, setStats] = useState<Stats | null>(null)
  const [err, setErr] = useState('')

  useEffect(() => {
    fetchStats(30).then((d) => setStats(d.stats)).catch((e) => setErr(String(e)))
  }, [])

  if (err) return <div className="empty" style={{ padding: 20 }}>{err}</div>
  if (!stats) return <div className="empty" style={{ padding: 20 }}>加载统计中…</div>

  const cards = [
    { label: '项目', value: stats.totalProjects },
    { label: '会话', value: stats.totalSessions },
    { label: '轮次', value: stats.totalTurns },
    { label: '账号', value: stats.totalAccounts },
  ]

  return (
    <div className="stats-page">
      <div className="stats-cards">
        {cards.map((c) => (
          <div className="stat-card" key={c.label}>
            <div className="stat-value">{c.value.toLocaleString()}</div>
            <div className="stat-label">{c.label}</div>
          </div>
        ))}
      </div>

      <div className="panel">
        <h3>近 30 天活跃（按会话更新日）</h3>
        <div className="stats-body"><ActivityChart days={stats.byDay} /></div>
      </div>

      <div className="stats-two-col">
        <div className="panel">
          <h3>按 Agent 分布</h3>
          <div className="stats-body">
            <BarList rows={stats.byAgent.map((a) => ({ key: a.agent, n: a.sessions, sub: `${a.turns.toLocaleString()} 轮次` }))} />
          </div>
        </div>
        <div className="panel">
          <h3>按账号分布</h3>
          <div className="stats-body">
            <BarList rows={stats.byAccount.map((a) => ({ key: `${a.name}${a.kind && a.kind !== 'other' ? `（${a.kind}）` : ''}`, n: a.sessions, sub: `${a.turns.toLocaleString()} 轮次` }))} />
          </div>
        </div>
      </div>
    </div>
  )
}

// 30 天活跃柱状图：缺失天补 0，保证时间轴连续
function ActivityChart({ days }: { days: { day: string; n: number }[] }) {
  const byDay = new Map(days.map((d) => [d.day, d.n]))
  const cols: { day: string; n: number }[] = []
  const now = new Date()
  for (let i = 29; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i)
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    cols.push({ day: key, n: byDay.get(key) || 0 })
  }
  const max = Math.max(1, ...cols.map((c) => c.n))
  return (
    <>
      <div className="chart-days">
        {cols.map((c) => (
          <div
            key={c.day}
            className="chart-col"
            title={`${c.day}：${c.n} 会话`}
          >
            <div className={`chart-bar ${c.n === 0 ? 'zero' : ''}`} style={{ height: `${Math.max(2, (c.n / max) * 100)}%` }} />
          </div>
        ))}
      </div>
      <div className="chart-axis">
        <span>{cols[0]?.day.slice(5)}</span>
        <span>{cols[cols.length - 1]?.day.slice(5)}</span>
      </div>
    </>
  )
}

// 横向条形列表：key + 数量 + 次要信息
function BarList({ rows }: { rows: { key: string; n: number; sub?: string }[] }) {
  if (!rows.length) return <div className="empty">暂无数据。点击右上角「扫描」</div>
  const max = Math.max(1, ...rows.map((r) => r.n))
  return (
    <div className="bar-list">
      {rows.map((r) => (
        <div className="bar-row" key={r.key}>
          <span className="bar-key" title={r.key}>{r.key}</span>
          <div className="bar-track">
            <div className="bar-fill" style={{ width: `${(r.n / max) * 100}%` }} />
          </div>
          <span className="bar-n">{r.n.toLocaleString()}</span>
          {r.sub && <span className="bar-sub">{r.sub}</span>}
        </div>
      ))}
    </div>
  )
}
