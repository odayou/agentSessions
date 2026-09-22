import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { fetchAccounts, fetchConfig, saveConfig, fetchStats } from '../api'
import { eventToHotkey, formatHotkey } from '../hotkey'
import { IS_TAURI } from '../lib'
import type { Account, AppConfig, DetectedAgent } from '../types'

const KINDS = ['other', 'work', 'personal']
// 与 src/detect.js 的 AGENTS 清单保持一致（id + 显示名）
const AGENT_LIST: { id: string; label: string }[] = [
  { id: 'opencode', label: 'OpenCode' },
  { id: 'claude-code', label: 'Claude Code' },
  { id: 'workbuddy', label: 'WorkBuddy' },
  { id: 'trae', label: 'Trae' },
  { id: 'traework', label: 'TRAE SOLO' },
  { id: 'codebuddy', label: 'CodeBuddy' },
  { id: 'lingma', label: 'Lingma' },
  { id: 'codex', label: 'Codex' },
]

// 设置视图（M4，规划 §三F）：排除规则（S8）/ 自动扫描间隔 / 账号映射 / Agent 路径 / 大文件保护。
// 保存走 POST /api/config，服务端保存后自动重扫一次使排除立即生效。
export default function SettingsView({ onSaved }: { onSaved?: () => void }) {
  const [config, setConfig] = useState<AppConfig | null>(null)
  const [accounts, setAccounts] = useState<Account[]>([])
  const [excludesText, setExcludesText] = useState('')
  const [autoScan, setAutoScan] = useState(5)
  // Agent 会话目录手动配置（readme §风险应对：默认目录探测不到时手动指定；仅限已知 agent）
  const [agentPaths, setAgentPaths] = useState<Record<string, string>>({})
  // 大文件保护：超过该阈值的会话文件跳过索引（默认 50MB）
  const [maxSize, setMaxSize] = useState(50)
  // 搜索快捷键（点击录入框后按下新按键；'/' 为默认）
  const [hotkey, setHotkey] = useState('/')
  const [recording, setRecording] = useState(false)
  // 账号映射编辑态：key `${agentId}::${rawName}` → { displayName, kind }
  const [mapping, setMapping] = useState<Record<string, { displayName: string; kind: string }>>({})
  // 最近一次扫描探测到的 agent 明细（含"已安装未索引"）
  const [detected, setDetected] = useState<DetectedAgent[]>([])
  const [msg, setMsg] = useState('')
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')

  useEffect(() => {
    fetchConfig().then((c) => {
      setConfig(c)
      setExcludesText(c.excludes.join('\n'))
      setAutoScan(c.autoScanMinutes)
      setAgentPaths(c.agentPaths || {})
      setMaxSize(c.maxFileSizeMB ?? 50)
      setHotkey(c.searchHotkey || '/')
    }).catch((e) => setErr(String(e)))
    fetchAccounts().then(setAccounts).catch(() => {})
    fetchStats(1).then((d) => setDetected(d.agents || [])).catch(() => {})
  }, [])

  // 用账号列表 + 现有映射初始化编辑态（accounts 异步到达后）
  useEffect(() => {
    if (!config || !accounts.length) return
    const next: Record<string, { displayName: string; kind: string }> = {}
    for (const a of accounts) {
      const key = `${a.agentId}::${a.rawName}`
      const m = config.accountMapping[key]
      // 服务端返回的账号行已是映射生效后的值；有显式映射则以其为准（displayName 可被清空回退 raw）
      next[key] = {
        displayName: m ? (m.displayName ?? a.rawName) : (a.displayName || a.rawName),
        kind: (m && m.kind) || a.kind || 'other',
      }
    }
    setMapping(next)
  }, [config, accounts])

  if (err) return <div className="empty" style={{ padding: 20 }}>{err}</div>
  if (!config) return <div className="empty" style={{ padding: 20 }}>加载配置中…</div>

  const setOne = (key: string, patch: Partial<{ displayName: string; kind: string }>) => {
    setMapping((m) => ({ ...m, [key]: { ...m[key], ...patch } }))
  }

  const onSave = async () => {
    setSaving(true); setMsg(''); setErr('')
    try {
      const excludes = excludesText.split('\n').map((s) => s.trim()).filter(Boolean)
      // 全量提交账号映射（含未改动行）：改回默认名/other 也能正确覆盖清除旧映射
      const accountMapping: Record<string, { displayName?: string; kind?: string }> = {}
      for (const a of accounts) {
        const key = `${a.agentId}::${a.rawName}`
        const m = mapping[key]
        if (!m) continue
        accountMapping[key] = { displayName: m.displayName.trim() || a.rawName, kind: m.kind }
      }
      // agentPaths 仅提交非空值（空 = 使用默认探测目录）；键限已知 agent
      const nextPaths: Record<string, string> = {}
      for (const { id } of AGENT_LIST) {
        const v = (agentPaths[id] || '').trim()
        if (v) nextPaths[id] = v
      }
      const saved = await saveConfig({
        excludes, autoScanMinutes: autoScan, accountMapping,
        agentPaths: nextPaths, maxFileSizeMB: maxSize, searchHotkey: hotkey,
      })
      setConfig(saved)
      setExcludesText(saved.excludes.join('\n'))
      setAgentPaths(saved.agentPaths || {})
      setHotkey(saved.searchHotkey || '/')
      setMsg('已保存，服务端已自动重扫（排除规则即时生效）')
      onSaved?.()
    } catch (e) {
      setErr('保存失败：' + String(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="settings-page">
      <div className="panel">
        <h3>排除规则（不索引指定路径）</h3>
        <div className="stats-body">
          <div className="hint" style={{ marginBottom: 8 }}>
            每行一条，按「源文件路径」与「项目目录」匹配。无通配符按路径包含匹配（贴目录即排除其下所有会话）；
            含 <code>*</code>/<code>?</code> 按 glob 匹配整条路径（<code>**</code> 跨目录）。保存后立即清理已索引的命中会话。
          </div>
          <textarea
            className="settings-textarea"
            value={excludesText}
            onChange={(e) => setExcludesText(e.target.value)}
            placeholder={'例：\nD:\\private\n**/playground/**\n**/node_modules/**'}
            rows={6}
            spellCheck={false}
          />
        </div>
      </div>

      <div className="panel">
        <h3>自动增量扫描</h3>
        <div className="stats-body scan-setting">
          <span>每</span>
          <input
            className="settings-number"
            type="number"
            min={0}
            max={1440}
            value={autoScan}
            onChange={(e) => setAutoScan(Math.max(0, Math.min(1440, Number(e.target.value) || 0)))}
          />
          <span>分钟自动增量扫描一次（0 = 关闭；服务启动时也会先扫一次，约 30 秒内生效）</span>
        </div>
      </div>

      <div className="panel">
        <h3>账号映射（显示名 / 工作·个人归类）</h3>
        <div className="stats-body">
          {accounts.length === 0 && <div className="empty">暂无账号（先扫描一次）</div>}
          <table className="settings-table">
            <tbody>
              {accounts.map((a) => {
                const key = `${a.agentId}::${a.rawName}`
                const m = mapping[key]
                if (!m) return null
                return (
                  <tr key={a.id}>
                    <td className="settings-agent">{a.agentId}</td>
                    <td className="settings-raw">{a.rawName}</td>
                    <td>
                      <input
                        className="settings-input"
                        value={m.displayName}
                        onChange={(e) => setOne(key, { displayName: e.target.value })}
                      />
                    </td>
                    <td>
                      <select
                        className="select"
                        value={m.kind}
                        onChange={(e) => setOne(key, { kind: e.target.value })}
                      >
                        {KINDS.map((k) => <option key={k} value={k}>{k === 'work' ? 'work（工作）' : k === 'personal' ? 'personal（个人）' : 'other（其他）'}</option>)}
                      </select>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div className="panel">
        <h3>Agent 会话目录（手动指定）</h3>
        <div className="stats-body">
          <div className="hint" style={{ marginBottom: 8 }}>
            默认自动探测各 Agent 的会话目录；若安装位置非标准（如绿色版、自定义 HOME），在此填入其会话根目录，
            下次扫描将纳入。留空 = 使用自动探测。Windows 下多层目录请用完整路径。
          </div>
          <table className="settings-table">
            <tbody>
              {AGENT_LIST.map(({ id, label }) => {
                const d = detected.find((x) => x.id === id)
                const unsupported = d?.status === 'placeholder'
                return (
                  <tr key={id}>
                    <td className="settings-agent">
                      {label}
                      {d && (
                        <span className={`meta-tag ${unsupported ? 'agent-dim' : ''}`} style={{ marginLeft: 6 }}>
                          {unsupported ? '已安装 · 暂不支持索引' : `已索引 ${d.sessions ?? 0} 会话`}
                        </span>
                      )}
                    </td>
                    <td>
                      {unsupported ? (
                        <span className="hint">会话为私有格式，暂无法读取内容</span>
                      ) : (
                        <input
                          className="settings-input"
                          style={{ width: '100%' }}
                          value={agentPaths[id] || ''}
                          placeholder="留空自动探测"
                          onChange={(e) => setAgentPaths((p) => ({ ...p, [id]: e.target.value }))}
                          spellCheck={false}
                        />
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div className="panel">
        <h3>大文件保护</h3>
        <div className="stats-body scan-setting">
          <span>超过</span>
          <input
            className="settings-number"
            type="number"
            min={0}
            max={2048}
            value={maxSize}
            onChange={(e) => setMaxSize(Math.max(0, Math.min(2048, Number(e.target.value) || 0)))}
          />
          <span>MB 的会话文件跳过索引（0 = 不限制；防止个别超大 jsonl 拖慢扫描）</span>
        </div>
      </div>

      <div className="panel">
        <h3>快捷键（打开搜索）</h3>
        <div className="stats-body">
          <div className="scan-setting">
            <div
              className={`hotkey-box ${recording ? 'recording' : ''}`}
              tabIndex={0}
              onFocus={() => setRecording(true)}
              onBlur={() => setRecording(false)}
              onKeyDown={(e) => {
                e.preventDefault()
                e.stopPropagation() // 录入过程不触发全局快捷键（含 App 层监听）
                if (e.key === 'Escape') { (e.target as HTMLElement).blur(); return }
                if (e.nativeEvent.isComposing) return
                const hk = eventToHotkey(e.nativeEvent)
                if (!hk) return // 纯修饰键，继续等待
                setHotkey(hk)
                ;(e.target as HTMLElement).blur()
              }}
              title="点击后按下新按键录入"
            >
              {recording ? '按下新按键…（Esc 取消）' : formatHotkey(hotkey)}
            </div>
            <button className="scan-btn mini-btn" onClick={() => setHotkey('/')}>恢复默认 /</button>
          </div>
          <div className="hint" style={{ marginTop: 8 }}>
            点击录入框后按下新按键即可（单键如 /、F3，或组合键如 Ctrl+K）。单键在输入框内不触发，组合键任何位置都触发。
            请避开浏览器或插件已占用的按键。保存后生效。
          </div>
        </div>
      </div>

      {IS_TAURI && (
        <div className="panel">
          <h3>调试</h3>
          <div className="stats-body">
            <div className="scan-setting">
              <button
                className="scan-btn"
                onClick={() => invoke('toggle_devtools').catch(() => {})}
                title="打开/关闭 WebView 开发者工具（也可用 F12 / Ctrl+Shift+I）"
              >
                打开开发者工具
              </button>
              <span className="hint">页面异常时排查用（F12 / Ctrl+Shift+I 随处可开）</span>
            </div>
          </div>
        </div>
      )}

      <div className="settings-actions">
        <button className="scan-btn" disabled={saving} onClick={onSave}>{saving ? '保存中…' : '保存配置'}</button>
        {msg && <span className="status" style={{ color: '#1a7f37' }}>{msg}</span>}
        {err && <span className="status" style={{ color: '#cf222e' }}>{err}</span>}
      </div>
    </div>
  )
}
