// 热键归一化：录制（设置页）与匹配（App 快捷键）共用同一套转换，录到的键一定能匹配。
// 格式：小写，'+' 连接修饰键（ctrl/alt/shift/meta）与主键，如 '/'、'f3'、'ctrl+k'。

// 中文输入法下 e.key 为 'Process'，需按物理键位 e.code 还原主键
const CODE_MAP: Record<string, string> = {
  slash: '/', period: '.', comma: ',', semicolon: ';', quote: "'",
  bracketleft: '[', bracketright: ']', backslash: '\\', backquote: '`',
  minus: '-', equal: '=', space: ' ',
}
const MODIFIER_KEYS = ['control', 'shift', 'alt', 'meta']

// 键盘事件 → 热键字符串；纯修饰键返回 null（不构成热键）
export function eventToHotkey(e: KeyboardEvent): string | null {
  let key = e.key.toLowerCase()
  if (key === 'process' || key === 'dead' || key === '') {
    const code = e.code.toLowerCase()
    if (CODE_MAP[code]) key = CODE_MAP[code]
    else if (/^key[a-z]$/.test(code)) key = code.slice(3) // KeyK → k
    else if (/^digit\d$/.test(code)) key = code.slice(5) // Digit1 → 1
    else key = code // f1、arrowup 等命名键：e.key 与 e.code 小写后一致
  }
  if (MODIFIER_KEYS.includes(key)) return null
  const mods: string[] = []
  if (e.ctrlKey) mods.push('ctrl')
  if (e.altKey) mods.push('alt')
  if (e.shiftKey) mods.push('shift')
  if (e.metaKey) mods.push('meta')
  return [...mods, key].join('+')
}

// 展示格式：'ctrl+k' → 'Ctrl + K'，'f3' → 'F3'（单字母大写为惯例写法）
export function formatHotkey(hk: string): string {
  return hk.split('+').map((p) =>
    p === 'ctrl' ? 'Ctrl'
      : p === 'alt' ? 'Alt'
        : p === 'shift' ? 'Shift'
          : p === 'meta' ? 'Win'
            : /^f\d{1,2}$/.test(p) ? p.toUpperCase()
              : p.length === 1 ? p.toUpperCase()
                : p
  ).join(' + ')
}

// 是否含修饰键（决定能否在输入框内触发）
export function hasModifier(hk: string): boolean {
  return hk.includes('+')
}
