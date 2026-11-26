---
name: agentsessions-adapter
description: 为 AgentSessions（本地 AI 编码会话统一索引工具）定位、发现并解析新工具的会话数据，产出可热更新的声明式适配器清单。当用户提供某个 AI 工具的会话/快照/索引文件并要求"接入适配器 / 新增 agent / 会话发现与解析 / 为什么某工具会话搜不到"，或要求通过远端清单（manifestRepo）扩展新 agent 时使用。包含按关键字或 ID 定位会话文件、判定 jsonl/json/sqlite/markdown 引擎、字段映射、清单校验以及 detect/scan/search 端到端验证流程。
---

# AgentSessions 新适配器发现与解析

## 概览

把"某个 AI 工具把会话存在哪、长什么样、怎么映射成统一会话模型"变成一份可验证的声明式清单。默认走远端清单（`manifestRepo`）或用户目录清单，**不改内置适配器/核心代码**；只有清单引擎确实表达不了时才讨论硬编码方案。

## 工作流

### 1. 收集线索

- 用户给的快照/索引文件先读顶层字段：找 `conversationId` / `sessionId` / `executionKey` / `userId`、时间戳、cwd、消息数组字段名。
- 快照/diff 类文件通常只是执行审计，没有对话正文；用其中的会话 ID 或用户原话继续找真正的 transcript。
- 关键字优先用用户真实请求里的话（如"2个函数中的魔术次数改为apollo可配置的数字"），比工具名更容易命中正文。

### 2. 定位会话文件

```bash
python scripts/find_session_files.py --keyword "用户原话片段" --keyword "会话ID"
```

默认扫 `~/AppData/Local`、`~/AppData/Roaming`、`~/Library/Application Support`、`~/.config`、`~/Doubao`，自动跳过 `node_modules`/`.git`/运行时大文件；`--roots` 可指定目录，`--max-mb` 调阈值。输出命中文件路径与上下文片段。定位后用目录树确认命名规律（如 `<root>/<convId>/agents/<agentId>/system/trajectory.jsonl`）。

### 3. 判定引擎

| 数据形态 | 引擎 | 判据 |
| --- | --- | --- |
| 逐行 JSON 事件流 | `jsonl` | 每行一条 `{role, content, ...}` |
| 单文件 JSON + 消息数组 | `json` | 有明确的 `messagesPath` |
| SQLite 库 | `sqlite` | 表里有会话与主消息表（OpenCode 兼容 schema） |
| 聊天历史 Markdown | `markdown` | 按标题分段为运行/会话 |
| 加密 / protobuf / Nitrite | 占位或 `external` | 远端清单**禁止** `external`；只能放用户目录 |

多通道工具选"含对话正文"的通道作会话源；快照/文件变更通道只作发现线索，避免重复索引。

### 4. 字段映射

先读 `references/manifest-schema.md`（引擎字段、rules 语义、常见坑），再写清单。要点：

- `session.id` 必须稳定且全局唯一（优先工具自己的 UUID）；缺省会回退为文件名，多会话必冲突。
- `session.cwd` 取真实项目路径（如工具调用参数里的 `path`），否则会话被归到"未分类"。
- `rules` 按文件里的消息顺序写，**第一条 `when` 命中的规则就消费该记录并 break**，所以 `tool_calls` 规则要放在普通 assistant 规则之前。
- 无逐轮时间戳时不必强造：搜索层已对轮次时间做 `COALESCE(t.timestamp, s.updated_at)` 回退。

### 5. 落地清单

优先追加到 AgentSessions 仓库的 `docs/manifest-repo/agent-manifests.json`（远端仓库种子，`{"manifests":[...]}`）；本地试验可放 `~/.agentsessions/adapters/<id>.json`（优先级最高）。不要改 `adapters/*.js` / `src/detect.js` 内置注册，除非用户明确要求内置。

### 6. 验证

```bash
node <AgentSessions仓库>/skills/agentsessions-adapter/scripts/verify_adapter.js \
  --repo <AgentSessions仓库> \
  --manifest <AgentSessions仓库>/docs/manifest-repo/agent-manifests.json \
  --id doubao --query "配置"
```

脚本自建临时清单目录与临时索引库，自动跑 `validate → detect → scan → search` 并清理；清单来自 `docs/manifest-repo/` 时按远端通道（用户目录缓存）模拟，否则按用户目录清单模拟。验证通过后让用户重启 bridge/桌面应用再跑真实 API（Node 会缓存旧模块）。

### 7. 搜不到的排查顺序

1. 是否只搜了浅层：L1/L2 命中数 ≥ `minResults` 时 auto 模式仍会搜正文层（L3），思考层（L4）才按需展开。
2. 轮次 `timestamp` 是否为 NULL：已按会话 `updated_at` 回退排序；临时库复现时优先看 `layer` 与 `seq`。
3. 标题是否截断到 80 字，关键词是否落在后半段；必要时在详情/正文里验证 FTS。
4. `cwd` / `project` / `agent` 过滤是否误伤；索引是否重建；清单 id 是否与内置 agent 冲突（内置优先）。

## 参考资料

- `references/manifest-schema.md`：引擎字段、rules 语义、校验规则与陷阱（按需读）。
- `references/discovery-playbook.md`：完整发现方法论 + 豆包实战案例（快照 → conversationId → trajectory.jsonl）。
