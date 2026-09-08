# SVH（Short Video Harness）

面向短视频 / AI 短剧制作的 **AI Video Production Harness**。在稳定的 Agent 工作环境（Workspace / Session / Tool / Provider）之上，V0.2 引入了 AI 短剧生产系统：项目 → 剧本 → 角色 → 场景 → 分镜 → 镜头 → 资产，配合 Workflow 编排与图片 / 视频生成 Providers。

```text
用户 → Workspace → Session → 与 AI Agent 对话
      → Agent 读取 Workspace → 调用 Tool → 修改文件
      → 实时观察执行过程 → Session / Workspace 持久化

制作流水线（V0.2 → V0.3）：
Chat（Director 导演）→ 创建生产项目 → 自动启动生产工作流
      → 剧本 → 角色 / 场景 → 分镜 → 图 / 视频生成 → 人工审核
      → 镜头配音（TTS）→ 生成字幕 → 成片组装（画面 + 音轨 + 烧录字幕）
```

## 技术栈

| 层         | 技术                                                                                                |
| ---------- | --------------------------------------------------------------------------------------------------- |
| Monorepo   | pnpm workspace                                                                                      |
| Frontend   | React 18 + TypeScript + Vite + Ant Design + Tailwind CSS + Zustand + TanStack Query + Monaco Editor |
| Backend    | Node.js + TypeScript + Fastify + SSE（无 WebSocket）                                                |
| Database   | SQLite（开发）+ Drizzle ORM（生产可切 PostgreSQL）                                                  |
| Agent Core | TypeScript Async Generator / AsyncIterable / Event Driven（不依赖任何 Web 框架）                    |
| LLM        | OpenAI Compatible API（OpenAI / DeepSeek / 本地 Ollama 等）                                         |

## 目录结构

```text
svh/
├── apps/
│   ├── web/          # React 工作台 UI + 制作中心（Production Center）
│   ├── server/       # Fastify API + SSE Agent Run + Production/Workflow 编排 + 生成任务入队
│   └── worker/       # 生成任务队列 worker：claim / 心跳 / stale 接管，执行图片 / 视频 / 音频（TTS）生成，分级并发预算
├── packages/
│   ├── core/         # Agent Runtime / Loop / Context Builder / Workflow 状态机
│   ├── providers/    # LLM / Image / Video Provider 接口 + Registry
│   ├── workspace/    # Workspace Manager / FileManager(安全路径)
│   ├── tools/        # Tool Registry + 文件工具 + 16 个生产工具（Production Tools）
│   ├── production/   # 生产领域包：项目/剧本/角色/场景/分镜/镜头/资产（纯领域，无 SQL/HTTP/AI）
│   ├── database/     # Drizzle schema（workspaces/sessions/settings/production/workflow）
│   └── shared/       # 共享类型与工具（AppError/Session/Message/randomId）
├── data/             # svh.db + workspaces/（项目事实来源）
├── docs/             # 使用文档（见 production-guide.md）
└── scripts/          # mock-llm.mjs（开发用 Mock LLM）
```

依赖方向：`shared ← database ← production ← workspace/providers/tools ← core ← server ← web`

## 快速开始

```bash
# 1. 安装依赖
pnpm install

# 2. 配置环境
cp .env.example .env
# 编辑 .env：至少配置 SVH_LLM_BASE_URL / SVH_LLM_MODEL（API Key 可选）

# 3. 同时启动 Server + Worker + Web（worker 与 server 共用同一 SQLite；默认 DB 路径同语义，开箱即用）
pnpm dev
# Server: http://localhost:3000
# Web:    http://localhost:5173
```

没有可用的 LLM API 时，可用 Mock 验证完整 Agent 流程：

```bash
node scripts/mock-llm.mjs            # http://localhost:9999/v1
# 在 Web 的「模型设置」中填写 Base URL http://localhost:9999/v1 与模型 mock-1
```

## 环境变量

见 [.env.example](./.env.example)：

```env
SVH_PORT=3000
SVH_DATABASE_URL=file:./data/svh.db
SVH_WORKSPACE_ROOT=./data/workspaces
SVH_LLM_BASE_URL=
SVH_LLM_API_KEY=
SVH_LLM_MODEL=
```

API Key 只保存在服务端（env 或 Settings 表），不会返回前端；也可以在 Web 顶部的「模型设置」中修改（持久化到数据库 settings 表）。

### 多域名/隧道访问示例

```text
web  → test1.kv2ray.cc  → Vite dev（apps/web/vite.config.ts 的 allowedHosts）
api  → test2.kv2ray.cc  → Fastify Server（默认监听 0.0.0.0）
mock → test3.kv2ray.cc  → Mock LLM（scripts/mock-llm.mjs）
```

- Web 域名放行：在 `apps/web/vite.config.ts` 的 `server.allowedHosts` 添加（或用 `SVH_ALLOWED_HOSTS` 环境变量，逗号分隔）。
- 跨域：若 Web 直连独立 API 域名，启动 Server 时设置 `SVH_CORS_ORIGIN` 包含 Web 域名（如 `SVH_CORS_ORIGIN=http://localhost:5173,http://test1.kv2ray.cc`）；默认走 Vite 同源代理则无需 CORS。
- Web 直连 API 域名（可选）：在 `apps/web/.env.local` 设置 `VITE_API_BASE=http://test2.kv2ray.cc`，请求将不经过 Vite 代理。

## 核心概念

- **Workspace**：数据库存元数据，文件系统存项目产物。创建时自动生成 `svh.project.json` 与 `VIDEO_AGENTS.md`（Context Builder 自动读取，缺省回退默认 System Prompt）。
- **Agent Runtime**：输出统一事件流（`run.started / message.delta / tool.called / tool.completed / workspace.changed / run.completed / run.error`），通过 SSE 转发到浏览器。
- **Agent Loop**：LLM → Tool Call → 执行 Tool → 结果回传 → 再次调用 LLM，最多 20 轮（超出报 `Maximum tool iterations exceeded`，不会导致 Server 崩溃）。
- **文件安全**：所有文件读写限制在 Workspace Root 内（`resolveSafeWorkspacePath` 拒绝 `../` 逃逸）。
- **Context**：System Prompt + VIDEO_AGENTS.md + Workspace Summary + 最近 50 条消息 + 当前用户消息（V1 不做复杂压缩）。

## AI 短剧生产系统（V0.2 → V0.3）

在不改动 Agent Runtime 的前提下，以「领域包 + 工具 + Profile + Workflow」的方式增量扩展。完整使用说明见 **[docs/production-guide.md](./docs/production-guide.md)**。

| 能力            | 说明                                                                                                                            |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| 生产领域模型    | Project / Script / Character / Scene / Storyboard / Shot / Asset 七类实体，跨实体完整性校验（`packages/production`，纯领域） |
| Production Tools | 16 个 Agent 可调用工具（create_project / create_script / create_scene / create_storyboard / create_shot 等），带工作区隔离 |
| Agent Profile   | Director（制作导演）/ Script（编剧）/ Storyboard（分镜师）三套角色：系统提示词 + 工具白名单，复用同一 Runtime               |
| Workflow Engine | 纯状态机 DAG（拓扑排序/重试/暂停/恢复/取消/级联取消）+ 服务端持久化与节点执行器（节点=带 Profile 的 Agent Run）              |
| Chat → Workflow | Director 对话成功创建项目后，自动创建并启动生产工作流，无需到制作中心手动 Run（会员门控，失败不影响对话）                   |
| Image Provider  | 文生图双路由：OpenAI 兼容 `/images/generations`（Volcengine Ark 等）+ DashScope 原生同步接口（qwen-image / 通义万相）           |
| Video Provider  | 异步任务式文生视频（`createTask / getTask / cancelTask` + 轮询），首批适配 DashScope（百炼）                                    |
| 任务队列        | `production_tasks` 即 SQLite 队列（payload + 原子 claim + 心跳回收）+ 独立 `apps/worker` 进程执行图片/视频/音频生成，重启自动接管；**分级并发预算**（global / provider / project，claim SQL 原子过滤，0=不限） |
| 生成审核与版本 | `generation_records` 审核账本（v1/v2/v3、approve / reject / replace / regenerate、镜头选中资产）、按镜头/分镜批量生成、Provider fallback、**待审核视图**（按分镜分组一键裁定）与列表读时对账自愈 |
| 工作流审核门控 | `review.generation` 节点：生成后挂起为 `waiting_user`，人工审核完成后自动续跑；可通过 `withGeneration` 勾选生成节点（图/视频/配音/字幕/成片组装全链） |
| 成片链路 | `audio.generate`（openai-compatible TTS 配音，角色音色）、`subtitle.generate`（本地生成 SRT，无模型依赖）、`video.compose`（ffmpeg 画面合成 + 音轨 mux + libass 字幕烧录，`@ffmpeg-installer` 免系统安装） |
| 资产本地化      | 生成成功后 worker 自动转存媒体到工作区（宽落库，失败可见可手动重试）；`GET /api/media` 鉴权流式送达（Range）；磁盘容量无护栏（见 guide） |
| 制作中心 UI     | 项目列表 → 详情七面板（剧本/角色/场景/分镜/**待审核**/资产）+ 工作流面板（SSE 实时节点状态、暂停/恢复/取消/重试）；五类实体完整人工 CRUD（编辑/删除/字段透传）、资产手动录入/编辑、镜头规格编辑、Prompt Inspector 可编辑重新生成 |

```text
制作中心：http://localhost:5173/#/production
Director 对话：新建会话 → 选择「制作导演」角色 → 描述需求 → 自动建项目并串联工作流
```

## 常用命令

```bash
pnpm dev          # 启动 Server + Worker + Web
pnpm build        # 所有包独立编译（tsc 产物在各包 dist/，web 为 vite 构建）
pnpm typecheck    # 全包 TypeScript 检查
pnpm lint         # ESLint
pnpm format       # Prettier 写入

# 测试（node:test，不引入测试框架；各包 / server 目录内）
cd packages/production && node --import tsx --test "test/**/*.test.ts"
cd packages/core      && node --import tsx --test "test/**/*.test.ts"
cd packages/providers && node --import tsx --test "test/**/*.test.ts"
cd apps/server        && node --import tsx --test "src/**/*.test.ts"
```

## API 摘要

- `POST/GET/DELETE /api/workspaces[/:id]` — Workspace
- `POST/GET /api/workspaces/:workspaceId/sessions`、`GET/PATCH/DELETE /api/sessions/:id`、`GET /api/sessions/:id/messages` — Session & 消息
- `POST /api/sessions/:id/run`（SSE，可带 `profileId`）— Agent Run
- `GET/PUT/PATCH` 文件：`/api/workspaces/:id/files[...]` — 浏览/读取/写入/删除
- `GET/PUT /api/settings` — 模型设置（ApiKey 掩码）
- `POST/GET /api/productions`、`GET/PATCH/DELETE /api/productions/:id` — 生产项目
- `/api/projects/:projectId/{scripts,characters,scenes,storyboards,shots}` — 生产实体 CRUD
- `POST /api/projects/:id/assets/generate-image`、`POST /api/projects/:id/assets/generate-video` — 图片 / 视频生成入队，统一返回 `{task}`；配置类错误即时 400
- `GET /api/tasks/:id`、`POST /api/tasks/:id/cancel` — 生成任务（图片/视频）轮询与取消
- `GET /api/media/:assetId?token=` — 已本地化资产的鉴权流式送达（通道内验签+用户态检查：未签名/坏签名/账号禁用 401；不存在/越权/未就绪同构 404；单区间 Range → 206；文件丢失 410）
- `POST /api/assets/:assetId/localize` — 手动重试转存（ready 且在盘 → 200 幂等不重下；ready 悬空 → 自愈重下；下载失败先收敛 DB 再 422 带脱敏原因；无远程地址的 b64 资产 400）
- `POST/GET /api/projects/:projectId/workflows`、`GET /api/workflows/:id` — 工作流
- `POST /api/workflows/:id/{run,pause,resume,cancel}`、`POST /api/workflows/:id/nodes/:nodeId/retry` — 执行控制
- `GET /api/workflows/:id/events`（SSE）— 工作流事件流

## 路线图（V0.3 预留）

V0.2 已完成图片 / 视频 Providers、生产流水线与生成任务队列化（独立 `apps/worker`）。后续：音频 / TTS Provider、FFmpeg 自动剪辑、Timeline 编辑器、视频预览、Plugins、Context Compaction / Long Term Memory —— 均可在不修改 Core 的前提下扩展（Providers / Tools / Workspace 接口已预留）。

## AI 短剧生产系统（V0.3：Production Context / Prompt Intelligence / 一致性 / 审核）

在不动 Agent Runtime / Provider / Workflow / Worker 底座的前提下，V0.3 增量升级为「理解短剧生产上下文、保持角色/画面/场景/镜头一致性的 AI Production Agent」：

- **Production Context**（`packages/production/src/context/`）：按 director/script/storyboard 角色加载最小相关投影（项目/剧本/角色/场景/分镜），注入 System Prompt；核心交付见 **[docs/svh-v0.3-summary.md](./docs/svh-v0.3-summary.md)** 与 **[docs/svh-v0.3-compatibility-review.md](./docs/svh-v0.3-compatibility-review.md)**。
- **Prompt Composition**（`packages/production/src/prompt/`）：统一 Image/Video 提示词组合（Style+Scene+Character+Shot+Camera+Action+Raw），`metadata` 追溯来源。
- **Character Consistency**（`packages/production/src/consistency/`）：`CharacterVisualProfile` + `deriveCharacterPromptAnchor`（同角色跨镜头同 Anchor）+ `ReferenceResolver`。
- **Visual Style**（`packages/production/src/style/`）：`VisualStyleProfile` + `StyleResolver`（Shot>Scene>Project>Global）+ 注入。
- **Generation Review**（`packages/production/src/generation/`）：`generation_records`（版本/历史/审核）+ approve/reject/replace + 镜头选中资产。
- **Generation Orchestration**（`packages/production/src/plan/`）：`GenerationPlan` + 批量生成端点 + Provider fallback。

> 注：此仓库同一 master 上另有一个并行「工作流生成节点」开发任务（工作流级批量扇出/绑定），与本 V0.3 按分工互补，详见 §五。

可用命令：`pnpm dev / build / typecheck / lint`，测试见下文「常用命令」。
