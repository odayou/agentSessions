import { memo, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { fetchSession, fetchExport, fetchContext, toggleStar } from '../api'
import { highlightHtml } from '../highlight'
import { renderMarkdown } from '../markdown'
import { fmtTimeFull, highlight } from '../lib'
import type { SessionDetail, Turn, Locate } from '../types'

// —— 详情消息类型过滤（想法.md §详情中支持选择只展示部分类型）——
type TurnKind = 'user' | 'assistant' | 'thinking' | 'tool' | 'files'
const KINDS: { k: TurnKind; label: string }[] = [
  { k: 'user', label: '用户' },
  { k: 'assistant', label: 'AI' },
  { k: 'thinking', label: '思考' },
  { k: 'tool', label: '工具' },
  { k: 'files', label: '文件' },
]
const FILTER_KEY = 'agentsessions.turnFilters'
// 详情展示模式：默认 Markdown 渲染，可切换原文（选择记忆在本地）
const MODE_KEY = 'agentsessions.detailMode'
type DetailMode = 'render' | 'raw'
function loadMode(): DetailMode {
  return localStorage.getItem(MODE_KEY) === 'raw' ? 'raw' : 'render'
}

// 读取"复用为全局习惯"的过滤集；损坏/缺失时返回 null（用全选）
function loadSavedFilters(): Set<TurnKind> | null {
  try {
    const raw = localStorage.getItem(FILTER_KEY)
    if (!raw) return null
    const arr = JSON.parse(raw)
    if (Array.isArray(arr) && arr.length && arr.every((x: unknown) => KINDS.some((y) => y.k === x))) {
      return new Set(arr as TurnKind[])
    }
  } catch { /* 忽略损坏的本地存储 */ }
  return null
}

function Code({ text }: { text: string }) {
  return (
    <div className="code">
      <pre style={{ margin: 0 }} dangerouslySetInnerHTML={{ __html: highlightHtml(text) }} />
    </div>
  )
}

// Markdown 渲染块（渲染模式）：memo 化避免会话内搜索每次击键全量重解析
function Md({ text, q }: { text: string | null; q?: string }) {
  const html = useMemo(() => renderMarkdown(text || '', q), [text, q])
  return <div className="md" dangerouslySetInnerHTML={{ __html: html }} />
}

function Collapse({ title, open, children, kind }: { title: React.ReactNode; open?: boolean; children: React.ReactNode; kind?: string }) {
  const [isOpen, setOpen] = useState(!!open)
  return (
    <div className={`collapse ${kind || ''}`}>
      <div className="collapse-head" onClick={() => setOpen(!isOpen)}>
        <span className={`collapse-caret ${isOpen ? 'open' : ''}`}>▶</span>
        {title}
      </div>
      {isOpen && <div className="collapse-body">{children}</div>}
    </div>
  )
}

// 大会话分批挂载：每批挂载的轮次数（配合底部哨兵滚动加载，避免首屏一次性渲染全部轮次）
const CHUNK = 50

// memo 化：filters/q/mode/t 不变的轮次在扩容、星标等重渲染时跳过（q 由 useDeferredValue 延迟更新）
const TurnBlock = memo(function TurnBlock({ t, filters, q, mode }: { t: Turn; filters: Set<TurnKind>; q: string; mode: DetailMode }) {
  const toolJson = t.toolInput
  // 按勾选类型过滤各块；整轮都被滤掉时不渲染
  const showUser = filters.has('user') && !!t.userMessage
  const showThinking = filters.has('thinking') && !!t.thinking
  const showAssistant = filters.has('assistant') && !!t.assistantMessage
  const showTool = filters.has('tool') && !!toolJson
  const showFiles = filters.has('files') && !!(t.filesChanged && t.filesChanged.length)
  if (!showUser && !showThinking && !showAssistant && !showTool && !showFiles) return null
  return (
    <div className="turn" id={`turn-${t.seq}`}>
      {showUser ? (
        <div className="turn-role user"><strong>用户</strong></div>
      ) : null}
      {showUser ? (
        <div className="turn-body">
          <div className="message">
            {mode === 'render' ? <Md text={t.userMessage} q={q} /> : highlight(t.userMessage, q)}
          </div>
        </div>
      ) : null}

      {showThinking ? (
        <Collapse kind="thinking" title={<em style={{ color: '#8a6d1a' }}>思考过程</em>} >
          <div className="thinking-body">
            {mode === 'render' ? <Md text={t.thinking} q={q} /> : highlight(t.thinking, q)}
          </div>
        </Collapse>
      ) : null}

      {showAssistant && t.assistantMessage ? (
        <>
          <div className="turn-role"><strong>AI</strong> {t.seq != null ? <span className="hint">#{t.seq}</span> : null}</div>
          <div className="turn-body">
            {mode === 'render' ? (
              <Md text={t.assistantMessage} q={q} />
            ) : t.assistantMessage.includes('\n---\n') ? splitBlocks(t.assistantMessage, q) : <div className="message">{highlight(t.assistantMessage, q)}</div>}
          </div>
        </>
      ) : null}

      {showTool ? (
        <Collapse kind="tool" title={<span style={{ color: 'var(--accent)' }}>工具调用 / 参数</span>}>
          <Code text={toolJson} />
        </Collapse>
      ) : null}

      {showFiles ? (
        <Collapse kind="files" title={<span style={{ color: '#1a7f37' }}>文件变更（{t.filesChanged.length}）</span>}>
          <div className="file-list">
            {t.filesChanged.map((f, i) => <span key={i}>{f}</span>)}
          </div>
        </Collapse>
      ) : null}
    </div>
  )
})

function splitBlocks(text: string, q: string) {
  // 按代码块拆分标题行与正文/代码，做基础渲染
  const parts: React.ReactNode[] = []
  const lines = text.split('\n')
  const buf: string[] = []
  let inCode = false
  let idx = 0
  const flush = () => {
    if (!buf.length) return
    const joined = buf.join('\n')
    parts.push(inCode ? <Code key={idx++} text={joined} /> : <div className="message" key={idx++}>{highlight(joined, q)}</div>)
    buf.length = 0
  }
  for (const line of lines) {
    if (/^```/.test(line)) {
      flush(); inCode = !inCode
    } else {
      buf.push(line)
    }
  }
  flush()
  return parts
}

function triggerDownload(name: string, content: string, mime: string) {
  const blob = new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

export default function SessionView({ sessionId, locate, onBack }: { sessionId: string; locate?: Locate; onBack: () => void }) {
  const [s, setS] = useState<SessionDetail | null>(null)
  const [err, setErr] = useState('')
  const [exporting, setExporting] = useState<'md' | 'json' | null>(null)
  // 类型过滤：初始取全局习惯（无则全选）
  const [filters, setFilters] = useState<Set<TurnKind>>(() => loadSavedFilters() ?? new Set(KINDS.map((x) => x.k)))
  const [remember, setRemember] = useState(() => localStorage.getItem(FILTER_KEY) !== null)
  // 展示模式：默认 Markdown 渲染；切换原文（选择记忆在本地）
  const [mode, setMode] = useState<DetailMode>(loadMode)
  // 转交：清洗上下文后一键复制（不路由到具体软件，用户粘贴给任意 Agent）
  const [copyMsg, setCopyMsg] = useState('')
  const [copyBusy, setCopyBusy] = useState(false)
  // 会话内搜索：关键词过滤本轮会话的 turns（本地内存过滤，即时生效）
  const [inlineQ, setInlineQ] = useState('')
  // 性能：搜索词延迟下发渲染（打字保持响应，重解析在低优先级渲染中完成）
  const deferredQ = useDeferredValue(inlineQ.trim())
  // 分批挂载：当前已挂载的轮次上限
  const [visibleCount, setVisibleCount] = useState(CHUNK)
  const sentinelRef = useRef<HTMLDivElement | null>(null)
  const scrolledRef = useRef(false)
  // 搜索命中定位（readme §D）：locate 变化时预填会话内搜索词并滚动到命中轮次
  const locateKey = `${locate?.seq ?? ''}|${locate?.q ?? ''}`

  useEffect(() => {
    setS(null); setErr('')
    setInlineQ(locate?.q || '')
    fetchSession(sessionId).then(setS).catch((e) => setErr(String(e)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, locateKey])

  // 会话/搜索词变化时重置分批与定位标记
  useEffect(() => {
    setVisibleCount(CHUNK)
    scrolledRef.current = false
  }, [sessionId, locateKey, deferredQ])

  // 会话内搜索命中：命中任一字段（用户/助手/思考/工具）即保留该轮
  const matchedTurns = useMemo(() => {
    const ql = deferredQ.toLowerCase()
    if (!ql) return s?.turns || []
    return (s?.turns || []).filter((t) => [t.userMessage, t.assistantMessage, t.thinking, t.toolInput]
      .some((x) => x && x.toLowerCase().includes(ql)))
  }, [s, deferredQ])
  const hasMore = matchedTurns.length > visibleCount

  // 底部哨兵进入视口（提前 600px）时挂载下一批；点击兜底（IO 不触发时）。
  // 依赖 visibleCount：扩容后若哨兵仍在范围内，重建 observer 立即再挂一批（IO 不重复回调同状态）
  useEffect(() => {
    const el = sentinelRef.current
    if (!el || !hasMore) return
    const io = new IntersectionObserver((es) => {
      if (es.some((e) => e.isIntersecting)) setVisibleCount((c) => c + CHUNK)
    }, { rootMargin: '600px' })
    io.observe(el)
    return () => io.disconnect()
  }, [hasMore, visibleCount])

  // 详情加载完成后滚动到命中轮次（若有）；目标在未挂载区间时先扩容再滚
  useEffect(() => {
    if (!s || locate?.seq == null || scrolledRef.current) return
    const idx = matchedTurns.findIndex((t) => t.seq === locate.seq)
    if (idx >= 0 && idx >= visibleCount) {
      setVisibleCount(Math.ceil((idx + 1) / CHUNK) * CHUNK)
      return // 扩容提交后本 effect 再跑一次完成滚动
    }
    const el = document.getElementById(`turn-${locate.seq}`)
    if (el) {
      el.scrollIntoView({ block: 'center' })
      scrolledRef.current = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s, locateKey, visibleCount, deferredQ])

  // 星标收藏：本地即时更新，失败回滚提示
  const onStar = async () => {
    if (!s) return
    const prev = s.starred
    setS({ ...s, starred: prev ? 0 : 1 })
    try {
      const starred = await toggleStar(sessionId)
      setS((cur) => (cur ? { ...cur, starred } : cur))
    } catch (e) {
      setS((cur) => (cur ? { ...cur, starred: prev } : cur))
      setErr('星标失败：' + String(e))
    }
  }

  // 复制清洗后的上下文：优先剪贴板 API，降级 textarea 选中复制（兼容非安全上下文）
  const onCopyContext = async () => {
    setCopyBusy(true); setCopyMsg('')
    try {
      const c = await fetchContext(sessionId)
      let ok = false
      try { await navigator.clipboard.writeText(c.text); ok = true } catch { /* 降级 */ }
      if (!ok) {
        const ta = document.createElement('textarea')
        ta.value = c.text
        ta.style.position = 'fixed'; ta.style.opacity = '0'
        document.body.appendChild(ta); ta.select()
        ok = document.execCommand('copy')
        document.body.removeChild(ta)
      }
      setCopyMsg(ok ? '已复制清洗后上下文（保留对话与代码，剔除思考/工具/文件噪音），可粘贴给任意 Agent' : '复制失败，请重试')
    } catch (e) {
      setCopyMsg('获取上下文失败：' + (e as Error).message)
    } finally {
      setCopyBusy(false)
    }
  }

  // "记住为默认"：勾选时持续持久化当前过滤集，取消勾选则清除
  useEffect(() => {
    if (remember) localStorage.setItem(FILTER_KEY, JSON.stringify([...filters]))
    else localStorage.removeItem(FILTER_KEY)
  }, [filters, remember])

  const toggleMode = () => {
    const next: DetailMode = mode === 'render' ? 'raw' : 'render'
    setMode(next)
    localStorage.setItem(MODE_KEY, next)
  }

  const toggleKind = (k: TurnKind) => {
    setFilters((prev) => {
      const next = new Set(prev)
      if (next.has(k)) next.delete(k)
      else next.add(k)
      // 至少保留一种类型，避免整页空白
      return next.size ? next : new Set([k])
    })
  }

  const onExport = async (format: 'md' | 'json') => {
    setExporting(format)
    try {
      const e = await fetchExport(sessionId, format)
      const mime = format === 'json' ? 'application/json;charset=utf-8' : 'text/markdown;charset=utf-8'
      triggerDownload(e.name, e.content, mime)
    } catch (e2) {
      setErr(String(e2))
    } finally {
      setExporting(null)
    }
  }

  if (err) return <div className="empty"><div className="error">{err}</div><button onClick={onBack}>返回</button></div>
  if (!s) return <div className="empty">加载会话…</div>

  return (
    <div style={{ padding: 20, maxWidth: 880, margin: '0 auto', height: '100%', overflowY: 'auto', boxSizing: 'border-box' }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
        <button className="scan-btn" onClick={onBack}>← 返回</button>
        <button
          className={`scan-btn star-btn ${s.starred ? 'starred' : ''}`}
          onClick={onStar}
          title={s.starred ? '取消星标' : '星标收藏，便于快速找回'}
        >
          {s.starred ? '★ 已收藏' : '☆ 收藏'}
        </button>
        <span className="spacer" style={{ flex: 1 }} />
        <button
          className="scan-btn"
          disabled={copyBusy}
          onClick={onCopyContext}
          title="把会话清洗为初始 prompt（保留对话与代码，剔除思考/工具/文件噪音）并复制到剪贴板，可粘贴给任意 Agent"
        >
          {copyBusy ? '复制中…' : '复制上下文 ⧉'}
        </button>
        <button className="scan-btn" disabled={exporting !== null} onClick={() => onExport('md')}>
          {exporting === 'md' ? '导出中…' : '导出 Markdown'}
        </button>
        <button className="scan-btn" disabled={exporting !== null} onClick={() => onExport('json')}>
          {exporting === 'json' ? '导出中…' : '导出 JSON'}
        </button>
      </div>
      {copyMsg && <div className="hint" style={{ marginBottom: 8 }}>{copyMsg}</div>}
      <div className="hint" style={{ marginBottom: 8 }}>
        转交提示：粘贴到任意 Agent 即可继续；若需统一管理多个 Agent，可了解 Omnigent、AionUi、OpenHands、ORCH、LiteLLM Agent Control Plane 等统一入口工具。
      </div>
      <div className="detail-head">
        <h2 className="detail-title">{s.title || '(无标题)'}</h2>
        <div className="meta-tags">
          <span className="meta-tag">{s.agentId}</span>
          {s.account && <span className="meta-tag">账号：{s.account}</span>}
          {s.project && <span className="meta-tag">项目：{s.project}</span>}
          {s.model && <span className="meta-tag">模型：{s.model}</span>}
          {s.rawFormat && <span className="meta-tag">格式：{s.rawFormat}</span>}
          <span className="meta-tag">{s.turnCount} 轮</span>
          <span className="meta-tag">{fmtTimeFull(s.updatedAt)}</span>
        </div>
        {s.sourceNote && (
          <div className="source-note" style={{ marginTop: 10, padding: '8px 12px', borderRadius: 6, background: '#fff3cd', border: '1px solid #e0c252', color: '#7a5c00', fontSize: 13 }}>
            ⓘ {s.sourceNote}
          </div>
        )}
        {s.subject && <div className="list-sub" style={{ marginTop: 8 }}>主题：{s.subject}</div>}
      </div>
      <div className="kind-filter-row">
        <input
          className="select"
          style={{ flex: 1, minWidth: 140 }}
          value={inlineQ}
          placeholder="会话内搜索…"
          onChange={(e) => setInlineQ(e.target.value)}
        />
        {inlineQ.trim() !== deferredQ && (
          <span className="status">过滤中…</span>
        )}
        {deferredQ && (
          <span className="status">{matchedTurns.length}/{s.turns.length} 轮命中</span>
        )}
        <span className="depth-label">显示</span>
        <button
          className={`depth-pill ${mode === 'render' ? 'active' : ''}`}
          onClick={toggleMode}
          title="切换 Markdown 渲染 / 原文展示（默认渲染，选择会记忆）"
        >
          {mode === 'render' ? '渲染' : '原文'}
        </button>
        <span className="depth-label">只看</span>
        {KINDS.map((x) => (
          <button key={x.k} className={`depth-pill ${filters.has(x.k) ? 'active' : ''}`} onClick={() => toggleKind(x.k)}>
            {x.label}
          </button>
        ))}
        <label className="auto-toggle" title="把当前过滤选择保存为所有会话详情的默认展示">
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
          复用为全局习惯
        </label>
      </div>
      {deferredQ && matchedTurns.length === 0 && (
        <div className="empty">本会话没有命中「{deferredQ}」的内容。</div>
      )}
      {matchedTurns.slice(0, visibleCount).map((t) => <TurnBlock key={t.seq} t={t} filters={filters} q={deferredQ} mode={mode} />)}
      {hasMore && (
        <div
          ref={sentinelRef}
          className="load-more"
          onClick={() => setVisibleCount((c) => c + CHUNK)}
          title="滚动到此处自动加载，点击立即展开"
        >
          继续展示 · 已显示 {visibleCount}/{matchedTurns.length} 轮
        </div>
      )}
    </div>
  )
}