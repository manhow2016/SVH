# SVH（Short Video Harness）

面向短视频制作场景的 **AI Agent Harness**。V1 优先交付稳定的 Agent 工作环境：

```text
用户 → Workspace → Session → 与 AI Agent 对话
      → Agent 读取 Workspace → 调用 Tool → 修改文件
      → 实时观察执行过程 → Session / Workspace 持久化
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
│   ├── web/          # React 三栏工作台 UI
│   └── server/       # Fastify API + SSE Agent Run
├── packages/
│   ├── core/         # Agent Runtime / Agent Loop / Context Builder / 事件
│   ├── providers/    # LLM Provider 接口 + Registry + OpenAI Compatible
│   ├── workspace/    # Workspace Manager / FileManager(安全路径)
│   ├── tools/        # Tool 接口 + Registry + list/read/write/delete_file
│   ├── database/     # Drizzle schema（workspaces/sessions/messages/settings）
│   └── shared/       # 共享类型与工具（AppError/Session/Message/randomId）
├── data/             # svh.db + workspaces/（项目事实来源）
└── scripts/          # mock-llm.mjs（开发用 Mock LLM）
```

依赖方向：`shared ← database ← workspace/providers/tools ← core ← server ← web`

## 快速开始

```bash
# 1. 安装依赖
pnpm install

# 2. 配置环境
cp .env.example .env
# 编辑 .env：至少配置 SVH_LLM_BASE_URL / SVH_LLM_MODEL（API Key 可选）

# 3. 同时启动 Server + Web
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

## 核心概念

- **Workspace**：数据库存元数据，文件系统存项目产物。创建时自动生成 `svh.project.json` 与 `VIDEO_AGENTS.md`（Context Builder 自动读取，缺省回退默认 System Prompt）。
- **Agent Runtime**：输出统一事件流（`run.started / message.delta / tool.called / tool.completed / workspace.changed / run.completed / run.error`），通过 SSE 转发到浏览器。
- **Agent Loop**：LLM → Tool Call → 执行 Tool → 结果回传 → 再次调用 LLM，最多 20 轮（超出报 `Maximum tool iterations exceeded`，不会导致 Server 崩溃）。
- **文件安全**：所有文件读写限制在 Workspace Root 内（`resolveSafeWorkspacePath` 拒绝 `../` 逃逸）。
- **Context**：System Prompt + VIDEO_AGENTS.md + Workspace Summary + 最近 50 条消息 + 当前用户消息（V1 不做复杂压缩）。

## 常用命令

```bash
pnpm dev          # 启动 Server + Web
pnpm build        # 所有包独立编译（tsc 产物在各包 dist/，web 为 vite 构建）
pnpm typecheck    # 全包 TypeScript 检查
pnpm lint         # ESLint
pnpm format       # Prettier 写入
```

## API 摘要

- `POST/GET/DELETE /api/workspaces[/:id]` — Workspace
- `POST/GET /api/workspaces/:workspaceId/sessions`、`GET/PATCH/DELETE /api/sessions/:id`、`GET /api/sessions/:id/messages` — Session & 消息
- `POST /api/sessions/:id/run`（SSE）— Agent Run
- `GET/PUT/PATCH` 文件：`/api/workspaces/:id/files[...]` — 浏览/读取/写入/删除
- `GET/PUT /api/settings` — 模型设置（ApiKey 掩码）

## 路线图（V2 预留）

媒体 Providers（图片/视频/声音生成）、FFmpeg 自动剪辑、Timeline 编辑器、视频预览、Skills、Plugins、Context Compaction / Long Term Memory —— 均可在不修改 Core 的前提下扩展（Providers / Tools / Workspace 接口已预留）。
