// 与后端 REST 桥返回结构对齐的类型
export interface Project {
  id: string
  path: string
  name: string
  customName: string | null
  drive: string | null
  firstSeen: number | null
  lastSeen: number | null
  sessionCount: number
  turnCount: number
  agents: { agent: string; n: number }[]
  accounts: { agent: string; name: string; kind: string | null; n: number }[]
}

export interface Account {
  id: string
  agentId: string
  rawName: string
  displayName: string | null
  kind: string | null
  sessionCount: number
}

export interface AgentStat {
  agent_id: string
  session_count: number
}

export interface SessionSummary {
  id: string
  agentId: string
  agentSessionId: string
  title: string | null
  subject: string | null
  parentSubject: string | null
  model: string | null
  createdAt: number | null
  updatedAt: number | null
  turnCount: number
  cwd: string | null
  starred: number
  projectId: string | null
  project: string | null
  account: string | null
}

export interface Turn {
  seq: number
  userMessage: string | null
  assistantMessage: string | null
  thinking: string | null
  toolInput: string | null
  filesChanged: string[]
  timestamp: number | null
}

export interface Subject {
  layer: number
  subject: string
  parent_id: number | null
}

export interface SessionDetail {
  id: string
  agentId: string
  agentSessionId: string
  title: string | null
  subject: string | null
  parentSubject: string | null
  model: string | null
  createdAt: number | null
  updatedAt: number | null
  turnCount: number
  cwd: string | null
  starred: number
  rawFormat: string | null
  sourceNote: string | null
  project: string | null
  account: string | null
  accountKind: string | null
  turns: Turn[]
  subjects: Subject[]
}

export interface SearchHit {
  id: string
  agent_id: string
  title: string | null
  subject: string | null
  subj?: string | null
  created_at: number | null
  cwd: string | null
  project: string | null
  account_name?: string | null
  account_raw?: string | null
  layer?: number // 命中位置 1..4（1 标题/2 主题/3 正文/4 思考；3、4 为轮次级带 seq）
  seq?: number | null
  user_message?: string | null
  assistant_message?: string | null
  thinking?: string | null
  timestamp?: number | null
}

export interface ScanResult {
  ok: boolean
  stats: { agents: { id: string; label: string; status: string; sessions?: number }[]; sessions: number; turns: number }
}

export interface ExportResult {
  ok: boolean
  name: string
  content: string
  format: string
}

// M4 统计（/api/stats）
export interface Stats {
  totalSessions: number
  totalTurns: number
  totalProjects: number
  totalAccounts: number
  byAgent: { agent: string; sessions: number; turns: number }[]
  byAccount: { name: string; kind: string | null; sessions: number; turns: number }[]
  byDay: { day: string; n: number }[]
}

// 最近一次扫描探测到的 agent 明细（placeholder = 已安装但暂不支持内容索引）
export interface DetectedAgent {
  id: string
  label: string
  status: 'ok' | 'placeholder'
  sessions?: number
  turns?: number
}

// M4 配置（/api/config）
export interface AccountMapping {
  displayName?: string
  kind?: string
}
export interface AppConfig {
  accountMapping: Record<string, AccountMapping>
  excludes: string[]
  autoScanMinutes: number
  agentPaths: Record<string, string>
  maxFileSizeMB: number
  searchHotkey: string
}

// 会话定位（搜索命中跳转）：轮次 + 高亮词
export interface Locate {
  seq: number | null
  q: string
}