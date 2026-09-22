# AgentSessions

本地优先的 AI 编码会话统一索引与检索工具。

自动发现本机已安装的 coding agent（Claude Code、OpenCode、WorkBuddy、Trae 等），把散落各处的会话记录统一索引到一起，按项目聚合、按账号区分，支持从标题到思考过程的分层全文搜索——让你随时找回"那个活是在哪个工具里干的、当时是怎么聊的"。

**全部数据留在本机，不上传、不联网。**

---

## 核心特性

### 时间线：先看到"活"

- 所有工具的会话汇成一条时间线，按 今天 / 昨天 / 7 天内 / 本月 / 更早 自动分组
- 卡片上一眼看到：标题、★ 收藏、工具、账号、项目、话题、轮次数、时间
- 支持按 Agent / 项目 / 账号 快速过滤

### 搜索：从浅到深，渐进披露

- 先搜会话标题，不够再搜主题、对话正文，最后搜 AI 思考过程——每一步都有状态提示，可手动继续加深
- 命中结果带层级徽标（标题 / 主题 / 正文 #2 / 思考 #2），点击直接跳到会话详情的对应轮次并高亮关键词
- 时间过滤预设（今天 / 本周 / 本月 / 自定义日期段）+ Agent / 项目 / 账号过滤
- 按 `/` 随时唤起搜索（兼容中文输入法），`Esc` 返回列表

### 会话详情：完整回顾

- 完整对话渲染：用户消息、AI 回复、思考过程（默认折叠）、工具调用、文件变更
- **默认 Markdown 渲染**：标题/列表/表格/引用/链接/行内样式 + 代码高亮，一键切换原文模式（选择会记忆）
- 思考 / 工具 / 文件内容可按类型开关，只看你想看的
- 代码块语法高亮（零依赖实现，防注入）
- 会话内搜索 + 命中定位
- ★ 收藏常用会话

### 导出与交接

- 一键导出 `.md` / `.json`，导出内容用自然语言组织（思考过程折叠、工具调用收进代码块），可直接归档或分享
- **上下文交接**：一键复制清洗后的上下文（去掉思考、工具调用、文件变更，只留对话），贴到其他工具里继续干活

### 项目与账号

- 同一工作目录的会话自动聚合为项目，支持重命名（显示"自定义"标记）
- 多账号区分：同一工具的工作号 / 个人号会话分开展示，支持手动映射命名与分类

### 统计

- 30 天活动趋势、Agent / 项目分布

### 省心后台

- 启动自动增量扫描（只处理新增/变更文件），间隔可配置（默认 5 分钟，可关闭）
- 状态栏实时显示：已索引 X 会话 · Y 项目 · Z Agent · 最后扫描时间
- 大文件保护：超过阈值（默认 50MB）的会话文件自动跳过
- 排除规则：贴一个目录路径或写 glob（`**/playground/**`），即可不索引某些项目

---

## 支持的 AI 工具

| 工具        | 状态        | 说明                                                       |
| ----------- | ----------- | ---------------------------------------------------------- |
| Claude Code | ✅ 完整支持 | 读取`~/.claude/projects`，含思考过程、工具调用、文件变更 |
| OpenCode    | ✅ 完整支持 | 读取`~/.local/share/opencode`                            |
| WorkBuddy   | ✅ 完整支持 | 读取`~/.workbuddy/projects`                              |
| Trae        | ✅ 完整支持 | 读取（`~/.trae-cn/memory/projects`）                     |
| Codex       | ✅ 基础支持 | 读取`~/.codex/sessions`，解析 rollout JSONL 格式         |
| CodeBuddy   | ✅ 基础支持 | 读取`~/.codebuddy/projects`，解析 transcript JSONL 格式  |
| Lingma      | ✅ 基础支持 | 读取`~/.lingma`，尝试解析 JSONL 格式会话文件             |
| TraeWork    | ✅ 基础支持 | 读取`AppData/Roaming/TRAE SOLO CN`，尝试解析会话文件     |

未识别 cwd 的会话归入"未分类"项目，不会丢弃；自定义安装路径可在设置页手动指定。

---

## 安装与运行（从源码）

**环境要求**：Node.js ≥ 18（Windows / macOS / Linux）

```bash
# 1. 安装依赖（根目录核心 + 前端）
npm install
cd ui && npm install && cd ..

# 2. 启动本地服务（REST 桥接，默认 127.0.0.1:18778）
npm run bridge

# 3. 启动前端（另开终端，默认 http://localhost:5173）
npm run dev:ui
```

打开浏览器访问 `http://localhost:5173`，首次启动 300ms 后自动开始增量扫描，状态栏可看到索引进度。

### 命令行用法

不想开 UI 时，CLI 一样能用：

```bash
npm run scan                                    # 扫描并索引全部已检测 agent
node src/cli.js scan --only claude-code         # 只扫描某个 agent
node src/cli.js detect                          # 列出本机检测到的 agent
node src/cli.js search "连接池" --depth 3       # 搜索（depth 1=标题 2=主题 3=正文 4=思考）
```

全局安装后可直接用 `as` 命令（见 package.json 的 `bin` 配置）。

---

## 配置

配置文件位于 `~/.agentsessions/config.json`（设置页可视化编辑，无需手改）：

| 字段                | 说明                                                                                                          | 默认   |
| ------------------- | ------------------------------------------------------------------------------------------------------------- | ------ |
| `excludes`        | 排除规则：无通配符按路径包含匹配（贴目录即排除其下所有会话），含`*` `?` `**` 按 glob 匹配，大小写不敏感 | `[]` |
| `autoScanMinutes` | 自动增量扫描间隔（分钟），`0` 关闭                                                                          | `5`  |
| `maxFileSizeMB`   | 大文件跳过阈值（MB），`0` 不限制                                                                            | `50` |
| `agentPaths`      | Agent 会话目录手动指定（路径存在即纳入扫描）                                                                  | `{}` |
| `accountMapping`  | 账号显示名与工作/个人分类映射                                                                                 | `{}` |
| `searchHotkey`    | 搜索快捷键                                                                                                    | `/`  |

索引数据库位于 `~/.agentsessions/agentsessions.db`，删除即重建索引（原始会话文件不受任何影响——本工具只读不改）。

---

## 开发

### 目录结构

```
agentSessions/
├── src/                  # 核心采集/解析（Node，CommonJS）
│   ├── detect.js         #   agent 安装检测
│   ├── scan.js           #   增量扫描调度（mtime+size 指纹）
│   ├── model.js          #   SQLite schema + 存储层（sessions/turns/subjects + FTS5）
│   ├── query.js          #   只读查询层（列表/详情/统计）
│   ├── search.js         #   L1-L4 分层搜索（标题/主题/正文/思考）
│   ├── config.js         #   ~/.agentsessions/config.json 读写 + 排除规则
│   ├── purpose.js        #   会话主题归类（L2 种子）
│   ├── export.js         #   导出 md/json
│   ├── handoff.js        #   上下文清洗交接
│   └── cli.js            #   命令行入口
├── adapters/             # agent 适配器（一 agent 一文件）
│   ├── lib.js            #   共享工具：findJsonlFiles / buildSubjects
│   ├── claude-code.js / opencode.js / workbuddy.js / trae.js   # 完整适配器
│   └── codex.js / codebuddy.js / lingma.js / traework.js       # 基础适配器
├── server.js             # REST 桥接（127.0.0.1:18778，原生 http，零框架）
├── scripts/
│   └── pack-backend.js   # 桌面打包：组装自包含后端载荷 → src-tauri/backend/
├── ui/                   # 前端（Vite + React + TypeScript）
│   └── src/
│       ├── views/        #   TimelineView / SearchView / SessionView / ProjectsView / StatsView / SettingsView
│       ├── api.ts        #   REST 封装
│       ├── lib.tsx       #   共享工具：fmtTime / highlight
│       └── highlight.ts  #   零依赖代码高亮
└── src-tauri/            # Tauri 桌面壳（打包用，配置见 tauri.conf.json）
```

### 常用命令

```bash
npm run bridge                # 启动 REST 服务
npm run dev:ui                # 启动前端开发服务器
cd ui && npx tsc --noEmit     # 前端类型检查（提交前必过）
node src/cli.js scan          # 命令行扫描
node src/cli.js search 关键词 # 命令行搜索
```

### 代码约定

- **后端**：CommonJS，内置模块用 `node:` 前缀；注释用中文；不引第三方依赖（目前唯一依赖 `better-sqlite3`）
- **前端**：React 函数组件 + hooks；**不新增运行时依赖**（图表纯 CSS、高亮零依赖是刻意为之）
- **适配器接口**：`sources()` 枚举会话文件 + `parseFile()` 单文件解析为统一会话模型；重复逻辑提取到 `adapters/lib.js`
- **只读原则**：绝不修改 agent 的原始会话文件

---

## 调试

### 桌面版前端调试

打包版内置 DevTools 入口（调试页面异常用）：**F12 / Ctrl+Shift+I** 随处切换，或 设置 → 调试 → 打开开发者工具。浏览器 dev 模式不劫持这两个按键，沿用浏览器自带 DevTools。

### 环境变量

| 变量                   | 说明           | 默认                                  |
| ---------------------- | -------------- | ------------------------------------- |
| `AGENTSESSIONS_DB`   | 索引数据库路径 | `~/.agentsessions/agentsessions.db` |
| `AGENTSESSIONS_PORT` | REST 服务端口  | `18778`                             |

调试时建议用独立库和端口，不碰真实索引：

```bash
$env:AGENTSESSIONS_DB="$env:TEMP\as-debug.db"; $env:AGENTSESSIONS_PORT="18999"; node server.js
```

图标

当前用的是`tauri init` 的默认 Tauri 图标，后续想换自己的图标，准备一张 1024×1024 PNG 执行`cd ui && npm run tauri icon <图片路径>` 即可全量替换。

### 常见问题

| 问题                        | 排查                                                                                          |
| --------------------------- | --------------------------------------------------------------------------------------------- |
| `better-sqlite3` 安装失败 | 需要 C++ 构建工具（Windows 装 VS Build Tools）；多数平台有预编译二进制，先重试`npm install` |
| 检测不到某个 agent          | 确认安装路径在支持列表；自定义路径到设置页配置`agentPaths`                                  |
| 某项目的会话没被索引        | 检查排除规则`excludes` 是否误命中；检查文件是否超过 `maxFileSizeMB`                       |
| 搜索结果不全                | 渐进披露默认先搜浅层，点"继续搜索正文/思考"或用`depth` 参数搜深层                           |
| 端口被占用                  | `AGENTSESSIONS_PORT` 换端口，或找到占用进程                                                 |
| 数据乱了想重来              | 删除`~/.agentsessions/agentsessions.db` 重新扫描即可，原始会话文件无损                      |

---

## 打包

桌面安装包基于 **Tauri 2**（Windows 目标：NSIS / MSI，配置见 [src-tauri/tauri.conf.json](src-tauri/tauri.conf.json)）。

**环境要求**：

- Rust（MSVC 工具链 `x86_64-pc-windows-msvc`——GNU 工具链链接 WebView2 会报 `export ordinal too large`，项目已在 `rust-toolchain.toml` 固定）
- Windows 需要 WebView2 Runtime（Win11 自带）

```bash
cd ui && npm install && cd ..
npm install
cd ui && npm run tauri build   # 产出安装包（src-tauri/target/release/bundle/）
cd ui && npm run tauri dev     # 桌面壳开发模式
```

> 注意：`@tauri-apps/cli` 安装在 `ui/` 的 devDependencies 中，必须在 `ui/` 目录下通过 `npm run tauri` 调用（脚本会自动回到项目根目录执行）；在根目录直接 `npx tauri` 会报 `could not determine executable to run`。

**国内网络必备**：首次打包时 Tauri 需从 GitHub releases 下载 NSIS / WiX 工具链，直连通常超时（报 `timeout: global`）。设置 GitHub 镜像后重试即可：

```bash
# Git Bash
export TAURI_BUNDLER_TOOLS_GITHUB_MIRROR="https://gh-proxy.com"

# PowerShell
$env:TAURI_BUNDLER_TOOLS_GITHUB_MIRROR="https://gh-proxy.com"
```

实测可用镜像（任选其一）：`gh-proxy.com` / `ghproxy.net` / `ghfast.top`。工具链会缓存到 `%LOCALAPPDATA%\tauri\`，首次下载成功后后续构建不再需要镜像。若走本地代理，也可改设 `HTTPS_PROXY`。

**自包含后端**：桌面安装包内置完整后端，无需目标机器安装 Node——`beforeBuildCommand` 自动执行 [scripts/pack-backend.js](scripts/pack-backend.js)，把 `node.exe` + `server.js` + `src/` + `adapters/` + 运行时依赖（`better-sqlite3` 等，已裁剪 sqlite 源码）组装为 `src-tauri/backend/`（约 70MB，已 gitignore），由 `tauri.conf.json` 的 `resources` 打进安装包。桌面版启动时自动拉起该桥进程（`127.0.0.1:18778`），期间界面显示启动过渡屏（就绪即自动进入主界面），退出时自动回收进程；自带 node 也保证了 `better-sqlite3` 原生模块与运行时 ABI 严格一致。dev 模式（`tauri dev`）同样会自动拉起仓库根目录的 `server.js`。

> 日常开发无需打包：`npm run bridge` + `npm run dev:ui` 即可（或 `cd ui && npm run tauri dev`，桌面壳开发模式会自动拉起后端）。

---

## 贡献

欢迎贡献，特别是**新 agent 适配器**——这是本工具的核心生态。

### 新增一个适配器

1. **注册检测**：在 [src/detect.js](src/detect.js) 的 `AGENTS` 中添加安装检测（目录存在 / 可执行文件存在即视为已安装）
2. **实现适配器** [adapters/&lt;agentId&gt;.js](adapters)：
   - **完整适配器**（参考 `claude-code.js`）：导出 `id` / `label` / `sourceDir` / `sourceFormat` / `sources()`（枚举会话文件）/ `parseFile()`（解析为统一会话模型：session + project + turns + subjects）
   - **基础适配器**（参考 `codex.js`）：导出 `id` / `label` / `sourceDir` / `sourceFormat` / `sources()` / `parseFile()`，提供基础会话解析支持
   - **占位适配器**（参考旧版 `codex.js`）：只导出 `id` / `label` / `placeholder` / `plan`（解析思路备注），设置页会显示"已安装 · 暂不支持索引"
   - 通用逻辑用 [adapters/lib.js](adapters/lib.js) 的 `findJsonlFiles` / `buildSubjects`，不要复制粘贴
3. **同步三处清单**（新增 agent 必须三处一致）：
   - `src/detect.js` 的 `AGENTS`
   - `src/config.js` 的 `KNOWN_AGENTS`（agentPaths 白名单）
   - `ui/src/views/SettingsView.tsx` 的 `AGENT_LIST`
4. **验证**：`node src/cli.js detect` 确认检测 → `node src/cli.js scan --db <临时库>` 确认解析数量与轮次 → `node src/cli.js search <关键词> --db <临时库>` 确认可搜 → 清理临时文件

### 提交前检查

- [ ] `cd ui && npx tsc --noEmit` 零错误
- [ ] 后端改动跑了 CLI 冒烟（detect / scan / search）
- [ ] 涉及 API 的改动用 curl 过一遍 `/api/search`、`/api/session`、`/api/export` 等端点
- [ ] 新功能不影响既有视图逻辑（特别是搜索渐进披露与详情定位链路）
- [ ] 不引入新的运行时依赖（前端）；后端依赖需说明理由

### 其他约定

- 修改 schema 时注意：`sessions` 表 UNIQUE 约束是 `(agent_id, agent_session_id)`，变更约束需重建索引表（含 FTS）
- 遵循现有中文注释风格；复杂逻辑写"为什么"而不是"是什么"
- PR 描述写清楚：改了什么、为什么改、怎么验证的

---

## 隐私与安全

- **全本地**：索引、配置、数据库全部在 `~/.agentsessions/`，无任何网络上报
- **只读采集**：对 agent 的原始会话文件零写入、零修改
- **可退出**：删除数据库目录即完全卸载数据，不留残余
- REST 服务仅监听 `127.0.0.1`，不暴露局域网

## License

MIT
