# 声明式清单字段与引擎语义（源自 src/manifest.js / src/engines.js）

## 顶层校验（manifest.validate）

- `manifestVersion: 1`；`id` 小写 slug（`^[a-z0-9][a-z0-9-]*$`）；`label` 非空。
- `engine` ∈ `jsonl | json | sqlite | external | markdown`。
- `detect.dirs` 任一目录存在（相对项按主目录展开，`~/` 支持）或 `detect.bins` 任一在 PATH，即视为已安装。
- 三源合并优先级：用户目录（`~/.agentsessions/adapters/*.json`）> 远端（`manifestRepo` 拉取）> 内置（`adapters/manifests/`）；同 id 的硬编码适配器始终优先。
- 远端清单不允许 `external` 引擎（供应链安全）；`external` 只能放用户目录清单。
- 远端缓存文件：`~/.agentsessions/adapters/.remote-manifests.json`，`{fetchedAt, manifests:[...]}`；拉取失败保留旧缓存。

## 记录引擎（jsonl / json）

字段：

- `source.root`（必填）、`source.ext`（默认 `.jsonl` / `.json`）、`source.cwdFromPath`（取 root 下第一段目录名作 cwd）。
- `session.messagesPath`：json 引擎必填，指向消息数组（点路径，`a.b.0.c` 形式）。
- `session.id` / `cwd` / `model` / `title` / `ts`：点路径；json 引擎的会话级字段查找域为 `[文档根, ...消息记录]`。
- `session.userFile`：可选的旁挂需求文件（相对源文件路径，支持 `../`）；`session.userPattern`：正则标题，取其后每段非空文本作为用户需求（append-only 文件可含多段）。transcript 中缺失的 user turn 会被按序补到事件流最前，已有的 user 记录按文本去重后保持原位——否则 `assembleTurns` 会丢弃这些 turn 的助手回复。
- `rules[]`：`role` ∈ `user|assistant|thinking|tool|title`；`when` 对象内所有字段按字符串化后**全字段相等**匹配；`text` 可为单路径或路径数组（首个非空生效）；`tool` 需 `name` 与 `input` 路径；`ts` 为字符串路径。

语义与陷阱：

- 一条记录**至多被一条规则消费**：命中第一条规则后无条件 `break`。同一条记录既要出正文又要出工具调用时，必须靠不同 `when` 拆成多条规则，且特殊规则放前面。
- `asText`：对象只取 `.text`；数组递归拼接。没有 `.text` 的对象数组（如 OpenAI `tool_calls`）不能直接当正文文本。
- `tool.input` 非字符串会 `JSON.stringify`（截断 8000 字）；`assembleTurns` 会尝试 `JSON.parse(input)` 提取 `file_path` / `path` 填 `filesChanged`。
- `role:title` 设置会话标题；未设置时回退到 `session.title` → title 规则 → 首条用户消息前 80 字。
- `assembleTurns` 只把用户消息之后的助手/工具事件归轮；首条用户消息之前的事件丢弃。只有工具事件、没有用户/助手/思考文本的轮次会被 `finalizeTurns` 剔除。
- cwd 回退链：记录 `session.cwd` 字段 → `cwdFromPath` → 源文件所在目录。
- `session.id` 缺省回退为「文件名去扩展」；同名文件分布在多个会话目录时必冲突（UNIQUE `(agent_id, agent_session_id)`）。
- 时间：事件 `ts` 的最小/最大值；全缺失则回落源文件 mtime。轮次 `timestamp` 可能为 NULL，搜索层已用 `COALESCE(t.timestamp, s.updated_at)` 兜底排序。
- 每个源文件独立指纹（mtime+size）增量；超过 `maxFileSizeMB` 跳过。单文件 `parseFile` 可返回单会话或会话数组。

## SQLite 引擎

- `sqlite.candidates`：库文件路径数组（`~/` 展开）。
- `session{table,id,cwd,title,model,createdAt,updatedAt}`；`message{table,id,sessionId,data,time}`；`part{table,messageId,data,textTypes,thinkTypes,toolTypes}`。
- `mirrorTables: [{table,column}]`：登记的 session id 会被排除（避免镜像重复索引）。
- 库文件不受 `maxFileSizeMB` 限制；一个库可含多会话。

## Markdown 引擎

- `source.fileName`（精确文件名）+ 可选 `source.root`；`markdown.runHeading` 正则命中行=一次运行=一个会话；`headingLevel` 标题为消息边界。
- `roleHeadings.{user,assistant}`、`ignoreHeadings`、`filters`（正则行剔除）。
- 多运行文件的会话 id = `文件路径#运行序号`；时间取 runHeading 捕获组，缺省回落文件 mtime；cwd = 文件所在目录。

## 外部进程引擎（仅用户目录清单）

stdin 一行 `{"op":"scan"}`；stdout 每行 `{"item": UnifiedSession}`；约束：只读、默认超时 15s、默认输出上限 20MB、Windows 隐藏窗口。
