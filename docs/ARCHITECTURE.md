# SVH V0.1 架构说明

> 本文档记录 **Phase 0（代码审计）+ Phase 1（核心数据模型与项目骨架）** 的实际交付内容、
> 关键技术决策及其理由。技术需求以《SVH V0.1 AI Content Agent 技术实施文档》为准，
> 本文档说明的是「我们如何实现它，以及为什么这样做」。

---

## 1. 技术栈与选型理由

| 层面 | 选型 | 理由 |
| --- | --- | --- |
| 语言 | TypeScript 5.9（**纯 ESM**） | 与 Prisma / Zod / Fastify 生态一致；ESM 是 Node 24 的原生形态 |
| 包管理 | pnpm 9 + workspaces | monorepo 标配，硬链接节省空间，依赖隔离严格 |
| 任务编排 | Turborepo | 增量构建与缓存，`turbo run typecheck test lint` 一次覆盖全仓 |
| HTTP 框架 | Fastify 5 | 相比 Express 有原生 Schema 校验、结构化日志、插件隔离；相比 NestJS 更轻，适合以「域插件」组织 |
| 数据层 | Prisma 6 + PostgreSQL | 类型安全、迁移可版本化；PostgreSQL 的 `jsonb` 与数组类型契合「类型化 metadata」设计 |
| 校验 | Zod 3 | 一份 Schema 同时驱动编译期类型与运行时校验 |
| 队列 | BullMQ + Redis | 与 AI 长任务场景契合（延迟、重试、进度、并发控制） |
| 前端 | React + Vite | Vite 冷启动快，适合画布 / 时间线这类重交互页面 |

### 明确排除的方案

- **不引入 NestJS**：SVH 的域边界用「一个域一个 Fastify 插件」即可表达，装饰器与 DI 容器会显著增加心智负担。
- **不做 ESM + CJS 双格式构建**：双格式会导致 `types` 指向错误的声明文件、字段声明不一致、`require(esm)` 的版本依赖脆弱性。本仓库统一纯 ESM，构建只出 ESM。
- **不为了 V0.1 新增基础设施**：复用本机已有的 PostgreSQL 与 Redis，不额外引入 RabbitMQ、Kafka、MinIO。

---

## 2. 包结构与依赖方向

```text
packages/
├── domain/     核心领域层：枚举、Zod Schema、类型、纯函数图算法、错误体系
├── config/     环境配置：Zod 校验 + fail-fast + 弱默认值黑名单
├── database/   Prisma Schema + Client 单例 + 仓储辅助
├── workflow/   四套内置工作流定义（纯数据，零 DB 依赖）
└── skills/     内置 Skill 目录（声明式元数据，不含执行实现）

apps/
└── api/        Fastify HTTP 服务：一域一插件
```

**依赖方向（严格单向，无环）**：

```text
config ──► （无内部依赖）
domain ──► （仅依赖 zod）
  ▲
  ├── workflow ──► skills（仅测试期）
  ├── skills
  ├── database
  └── api ──► database, workflow, skills, config
```

约束：

1. `domain` **不得**依赖 Prisma / Fastify / Redis —— 它是三方共用的纯领域层。
2. `workflow` 只含 DAG 数据与图算法，**不依赖数据库**。
3. `skills` 不含执行实现，只声明能力；执行链路（Skill Registry + Worker + Model Router）属于 Phase 2/3。
4. 每个包都具备 `build` / `typecheck` / `test` / `lint` 四个 script，CI 里不出现逐包硬编码。

---

## 3. 关键设计决策

### 3.1 枚举单一事实来源 + 漂移测试

**问题**：Prisma 6 的 schema 解析器不支持 `import` TypeScript 枚举（该能力需 Prisma 7）。若在 schema 里手写一遍枚举，就存在与领域类型漂移的风险。

**决策**：

- 枚举取值在 `packages/domain/src/enums.ts` 用 `as const` 数组定义，是唯一事实来源
- Prisma schema 内手写同名枚举
- **用单元测试强制两者一致**：`packages/database/test/enum-drift.test.ts` 逐个比对 21 个枚举

任何一侧新增或删除取值，测试立即失败并精确指出差异。这把「不可自动化的约束」转化成了「编译/测试期可发现的错误」。

枚举命名使用下划线而非点号（`ai_llm` 而非 `ai.llm`），因为 Prisma 枚举值不允许包含 `.`，统一之后漂移测试可以做简单的等值比对。

### 3.2 任务运行时契约（来自 Phase 0 审计）

参考项目 `aiVideo` 的任务系统存在若干值得继承的设计与若干必须规避的坑，结论已固化为 `packages/domain/src/task-runtime.ts` 的代码约束：

| 决策 | 内容 | 理由 |
| --- | --- | --- |
| **领域层重试** | BullMQ `attempts` 恒为 1，重试由领域层控制 | 只有这样才能在重试前**切换模型**，并让重试计数与状态回写**在同一事务内**提交 |
| **幂等三件套** | DB 唯一键 `@@unique([projectId, idempotencyKey])` + 确定性 `jobId` (`task-{id}-attempt-{n}`) + CAS 闸门 | 三层叠加才能同时防住「用户重复点击」「事件重放」「多 Worker 竞争」 |
| **Fencing** | `task_leases` 表存 `leaseUntil` / `leaseVersion` / `workerId` / `heartbeatAt`；终态写入必须带令牌做 CAS | 防止失去租约的旧 Worker 覆盖新 Worker 的结果 |
| **执行尝试审计** | `task_attempts` 表按 `(taskId, attempt)` 记录模型、耗时、错误、用量 | 成本归因与失败分析的数据基础 |
| **资源池分队列** | `ai_llm` / `ai_image` / `ai_video` / `ai_audio` / `ai_digital_human` / `ai_render` / `asset` | 避免数分钟级的视频任务饿死秒级的文本任务 |
| **状态机白名单** | `TASK_TRANSITIONS` 用 `satisfies` 约束，新增状态忘补转移规则即编译错误 | 状态机必须是代码而非文档 |
| **避免上帝表** | 租约与尝试记录拆成独立表，不塞进 `agent_tasks` | 35+ 列的 Task 表难以维护 |

`task_leases` 与 `task_attempts` 已在本阶段建表（Phase 1），执行逻辑在 Phase 9。

### 3.3 API 传输层：不使用统一包装

**问题**：常见的 `HTTP 200 + {code, data, message}` 包装会让 SSE、流式响应与 RESTful 语义三者无法统一。

**决策**（见 `packages/domain/src/transport.ts`）：

- **成功**：直接返回资源，用 HTTP 状态码表达语义（200 / 201 / 204）
- **失败**：4xx/5xx + `{ error: { code, message, suggestions, retryable }, requestId }`
- **列表**：`{ items, total, page, pageSize, hasMore }`
- **实时推送**：独立的 SSE 事件协议（`SseEnvelope`，含会话内单调递增 `seq`）

因此代码中**刻意不存在**统一的 `ApiResponse<T>` 类型。

### 3.4 错误体系：技术信息与用户信息分离

**问题**：技术文档第 66 条禁止向用户暴露 `500 Internal Server Error` / `AxiosError` / `ProviderError`。

**决策**：每个 `SvhError` 携带两份信息。

```ts
error.toUserResponse()  // { code, message, suggestions, retryable } → 客户端
error.toLogObject()     // { code, message, context, details }      → 日志
```

- 用户文案中**禁止出现技术术语**（有测试断言这一点）
- 404 必须点明**什么不存在**（`resourceLabel`），而不是笼统的「没有找到对应的内容」
- `HTTP_STATUS_BY_CODE` 与 `USER_MESSAGE_BY_CODE` 都用 `satisfies Record<ErrorCode, ...>` 约束，新增错误码时若忘记补映射会编译失败

### 3.5 配置：fail-fast + 弱默认值黑名单

**问题**：参考项目全仓无 env 加载与校验机制，各处在代码里写 `process.env.X ?? '默认值'`。这直接导致一处真实的安全漏洞——密钥在两处以不同默认值回落，使生产安全校验失效。

**决策**（见 `packages/config`）：

1. 服务入口第一件事是 `bootstrapConfig()`：加载 `.env` → Zod 校验 → 失败即退出
2. **禁止**业务代码直接读 `process.env`，一律 `getEnv()`
3. 不只检查空值，还显式拒绝 `change-me` / `dev-only-` / `minioadmin` 等**弱默认值**
4. 一次性收集全部问题再抛错，避免「修一个报一个」

> 这个校验在本阶段就发挥了作用：`.env` 里残留的占位密钥被它拦下，强制换成 `openssl rand -hex 32` 生成的强随机值。

### 3.6 配置文件的单一事实来源

**问题**：Prisma 6 只会在「schema 所在目录」及其上一级查找 `.env`，而 SVH 是 monorepo，配置在仓库根目录。若为迁就 Prisma 在包内再放一份 `.env`，就会出现两份配置互相漂移。

**决策**：编写极薄的 `packages/database/scripts/prisma-env.mjs`，逐级向上查找唯一一份 `.env`，载入后再执行 Prisma CLI。同时保证**真实环境变量优先于 `.env`**（载入后还原已有值），使容器注入的配置不会被仓库文件覆盖。

### 3.7 优雅关闭

参考项目 API 侧完全没有 shutdown hooks，容器停止时会直接掐断在途请求。SVH 的关闭顺序（顺序本身重要）：

1. 停止接受新连接（`app.close()`），等待在途请求完成
2. 释放数据库连接池
3. 退出；超时（15s）则强制退出，避免容器卡在 stopping

### 3.8 领域模型：Content / Asset / Workflow 的通用性

技术文档第 78 条原则 3 要求「不要把短剧逻辑写死到核心架构」。本阶段的落实方式：

- **Content** 用 `type` + `metadata` + 绑定的 Workflow 表达类型差异，核心表不含任何短剧专属字段
- **左侧导航分区是声明式配置**（`CONTENT_SECTIONS`），不是散落的 `if (contentType === 'drama')`：

  | 内容类型 | 导航分区 |
  | --- | --- |
  | 广告 | 创意 / 产品 / 脚本 / 分镜 / 视频 / 成片 |
  | 短剧 | 剧本 / 角色 / 场景 / 分集 / 分镜 / 视频 |
  | 数字人 | 数字人 / 文案 / 声音 / 视频 / 成片 |

- **Asset System 统一一张表**，类型特有结构放在经校验的 `metadata` 中。判别联合 Schema 保证「角色的 appearance 是对象、道具的 appearance 是字符串」这类差异在写入时即被校验
- **Workflow 定义是数据而非代码**，可序列化、可持久化，因此 Agent 能动态规划出新流程（`origin: agent_planned`）

### 3.9 资产版本语义

- 创建资产即写入 v1，使版本历史从创建那一刻完整
- 变更采用**深合并**（`deepMerge`），保证「把发色改成红色」不会抹掉年龄、脸型等字段——这是 Agent 做局部修改的语义基础
- **恢复不是回滚**：恢复 v1 会形成 v3（内容等于 v1）。历史只增不改，用户恢复错了还能再恢复回去

---

## 4. 数据模型总览

共 20 张表，对应技术文档第 39 条：

| 分组 | 表 |
| --- | --- |
| 用户与项目 | `users`、`projects`、`project_members` |
| 内容 | `contents`、`content_versions` |
| 会话 | `sessions`、`messages` |
| 资产 | `assets`、`asset_versions`、`asset_references` |
| 技能 | `skills`、`skill_executions` |
| 工作流 | `workflows`、`workflow_runs` |
| 任务 | `agent_tasks`、`agent_task_steps`、`task_leases`、`task_attempts` |
| 模型 | `model_providers`、`models`、`model_tasks` |
| 输出 | `outputs` |

设计要点：

- **主键**用 `cuid()`，不暴露自增规模
- **资产 slug 项目内唯一**（如 `苏晚`），支持用户在输入框用 `@苏晚` 引用
- **JSON 字段都有明确的校验 Schema**（`projectMemorySchema`、`contentMetadataSchema`、`resolveAssetMetadata` 等），不是无约束的自由字段
- **软删除**用 `status` / `archivedAt` 表达，物理删除仅用于清理孤儿子行
- 需要保留历史的实体（资产、内容）都带版本表

---

## 5. 四套内置工作流

对应技术文档第 24~27 条，定义在 `packages/workflow/src/`。

| 流程 | 节点数 | 拓扑层数 | 关键并行设计 |
| --- | --- | --- | --- |
| 广告 | 13 | 9 | 产品视觉与创意链路并行准备 |
| 短视频 | 10 | 8 | 脚本与素材并行，在镜头节点汇聚 |
| 短剧 | 16 | 11 | **角色与场景同层可并行**（第 45 条明确要求）；剧本→分镜→画面严格串行 |
| 数字人 | 10 | 6 | 形象 / 文案 / 声音 / 背景四方并行，在合成节点汇聚 |

约定：

- `edges` 由 `dependsOn` **自动派生**，避免手写两份漂移（有测试断言二者一致）
- 节点 `skill` 字段引用的技能必须存在于 `@svh/skills` 目录（有测试断言）
- `highCost: true` 严格等价于「执行到这里会请求用户确认」，因此其技能必须是 `risk: high`（有测试断言）

---

## 6. 本阶段交付边界

**已完成（Phase 0 + Phase 1）**

- Phase 0：两份代码审计报告（见 `docs/ARCHITECTURE_AUDIT_*.md`）
- Monorepo 骨架、tsconfig 基线、Turbo 流水线
- 核心领域层：枚举、Schema、类型、图算法、错误体系、传输契约
- 全量数据模型 + 迁移 + 种子数据
- 环境配置校验（fail-fast + 弱默认值黑名单）
- 四套内置工作流定义 + 43 个技能目录
- Fastify API 骨架：健康检查、项目 / 内容 / 资产 / 技能 / 工作流路由
- 174 个单元与集成测试（`config` 25 / `domain` 57 / `database` 23 / `workflow` 30 / `skills` 10 / `api` 29）

**尚未实现（后续阶段）**

| 能力 | 计划阶段 |
| --- | --- |
| Skill Registry 与执行实现 | Phase 2 |
| Model Router 与 Provider 适配器 | Phase 3 |
| Creative Agent（Intent / Context / Planner / Tool Calling） | Phase 4 |
| Agent UI | Phase 5 |
| Worker 与 Task Queue 执行 | Phase 9 |
| SSE 实时推送 | Phase 5（协议已定义） |
| Creative Canvas | Phase 7 |
| Timeline | Phase 7 |
| 多平台输出适配 | P4 |

**刻意的「未实现」表达方式**：`POST /api/skills/:id/execute` 在功能未接通时返回 **501 并说明当前阶段**，而不是返回一个看似成功却什么都没做的响应。高成本技能即使功能未就绪也先走「需要确认」的领域语义，以保护用户额度。

---

## 7. 后续阶段的架构准备

本阶段为后续阶段预埋的接口：

- `Skill` / `SkillContext` / `SkillResult` 接口已在 `@svh/domain` 定义，Phase 2 只需实现注册表与执行器
- `ModelRoutingPolicy` / `ModelInvokeRequest` / `ModelInvokeResult` 已定义，含降级链路记录（`attempts` 数组），Phase 3 按此实现 Router
- `model_providers.apiKeyEncrypted` + `apiKeyMask` 已就位，`ModelProviderView` 明确**不含密钥字段**，BYOK 接入不会泄漏凭据
- SSE 事件协议（`SSE_EVENT_TYPES` / `SseEnvelope`）已定义，含 `seq` 断点续传语义
- `SseEnvelope.sessionId` 为强制字段，服务端必须按会话过滤——这是防止跨用户事件泄漏的结构性保障

---

## 8. 已知限制

1. `prisma/schema.prisma` 中的枚举需手工与 `domain/enums.ts` 保持一致，靠测试守护而非编译器。升级到 Prisma 7 后可改为直接 `import`，届时删除该测试。
2. 数据库列命名使用 camelCase（Prisma 默认），需在查询时加引号。此选择优先保证「领域语言 ↔ 数据库语言」一致性，降低心智负担。
3. 尚无认证与鉴权。技术文档第 68 条要求的「默认拒绝 + 显式放行」模型将在引入用户体系时一并实现。
4. Redis 健康检查使用原生 TCP（避免为探针引入完整客户端），仅验证连通性，不验证 BullMQ 队列状态。
