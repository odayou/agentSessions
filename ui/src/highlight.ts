// 轻量语法高亮：无外部依赖，按通用 token 规则着色（对齐 GitHub 浅色语法配色）。
// 先分词再逐 token 转义，规避 XSS；返回可直接插入的 HTML 字符串。

const KEYWORDS = new Set([
  'import', 'export', 'from', 'default', 'return', 'if', 'else', 'elif', 'for', 'while',
  'do', 'switch', 'case', 'break', 'continue', 'const', 'let', 'var', 'function', 'class',
  'interface', 'type', 'extends', 'implements', 'super', 'this', 'new', 'delete', 'typeof',
  'instanceof', 'in', 'of', 'async', 'await', 'yield', 'try', 'catch', 'finally', 'throw',
  'throws', 'static', 'public', 'private', 'protected', 'readonly', 'abstract', 'override',
  'def', 'lambda', 'self', 'pass', 'with', 'as', 'assert', 'global', 'nonlocal', 'and',
  'or', 'not', 'True', 'False', 'None', 'true', 'false', 'null', 'undefined', 'nil',
  'undefined', 'is', 'match', 'where', 'package', 'nt', 'struct', 'enum', 'fn', 'mod',
  'use', 'impl', 'pub', 'crate', 'let', 'mut', 'ref', 'dyn', 'trait', 'async', 'await',
])

// 从左向右一次扫描：先用 sticky 正则逐规则匹配，未命中则逐字符推进
const COMMENTS = /\/\/[^\n]*|\/\*[\s\S]*?\*\/|#[^\n]*/y
const STRINGS = /"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\\n])*`/y
const NUMBERS = /\b\d[\d_]*(?:\.\d+)?\b/y
const WORDS = /[A-Za-z_$][\w$]*/y

function escapeHtml(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export function highlightHtml(code: string): string {
  // 超长代码块降级：跳过逐字符分词，直接转义输出，避免超大文件（如整文件 dump）高亮耗时
  if (code.length > 200_000) return escapeHtml(code)
  // 用数组 push + 末尾 join，避免超大代码块逐字符 += 的 O(n²) 拼接开销
  const out: string[] = []
  let i = 0
  const n = code.length
  while (i < n) {
    COMMENTS.lastIndex = i
    const cm = COMMENTS.exec(code)
    if (cm && cm.index === i) {
      out.push(`<span class="tok-cmt">${escapeHtml(cm[0])}</span>`)
      i = COMMENTS.lastIndex
      continue
    }
    STRINGS.lastIndex = i
    const st = STRINGS.exec(code)
    if (st && st.index === i) {
      out.push(`<span class="tok-str">${escapeHtml(st[0])}</span>`)
      i = STRINGS.lastIndex
      continue
    }
    NUMBERS.lastIndex = i
    const nm = NUMBERS.exec(code)
    if (nm && nm.index === i) {
      out.push(`<span class="tok-num">${escapeHtml(nm[0])}</span>`)
      i = NUMBERS.lastIndex
      continue
    }
    WORDS.lastIndex = i
    const wm = WORDS.exec(code)
    if (wm && wm.index === i) {
      const w = wm[0]
      const esc = escapeHtml(w)
      if (KEYWORDS.has(w)) {
        out.push(`<span class="tok-kw">${esc}</span>`)
      } else {
        const isFn = /^\s*\(/.test(code.slice(i + w.length, i + w.length + 2))
        const isType = /^[A-Z]/.test(w)
        out.push(`<span class="${isFn ? 'tok-fn' : isType ? 'tok-type' : ''}">${esc}</span>`)
      }
      i = WORDS.lastIndex
      continue
    }
    // 普通字符逐字推进（含空白与符号）
    const ch = code[i]
    out.push(ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : ch === '&' ? '&amp;' : ch)
    i++
  }
  return out.join('')
}