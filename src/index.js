'use strict'
const path = require('node:path')
const os = require('node:os')
const { runScan } = require('./scan')
const { search } = require('./search')
const { detectAll } = require('./detect')
const { openStore } = require('./model')

// 默认数据目录：~/.agentsessions/agentsessions.db
function defaultDbPath() {
  return path.join(os.homedir(), '.agentsessions', 'agentsessions.db')
}

module.exports = { runScan, search, detectAll, openStore, defaultDbPath }