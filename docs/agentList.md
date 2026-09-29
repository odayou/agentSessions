# AI 编码 Agent 会话存储位置与解析方式——适配器开发参考

本文档排列组合市面上的 AI 编码工具（CLI / Agent / IDE 插件等形态，IDE 又分 VS Code 系列与 JetBrains 系列），逐一分析其会话存储位置及解析方式，作为本软件已实现解析器的补充。核心问题：架构上是否要支持动态新增解析器、避免每次重新发客户端？——结论见 §六。

## 一、工具 × 宿主 排列组合矩阵

| 工具 | CLI | VS Code 系列 | JetBrains 系列 | 独立 IDE / 桌面端 | 其他宿主 |
|---|---|---|---|---|---|
| Claude Code | ✅ | ✅ 插件桥接 | ✅ 插件桥接 | — | — |
| Codex CLI | ✅ | ✅ 插件（实验） | — | — | — |
| Gemini CLI | ✅ | — | — | — | Antigravity |
| Qwen Code | ✅ | — | — | — | — |
| OpenCode | ✅ | — | — | — | 插件生态 |
| Aider | ✅ | — | — | — | — |
| Copilot CLI | ✅ | — | — | — | — |
| GitHub Copilot Chat | — | ✅ | ✅ | Visual Studio | — |
| Cline | ✅ | ✅ | ✅ | — | SDK |
| Roo Code | — | ✅ | — | — | — |
| Continue.dev | — | ✅ | ✅ | — | — |
| CodeBuddy | ✅ | ✅ | ✅ | — | Zed (ACP) |
| WorkBuddy | ✅ | ✅ | — | ✅ 桌面端 | 插件市场通道 |
| 通义灵码 | — | ✅ | ✅ | — | — |
| Trae | ✅ | — | ✅ IDEA 插件 | ✅ Trae IDE | — |
| Cursor | ✅ CLI / ACP | ✅ 核心形态 | ✅ ACP 接入 | ✅ Cursor IDE | — |
| Windsurf | — | ✅ | — | ✅ Windsurf IDE | — |
| Kiro | ✅ | — | — | ✅ Kiro IDE | — |
| MiMo Code | ✅ | ⏳ 第三方扩展，官方未发 | ⏳ 未发布 | ⏳ 已宣布 | — |
| Antigravity | — | — | — | ✅ IDE | 复用 Gemini 演进格式（SQLite + protobuf，加密） |


## 二、各适配器详细规格

### 2.1 Claude Code

**适配器 ID**：`claude-code`

**存储路径**：
`~/.claude/projects/<hash>/sessions/<session-id>.jsonl`

`<hash>` 由工作目录路径派生，每个项目目录拥有独立的会话命名空间。

**格式**：Append-only JSONL，每行一个自包含的 JSON 对象，包含四种条目类型：`user`（用户消息，阻塞写入）、`assistant`（AI 回复，非阻塞队列写入）、`progress`（工具执行期间，内联写入）、`system/compact_boundary`（自动压缩后，标记摘要边界）。

**项目识别**：`cwd` 字段 + 目录 hash。

**解析要点**：解析 JSONL 每行，按 `type` 字段分类。`progress` 条目关联工具调用，`compact_boundary` 标记上下文压缩边界。无效或截断的行需跳过以兼容崩溃场景。

**解析难度**：低。

**异常说明**：超大会话文件（>50MB）需跳过解析，避免拖垮宿主 Agent。


### 2.2 Codex CLI

**适配器 ID**：`codex`

**存储路径**：
`$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<timestamp>-<uuid>.jsonl[.zst]`（默认 `~/.codex/`）

会话按日期分桶而非按项目。

**格式**：JSONL rollout 文件，同一对话被记录两次：`response_item` 行是面向模型的历史，`event_msg` 行是并行的 UI 流。Codex 还会在 SQLite 数据库（`~/.codex/state_N.sqlite`，threads 表）中持久化会话元数据，包含 id、title、first_user_message、model、cwd、created_at、updated_at 等字段。

**项目识别**：需从文件内容提取 `cwd`（按日期分桶意味着项目归属只能通过读取文件内容确定）。

**解析要点**：需要处理两种行类型。上游未文档化，字段在版本间可能增删，解析器需容忍缺失和未知字段。Codex 0.32.0 引入了 rollout JSONL 格式的 breaking change。

**解析难度**：中。

**异常说明**：格式在版本间可能变化，需版本检测机制。


### 2.3 Gemini CLI

**适配器 ID**：`gemini`

**存储路径**：
`~/.gemini/tmp/<project_hash>/chats/`

`<project_hash>` 基于项目根目录生成，会话按项目隔离。

**格式**：存在新旧两种格式：旧版为 `chats/session-*.json`（信封对象），新版为 JSONL。Gemini CLI 已从重写整个大 JSON 文件迁移到 append-only JSONL 流式日志，初始会话元数据写为第一行，后续消息对象逐条追加。后续版本（Antigravity）改为 SQLite + protobuf 格式，旧版使用 AES-GCM 加密的 `.pb` 文件。

**项目识别**：`project_hash` 目录。

**解析要点**：需兼容新旧两种格式。旧版 JSON 信封结构为 `{sessionId, projectHash, startTime, messages: [...]}`。新版 JSONL 每行包含 `type` 字段区分条目类型。Antigravity 格式需要 `agy-reader` 解密后读取 trajectory.json sidecar。

**解析难度**：中。

**异常说明**：格式演进路径表明存储格式可能发生根本性变化，适配器需要版本检测机制。


### 2.4 Qwen Code

**适配器 ID**：`qwen-code`

**存储路径**：
`~/.qwen/projects/<sanitized-cwd>/chats/<session-id>.jsonl`

会话数据按项目范围的 JSONL 存储。另有 `~/.qwen/sessions/<pid>.json` 存储跨会话协议注册信息。

**格式**：JSONL 会话记录，工具名使用 Gemini 血统的命名（如 `run_shell_command`），需要归一化为 Claude 风格后上报。

**项目识别**：`<sanitized-cwd>` 目录名（完整 cwd 路径，非字母数字字符替换为 `-`）。

**解析要点**：Qwen Code 是 Gemini 格式的 fork，解析器可复用 Gemini 逻辑，但需注意工具名映射和路径差异。

**解析难度**：低到中。


### 2.5 OpenCode

**适配器 ID**：`opencode`

**存储路径**：
`~/.local/share/opencode/opencode.db`（SQLite）

旧版本（pre-1.2）使用 JSON 树结构存储在 `~/.local/share/opencode/storage/` 下。

**格式**：SQLite 数据库包含 `session`、`message`、`part` 表。`session` 表字段：`id, title, directory, parent_id, agent, model, time_created, time_updated`；`message` 表字段：`id, session_id, time_created, data`；`part` 表的 `data.type=text` 为时间线文本，`data.type=compaction` 为压缩标记。

**项目识别**：数据库列（`session.directory`），无需从文件路径推断。

**解析要点**：需要 SQLite 读取能力。OpenCode 还提供插件 API（`session.status`、生命周期 hook），可作为实时通道补充。

**解析难度**：中。

**异常说明**：需要处理版本迁移（JSON 树 → SQLite）。


### 2.6 Aider

**适配器 ID**：`aider`

**存储路径**：
`<repo>/.aider.chat.history.md`

Aider 没有中心化会话存储，每个仓库写入一个 Markdown 日志文件，多次运行累积在同一个文件中。

**格式**：Markdown，使用 `####` 标题标记用户消息，助手回复为标题间的纯文本段落。顶层标题为 `# aider chat started at <ts>`。每个 `# aider chat started at ...` 头部对应一次运行，agentsview 将每次运行索引为独立会话。

**项目识别**：文件所在仓库路径。

**解析要点**：解析器需要识别 `####` 标题作为用户消息边界，提取其间的助手回复。Markdown 中可能包含代码块和 diff。没有逐消息时间戳，运行开始时间来自 `# aider chat started at ...` 头部。任何包含 2 个以上 `####` 标题的 `.md` 文件都可能被误触发，需要严格校验文件名。

**解析难度**：中。

**异常说明**：默认不扫描，需用户显式指定 `AIDER_DIR`，避免 macOS 隐私提示和性能问题。


### 2.7 Copilot CLI

**适配器 ID**：`copilot-cli`

**存储路径**：
`~/.copilot/session-state/<uuid>/events.jsonl`

同时维护 `~/.copilot/session-store.db`（SQLite）作为派生索引。

**格式**：JSONL 事件日志 + `workspace.yaml` 存储会话元数据（名称、cwd）。SQLite 索引将多步助手轮次折叠为单条 `assistant_response` 行，会丢失部分助手文本。

**项目识别**：`workspace.yaml` 中的 `cwd`。

**解析要点**：优先读 `events.jsonl` 获取完整事件流，`session-store.db` 仅作索引参考。`workspace.yaml` 提供项目关联信息。旧版会话存储在 `~/.copilot/history-session-state/`，在 `--resume` 时迁移到新格式。

**解析难度**：低。


### 2.8 Kiro CLI / Kiro IDE

**适配器 ID**：`kiro`

**存储路径**：
- CLI：`~/.local/share/kiro-cli/data.sqlite3`（SQLite），会话存储在 `conversations_v2` 表中，按用户主目录键控
- CLI（另有 JSONL）：`~/.kiro/sessions/cli/<id>.jsonl`（+ companion `<id>.json`）
- IDE v2：`~/.kiro/sessions/<workspace-hash>/sess_<id>/`（目录格式）
- IDE（另有）：`%APPDATA%\Kiro\User\globalStorage\kiro.kiroagent\workspace-sessions<base64-encoded-workspace-path>\`

**格式**：SQLite（`conversations_v2` 表，`key` 为工作目录路径，`value` 为 JSON 包含 `history` 数组）+ JSONL + 目录格式。

**项目识别**：`conversations_v2.key` 字段（工作目录路径）。

**解析要点**：直接查询 `conversations_v2` 表。IDE 格式为目录格式，需要文件系统遍历。`~/.kiro/sessions` 受 `KIRO_HOME` 环境变量影响。

**解析难度**：低。

**异常说明**：`kiro-cli chat --list-sessions` 从主目录运行时不显示结果（bug），但 `--resume` 正常工作。会话数据本身是正确保存的。


### 2.9 GitHub Copilot Chat

#### 2.9.1 VS Code 系列

**适配器 ID**：`copilot-vscode`

**存储路径**：
- 核心聊天会话：`~/Library/Application Support/Code/User/workspaceStorage/<hash>/chatSessions/*.jsonl` + `~/Library/Application Support/Code/User/globalStorage/emptyWindowChatSessions/*.jsonl`
- 扩展转录：`~/Library/Application Support/Code/User/workspaceStorage/<hash>/GitHub.copilot-chat/transcripts/`
- OTel SQLite：VS Code Copilot Chat 的 `agent-traces.db`

**格式**：前三个位置为 JSONL（schema 不同，解析器按源类型/事件形状切换），OTel 源为 SQLite。VS Code 核心聊天会话使用 delta journal：`kind:0` 设置根对象，`kind:1` 在路径 `k` 写入值，`kind:2` 向数组路径追加项。

**项目识别**：`workspaceStorage/<hash>` 目录。

**解析要点**：OTel 源优先（当存在时），因为携带完整的输入/输出/缓存 token 计数；旧版 JSONL 源只记录输出 token。如果 OTel 发现至少一个源，workspace `chatSessions/*.jsonl` 和 `emptyWindowChatSessions/*.jsonl` 将被跳过。

**解析难度**：中。

**异常说明**：OTel 源需要 Node 22+，使用内置 `node:sqlite` 模块。DB 缺失/锁定/损坏时回退到 JSONL 源。

#### 2.9.2 JetBrains 系列

**适配器 ID**：`copilot-jetbrains`

**存储路径**：
`~/.config/github-copilot/<ide>/<kind>/<storeId>/copilot-*-nitrite.db`

覆盖 IntelliJ IDEA、PyCharm、RubyMine 等。

**格式**：Nitrite（H2 MVStore）`.db` 文件，与 VS Code 的 JSONL/SQLite 格式完全不同。

**项目识别**：`<ide>/<kind>/<storeId>` 路径层级。

**解析要点**：agentsview 不直接读取 Nitrite 数据库，支持的路径是通过 `copilot-jetbrains-exporter` 导出为 JSONL，然后指向输出目录。

**解析难度**：高（Nitrite 格式，需要导出工具）。


### 2.10 Cline

**适配器 ID**：`cline`

**存储路径**：
`~/.cline/data/tasks/<taskId>/api_conversation_history.json`

VSCode、CLI、JetBrains 三类客户端共用 `~/.cline/data/` 下的文件级 JSON 存储。每个任务独立目录，包含 `api_conversation_history.json`（原始 Anthropic 格式消息数组）、`ui_messages.json`（UI 展示消息）和 `task_metadata.json`（任务元数据）。

**项目识别**：`task_metadata.json` 中的工作区信息。

**解析要点**：优先解析 `api_conversation_history.json` 获取完整对话，`ui_messages.json` 作为补充。工作区 hash 由工作区路径计算得出，JetBrains 客户端通过 `WORKSPACE_STORAGE_DIR` 环境变量适配。

**解析难度**：低。

**异常说明**：旧版存储在 VS Code globalStorage 下（`saoudrizwan.claude-dev/tasks/`），新版迁移到 `~/.cline/data/`。


### 2.11 Roo Code

**适配器 ID**：`roo-code`

**存储路径**：
- macOS：`~/Library/Application Support/Code/User/globalStorage/rooveterinaryinc.roo-cline/tasks/`
- Linux：`~/.config/Code/User/globalStorage/rooveterinaryinc.roo-cline/tasks/`
- Windows：`%APPDATA%/Code/User/globalStorage/rooveterinaryinc.roo-cline/tasks/`

**格式**：每个任务独立目录，包含 `api_conversation_history.json`（原始 API 消息交换）、`ui_messages.json`（用户面向的消息格式）、`task_metadata.json`（可选）、`history_item.json`（Roo Code 特有的任务历史项）。

**项目识别**：`task_metadata.json` 中的工作区信息。

**解析要点**：与 Cline 解析器可高度复用。注意扩展 ID 不同（`rooveterinaryinc.roo-cline` vs `saoudrizwan.claude-dev`）。Roo Code 新增了 `TaskHistoryStore` 服务，每个任务的 `HistoryItem` 存储为独立的 `history_item.json` 文件。

**解析难度**：低。

**异常说明**：Checkpoints 会在任务目录中创建完整的 git 仓库，导致磁盘占用快速增长（可达 40GB+），解析时需跳过 checkpoint 相关文件。


### 2.12 Continue.dev

**适配器 ID**：`continue-dev`

**存储路径**：
`~/.continue/sessions/<sessionId>.json`

另有一个 `sessions.json` 作为元数据索引。

**格式**：JSON。每个会话文件包含 `history` 数组（`{role, content}` 消息对象）、`title`、`workspaceDirectory`、`mode`、`chatModelTitle`。

**项目识别**：`workspaceDirectory` 字段。

**解析要点**：直接解析 JSON，遍历 `history` 数组。`sessions.json` 可用于快速列表。

**解析难度**：低。


### 2.13 通义灵码

**适配器 ID**：`lingma`

**存储路径**：
- 会话数据：`~/.lingma/cache/projects/{project-id}/conversation-history/{session-id}/{session-id}.jsonl`
- 会话索引：`~/.lingma/cache/db/local.db`（SQLite）

**格式**：JSONL 会话数据 + SQLite 索引。

**项目识别**：`project-id` 关联工作目录。

**解析要点**：JSONL 解析 + SQLite 索引查询。

**解析难度**：低。

**异常说明**：通义灵码当前不提供跨会话、持久化存储的历史记录功能。关闭对话面板后记录即清空，重启 IDE 或切换项目也会清空。唯一痕迹是 IDE 的 Local History（24小时内）和 Git 提交记录。**建议标注为“无持久化会话存储”，降级或移除适配器开发优先级。**


### 2.14 Trae

**适配器 ID**：`trae`

**存储路径**：
- 主存储：`%APPDATA%\Trae CN\ModularData\ai-agent`（Windows）或 `~/Library/Application Support/Trae CN/ModularData/ai-agent`（macOS），内含 `database.*` SQLite 文件
- 工作区存储：`%APPDATA%\Trae\User\workspaceStorage\<workspace-id>\state.vscdb`
- CLI：`~/.trae/sessions/`（可通过 `TRAE_SESSIONS_DIR` 覆盖）

**格式**：SQLite + JSONL。对话记录与工作区目录绑定存储。**SQLite DB 可能是加密的**。

**项目识别**：工作区 ID（`workspaceStorage` 目录名）。

**解析要点**：加密 DB 是主要障碍。`state.vscdb` 中只存储输入框的 UI 状态，Agent 返回的完整消息在 `ModularData/ai-agent` 下的 `database.*` 文件中。

**解析难度**：高（加密）。

**异常说明**：Trae 对话记录全局集中存储在 `database.db` 中，没有按项目分开。官方暂不支持查找到对话记录的源文件导出。


### 2.15 Cursor

**适配器 ID**：`cursor`

**存储路径**：
- 主路径：`~/.cursor/chats/<workspace>/<agent>/store.db`（SQLite）
- 工作区存储（macOS）：`~/Library/Application Support/Cursor/User/workspaceStorage/<hash>/state.vscdb`
- 全局存储：`~/Library/Application Support/Cursor/User/globalStorage/state.vscdb`

**格式**：SQLite。`cursorDiskKV` 表中，关键 key 模式为 `composerData:<uuid>`（每个对话一行）和 `bubbleId:<composerId>:<messageId>`（每条消息）。Value 为 JSON blob，包含 `richText`（格式化对话内容）、`text`（纯文本版本）、`conversationMap`（完整消息历史）、`createdAt`、`composerId` 等字段。

**项目识别**：workspace hash 目录。

**解析要点**：打开 SQLite 只读连接，遍历 `cursorDiskKV` 表，按 key 模式分类提取。`ItemTable` 中的 `composer.composerHeaders` 是 composer 会话索引。Composer 会话（Ctrl+I）和聊天面板会话可能分开存储，需要进一步调查。

**解析难度**：高。

**异常说明**：Schema 未官方文档化，版本间变化风险大。需要枚举所有 workspace hash 子目录。


### 2.16 Windsurf

**适配器 ID**：`windsurf`

**存储路径**：
- 主路径：`~/Library/Application Support/Windsurf/User/globalStorage/state.vscdb`（macOS）或 `%APPDATA%\Windsurf\User\globalStorage\state.vscdb`（Windows）
- 旧版/补充：`~/.codeium/chat_state/*.pbtxt`（text-format protobuf）
- 另有：`~/.codeium/windsurf/session.db`（SQLite）

**格式**：SQLite（`state.vscdb`，与 Cursor 类似的 VS Code 派生结构，schema 未文档化）+ protobuf（旧版）+ SQLite（`session.db`）。

**项目识别**：workspaceStorage 目录 hash。

**解析要点**：与 Cursor 同源，可复用部分解析逻辑。Cascade 会话内容在磁盘上加密，只能回退到标题级别。

**解析难度**：高。

**异常说明**：Schema 未文档化。Cascade 加密是主要障碍。


### 2.17 WorkBuddy

**适配器 ID**：`workbuddy`

**存储路径**：
- CLI/桌面端：`~/.workbuddy/projects/<cwd-slug>/<session-uuid>.jsonl`
- 聚合数据库：`~/.workbuddy/workbuddy.db`（SQLite，含 `workspaces.path`、`sessions.cwd`）
- 另有：`~/.workbuddy/app/sessions.json`（含 `.sessions[i].workDir`）和 `~/.workbuddy/sessions/<id>.json`（含 `.cwd`）

**格式**：JSONL（会话转录）+ SQLite（聚合数据库）。

**项目识别**：`cwd-slug` 由绝对路径的路径分隔符替换为 `-` 生成，项目关联可直接从目录名还原。

**解析要点**：优先读 `~/.workbuddy/projects/` 下的 JSONL 文件。`workbuddy.db` 可作为索引和兜底通道。IDE 插件形态依赖插件市场通道和 `settings.json` 中的 hook 配置，桌面端配置在启动时缓存，装后须完全重启才能生效。

**解析难度**：中。

**异常说明**：WorkBuddy 有国内版（`~/.workbuddy/`）和海外版（`~/.workbuddy-ai/`）两个数据目录。


### 2.18 CodeBuddy

**适配器 ID**：`codebuddy`

**存储路径**：
- CLI：`~/.codebuddy/projects/<project-key>/*.jsonl`
- 另存：`~/.codebuddy/history.jsonl`
- 全局目录：`~/.codebuddy/`（含 `sessions/`、`projects/`、`settings.json`）

**格式**：JSONL。CodeBuddy CLI/WebUI 会话以 JSONL 转录存储在 `~/.codebuddy/projects/<project-key>/*.jsonl`。IDE / VS Code 扩展将最终 Agent 使用写入扩展日志。

**项目识别**：`<project-key>` 目录名。

**解析要点**：CodeBuddy 写入 `~/.codebuddy/settings.json` 的 `SessionEnd` hook（Claude Code 的 fork），解析逻辑可复用 Claude Code 的 hook 机制。ACP 模式下，会话状态由编辑器侧管理，CodeBuddy 只作为无状态后端。

**解析难度**：低。

**异常说明**：企业硬锁情况下（admin-trusted），官方仅支持腾讯 Distributed policy bundle 分发，安装器无法写入。


### 2.19 MiMo Code

**适配器 ID**：`mimo-code`

**核心定位**：小米 MiMo 团队开源的终端原生 Coding Agent，基于 OpenCode 深度二次开发（MIT 协议）。与 OpenCode 有直接血缘，但会话存储是多层的，不能简单当成 OpenCode 的变体处理。

**存储路径（多层级，需同时覆盖）**：
- 第一层（主通道）会话数据库：`~/.local/share/mimocode/mimocode.db`（SQLite，OpenCode-fork schema，`session`/`message`/`part` 表与 `opencode.db` 同源）
- 第二层 项目级持久记忆：`<项目根目录>/.mimo/memories/`（`project.db`、`session_checkpoints/`、`task_snapshots/`）
- 第三层 会话检查点：`<项目根目录>/.mimo/checkpoints/`（token 占用达 20%/45%/70% 时由 Writer 子 Agent 写入带时间戳的 JSON，含 `intent`/`task_tree`/`error_summary` 三字段，不存原始对话流）
- 第四层 会话级便签：`<项目根目录>/.mimo/notes.md`（Markdown，唯一允许主 Agent 直接编辑的文件）

**格式**：SQLite（主通道）+ SQLite/JSON（项目记忆与检查点）+ Markdown（便签）。

**项目识别**：主通道 `session` 表的 `directory`/`cwd` 字段（继承 OpenCode schema）；`.mimo/` 目录本身位于项目根目录，天然标识项目。

**解析要点**：
1. 主通道优先：直接读取 `mimocode.db`，复用 OpenCode 的 SQLite 解析逻辑。
2. 排除镜像记录：被动读取器只聚合 mimo 原生轮次，避免把经由 MiMo Code 调用的 Claude/claude-mem 镜像会话重复计入。已实现（2026-09-28）：镜像会话登记于库内 `claude_import`/`external_import` 表（`session_id` 列引用主通道会话 id），sqlite 引擎按清单 `mirrorTables` 声明收集登记集合并整体跳过；登记表缺失（版本差异）静默跳过，不做任何排除。
3. `.mimo/` 目录作为补充：项目记忆与检查点不含原始对话流，可提供项目上下文、任务树与设计决策，用于丰富会话详情的“项目背景”。
4. 检查点不是会话记录：`.mimo/checkpoints/` 的 JSON 是压缩后的任务状态，不要当会话转录解析。

**解析难度**：中。schema 与 OpenCode 同源可复用；难点在区分原生 mimo 轮次与镜像的 Claude 记录。

**异常说明**：官方定位终端原生工具，原生 IDE 插件尚未作为核心形态提供（社区第三方扩展非官方）；官方曾宣布 desktop app 与 IDE extensions，但截至调研时点 IDE 端存储路径未明确。适配器先只覆盖 CLI 形态，IDE 端待官方发布后另行调研。


## 三、按格式分类的解析器复用策略

| 格式类型 | 涉及工具 | 解析策略 |
|---|---|---|
| JSONL（Claude 式） | Claude Code、CodeBuddy、Qwen Code、Gemini CLI、Lingma、Copilot CLI、WorkBuddy | 共享 JSONL 行解析器 + 工具名归一化 |
| JSONL（rollout） | Codex CLI | 专用 rollout 解析器（`parse-rollout.js`） |
| SQLite | OpenCode、Cursor、Windsurf、Kiro、Trae、MiMo Code（OpenCode-fork schema） | 共享 SQLite 读取器 + 各工具 schema 适配；MiMo Code 需增加消息来源过滤（排除镜像的 Claude 记录） |
| JSON 文件 | Cline、Roo Code、Continue.dev、Gemini（旧版） | 共享 JSON 解析器 + 各工具字段映射 |
| Markdown | Aider | 专用 Markdown 解析器 |
| Nitrite (H2) | Copilot JetBrains | 需要导出工具转换为 JSONL |
| protobuf | Windsurf（旧版）、Antigravity | 需要专用解密/解析工具 |


## 四、解析难度总览

| 难度 | 工具 | 原因 |
|---|---|---|
| **低** | Claude Code、Cline、Roo Code、Continue.dev、Kiro、Copilot CLI、Lingma、CodeBuddy | 格式清晰、文档完善或有成熟实现 |
| **中** | Codex CLI、Gemini CLI、Qwen Code、OpenCode、Aider、WorkBuddy、Copilot VS Code、MiMo Code | 需要处理格式演进或未文档化字段 |
| **高** | Cursor、Windsurf、Trae、Copilot JetBrains | Schema 未文档化、加密或需要专用导出工具 |


## 五、风险与注意事项

**Schema 漂移**：Cursor、Windsurf 的 schema 未文档化，版本更新可能导致解析失败。建议解析器设计为容错模式，解析失败时降级为原始文本索引。

**格式演进**：Gemini CLI 从 JSON → JSONL → SQLite + protobuf 的演进路径表明，CLI 工具的存储格式可能发生根本性变化，适配器需要版本检测机制。Codex 0.32.0 引入了 rollout JSONL 格式的 breaking change。

**加密存储**：Trae 的会话 DB 可能加密，Windsurf 的 Cascade 会话内容加密，Antigravity 的旧版使用 AES-GCM 加密的 `.pb` 文件。这些需要确认是否有官方导出通道或社区解密工具。

**非文档化格式**：Codex 的 rollout 格式、Cursor 的 `cursorDiskKV` schema 均未官方文档化，依赖社区逆向工程，稳定性无法保证。

**Hook vs 文件解析**：对于支持 hook 的工具（Claude Code、CodeBuddy、WorkBuddy 等），hook 事件比文件解析更实时、更可靠。对于不支持 hook 的工具，文件解析是唯一通道。WorkBuddy 明确设计为“hook + 被动扫描”双通道。

**大文件保护**：Claude Code 的 JSONL 会话文件可能超过 50MB，Cline 的 `api_conversation_history.json` 可达 20MB+，解析时需设置阈值跳过或流式处理。

**跨客户端共享存储是少数**：Cline 是正面案例（`~/.cline/data/` 覆盖所有形态），但大多数工具（Copilot、Trae、Cursor）的 IDE 端和 CLI 端是割裂的。项目聚合视图需要接受一个现实：同一个项目在不同宿主中的会话可能无法自动合并，除非用户手动关联。

**适配器 ID 应是 `agent_id + host_id` 的组合**，而不是单一 `agent_id`。同一个 Copilot，在 VS Code 和 JetBrains 里完全是两套存储。如果适配器只按“Copilot”来写，会漏掉一半的数据源。

**通义灵码不可采集**：当前不提供跨会话、持久化存储的历史记录功能，关闭对话面板后记录即清空。建议从适配器开发清单中移除或降级。

## 六、本软件适配器实现状态与动态化架构建议

### 6.1 实现状态（与仓库 `adapters/` 对齐）

| 文档条目 | 适配器 ID | 状态 | 说明 |
|---|---|---|---|
| Claude Code（§2.1） | `claude-code` | ✅ 完整 | JSONL 转录解析 |
| Codex CLI（§2.2） | `codex` | ✅ 基础 | rollout JSONL |
| OpenCode（§2.5） | `opencode` | ✅ 完整 | SQLite 主通道 |
| WorkBuddy（§2.17） | `workbuddy` | ✅ 完整 | JSONL，双数据目录（国内 `~/.workbuddy` / 海外 `~/.workbuddy-ai`） |
| Trae（§2.14） | `trae` | ✅ hook 通道 | Claude 式 hook（`~/.trae-cn/hooks.json`）；加密 SQLite 待解 |
| Trae SOLO 桌面版 | `traework` | ✅ 基础 | 加密 SQLite，能力受限 |
| CodeBuddy（§2.18） | `codebuddy` | ✅ 基础 | `~/.codebuddy` JSONL |
| 通义灵码（§2.13） | `lingma` | ✅ 基础（降级） | 受 §2.13「无持久化存储」限制 |
| Qwen Code（§2.4）/ Continue.dev（§2.12） | `qwen-code` / `continue-dev` | ✅ 动态清单 | 声明式清单（§6.2）驱动通用格式引擎，已通过端到端点测 |
| Gemini CLI（§2.3） | `gemini` | ✅ 完整 | 新旧双格式兼容（新版 JSONL + 旧版信封 JSON）；project_hash 不可逆，cwd 回落 hash 目录 |
| Aider（§2.6） | `aider` | ✅ 动态清单 | 第五引擎 Markdown 分段驱动（`adapters/manifests/aider.json`）：逐运行分段为多会话（新式/旧式排版兼容，成本行剔除）；无中心存储，扫描需 agentPaths 指定仓库目录 |
| Copilot CLI（§2.7） | `copilot-cli` | ✅ 基础 | events.jsonl 多形状容错（SDK content blocks / 扁平消息）+ workspace.yaml 项目关联；session-store.db（折叠索引）不读 |
| Copilot VS Code（§2.9.1） | `copilot-vscode` | ✅ 基础 | chatSessions delta journal 重放（kind:0 根快照 / kind:1 路径段写值 / kind:2 数组追加，k 为路径段数组）+ emptyWindowChatSessions；cwd 由 workspace.json folder URI 解码；thinking 常为空/加密态仅取明文；OTel agent-traces.db 未见本地实例，待后续；已用本机 85 个真实文件点测验证 |
| Copilot JetBrains（§2.9.2） | `copilot-jetbrains` | ⏸ 占位 | Nitrite（H2 MVStore）无法直读，待官方导出通道或 external 引擎桥接导出脚本 |
| Cline（§2.10） | `cline` | ✅ 完整 | `~/.cline/data/tasks/`（三端共用）+ 旧版 VS Code globalStorage 兜底；tool_result 回执不建轮 |
| Roo Code（§2.11） | `roo-code` | ✅ 完整 | 与 Cline 共享任务解析（`adapters/lib.js parseClineStyleTaskDir`），支持 `history_item.json`；checkpoint git 目录天然跳过 |
| Kiro（§2.8） | `kiro` | ✅ 基础 | SQLite `conversations_v2` 主通道（key=工作目录，value=JSON，条目形状容错）；`~/.kiro/sessions` JSONL/目录格式 schema 未文档化，待后续 |
| Cursor（§2.15） | `cursor` | ✅ 基础 | `cursorDiskKV` 容错解析（composerData + bubbleId，headersOnly 顺序优先、写入序兜底，富文本剥离）；每库多会话 + 多库遍历 |
| Windsurf（§2.16） | `windsurf` | ⏸ 占位 | Cascade 内容加密，仅标题级可读；解析计划见 `adapters/windsurf.js` |
| MiMo Code（§2.19） | `mimo-code` | ✅ 基础 | OpenCode 同源 SQLite，声明式清单（§6.2 sqlite 引擎）接入；镜像会话过滤已实现：`mirrorTables` 声明（claude_import/external_import 登记集排除，缺表静默容错），已用真实 mimocode.db 回归验证 |
| Antigravity | `antigravity` | ⏸ 占位 | 加密 SQLite+protobuf，待 agy-reader 类解密通道或 external 引擎桥接 |

### 6.2 动态新增解析器的架构建议（回答开篇问题）

**现状**：新增适配器 = 编写 `adapters/<id>.js` + 在 `src/scan.js` 的 `ADAPTERS` 注册表与 `src/detect.js` 的 `AGENTS` 清单注册 → 必须重新打包发版。

**建议调整为「格式引擎 + 声明式清单 + 外部进程协议」三层**：

1. **通用格式引擎内置客户端**：按 §三 复用策略沉淀 4 个引擎——JSONL 行解析、SQLite 读取、JSON 结构解析、Markdown 分段。引擎稳定，随客户端发版。
2. **适配器退化为声明式清单（manifest JSON）**：声明存储路径 glob、所用引擎、字段映射、项目识别规则、过滤/归一化规则、版本兼容范围。多数新适配器只是新增一份 JSON，无需写代码。
3. **清单热更新通道**：扫描时合并三处清单——内置清单（随包）、用户目录 `~/.agentsessions/adapters/*.json`（手动投放）、远端清单仓库（版本化 URL，定时拉取 + schema 校验 + 失败回退内置）。实现“不发客户端新增解析器”。
4. **外部进程适配器协议**：Nitrite（Copilot JetBrains）、protobuf/加密（Windsurf、Antigravity）等无法内置的格式，约定 stdin/stdout JSONL 进程协议，任意语言的可执行脚本放入用户适配器目录即可被发现；执行施加只读、超时、输出限额。
5. **保留硬编码适配器**：高价值/复杂工具（Codex rollout 演进、Copilot OTel delta journal、Cursor `cursorDiskKV`）继续内置，保证解析质量与性能。

**安全约束**（沿用项目既定原则）：manifest 与外部适配器均为只读通道；路径校验（仅允许清单声明的主目录/项目目录）、大文件阈值跳过、单适配器超时；除远端清单拉取外禁止网络访问；清单加载失败一律回退内置行为。

**迁移路径**：① 把 `detect/scan` 两张注册表改为「内置清单 + 用户清单」合并加载（现有 8 个适配器行为不变）；② 将同质化的 JSONL 类适配器迁到声明式；③ 接入远端清单仓库与外部进程协议。

**实现状态（2026-09-28，§6.1 全量落地）**：三层架构已落地——`src/manifest.js` 实现三源清单合并（内置 `adapters/manifests/` + 用户 `~/.agentsessions/adapters/` + 远端 `manifestRepo` 定时拉取，优先级 用户 > 远端 > 内置，拉取失败回退缓存），`src/engines.js` 实现四类通用格式引擎（JSONL 行解析 / JSON 结构 / SQLite 直读 / 外部进程 stdin-stdout JSONL 协议，含超时与输出限额）并接入 `detect/scan/config`；声明式清单现有 `qwen-code`（JSONL）、`continue-dev`（JSON）、`mimo-code`（SQLite，OpenCode 同源 schema）三份。剩余工具按 §四难度全部接入：`gemini`（新旧双格式）、`aider`（Markdown 逐运行分段）、`copilot-cli`（events.jsonl 容错 + workspace.yaml）、`copilot-vscode`（chatSessions delta journal 重放 + emptyWindowChatSessions + workspace.json cwd 映射）、`cline` / `roo-code`（共享任务目录解析）、`kiro`（conversations_v2）、`cursor`（cursorDiskKV 容错）为硬编码适配器；`copilot-jetbrains` / `windsurf` / `antigravity` 为占位适配器（含探测与解析计划，设置页显示「已安装 · 暂不支持索引」）。配套扩展：`scan.js` 支持多候选库遍历（每库多会话）与单文件多会话（aider）；`config.js` 的 `KNOWN_AGENTS` 改为动态并入 `detect.AGENTS` 与清单 id。端到端点测（探测 → 扫描落库 → 字段断言 → 增量跳过 → 既有清单引擎回归）64/64 通过；copilot-vscode 后续落地时另以本机 85 个真实 chatSessions 文件点测 25/25 通过（fixture 合成场景 + 真实数据双通道）。Markdown 分段引擎已落地为第五引擎（`engines.js markdownAdapter`：按精确文件名枚举、runHeading 逐运行分段、角色标题/旧式隐式用户标题状态机、过滤行剔除，清单声明 runHeading/headingLevel/roleHeadings/ignoreHeadings/filters），Aider 已从硬编码迁移为内置清单 `manifests/aider.json` 驱动，迁移点测 27/27 通过。§6.1 全量落地后收口（2026-09-28）：① 镜像会话过滤（§2.19）随 sqlite 引擎实现——清单新增 `sqlite.mirrorTables` 声明（`{table, column}` 过 isSqlIdent 白名单校验防注入），引擎扫描前收集登记表会话 id 并整体排除，登记表缺失/不可读静默跳过；MiMo 声明 claude_import/external_import 双登记表，并移除与真实 schema 不符的 session.model 列声明。② `scan.js` dbCandidates 分支补单库容错：逐库 try/catch，单库 schema 漂移/损坏仅记录 agent 级 error 降级，不再中断整体扫描。点测 34/34 通过（镜像过滤/缺表容错/真实库回归/垃圾库降级/四清单回归）；其余待办经本机复核均为数据阻塞（Copilot OTel agent-traces.db 无实例、JetBrains Nitrite 无数据、Antigravity 未安装、Windsurf 仅空 .pb），维持占位不变。