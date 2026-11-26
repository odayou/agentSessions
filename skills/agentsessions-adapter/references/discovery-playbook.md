# 发现方法论与豆包实战

## 目录

1. [四步发现法](#四步发现法)
2. [豆包案例：从快照到会话正文](#豆包案例从快照到会话正文)
3. [清单映射与验证结果](#清单映射与验证结果)
4. [搜索缺失的根因模式](#搜索缺失的根因模式)

## 四步发现法

1. **由点及面**：拿到任一会话相关文件先读顶层键，提取 `conversationId` / `sessionId` / `executionKey` / 时间戳与字段结构。
2. **关键字反查**：用用户原话（而不是工具名）全盘搜索数据目录，找到真正含对话正文的文件；同一关键字常同时命中日志/索引库，按目录名与文件大小筛出 transcript。
3. **看目录规律**：对命中文件向上逐级列目录，确认 `<root>/<会话ID>/.../<固定文件名>` 的稳定性；固定文件名才能用 `source.root` + `source.ext` 枚举。
4. **看消息形状**：抽 10~20 条记录打印 `role` / 键集合 / 文本片段 / 工具调用形状，再决定引擎与 rules 顺序。

启发式：快照/编辑审计文件（`fileContents`、`addedLines`）通常不是会话正文；聊天历史（`role=user/assistant/tool`）才是。优先索引正文通道，避免与工具自带镜像重复计数。

## 豆包案例：从快照到会话正文

- 用户给的快照：`AppData/Local/Doubao/User Data/coding/snapshot/<uid>/<conversationId>/<executionKey>/<agentId>.json`，字段为 `execution`（id/起止时间）、`files`（变更文件）、`fileContents`（原文/改后）。没有对话消息。
- 用 `execution.conversationId` 与用户原话（"2个函数中的魔术次数改为apollo可配置的数字"）反查，命中真正的会话文件：
  `AppData/Local/Doubao/User Data/Default/.doubao/agent_mode/workspace/.sessions/<conversationId>/agents/<agentId>/system/trajectory.jsonl`
- 同目录还有 `assignment.md`（需求追加日志）、`board.md`（任务公告板），可作补充但不含完整回复。
- `trajectory.jsonl` 每行形状：
  - `{"role":"user","content":"..."}`
  - `{"role":"assistant","content":"..."}`
  - `{"role":"assistant","tool_calls":[{"id":...,"type":"function","function":{"name":"Grep|Read|Edit","arguments":{...}}}]}`
  - `{"role":"tool","content":"工具回执","tool_call_id":"..."}`
- 没有逐行时间戳；会话级时间只能回落文件 mtime。
- **格式变体**：部分会话（如 `38456694777105154`）的 trajectory 里早期 turn **没有 `role=user` 记录**，用户原话只在同目录的 `assignment.md`（`## [时间戳] 需求` 下的正文，append-only 多段）。此时清单必须用 `session.userFile="assignment.md"` + `session.userPattern="^## \\[.*\\] 需求\\s*$"` 补齐缺失轮次，否则 `assembleTurns` 会丢掉这些 turn 的全部助手回复。引擎会把 assignment 里未出现在 transcript 的需求段按序插到事件流最前，已有 user 记录保持原位。

## 清单映射与验证结果

- 引擎 `jsonl`；`detect.dirs` 同时声明快照根与 `.sessions` 根；`source.root` 指向 `.sessions`，`ext=".jsonl"`。
- `session.id = tool_calls.0.id`（首个工具调用 UUID，稳定唯一）；`session.cwd = tool_calls.0.function.arguments.path`（首个 Grep 的 `path` 即项目根）。
- rules 顺序：`tool_calls.0..7.function`（按 index 逐条，因为一条记录只被一条规则消费）→ `role=user` → `role=assistant` → `role=tool` 回执。
- 标题自动取首条用户消息（快照里的 Java 方法名正好来自这条消息）。
- 端到端验证：`validate` 通过；检测命中；扫描 1 会话 1 轮；14 条工具事件；`filesChanged` 含真实改动文件；搜索 `apollo` 命中。

## 搜索缺失的根因模式

用户反馈"默认搜索不到，选 agent/项目才能搜到"，两次原因叠加：

1. **浅层提前收束**：`q=配置` 在标题层命中 12 条 ≥ `minResults=8`，auto 模式不再下沉正文；该词只出现在豆包会话的 AI 回复正文。加过滤后标题命中为 0，才会搜正文。
   - 修复：auto 模式只要 `depth>=3` 就默认搜正文层（L3）；L4 思考层仍按命中不足才展开。
2. **NULL 轮次时间排到末尾**：trajectory 无逐轮时间戳，`ORDER BY t.timestamp DESC LIMIT 50` 把新会话挤出结果。
   - 修复：L3/L4 排序改 `COALESCE(t.timestamp, s.updated_at) DESC`。

排查时先复现三条请求（默认 / agent 过滤 / 项目过滤），观察 `total`、`depth`、命中 `layer` 与 `seq`，再决定是否改清单或改搜索层。改完后端代码要重启 bridge/桌面应用（Node 模块缓存）。
