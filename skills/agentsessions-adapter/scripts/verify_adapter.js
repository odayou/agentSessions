#!/usr/bin/env node
'use strict'
// 声明式清单端到端验证：临时清单目录 + 临时索引库，跑 validate → detect → scan → search，结束清理。
// 用法：node verify_adapter.js --repo <AgentSessions根目录> --manifest <清单文件> --id <agentId> [--query 关键词] [--mode user|remote]
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue
    const k = argv[i].slice(2)
    const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true
    out[k] = v
  }
  return out
}

function fail(msg) { console.error('验证失败：' + msg); process.exit(1) }

const opt = parseArgs(process.argv.slice(2))
const repo = opt.repo || process.cwd()
const manifestFile = opt.manifest
if (!manifestFile || !fs.existsSync(manifestFile)) fail('需要 --manifest <存在的清单文件>')

let doc
try { doc = JSON.parse(fs.readFileSync(manifestFile, 'utf8')) } catch (e) { fail('清单 JSON 解析失败：' + e.message) }
const all = Array.isArray(doc) ? doc : (Array.isArray(doc.manifests) ? doc.manifests : [doc])
const id = opt.id && opt.id !== true ? opt.id : (all.length === 1 ? all[0].id : null)
if (!id) fail('多个清单时需要 --id <agentId>')
const m = all.find((x) => x && x.id === id)
if (!m) fail(`清单文件中找不到 id=${id}`)

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'as-verify-'))
process.env.AGENTSESSIONS_MANIFEST_DIR = tmp // 必须在 require config/manifest 之前设置
const isRemote = (opt.mode && opt.mode === 'remote')
  || (!opt.mode && String(manifestFile).replace(/\\/g, '/').includes('/manifest-repo/'))
const cfg = { ...require(path.join(repo, 'src/config')).loadConfig() }
if (isRemote) {
  cfg.manifestRepo = 'https://example.invalid/manifests.json'
  cfg.manifestRefreshMinutes = 600 // 配合 fetchedAt=now，避免验证时发起真实网络请求
  fs.writeFileSync(path.join(tmp, '.remote-manifests.json'), JSON.stringify({ fetchedAt: Date.now(), manifests: all }))
} else {
  fs.writeFileSync(path.join(tmp, id + '.json'), JSON.stringify(m))
}

let result
try {
  const manifest = require(path.join(repo, 'src/manifest'))
  const err = manifest.validate(m)
  if (err) fail(`清单校验失败：${err}`)
  if (isRemote && m.engine === 'external') fail('远端清单禁止 external 引擎')

  const detected = require(path.join(repo, 'src/detect')).detectAll(cfg).some((a) => a.id === id)
  const dbFile = path.join(tmp, 'verify.db')
  return require(path.join(repo, 'src/scan')).runScan(dbFile, { only: id, cfg }).then((r) => {
    const stat = r.stats.agents.find((a) => a.id === id) || { status: 'missing' }
    const out = { id, mode: isRemote ? 'remote' : 'user', valid: true, detected, status: stat.status, sessions: stat.sessions || 0, turns: stat.turns || 0, error: stat.error || null }
    if (opt.query && opt.query !== true) {
      const s = require(path.join(repo, 'src/search')).search(dbFile, {
        q: String(opt.query), depth: 4, auto: true, minResults: 8, limit: 50,
      })
      const hit = s.hits.find((h) => h.agent_id === id)
      out.search = { total: s.total, depth: s.depth, found: !!hit, layer: hit && hit.layer, seq: hit && hit.seq, title: hit && hit.title }
    }
    console.log(JSON.stringify(out, null, 2))
    if (!detected || stat.status !== 'ok') process.exitCode = 1
  }).catch((e) => fail(e.stack || e.message)).finally(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })
} catch (e) {
  fs.rmSync(tmp, { recursive: true, force: true })
  fail(e.stack || e.message)
}
