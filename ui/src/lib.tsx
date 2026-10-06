// 前端共享工具：时间格式化 + 关键词高亮（列表卡片与详情视图共用）。
import React from 'react'
import { openUrl } from '@tauri-apps/plugin-opener'

// 是否运行在 Tauri 桌面壳内（浏览器 dev 模式为 false，沿用浏览器自带 DevTools）
export const IS_TAURI = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

// 打开外部链接：桌面壳内走 opener 插件（webview 里 window.open 与 target="_blank" 被拦截），
// 浏览器 dev 模式回落原生 window.open
export function openExternal(url: string): void {
  if (IS_TAURI) openUrl(url).catch((e) => console.error('打开外链失败：', e))
  else window.open(url)
}

// 全局兜底：markdown 渲染出的 <a target="_blank"> 在桌面壳内点了没反应，
// 捕获点击统一改走 openExternal（浏览器 dev 模式行为不变，仅把默认新标签换成 window.open）
export function installExternalLinkHandler(): void {
  document.addEventListener('click', (e) => {
    const a = (e.target as Element | null)?.closest?.('a[target="_blank"]') as HTMLAnchorElement | null
    if (!a) return
    const href = a.getAttribute('href')
    if (!href) return
    e.preventDefault()
    openExternal(href)
  })
}

// 短格式（不含年）：列表卡片时间徽标；空值显示 fallback
export function fmtTime(t: number | null, fallback = '—'): string {
  if (!t) return fallback
  return new Date(t).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

// 完整格式（含年）：会话详情头部
export function fmtTimeFull(t: number | null): string {
  if (!t) return ''
  return new Date(t).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// 关键词高亮：按不区分大小写拆词包裹 <mark>（React 文本节点，天然防注入）；
// 无关键词或首词未命中时原样返回（省去正则开销）。
export function highlight(text: string | null | undefined, q: string): React.ReactNode {
  if (!text) return null
  const terms = q.trim().split(/\s+/).filter(Boolean)
  if (!terms.length || !text.toLowerCase().includes(terms[0].toLowerCase())) {
    return <>{text}</>
  }
  const parts: React.ReactNode[] = []
  const re = new RegExp(`(${terms.map(escapeRe).join('|')})`, 'gi')
  let last = 0
  let key = 0
  for (const m of text.matchAll(re)) {
    const idx = m.index as number
    if (idx > last) parts.push(text.slice(last, idx))
    parts.push(<mark key={key++}>{m[0]}</mark>)
    last = idx + m[0].length
  }
  if (last < text.length) parts.push(text.slice(last))
  return <>{parts}</>
}
