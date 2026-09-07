# AI 短剧生产系统使用指南（V0.2）

本文档面向 SVH V0.2 的生产系统使用者与二开者，覆盖：模型配置、角色对话、Chat→Workflow 自动串联、制作中心、工作流操作与图片 / 视频生成。

## 1. 总览

```text
对话（制作导演 Director）
  → 创建生产项目 ──(自动串联)──→ 生产工作流（剧本 → 角色 / 场景 → 分镜）
                                      │
制作中心 #/production ←───────────────┘
  项目详情：剧本 / 角色 / 场景 / 分镜 / 镜头 / 资产 六面板 + 工作流面板
  资产生成：文生图（OpenAI 兼容 / DashScope 原生路由）· 文生视频（DashScope 异步任务）
```

设计原则：生产系统是在既有 Agent Harness（Runtime / Session / Workspace / Tool / Provider Registry）之上的**增量扩展**，Agent Runtime 零改动。

## 2. 启动与模型配置

```bash
pnpm install
pnpm dev            # Server :3000 + Worker（无端口，消费任务队列）+ Web :5173
```

没有真实 API 时可用 Mock LLM 跑通对话与串联流程：

```bash
node scripts/mock-llm.mjs   # http://localhost:9999/v1
# Settings「模型设置」→ Base URL 填 http://localhost:9999/v1
# （mock 在请求携带 create_project 工具时扮演 Director，返回建项 tool call，便于验证自动串联）
```

生产流水线涉及三类模型，均在 Web 顶部「模型设置」中选择并保存（持久化于数据库，API Key 不返回前端）：

| 用途 | 类型        | 说明                                                                        |
| ---- | ----------- | --------------------------------------------------------------------------- |
| 对话 | text (LLM)  | OpenAI Compatible；驱动 Agent Run 与工作流节点执行                          |
| 图片 | image       | Volcengine Ark 等 OpenAI 兼容 `/images/generations`；**百炼走原生端点**（见下） |
| 视频 | video       | 异步任务式文生视频，V0.2 仅适配 **DashScope（百炼）**，需配置其 API Key      |

> **百炼（DashScope）图片模型说明**：DashScope **不提供** OpenAI 兼容的
> `/images/generations` 端点（实测 404）。其图片模型（`qwen-image` 通义千问图像 /
> `wanx2.1-t2i` 通义万相）由服务端自动路由到 DashScope **原生同步接口**
> `/api/v1/services/aigc/multimodal-generation/generation`；`size` 自动做 `1024x1024 → 1024*1024`
> 风格转换。百炼 Key 只需配一份（与视频共用），设置页「验证 Key」通过后即可在资产面板直接生成。

会员门控：工作流**管理与执行**接口（创建 / 列表 / 详情 / run / pause / resume / cancel / retry）要求订阅套餐包含 `workflow.automation` 功能位（免费用户会得到 403 `FEATURE_NOT_AVAILABLE`；事件流仅做登录 + 所有权校验）；管理员角色绕过门控。制作中心的数据类接口不受此限制。

## 3. 对话与 Agent 角色

聊天输入框底部提供「角色」下拉（与技能 / 模型并列）。角色 = 系统提示词 + 工具白名单，共用同一个 Agent Runtime：

| 角色 id     | 名称     | 职责与关键工具                                                        |
| ----------- | -------- | --------------------------------------------------------------------- |
| director    | 制作导演 | 需求 → 生产计划 → `create_project` → 规划工作流（禁图/视频工具）      |
| script      | 编剧     | 故事改编 → `create_script` / `update_script`（版本自动 +1）           |
| storyboard  | 分镜师   | 剧本 → `create_scene` / `create_storyboard` / `create_shot` 结构化数据 |

不选角色 = 通用助手（原有行为不变）。技能模式下角色选择器禁用（技能是独立执行路径）。

### Chat → Workflow 自动串联

**触发条件**（全部满足才执行）：

1. 使用「制作导演」角色；
2. 本次 Run 中 `create_project` 工具**成功**返回（得到项目 id）；
3. Run 正常结束（`run.completed`，非中断 / 非 `run.error`）。

**行为**：Run 结束后服务端自动为该项目创建默认生产工作流（用户本轮输入注入剧本节点 prompt）并立即启动，复用当前会话与模型配置——与在制作中心手动 Run 完全一致，节点产物会追加到当前会话消息流。

**边界**：

- 无 `workflow.automation` 权限（免费用户）→ 静默跳过（仅服务端日志），仍可手动到制作中心触发；
- 项目已有工作流 → 不重复创建（幂等）；
- 自动串联内部任何异常只记日志，**绝不影响用户已收到的对话回复**；
- 一次 Run 建多个项目时只对最后一个串联。

## 4. 制作中心（`#/production`）

- **项目列表**：创建 / 进入项目；显示类型（short_drama 等）、状态、目标时长与风格。
- **项目详情**六面板：
  - 剧本：标题 + 正文，内容变更版本自动 +1，可标记审核状态；
  - 角色：名称 / 描述 / 外貌 / 性格（外貌为结构化 JSON）；
  - 场景：名称 / 描述 / 时间地点 / 出场角色；
  - 分镜：时长 / 景别 / 运镜 / 画面描述 / 图像与视频提示词；
  - 镜头：分镜下拆分镜头（同一分镜镜头总时长 ≤ 分镜时长，领域层校验）；
  - 资产：按类型筛选（图片/视频/音频/文档/字幕/参考）、**一键生成图片 / 提交视频任务**、展示结果（远程 URL）、删除。
- 所有实体按 **工作区隔离**：跨用户访问他人项目一律 404（不泄漏存在性）。

### 工作流面板

默认生产 DAG（4 节点，拓扑排序执行）：

```text
script（生成剧本） → characters（提取角色） ┐
                     └→ storyboard（生成分镜，依赖 scenes + characters）
script → scenes（生成场景） ┘
```

操作：

- **Run**：选择执行会话（节点 = 带对应角色的 Agent Run，消息追加到该会话）；
- **暂停 / 恢复 / 取消**：暂停在节点边界生效；取消会级联取消未开始的下游节点；
- **节点重试**：工作流 `failed` 后仅可重试失败 / 被取消节点（含下游级联重置）；
- **实时状态**：`GET /api/workflows/:id/events`（SSE）推送节点级事件；未运行时返回快照。

节点角色映射：`script.generate` / `character.extract` → 编剧；`scene.generate` / `storyboard.generate` → 分镜师。

## 5. 图片 / 视频资产生成（入队 → worker 执行 → 任务条轮询）

制作中心「资产」面板内置生成区（图片 / 视频类型下显示）：输入描述 → 选择模型（默认取已启用列表首位，可换）→ 生成 → 任务条展示排队 / 进度 / 取消 → 完成后资产自动出现在网格。生成统一走 HTTP 路由 → `GenerationService` 入队（V0.2 无生成类 Agent 工具，Agent Profile 工具白名单明确不含生成）。

图片与视频生成统一走 `production_tasks` 即 SQLite 队列：server 只做输入校验与入队（即时返回任务视图，`status = queued`；**形状差异待 V0.3 统一**：图片包在 `{ task }` 中，视频返回任务视图本体），独立 `apps/worker` 进程原子 claim 任务、调用供应商并轮询，完成后回写终态并**自动入库资产**。任务有活跃 worker 执行期间不重复 claim；worker 崩溃 / 重启后由心跳超时回收、凭已持久化的 `providerTaskId` 续轮询——不丢任务。

### 错误语义（入队式）

- **配置类错误 → 入队时即时 400**，不生成任务：`prompt` 为空（视频场景 `prompt` 与 `imageUrl` 均为空）、无已启用的对应类型模型、所选供应商 **API Key 未配置**；
- **Provider 类错误 → 进入 `task.error`，不再有同步 502**：Key 失效、额度不足、请求超时、非 DashScope 视频模型的限制等，发生在 worker 执行期，`status` 置 `failed`，前端任务条展示原始错误与排查指引（凭证类错误指引到「模型设置」检查 API Key）；
- 通过 `GET /api/tasks/:id` 可复查任意任务终态与错误信息。

### 资产存储

资产仍保存**供应商远程 URL**（V0.2 不落本地文件服务器；DashScope URL **24 小时过期**，重要结果请及时下载转存）；图片返回 `b64_json` 时写入资产 `metadata.b64Json`。落库资产记录 `generation.providerId` / `model` / `prompt` / `taskId` 溯源信息。

### 任务 API

- `POST /api/projects/:id/assets/generate-image`（body：`{ prompt, modelName?, size? }`）→ `{ task }`；
- `POST /api/projects/:id/assets/generate-video`（body：`{ prompt, imageUrl?, modelName?, duration?, resolution? }`）→ **任务视图本体**（历史形状，与图片的 `{ task }` 包装不一致，V0.3 统一）；
- `GET /api/tasks/:id`：`{ id, kind, status, progress, outputUrl, error, providerId }`，`status` 走 `queued → running → completed | failed | cancelled`；
- `POST /api/tasks/:id/cancel`：排队 / 进行中 → `cancelled`（worker 会 best-effort 通知供应商取消，不落资产）；
- 参数约束（万相 2.1 系列，官方 API 实测/文档）：`duration` **固定 5 秒**（2.5/2.6 模型才支持 5/10 或 2-15）；`resolution` 官方要求 `宽*高` 具体值（如 `1280*720`），填档位写法 `480P/720P/1080P` 会被自动转换为 `832*480/1280*720/1920*1080`；
- 视频适配器仅支持 `providerId = dashscope`（百炼，`https://dashscope.aliyuncs.com/api/v1`），该限制在执行期报错（`task.error`）。

### 运行 worker

```bash
pnpm --filter @svh/worker dev     # tsx watch，开发模式
pnpm --filter @svh/worker start   # 独立进程运行
```

worker 的默认 `SVH_DATABASE_URL` 与 server **同语义**（相对路径按仓库根解析、绝对路径原样，`file:` 前缀兼容），默认即开箱指向同一个 `data/svh.db`，常规单库部署无需显式配置；多进程 / 多机部署时确保双方指向同一 DB 文件即可共享队列（可同时跑多个 worker，任务按 `workerId` 原子认领互不重复）。最终语义：server 与 worker 对 `SVH_DATABASE_URL`（默认值与显式相对值）一律按仓库根解析。

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `SVH_DATABASE_URL` | `./data/svh.db`（按仓库根解析） | 与 server 默认指向同一文件，无需对齐 cwd |
| `SVH_WORKER_ID` | `wkr-<pid>` | 认领者标识（日志与 `claimed_by` 列） |
| `SVH_WORKER_CONCURRENCY` | `2` | 单 worker 同时执行的任务上限 |
| `SVH_WORKER_TICK_MS` | `2000` | 主循环扫描 / 认领间隔 |
| `SVH_WORKER_POLL_MS` | `5000` | 供应商任务状态轮询间隔 |
| `SVH_WORKER_STALE_MS` | `60000` | `running` 心跳超时阈值，超过即被回收接管 |
| `SVH_WORKER_MAXWAIT_MS` | `900000` | 视频任务最长等待，超限置 `failed` 防僵尸轮询 |

> ⚠️ **成本提示**：多开 worker 时供应商调用总并发 = 各进程 `SVH_WORKER_CONCURRENCY` 之和，队列不设全局并发/费用护栏——按 API 额度规划 worker 数量。

## 6. REST API 摘要

```text
生产实体
  POST/GET /api/productions · GET/PATCH /api/productions/:id
  GET/POST /api/projects/:projectId/{scripts,characters,scenes,storyboards,shots}
  GET/PATCH /api/scripts/:id · PATCH /api/{characters,scenes,storyboards,shots}/:id
  GET /api/projects/:projectId/assets?type= · DELETE /api/assets/:id

生成
  POST /api/projects/:id/assets/generate-image
  POST /api/projects/:id/assets/generate-video
  GET  /api/tasks/:id · POST /api/tasks/:id/cancel

工作流（需 workflow.automation）
  POST/GET /api/projects/:projectId/workflows · GET /api/workflows/:id
  POST /api/workflows/:id/run        body: { sessionId }
  POST /api/workflows/:id/{pause,resume,cancel}
  POST /api/workflows/:id/nodes/:nodeId/retry
  GET  /api/workflows/:id/events     （SSE）

角色
  GET /api/agent/profiles
  POST /api/sessions/:id/run         body: { message, profileId? }（SSE）
```

## 7. 数据模型

7 张生产表（`packages/database/src/schema/production.ts`）：`production_projects / scripts / characters / scenes / storyboards / shots / assets`，均含 `workspace_id + user_id` 双归属列与 JSON 列（模式 `"json"`）；工作流表 `workflows / workflow_nodes`（节点含 `sort_order` 保证同毫秒时间戳下的稳定排序）。

数据库首次启动回放 `INIT_SQL`（幂等 DDL）+ 种子数据**仅在对应表为空时播种**（管理员删除的种子行不会在重启后复活）。

## 8. 开发与测试

```bash
pnpm typecheck && pnpm lint && pnpm build

# 单元 / 集成测试（node:test，无测试框架依赖）
cd packages/database  && node --import tsx --test "test/**/*.test.ts"   # schema/迁移
cd packages/production && node --import tsx --test "test/**/*.test.ts"  # 领域规则 + Drizzle 仓储/队列
cd packages/core      && node --import tsx --test "test/**/*.test.ts"   # Workflow 状态机 + Profile
cd packages/providers && node --import tsx --test "test/**/*.test.ts"   # Image/Video Provider + 轮询
cd apps/server        && node --import tsx --test "src/**/*.test.ts"    # 路由/服务/glue（含入队语义）
cd apps/worker        && node --import tsx --test "test/**/*.test.ts"   # 队列核心：原子 claim / 心跳 / stale 回收
```

关键分层：`packages/production` 为领域包（含 `DrizzleProductionRepository`，供 server 与 worker 共用）；HTTP 路由与工作流编排在 `apps/server`；`apps/worker` 为独立的生成任务队列执行进程（claim / 心跳 / 供应商轮询 / 资产落库）；Image / Video Provider 在 `packages/providers`；生产工具在 `packages/tools`（Agent 可调用，经 ToolRegistry 注册）。

V0.3 方向（未实现）：音频 / TTS、FFmpeg 剪辑合成、Timeline 编辑器。
