import { useEffect, useMemo, useState } from 'react'
import { fetchProjects, fetchAccounts, fetchSessions, fetchAgents, renameProject } from '../api'
import { fmtTime } from '../lib'
import type { Project, Account, SessionSummary } from '../types'

export default function ProjectsView({ onOpenSession }: { onOpenSession: (id: string) => void }) {
  const [projects, setProjects] = useState<Project[] | null>(null)
  const [accounts, setAccounts] = useState<Account[]>([])
  const [agents, setAgents] = useState<{ agent_id: string; session_count: number }[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [err, setErr] = useState('')

  const load = () => {
    setErr('')
    Promise.all([fetchProjects(), fetchAccounts(), fetchAgents()])
      .then(([p, a, ag]) => { setProjects(p); setAccounts(a); setAgents(ag) })
      .catch((e) => setErr(String(e)))
  }
  useEffect(load, [])

  useEffect(() => {
    if (!selected) { setSessions([]); return }
    fetchSessions({ project: selected }).then(setSessions).catch((e) => setErr(String(e)))
  }, [selected])

  const selectedProject = projects?.find((p) => p.id === selected) ?? null

  // 项目改名（readme §整理）：空输入 = 恢复自动命名；成功后刷新项目列表（名称由后端 projectDisplay 统一生效）
  const onRename = async () => {
    if (!selectedProject) return
    const input = window.prompt(
      `自定义项目名（留空恢复自动命名「${selectedProject.name}」）：`,
      selectedProject.customName || '',
    )
    if (input === null) return // 取消
    const name = input.trim().slice(0, 100)
    if (name === (selectedProject.customName || '')) return // 未变化
    try {
      await renameProject(selectedProject.id, name)
      const p = await fetchProjects()
      setProjects(p)
    } catch (e) {
      setErr('改名失败：' + String(e))
    }
  }

  const activeAgents = useMemo(
    () => agents.filter((a) => a.session_count > 0),
    [agents],
  )

  return (
    <div className="grid">
      <aside className="side">
        <div className="panel" style={{ borderRadius: 0, border: 'none', borderBottom: '1px solid var(--border)' }}>
          <div style={{ padding: '10px 14px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <strong style={{ fontSize: 14 }}>账号</strong>
            <span className="badge">{accounts.length}</span>
          </div>
          {accounts.map((a) => (
            <div className="list-item" key={a.id} onClick={() => setSelected(null)}>
              <div className="list-title">{a.agentId} / {a.displayName || a.rawName}</div>
              <div className="list-sub">{a.rawName} · {a.sessionCount} 会话</div>
            </div>
          ))}
        </div>

        <div className="panel" style={{ borderRadius: 0, border: 'none' }}>
          <div style={{ padding: '10px 14px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <strong style={{ fontSize: 14 }}>项目</strong>
            <span className="badge">{projects?.length ?? 0}</span>
          </div>
          {err && <div className="error">{err}</div>}
          {!projects && <div className="empty">加载中…</div>}
          {projects?.length === 0 && <div className="empty">尚无索引，请点击右上角「扫描」。</div>}
          {projects?.map((p) => (
            <div
              key={p.id}
              className={`list-item ${selected === p.id ? 'active' : ''}`}
              onClick={() => setSelected(p.id === selected ? null : p.id)}
            >
              <div className="list-title">{p.name}</div>
              <div className="list-sub" title={p.path}>{p.path}</div>
              <div className="meta-tags">
                <span className="meta-tag">{p.sessionCount} 会话</span>
                {p.drive && <span className="meta-tag">{p.drive}</span>}
                {p.agents.map((a) => <span className="meta-tag" key={a.agent}>{a.agent}×{a.n}</span>)}
                <span className="meta-tag">更新 {fmtTime(p.lastSeen)}</span>
              </div>
            </div>
          ))}
        </div>
      </aside>

      <main className="main">
        {selectedProject ? (
          <>
            <div className="detail-head" style={{ marginBottom: 14, padding: 16 }}>
              <h2 className="detail-title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                {selectedProject.name}
                {selectedProject.customName && (
                  <span className="meta-tag" title="自定义名称，改名可恢复自动命名">自定义</span>
                )}
                <button className="scan-btn rename-btn" onClick={onRename} title="自定义项目名（留空恢复自动命名）">改名</button>
              </h2>
              <div className="list-sub" title={selectedProject.path}>{selectedProject.path}</div>
              <div className="meta-tags" style={{ marginTop: 8 }}>
                <span className="meta-tag">{selectedProject.sessionCount} 会话</span>
                <span className="meta-tag">{selectedProject.turnCount} 轮次</span>
                {selectedProject.drive && <span className="meta-tag">{selectedProject.drive}</span>}
                {selectedProject.accounts.map((ac) => (
                  <span className="meta-tag" key={`${ac.agent}-${ac.name}`}>{ac.agent}/{ac.name}×{ac.n}</span>
                ))}
              </div>
            </div>
            {sessions.length === 0 && <div className="empty">该项目暂无会话</div>}
            {sessions.map((s) => (
              <div className="panel" key={s.id} style={{ cursor: 'pointer' }} onClick={() => onOpenSession(s.id)}>
                <div style={{ padding: '12px 14px' }}>
                  <div className="list-title">
                    {s.starred ? <span className="star-mark" title="已星标">★</span> : null}
                    {s.title || '(无标题)'}
                  </div>
                  <div className="meta-tags" style={{ marginTop: 6 }}>
                    <span className="meta-tag">{s.agentId}</span>
                    {s.account && <span className="meta-tag">{s.account}</span>}
                    {s.subject && <span className="meta-tag">主题：{s.subject}</span>}
                    {s.model && <span className="meta-tag">{s.model}</span>}
                    <span className="meta-tag">{s.turnCount} 轮</span>
                    <span className="meta-tag">{fmtTime(s.updatedAt)}</span>
                  </div>
                </div>
              </div>
            ))}
          </>
        ) : (
          <div className="empty">
            <p>选择一个项目查看会话，或查看账号统计。</p>
            <p className="hint">已索引 {projects?.length ?? 0} 个项目、{activeAgents.length} 个 agent、{accounts.length} 个账号。</p>
          </div>
        )}
      </main>
    </div>
  )
}