import { useState, useEffect, useCallback, useRef } from 'react'
import { doSearch } from '../api'
import { fmtTime, highlight } from '../lib'
import type { SearchHit } from '../types'

// 搜索态子组件（Gmail 式双态主页）：由 TimelineView 宿主在搜索框有关键词时挂载。
// 保留完整搜索状态机：自动渐进（浅层结果不足才深入）+ 手动继续深搜 + 时间区间 + 命中层级徽标。
// 过滤条件（agent/project/account）与时间预设由宿主持有，经 props 下发；本组件只管搜索与结果渲染。

// 命中位置的自然语言呈现（内部按层级 1..4 区分，界面上不暴露层级概念）
const HIT_WHERE: Record<number, string> = { 1: '标题', 2: '主题', 3: '正文', 4: '思考' }

// 时间预设：自定义区间按"日起点 00:00 ~ 日终点 23:59"取整
export type TimePreset = 'all' | 'today' | 'week' | 'month' | 'custom'
export const TIME_PRESETS: { v: TimePreset; label: string }[] = [
  { v: 'all', label: '全部时间' },
  { v: 'today', label: '今天' },
  { v: 'week', label: '本周' },
  { v: 'month', label: '本月' },
  { v: 'custom', label: '自定义' },
]

export function rangeOf(p: TimePreset, fromD: string, toD: string): { from?: number; to?: number } {
  const dayStart = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  if (p === 'today') return { from: dayStart(new Date()) }
  if (p === 'week') {
    const now = new Date()
    // 本周一 00:00（getDay 周日=0，归一化为周一=0）
    return { from: dayStart(new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((now.getDay() + 6) % 7))) }
  }
  if (p === 'month') { const now = new Date(); return { from: new Date(now.getFullYear(), now.getMonth(), 1).getTime() } }
  if (p === 'custom') {
    const from = fromD ? dayStart(new Date(fromD)) : undefined
    const to = toD ? new Date(new Date(toD).setHours(23, 59, 59, 999)).getTime() : undefined
    return { from, to }
  }
  return {}
}

interface Props {
  q: string
  account: string
  project: string
  agent: string
  time: TimePreset
  fromD: string
  toD: string
  onOpenSession: (id: string, loc?: { seq?: number | null; q?: string }) => void
}

export default function SearchPanel({ q, account, project, agent, time, fromD, toD, onOpenSession }: Props) {
  const [results, setResults] = useState<SearchHit[]>([])
  const [total, setTotal] = useState(0)
  // 搜索范围（让用户知道"搜完了没有"）：实际搜到的深度 2=标题+主题 / 3=+正文 / 4=+思考
  const [searchedDepth, setSearchedDepth] = useState(0)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')
  const timer = useRef<ReturnType<typeof setTimeout>>()

  // full=true 时全量搜索（标题/主题/正文/思考一次搜全）；否则自动渐进——浅层结果不足才深入
  const run = useCallback((q2: string, acc: string, proj: string, ag: string, rng: { from?: number; to?: number }, full = false) => {
    const query = q2.trim()
    setLoading(true); setErr('')
    doSearch({
      q: query, depth: 4, auto: !full,
      account: acc || undefined, project: proj || undefined,
      agent: ag || undefined, from: rng.from, to: rng.to,
    })
      .then((r) => { setResults(r.hits); setTotal(r.total); setSearchedDepth(r.depth ?? 0) })
      .catch((e) => { setErr(String(e)); setResults([]); setTotal(0); setSearchedDepth(0) })
      .finally(() => setLoading(false))
  }, [])

  // 自动搜索（防抖由宿主的 trigger 依赖驱动）：输入/过滤变化时回到自动渐进
  const trigger = useCallback(() => {
    if (!q.trim()) { setResults([]); setTotal(0); setSearchedDepth(0); return }
    run(q, account, project, agent, rangeOf(time, fromD, toD))
  }, [q, account, project, agent, time, fromD, toD, run])

  // 手动继续深入：把对话正文与思考过程也搜进来（与已有结果合并展示）
  const searchAll = useCallback(() => {
    run(q, account, project, agent, rangeOf(time, fromD, toD), true)
  }, [q, account, project, agent, time, fromD, toD, run])

  useEffect(() => {
    timer.current = setTimeout(trigger, 350)
    return () => clearTimeout(timer.current)
  }, [trigger])

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      {err && <div className="error">{err}</div>}

      {/* 搜索状态行：让"搜到哪一层"可见，并提供手动继续深搜入口 */}
      <div className="filter-row">
        <span className="spacer" style={{ flex: 1 }} />
        {loading && <span className="status">搜索中…</span>}
        {!loading && q.trim() && searchedDepth >= 4 && (
          <span className="status">已搜索全部内容：标题、主题、正文、思考</span>
        )}
        {!loading && q.trim() && searchedDepth === 3 && (
          <>
            <span className="status">已在标题、主题与对话正文中搜索</span>
            <button className="scan-btn mini-btn" onClick={searchAll}>在思考过程中继续搜索</button>
          </>
        )}
        {!loading && q.trim() && searchedDepth > 0 && searchedDepth <= 2 && (
          <>
            <span className="status">在标题和主题中找到 {total} 条</span>
            <button className="scan-btn mini-btn" onClick={searchAll}>在正文与思考中继续搜索</button>
          </>
        )}
      </div>

      <div className="search-results" style={{ overflowY: 'auto', flex: 1, padding: '10px 20px 20px' }}>
        {q.trim() && total === 0 && !loading && (
          <div className="empty">
            {searchedDepth >= 4
              ? <>已搜索标题、主题、对话正文与思考过程，没有找到与「{q}」相关的内容</>
              : <>没有找到与「{q}」相关的内容<button className="scan-btn mini-btn" style={{ marginTop: 10 }} onClick={searchAll}>在对话正文与思考过程中找找</button></>}
          </div>
        )}
        {results.map((h) => (
          <div
            className="panel"
            key={h.id}
            style={{ cursor: 'pointer' }}
            title={h.layer && h.layer >= 3 && h.seq != null ? `在${HIT_WHERE[h.layer]}中找到，点击跳到第 ${h.seq} 轮并高亮` : '打开会话详情'}
            onClick={() => onOpenSession(h.id, { seq: h.seq ?? null, q: q.trim() })}
          >
            <div style={{ padding: '12px 14px' }}>
              <div className="list-title">{highlight(h.title, q) || '(无标题)'}</div>
              <div className="meta-tags" style={{ marginTop: 6 }}>
                {h.layer && (
                  <span className={`meta-tag layer-tag l${h.layer}`} title={`在${HIT_WHERE[h.layer]}中找到${h.layer >= 3 && h.seq != null ? `（第 ${h.seq} 轮）` : ''}`}>
                    {HIT_WHERE[h.layer]}{h.layer >= 3 && h.seq != null ? ` #${h.seq}` : ''}
                  </span>
                )}
                <span className="meta-tag">{h.agent_id}</span>
                {(h.account_name || h.account_raw) && <span className="meta-tag">{h.account_name || h.account_raw}</span>}
                {h.project && <span className="meta-tag">{h.project}</span>}
                <span className="meta-tag">{fmtTime(h.created_at ?? h.timestamp ?? null, '')}</span>
              </div>
              {(h.subject || h.subj) && (
                <div className="list-sub" style={{ marginTop: 6 }}>主题：{highlight(h.subject || h.subj, q)}</div>
              )}
              {h.assistant_message && (
                <div className="message" style={{ marginTop: 8, fontSize: 13, color: 'var(--muted)' }}>
                  {highlight(String(h.assistant_message).slice(0, 220), q)}
                </div>
              )}
              {h.thinking && (
                <div className="list-sub" style={{ marginTop: 6, fontStyle: 'italic' }}>
                  💭 {highlight(String(h.thinking).slice(0, 140), q)}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
