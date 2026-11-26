#!/usr/bin/env node
'use strict'
// 把仓库内的 skill 源码打成 .skill（zip）分发件，随 Release 上传供用户导入 Claude Code / CodeBuddy。
// 零依赖：手写 STORE 模式 zip（仅需 CRC32），避免 CI 平台差异与新增 npm 依赖。
// 用法：node scripts/pack-skill.js [--out dist-skill] [--skill agentsessions-adapter]
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const opt = {}
for (let i = 2; i < process.argv.length; i++) {
  if (!process.argv[i].startsWith('--')) continue
  const k = process.argv[i].slice(2)
  opt[k] = process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[++i] : true
}
const name = opt.skill && opt.skill !== true ? opt.skill : 'agentsessions-adapter'
const srcDir = path.join(ROOT, 'skills', name)
if (!fs.existsSync(srcDir)) { console.error(`[pack-skill] 找不到技能源码目录：${srcDir}`); process.exit(1) }
const outDir = path.resolve(ROOT, opt.out && opt.out !== true ? opt.out : 'dist-skill')
const outFile = path.join(outDir, name + '.skill')

let table = null
function crcTable() {
  if (table) return table
  table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1)
    table[n] = c >>> 0
  }
  return table
}
function crc32(buf) {
  const t = crcTable()
  let c = 0xffffffff
  for (const b of buf) c = t[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
const u16 = (v) => { const b = Buffer.alloc(2); b.writeUInt16LE(v & 0xffff); return b }
const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0); return b }

function collect(dir, zipRoot, out) {
  const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
  for (const e of entries) {
    if (e.name.startsWith('.')) continue
    const full = path.join(dir, e.name)
    const zipPath = zipRoot + '/' + e.name
    if (e.isDirectory()) collect(full, zipPath, out)
    else if (e.isFile()) out.push({ file: full, zipPath })
  }
}
const entries = []
collect(srcDir, name, entries)
if (!entries.length) { console.error('[pack-skill] 技能目录为空'); process.exit(1) }

const now = new Date()
const modTime = (now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2)
const modDate = ((Math.max(now.getFullYear(), 1980) - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()
const locals = []
const central = []
let offset = 0
for (const { file, zipPath } of entries) {
  const data = fs.readFileSync(file)
  const nameBuf = Buffer.from(zipPath, 'utf8')
  const crc = crc32(data)
  const local = Buffer.concat([
    u32(0x04034b50), u16(20), u16(0), u16(0), u16(modTime), u16(modDate),
    u32(crc), u32(data.length), u32(data.length), u16(nameBuf.length), u16(0), nameBuf, data,
  ])
  const cd = Buffer.concat([
    u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(modTime), u16(modDate),
    u32(crc), u32(data.length), u32(data.length),
    u16(nameBuf.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), nameBuf,
  ])
  locals.push(local)
  central.push(cd)
  offset += local.length
}
const cdBuf = Buffer.concat(central)
const eocd = Buffer.concat([
  u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length),
  u32(cdBuf.length), u32(offset), u16(0),
])
fs.mkdirSync(outDir, { recursive: true })
fs.writeFileSync(outFile, Buffer.concat([...locals, cdBuf, eocd]))
console.log(`[pack-skill] 已生成 ${outFile}（${entries.length} 个文件，${(fs.statSync(outFile).size / 1024).toFixed(1)}KB）`)
