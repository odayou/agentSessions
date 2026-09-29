'use strict';
// GitHub Copilot Chat（VS Code 系列）适配器（agentList §2.9.1）
// 源：<editor>/User/workspaceStorage/<hash>/chatSessions/<uuid>.jsonl（delta journal），
//     另有 <editor>/User/globalStorage/emptyWindowChatSessions/*.jsonl（无工作区会话，cwd 回落文件所在目录）。
// delta journal 三操作重放重建会话文档（2026-09 经本机真实样本逆向验证）：
//   kind:0 根快照（v 整表替换）/ kind:1 按路径段数组 k 写值 v / kind:2 向 k 指向的数组追加（v 为批量数组或单对象）。
// 文档结构：{creationDate, sessionId, customTitle?, requests:[{timestamp, responseTimestamp, hiddenFromTranscript,
//   message:{text}, response:[parts], modelId}]}；response 的文本 part 无 kind 字段（value 即文本），
//   其余 kind：thinking（value 常为空/加密态）/ inlineReference（inlineReference.fsPath）/ toolCall（schema 未定，容错提取）。
// cwd 取 workspaceStorage/<hash>/workspace.json 的 folder URI（file:///d%3A/... → d:/...，非本地 URI 忽略）。
// OTel agent-traces.db（token 计数更全）本机无实例，待后续接入；无请求的空会话不索引。
const fs = require('node:fs');
const path = require('node:path');
const { buildSubjects, assembleTurns, finalizeTurns, mtimeMs } = require('./lib');

// —— delta journal 重放：按行应用三类操作，重建会话文档 ——
function replayJournal(text) {
  let doc = {};
  for (const line of text.split(/\r?\n/)) {
    const l = line.trim();
    if (!l) continue;
    let o;
    try { o = JSON.parse(l); } catch { continue; }
    if (!o || typeof o !== 'object') continue;
    if (o.kind === 0) { // 根快照
      if (o.v && typeof o.v === 'object') doc = o.v;
      continue;
    }
    const segs = o.k;
    if (!Array.isArray(segs) || !segs.length) continue;
    // 沿路径段走到父容器（缺失时创建：下一段为数字建数组，否则建对象）
    let cur = doc;
    for (let i = 0; i < segs.length - 1; i++) {
      const s = segs[i];
      if (cur[s] == null) cur[s] = (typeof segs[i + 1] === 'number') ? [] : {};
      cur = cur[s];
    }
    const last = segs[segs.length - 1];
    if (o.kind === 1) cur[last] = o.v; // 路径写
    else if (o.kind === 2) { // 数组追加
      if (!Array.isArray(cur[last])) cur[last] = [];
      if (Array.isArray(o.v)) cur[last].push(...o.v);
      else if (o.v != null) cur[last].push(o.v);
    }
  }
  return doc;
}

// response parts → 助手事件内容（文本 part 无 kind；未识别的 kind 跳过）
function extractResponseParts(parts) {
  let text = '';
  let thinking = '';
  const tools = [];
  for (const p of parts || []) {
    if (!p || typeof p !== 'object') continue;
    if (p.kind === 'thinking') {
      let t = '';
      if (typeof p.value === 'string') t = p.value;
      else if (Array.isArray(p.value)) {
        t = p.value.map((x) => (typeof x === 'string' ? x : (x && typeof x.text === 'string' ? x.text : ''))).filter(Boolean).join('\n');
      }
      if (t) thinking = thinking ? thinking + '\n' + t : t;
    } else if (p.kind === 'inlineReference') {
      const ref = p.inlineReference;
      const fp = ref && (typeof ref.fsPath === 'string' ? ref.fsPath : (typeof ref.path === 'string' ? ref.path : null));
      if (fp) text += fp; // 文件引用按出现位置内联为路径文本，保持语句连贯
    } else if (p.kind === 'toolCall' || p.kind === 'toolInvocation') {
      const name = (p.toolId && typeof p.toolId === 'object' && (p.toolId.name || p.toolId.value))
        || p.toolName || p.name || p.toolId || 'tool';
      let input = p.parameters != null ? p.parameters : (p.arguments != null ? p.arguments : p.input);
      if (input != null && typeof input !== 'string') { try { input = JSON.stringify(input); } catch { input = String(input); } }
      tools.push({ name: String(name), input: String(input || '').slice(0, 8000) });
    } else if (!p.kind && typeof p.value === 'string') text += p.value;
  }
  return { text, thinking, tools };
}

// workspace.json 的 folder URI → 本地路径（file:///d%3A/x → d:/x；非 file:// 的远端 URI 忽略）
function folderToPath(folder) {
  if (typeof folder !== 'string' || !folder) return null;
  let uri = folder;
  try { uri = decodeURIComponent(folder); } catch { /* 保原样 */ }
  if (!uri.startsWith('file://')) return null;
  return uri.slice('file://'.length).replace(/^\/(?=[A-Za-z]:[\\/])/, '') || null;
}

function workspaceCwd(wsDir) {
  try {
    const doc = JSON.parse(fs.readFileSync(path.join(wsDir, 'workspace.json'), 'utf8'));
    return folderToPath(doc.folder);
  } catch { return null; }
}

// 解析单个 delta journal 文件为一个 UnifiedSession（无请求/全空轮次的会话返回 null）
function parseFile(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
  const doc = replayJournal(text);
  const requests = Array.isArray(doc.requests) ? doc.requests : [];

  const events = [];
  let model = null;
  for (const r of requests) {
    if (!r || typeof r !== 'object' || r.hiddenFromTranscript) continue;
    if (!model && typeof r.modelId === 'string' && r.modelId) model = r.modelId;
    const ts = typeof r.timestamp === 'number' ? r.timestamp : null;
    const userText = r.message && typeof r.message.text === 'string' ? r.message.text : '';
    if (userText) events.push({ ts, kind: 'user', text: userText, thinking: '', tools: [] });
    const { text: asst, thinking, tools } = extractResponseParts(r.response);
    const respTs = typeof r.responseTimestamp === 'number' ? r.responseTimestamp : ts;
    if (asst || thinking || tools.length) events.push({ ts: respTs, kind: 'asst', text: asst, thinking, tools });
  }

  const nonEmpty = finalizeTurns(assembleTurns(events));
  if (!nonEmpty.length) return null;

  // cwd：chatSessions 文件位于 workspaceStorage/<hash>/chatSessions/ → 兄弟 workspace.json；
  // emptyWindowChatSessions（无工作区）回落文件所在目录
  const sessionDir = path.dirname(file);
  let cwd = null;
  if (path.basename(sessionDir) === 'chatSessions') cwd = workspaceCwd(path.dirname(sessionDir));
  if (!cwd) cwd = sessionDir;

  const mt = mtimeMs(file);
  const reqTs = requests
    .map((r) => (typeof r.responseTimestamp === 'number' ? r.responseTimestamp : (typeof r.timestamp === 'number' ? r.timestamp : null)))
    .filter((t) => t != null);
  const createdAt = typeof doc.creationDate === 'number' ? doc.creationDate : (reqTs.length ? Math.min(...reqTs) : mt);
  const updatedAt = reqTs.length ? Math.max(...reqTs) : (mt || createdAt);

  return {
    session: {
      agentSessionId: typeof doc.sessionId === 'string' && doc.sessionId ? doc.sessionId : path.basename(file, '.jsonl'),
      cwd,
      title: (typeof doc.customTitle === 'string' && doc.customTitle)
        || (nonEmpty[0].userMessage ? nonEmpty[0].userMessage.replace(/\s+/g, ' ').slice(0, 80) : null),
      model,
      createdAt,
      updatedAt,
      sourceFile: file,
    },
    project: { cwd, name: path.basename(cwd) || cwd },
    turns: nonEmpty,
    subjects: buildSubjects(nonEmpty),
  };
}

// 枚举源文件：workspaceStorage/<hash>/chatSessions/*.jsonl + globalStorage/emptyWindowChatSessions/*.jsonl
function sources(dir) {
  const out = [];
  const push = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) if (ent.isFile() && ent.name.endsWith('.jsonl')) out.push(path.join(d, ent.name));
  };
  const wsRoot = path.join(dir, 'workspaceStorage');
  let wsDirs;
  try { wsDirs = fs.readdirSync(wsRoot, { withFileTypes: true }); } catch { wsDirs = []; }
  for (const ws of wsDirs) {
    if (!ws.isDirectory()) continue;
    push(path.join(wsRoot, ws.name, 'chatSessions'));
  }
  push(path.join(dir, 'globalStorage', 'emptyWindowChatSessions'));
  return out;
}

module.exports = { sources, parseFile, id: 'copilot-vscode', label: 'Copilot (VS Code)', sourceFormat: 'jsonl/delta-journal' };
