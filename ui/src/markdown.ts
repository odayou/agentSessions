// markdown.ts —— 极简 Markdown 渲染（零依赖，遵循项目无三方库约定）
// 安全模型：输入先整体 HTML 转义，此后只追加自生成的白名单标签，链接仅放行
// http(s)/mailto/#/相对路径，天然免疫 XSS；关键词 <mark> 在行内转换后、
// 避开标签区间插入（代码块内不高亮，与原文模式行为一致）。
import { highlightHtml } from './highlight'

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ESC[c])
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// 关键词 <mark> 包裹（输入为已转义文本，q 需同样转义后匹配）
function markTerms(escaped: string, q: string): string {
  const terms = q.trim().split(/\s+/).filter(Boolean).map(escapeHtml)
  if (!terms.length) return escaped
  if (!escaped.toLowerCase().includes(terms[0].toLowerCase())) return escaped
  const re = new RegExp(`(${terms.map(escapeRe).join('|')})`, 'gi')
  return escaped.replace(re, '<mark>$1</mark>')
}

// 只在标签之间的文本区间做关键词标记，避免污染标签名/属性
function markOutsideTags(html: string, q: string): string {
  if (!q.trim()) return html
  return html
    .split(/(<[^>]+>)/g)
    .map((part) => (part.startsWith('<') ? part : markTerms(part, q)))
    .join('')
}

// 链接白名单：http(s)/mailto/#/相对路径；其余（如 javascript:）降级为纯文本
function safeUrl(u: string): string {
  return /^(https?:|mailto:|#|\/)/i.test(u) ? u : ''
}

// 行内元素：代码/图片（降级为链接文本）/链接/粗体/删除线/斜体，最后做关键词标记
function inline(s: string, q: string): string {
  const t = s
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, '[$1]($2)')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, text: string, url: string) => {
      const u = safeUrl(url)
      return u ? `<a href="${u}" target="_blank" rel="noreferrer">${text}</a>` : `${text}（${url}）`
    })
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/~~([^~\n]+)~~/g, '<del>$1</del>')
    .replace(/(^|[^\w*])\*([^*\n]+)\*(?=[^\w*]|$)/g, '$1<em>$2</em>')
    .replace(/(^|[^\w_])_([^_\n]+)_(?=[^\w_]|\W|$)/g, '$1<em>$2</em>')
  return markOutsideTags(t, q)
}

interface Seg {
  type: 'code' | 'text'
  content: string
}

// 围栏代码块切分（```；未闭合围栏按代码收尾，容错 AI 输出）
function splitFences(src: string): Seg[] {
  const segs: Seg[] = []
  const lines = src.split('\n')
  let buf: string[] = []
  let code: string[] | null = null
  for (const line of lines) {
    if (code === null) {
      if (/^```\S*\s*$/.test(line)) {
        if (buf.length) segs.push({ type: 'text', content: buf.join('\n') })
        buf = []
        code = []
      } else buf.push(line)
    } else {
      if (/^```\s*$/.test(line)) {
        segs.push({ type: 'code', content: code.join('\n') })
        code = null
      } else code.push(line)
    }
  }
  if (code !== null) segs.push({ type: 'code', content: code.join('\n') })
  if (buf.length) segs.push({ type: 'text', content: buf.join('\n') })
  return segs
}

function splitRow(l: string): string[] {
  return l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim())
}

const isHeading = (l: string) => /^#{1,6}\s+/.test(l)
// 输入已整体转义：块引用符号 > 在文本中为 &gt;（用户字面 &gt; 则是 &amp;gt;，不会误判）
const isQuote = (l: string) => /^\s*&gt;/.test(l)
const isUl = (l: string) => /^\s*[-*+]\s+/.test(l)
const isOl = (l: string) => /^\s*\d+[.)]\s+/.test(l)
const isHr = (l: string) => /^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(l)
const isTableSep = (l: string) => /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(l)
const isBlockStart = (l: string) => isHeading(l) || isQuote(l) || isUl(l) || isOl(l) || isHr(l)

// 块级元素：标题/水平线/表格/引用/列表/段落（输入为已转义文本）
function blocks(text: string, q: string): string {
  const lines = text.split('\n')
  const out: string[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim()) { i++; continue }

    const h = /^(#{1,6})\s+(.+)$/.exec(line)
    if (h) {
      const n = h[1].length
      out.push(`<h${n}>${inline(h[2], q)}</h${n}>`)
      i++
      continue
    }
    if (isHr(line)) { out.push('<hr>'); i++; continue }

    // GFM 表格：表头行含 | 且下一行为 |-| 分隔行
    if (line.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const head = splitRow(line)
      const rows: string[][] = []
      let j = i + 2
      while (j < lines.length && lines[j].trim() && lines[j].includes('|')) {
        rows.push(splitRow(lines[j]))
        j++
      }
      const th = head.map((c) => `<th>${inline(c, q)}</th>`).join('')
      const tb = rows
        .map((r) => `<tr>${head.map((_c, k) => `<td>${inline(r[k] || '', q)}</td>`).join('')}</tr>`)
        .join('')
      out.push(`<table><thead><tr>${th}</tr></thead><tbody>${tb}</tbody></table>`)
      i = j
      continue
    }

    if (isQuote(line)) {
      const quote: string[] = []
      while (i < lines.length && isQuote(lines[i])) {
        quote.push(lines[i].replace(/^\s*&gt;\s?/, ''))
        i++
      }
      out.push(`<blockquote>${blocks(quote.join('\n'), q)}</blockquote>`)
      continue
    }

    if (isUl(line)) {
      const items: string[] = []
      while (i < lines.length && isUl(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*+]\s+/, ''))
        i++
      }
      out.push(`<ul>${items.map((x) => `<li>${inline(x, q)}</li>`).join('')}</ul>`)
      continue
    }

    if (isOl(line)) {
      const items: string[] = []
      while (i < lines.length && isOl(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+[.)]\s+/, ''))
        i++
      }
      out.push(`<ol>${items.map((x) => `<li>${inline(x, q)}</li>`).join('')}</ol>`)
      continue
    }

    // 段落：连续非空行合并（单换行转 <br>，贴合聊天内容习惯）
    const para: string[] = []
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) {
      para.push(lines[i])
      i++
    }
    if (para.length) out.push(`<p>${para.map((l) => inline(l, q)).join('<br>')}</p>`)
    else {
      // 兜底：该行被判为块起始（isBlockStart）却无任何处理器接管，必须在此消费掉，
      // 否则 i 不推进会让渲染进程死循环（整页点击无响应）。按段落展示以保证一定前进。
      out.push(`<p>${inline(line.trim(), q)}</p>`)
      i++
    }
  }
  return out.join('')
}

// 渲染入口：文本段走块级+行内，代码块复用 highlight.ts 词法高亮（与原文模式同观感）
export function renderMarkdown(src: string, q = ''): string {
  if (!src) return ''
  // 统一换行：CRLF/CR → LF。行尾残留的 \r 会让块级判定与 (.+) 失配（. 不匹配 \r，
  // 且非多行 $ 只在串尾成立），曾导致标题行无人接管、blocks() 的 i 不推进而死循环（整页假死）
  const text = src.replace(/\r\n?/g, '\n')
  return splitFences(text)
    .map((seg) =>
      seg.type === 'code'
        ? `<div class="code"><pre style="margin:0">${highlightHtml(seg.content)}</pre></div>`
        : blocks(escapeHtml(seg.content), q)
    )
    .join('')
}
