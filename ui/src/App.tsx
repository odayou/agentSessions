import { useState, useCallback, useEffect } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { doScan, ping, fetchStats, fetchConfig } from './api'
import ProjectsView from './views/ProjectsView'
import SearchView from './views/SearchView'
import SessionView from './views/SessionView'
import StatsView from './views/StatsView'
import SettingsView from './views/SettingsView'
import TimelineView from './views/TimelineView'
import { eventToHotkey, formatHotkey, hasModifier } from './hotkey'
import { IS_TAURI } from './lib'
import type { Locate, Stats } from './types'

// —— hash 路由：#/sessions(默认·时间线) | #/search | #/projects | #/stats | #/settings | #/session/<id>[?seq=&q=] ——
// 会话详情在右栏打开，浏览器前进/后退自然闭环。
// seq/q 为搜索命中定位参数（readme §D：点击跳转到会话详情的命中轮次）。
type ListView = 'sessions' | 'search' | 'projects' | 'stats' | 'settings'

interface Route {
  list: ListView
  sessionId: string | null
  locate: Locate
}

const LIST_VIEWS: ListView[] = ['sessions', 'search', 'projects', 'stats', 'settings']
const EMPTY_LOCATE: Locate = { seq: null, q: '' }

function parseHash(): Route {
  const seg = (location.hash || '#/').replace(/^#\/?/, '').split('/').filter(Boolean)
  if (seg[0] === 'session' && seg[1]) {
    // 会话路由：左栏列表视图不随 hash 变化（保持用户所在列表），仅打开右栏详情
    const [idPart, query = ''] = seg[1].split('?')
    const qp = new URLSearchParams(query)
    const seqRaw = qp.get('seq')
    return {
      list: lastList,
      sessionId: decodeURIComponent(idPart),
      locate: {
        seq: seqRaw !== null && seqRaw !== '' ? Number(seqRaw) : null,
        q: qp.get('q') || '',
      },
    }
  }
  const list = LIST_VIEWS.includes(seg[0] as ListView) ? (seg[0] as ListView) : 'sessions'
  lastList = list
  return { list, sessionId: null, locate: EMPTY_LOCATE }
}

// 上一个列表视图（供 session 路由返回时恢复；模块级即可，不参与渲染）
let lastList: ListView = 'sessions'

export default function App() {
  const [route, setRoute] = useState<Route>(() => parseHash())
  const [dbOnline, setDbOnline] = useState(true)
  const [scanning, setScanning] = useState(false)
  const [scanMsg, setScanMsg] = useState('')
  const [leftCollapsed, setLeftCollapsed] = useState(false)
  // 扫描后递增以强制列表/详情重挂载重拉数据
  const [refreshKey, setRefreshKey] = useState(0)
  // 搜索快捷键（设置页可录制自定义；默认 '/'）
  const [searchHotkey, setSearchHotkey] = useState('/')
  // 启动门控：桌面版后端由主进程拉起，就绪前显示过渡屏而非空状态界面
  const [booting, setBooting] = useState(true)
  const [bootSlow, setBootSlow] = useState(false)

  const checkOnline = useCallback(async () => {
    try {
      const ok = await ping()
      setDbOnline(ok)
      if (ok) setBooting(false)
    } catch {
      setDbOnline(false)
    }
  }, [])

  // 常规健康检查（就绪后 5s 一拍）
  useEffect(() => {
    checkOnline()
    const t = setInterval(checkOnline, 5000)
    return () => clearInterval(t)
  }, [checkOnline])

  // 启动期快轮询：后端监听端口的瞬间放行，避免 5s 间隔造成人为延迟
  useEffect(() => {
    if (!booting) return
    const t = setInterval(checkOnline, 150)
    return () => clearInterval(t)
  }, [booting, checkOnline])

  // 启动过慢提示（>10s）
  useEffect(() => {
    if (!booting) return
    const t = setTimeout(() => setBootSlow(true), 10_000)
    return () => clearTimeout(t)
  }, [booting])

  // 开发者工具（仅桌面壳）：F12 / Ctrl+Shift+I 切换 WebView DevTools；浏览器模式不劫持
  useEffect(() => {
    if (!IS_TAURI) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'F12' || (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'i')) {
        e.preventDefault()
        invoke('toggle_devtools').catch(() => {})
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // 路由：hash 变化（含浏览器前进/后退）→ 同步状态
  useEffect(() => {
    const onHash = () => setRoute(parseHash())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  // 热键配置：挂载时读取；设置保存后 refreshKey 变化 → 重载生效
  useEffect(() => {
    fetchConfig().then((c) => setSearchHotkey(c.searchHotkey || '/')).catch(() => {})
  }, [refreshKey])

  const goList = useCallback((view: ListView) => {
    location.hash = `#/${view}`
  }, [])

  const openSession = useCallback((id: string, loc?: { seq?: number | null; q?: string }) => {
    const qp = new URLSearchParams()
    if (loc?.seq != null) qp.set('seq', String(loc.seq))
    if (loc?.q) qp.set('q', loc.q)
    const query = qp.toString()
    location.hash = `#/session/${encodeURIComponent(id)}${query ? '?' + query : ''}`
  }, [])

  const closeSession = useCallback(() => {
    location.hash = `#/${lastList}`
  }, [])

  // 快捷键（M4）：Esc 关闭详情返回列表；可自定义热键（默认 /）跳到搜索并聚焦输入框
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing) return // 输入法组词过程中的按键不处理
      if (e.key === 'Escape' && route.sessionId) { closeSession(); return }
      const hk = eventToHotkey(e)
      if (!hk || hk !== searchHotkey) return
      // 裸键（如 /）在输入框内不劫持，避免打断正常输入；组合键（如 Ctrl+K）随时可用
      if (!hasModifier(hk)) {
        const t = e.target as HTMLElement | null
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      }
      e.preventDefault()
      const focusSearch = () => (document.getElementById('search-input') as HTMLInputElement | null)?.focus()
      // 已在搜索页：hash 不变不会触发重渲染，同步聚焦即可
      if (location.hash === '#/search') { focusSearch(); return }
      location.hash = '#/search'
      // SearchView 挂载时序不定（首次切换视图），多级兜底聚焦
      requestAnimationFrame(focusSearch)
      setTimeout(focusSearch, 60)
      setTimeout(focusSearch, 250)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [route.sessionId, closeSession, searchHotkey])

  const onScan = useCallback(async () => {
    setScanning(true); setScanMsg('')
    try {
      const r = await doScan()
      setScanMsg(`扫描完成：${r.stats.sessions} 会话, ${r.stats.turns} 轮次`)
      setRefreshKey((k) => k + 1) // 触发视图重挂载刷新
      setTimeout(() => checkOnline(), 200)
    } catch (e) {
      setScanMsg('扫描失败：' + (e as Error).message)
    } finally {
      setScanning(false)
    }
  }, [checkOnline])

  // 启动过渡屏：后端就绪前不渲染主界面，避免空状态文字闪现
  if (booting) {
    return (
      <div className="boot-splash">
        <h2>AgentSessions</h2>
        <div className="boot-spinner" aria-hidden />
        <p>{bootSlow ? '仍在启动中…若长时间无响应，请关闭后重试' : '正在启动本地服务…'}</p>
      </div>
    )
  }

  if (!dbOnline) {
    return (
      <div className="offline-overlay">
        <h2>AgentSessions</h2>
        <p>无法连接本地后端服务。</p>
        <div className="hint">后端服务未启动或连接失败。请确认 Node 桥在 18778 端口运行（桌面版会自动拉起）。</div>
      </div>
    )
  }

  return (
    <div className="app">
      <header className="topbar">
        <h1>AgentSessions</h1>
        <nav className="tabs">
          <button className={`tab ${route.list === 'sessions' && !route.sessionId ? 'active' : ''}`} onClick={() => goList('sessions')}>会话</button>
          <button className={`tab ${route.list === 'search' && !route.sessionId ? 'active' : ''}`} onClick={() => goList('search')}>搜索 <span className="kbd">{formatHotkey(searchHotkey)}</span></button>
          <button className={`tab ${route.list === 'projects' && !route.sessionId ? 'active' : ''}`} onClick={() => goList('projects')}>项目 / 账号</button>
          <button className={`tab ${route.list === 'stats' && !route.sessionId ? 'active' : ''}`} onClick={() => goList('stats')}>统计</button>
          <button className={`tab ${route.list === 'settings' && !route.sessionId ? 'active' : ''}`} onClick={() => goList('settings')}>设置</button>
        </nav>
        <span className="spacer" />
        <span className="status">{scanMsg}</span>
        <button className="scan-btn" disabled={scanning} onClick={onScan}>{scanning ? '扫描中…' : '扫描'}</button>
      </header>
      <div className="body">
        {/* 左栏：列表视图（详情打开时可收起） */}
        <div className={`main-col ${route.sessionId ? 'has-detail' : ''} ${route.sessionId && leftCollapsed ? 'collapsed' : ''}`}>
          {route.list === 'sessions' && <TimelineView key={`tl-${refreshKey}`} onOpenSession={openSession} />}
          {route.list === 'projects' && <ProjectsView key={`p-${refreshKey}`} onOpenSession={openSession} />}
          {route.list === 'search' && <SearchView key={`s-${refreshKey}`} onOpenSession={openSession} hotkeyLabel={formatHotkey(searchHotkey)} />}
          {route.list === 'stats' && <StatsView key={`st-${refreshKey}`} />}
          {route.list === 'settings' && <SettingsView key={`se-${refreshKey}`} onSaved={() => setRefreshKey((k) => k + 1)} />}
        </div>
        {/* 右栏：会话详情 */}
        {route.sessionId && (
          <>
            <button
              className="collapse-left"
              title={leftCollapsed ? '展开列表' : '收起列表'}
              onClick={() => setLeftCollapsed((v) => !v)}
            >
              {leftCollapsed ? '»' : '«'}
            </button>
            <div className="detail-col">
              <SessionView key={`d-${route.sessionId}-${refreshKey}`} sessionId={route.sessionId} locate={route.locate} onBack={closeSession} />
            </div>
          </>
        )}
      </div>
      <StatusBar refreshKey={refreshKey} />
    </div>
  )
}

// 底部状态栏（readme §6.1）：已索引量 + 最近扫描时间，让自动增量扫描"看得见"
function StatusBar({ refreshKey }: { refreshKey: number }) {
  const [info, setInfo] = useState<{ stats: Stats; lastScanAt: number } | null>(null)

  useEffect(() => {
    let alive = true
    const load = () => fetchStats(1).then((d) => { if (alive) setInfo(d) }).catch(() => {})
    load()
    const t = setInterval(load, 60 * 1000)
    return () => { alive = false; clearInterval(t) }
  }, [refreshKey])

  const lastScan = !info?.lastScanAt
    ? '未扫描'
    : Date.now() - info.lastScanAt < 60 * 1000
      ? '刚刚'
      : Date.now() - info.lastScanAt < 3600 * 1000
        ? `${Math.floor((Date.now() - info.lastScanAt) / 60000)} 分钟前`
        : new Date(info.lastScanAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })

  return (
    <footer className="statusbar">
      {info
        ? <>已索引 {info.stats.totalSessions.toLocaleString()} 会话 · {info.stats.totalProjects} 项目 · {info.stats.byAgent.length} 个 Agent · 最后扫描 {lastScan}</>
        : '…'}
    </footer>
  )
}
