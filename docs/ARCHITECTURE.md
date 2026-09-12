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
├── database/   Prisma Schema + Client 单例 + 任务运行时仓储 + 资产写入入口
├── workflow/   四套内置工作流定义（纯数据，零 DB 依赖）
├── skills/     技能目录 + 注册表 + 执行引擎 + 15 个技能实现
├── model/      Model Router：选模 / 重试 / 降级 + Mock Provider
└── queue/      BullMQ 资源池封装：确定性 jobId、领域层重试、优雅关闭

apps/
├── api/        Fastify HTTP 服务：一域一插件
└── worker/     任务消费者 + 对账循环
```

**依赖方向（严格单向，无环）**：

```text
config ──► （无内部依赖）
domain ──► （仅依赖 zod）
  ▲
  ├── model ──► domain
  ├── workflow ──► domain（skills 仅测试期）
  ├── skills ──► domain, model（仅 import type）
  ├── queue ──► domain, config
  ├── database ──► domain, model, workflow, skills, config
  ├── api ──► database, workflow, skills, config, queue
  └── worker ──► 全部
```

依赖必须保持**无环**。曾经出现过一次 `database ⇄ skills` 的环
（database 的 seed 需要技能目录，而 skills 的测试声明了 database 依赖），
被 `turbo run typecheck` 直接拦下。修复方式是删除 skills 侧那个**实际未被使用**的
依赖声明 —— 循环依赖往往来自遗留的声明而非真实需求。

约束：

1. `domain` **不得**依赖 Prisma / Fastify / Redis —— 它是三方共用的纯领域层。
2. `workflow` 只含 DAG 数据与图算法，**不依赖数据库**。
3. `skills` 不含执行实现，只声明能力；执行链路（Skill Registry + Worker + Model Router）属于 Phase 2/3。
4. 每个包都具备 `build` / `typecheck` / `test` / `lint` 四个 script，CI 里不出现逐包硬编码。

### 关于 `main` / `exports` 与 `dist` 的定位

包的 `main` / `types` / `exports` **指向 `src/*.ts`**，这是刻意的：

- API 与 Worker 通过 `tsx` 运行，前端由 Vite 直接消费 TS 源码，因此开发期**零构建**，改一行代码立刻生效
- `build` 任务（`tsc -p tsconfig.build.json`）的职责是**验证产物可编译**并产出结构正确的 `dist/`
- 未来需要发布或容器化时，只需把 `exports` 改指 `dist/index.js`，产物已经就位

配套约定：`typecheck` 用的 `tsconfig.json` **包含 `test/`**（测试也要查类型），而 `build` 用的 `tsconfig.build.json` **排除 `test/`**。两者若不分开，`tsc` 会把 `rootDir` 推断到包根，产物结构变成 `dist/src/**` 而不是 `dist/**`，并把测试代码一并编译进发布产物。

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
| 广告 | 13 | 10 | 产品视觉与创意链路并行准备 |
| 短视频 | 10 | 7 | 脚本与素材并行，在镜头节点汇聚 |
| 短剧 | 16 | 11 | **角色与场景同层可并行**（第 45 条明确要求）；剧本→分镜→画面严格串行 |
| 数字人 | 10 | 6 | 形象 / 文案 / 声音 / 背景四方并行，在合成节点汇聚 |

> 上表数据由 `topologicalLayers()` 实测得出，并有测试断言，不是估算。

约定：

- `edges` 由 `dependsOn` **自动派生**，避免手写两份漂移（有测试断言二者一致）
- 节点 `skill` 字段引用的技能必须存在于 `@svh/skills` 目录（有测试断言）
- `highCost: true` 严格等价于「执行到这里会请求用户确认」，因此其技能必须是 `risk: high`（有测试断言）

---

## 6. Phase 2 交付：Skill 执行链路与任务运行时

Phase 2 把「技能声明」变成了「可执行的受控任务」。核心是四块：

### 执行链路

```text
POST /api/skills/:id/execute   → 202 + taskId（不阻塞）
        ↓
agent_tasks (pending) + BullMQ 入队（确定性 jobId）
        ↓
Worker: CAS 抢占租约 → 心跳续约 → SkillExecutor 执行
        ↓
skill 实现 → ctx.deps.models / ctx.deps.assets（端口注入）
        ↓
Fencing 写入 success/failed/waiting_user + attempt 审计
```

### 已实现的 15 个技能

| 类别 | 技能 |
| --- | --- |
| 基础（文档第 20 条） | `text.generate` `script.generate` `image.generate` `image.edit` `video.generate` `video.extend` `audio.generate` `voice.generate` `subtitle.generate` `edit.video` `asset.create` `asset.update` |
| 流程通用 | `requirement.analyze` `edit.brand_overlay` `output.publish` |

其余 28 个（`advertisement.*` / `short_video.*` / `drama.*` / `digital_human.*`）
已在目录中声明但**执行时明确报「正在开发中」**，而不是静默返回空结果 ——
这类业务编排需要「一稿多图 + 角色一致性」，属于 Phase 8。

### 关键实现决策

**① Skill 通过端口注入依赖，不直接访问数据库**

`SkillDeps` 提供 `models` / `assets` / `contents` / `projects` 四个窄接口。
好处是技能可以脱离数据库做单测，且换持久化方案时无需改技能代码。
`@svh/skills` 对 `@svh/model` 只有 `import type`，运行时不绑定实现。

**② 进度上报自动携带 Fencing 令牌**

执行器在装配上下文时，把模型端口包装为「已绑定 taskId」的版本。
这样 15 个技能实现**一行都不用改**就获得了成本归因能力
（`model_tasks.taskId` 是关联键）。

**③ 确认闸门分静态与动态两层**

- **静态**：`definition.requiresConfirmation`（如 `video.generate` 天然高成本）
- **动态**：`implementation.isHighRisk(input)`（按本次规模判断）

动态判定的存在理由：生成 1 张图是常规操作，一次生成 20 张才需要确认。
静态标记无法表达这种差异，而技能实现看得到归一化后的具体入参。
目前 `image.generate` 用 `count > 1` 触发确认。

**④ 两层重试的分工必须分清**

| 层 | 位置 | 处理什么 |
| --- | --- | --- |
| 模型层 | `ModelRouter` | 同模型内退避重试 + 切换备用模型，对领域层透明 |
| 领域层 | `TaskRunner` | 模型层全部失败后，把任务置回 pending 并延迟重新入队 |

推论：**用 `failFirstN` 测不出领域层重试** —— 那点抖动会被模型层自己消化掉，
任务第一次尝试就成功了。这是两层分工正确的表现，测试里已明确记录这一点。

**⑤ `edit.video` 产出真实可用的 EDL 而非占位**

本阶段不引入 FFmpeg（重量级系统依赖，且当前要验证的是任务链路而非编码性能）。
但剪辑技能产出的是**真实的剪辑决策数据**：每个片段的入出点、时间轴位置、
转场方式、音轨、字幕轨。Timeline（第 37 条）直接消费它，
后续接入渲染器时只需把 EDL 喂进去，数据结构不用重做。

**⑥ 对账循环兜住进程崩溃**

Worker 可能被 kill -9 或容器驱逐，任务会停在 running 且租约永不释放。
对账循环每分钟扫描租约过期且仍 running 的任务，重置为 pending 并重新入队；
启动时也会立刻对账一次，处理上次遗留的僵尸任务。

---

## 6.5 Phase 3 交付：真实 Provider 接入

Phase 2 已把 Model Router 的选模 / 重试 / 降级逻辑做好，Phase 3 补齐**协议适配器**
与 **BYOK 配置管理**，使系统可以真正调用用户的模型 API。

### 三个适配器与它们的协议差异

| 适配器 | 覆盖范围 | 关键协议差异 |
| --- | --- | --- |
| OpenAI 兼容 | OpenAI / Azure / vLLM / Ollama / 国内厂商 | 默认协议；`response_format: json_schema` 且 strict 要求 `required` 覆盖全部字段 |
| Anthropic | Claude 系列 | `x-api-key` + `anthropic-version` 头；系统提示词在顶层；**结构化输出必须用 Tool Calling**（无 `response_format`） |
| Gemini | Gemini / Imagen / Veo | 模型名在**路径**里；`contents[].parts[]`；参数嵌在 `generationConfig`；`responseSchema` 只接受 OpenAPI 子集 |

把「OpenAI 兼容」当万能协议是行不通的：图片 / 视频 / 音频各家的路径与报文差异很大。
因此适配器通过 `provider.config` 支持**端点覆盖与字段映射**，
而不是把厂商差异硬编码进代码：

```jsonc
{
  "routes": { "image": "/v1/images/text2image" },   // 覆盖端点
  "imageSizeMode": "width_height",                  // size 还是 width/height
  "asyncRoutes": {                                  // 视频等长任务
    "submit": "/video/submit",
    "poll": "/video/tasks/{id}"
  },
  "taskIdPath": "data.task_id",                     // 任务 id 在响应中的位置
  "statusPath": "data.status",
  "successValues": ["SUCCESS"]
}
```

### 错误映射决定用户体验

HTTP 状态码到领域错误的映射不是形式主义，它直接决定了**用户看到什么**与
**是否值得重试**：

| 状态 | 领域错误 | 可重试 | 用户看到 |
| --- | --- | --- | --- |
| 401 / 403 | `PROVIDER_UNAVAILABLE` | ❌ | 「API Key 无效或权限不足」+ 去检查配置 |
| 404 | `PROVIDER_UNAVAILABLE` | ❌ | 「配置的模型名称不存在」 |
| 429 | `PROVIDER_UNAVAILABLE` | ✅ | 「调用过于频繁，请稍后再试」 |
| 5xx | `PROVIDER_UNAVAILABLE` | ✅ | 「模型服务暂时不可用」 |
| 400 + 内容策略 | `MODEL_CONTENT_REJECTED` | ❌ | 「未通过安全校验，请调整描述」 |

最后一行值得注意：内容拦截走 400，但**不能当成普通参数错误**。
同样的提示词重试多少次都会被拒，因此必须标为不可重试，
并引导用户改描述——而不是让用户以为等服务恢复就好。

### 健康状态与自动降级

- **主动探活**：保存配置时立即测试，用户当场知道配对没有
- **被动累计**：每次真实调用失败都累加 `failureCount`，达阈值后标记 `degraded` / `down`
- **成功即归零**：这是最容易漏的一点——不归零就再也回不到 healthy
- **凭据错误直接判死**：401/403 不是抖动，不必等阈值
- `down` 的 Provider 会被 Model Router 的候选排序直接排除，从而自动切换备用模型

### BYOK 配置的安全约束

**API Key 绝不出现在任何响应里**。这不是靠「记得排除」，而是靠结构保证：
所有查询都用 `select` 显式挑字段，并统一经过 `toProviderView` 转换，
该函数返回的对象里根本没有密钥字段。测试逐条断言了这一点。

配套细节：
- 写入时 AES-256-GCM 加密，密文带版本前缀（`v1:iv:tag:data`）便于将来轮换算法
- 掩码保留首尾（`sk-****abcd`），足以让用户确认「是不是这把钥匙」
- **测试未保存的配置用纯内存覆写**，不碰数据库——早期实现是「临时写库 + 回滚」，
  那样在并发下会让正在进行的真实调用短暂拿到错误的凭据

### 配置热更新

用户在设置里改完配置后，正在运行的 Worker 应当自动生效。
实现方式是轻量的**配置版本号**（Provider 数量 + 最近更新时间）：
Worker 每 30 秒比对一次，变了才重建 Model Router。
只影响之后新建的任务，正在执行的任务继续用旧依赖跑完 ——
中途换模型会让同一次生成的前后步骤风格不一致。

### 一次设计返工：移除「Mock / 真实」开关

早期用 `MODEL_PROVIDER_MODE=mock|real` 控制是否使用 Mock。
端到端验证时暴露了它的危险组合：**已配置真实 Provider + mode=mock**
会让真实配置被静默忽略，用户以为在用真实模型，实际拿到假数据。

改为**自动判定**：数据库里有可用的真实模型就用真实的，一个都没有才回落 Mock
（并记录警告）。行为更可预测，也不会出现「配置了却不生效」。

---

## 6.8 Phase 4 交付：Creative Agent

前面三个阶段建好了能力底座（数据模型、技能执行、真实模型接入），
Phase 4 让自然语言真正能驱动它们。

### 链路

```text
用户消息
  → IntentAnalyzer    意图分类 + 内容类型识别 + 参数提取
  → ContextResolver   按任务最小化装配上下文（含 token 预算）
  → WorkflowPlanner   基于内置模板动态调整，或从零规划轻量流程
  → PromptCompiler    分层编译（硬约束 → 任务 → 用户原始表述）
  → AgentRuntime      多步工具循环（模型决策 → 工具执行 → 结果回喂）
  → 回复 / 计划 / 确认请求
```

### 五个关键设计决策

**① 意图识别用「规则 + 模型」混合，规则在前**

纯模型方案有两个实际问题：「继续」「确认」这类指令语义极简单却要等一次模型往返；
而「第三个镜头改成夜景」要求精确的序号定位，模型经常给不出稳定结果。

因此规则先匹配高置信度模式（命中即零成本返回），未命中才交给模型。
实测效果：`继续` 类指令 0 延迟，`把第三个镜头改成夜景` 稳定定位到 Shot 03。

**② 序号解析必须支持中文数字**

`第3个` / `第三个` / `第十二集` 都要能解析。单字符映射只能处理个位数，
因此实现了按十位与个位组合的解析（`parseChineseNumber`）。

**③ 模型能判断「改哪里」却常漏「第几个」**

实测发现模型经常给出 `targetKind: 'shot'` 但不给 `targetIndex`。
因此代码里有一条硬规则：**只要模型没给出有效序号，就必须再走一次规则补齐**。
这个补齐逻辑直接决定了「只重新生成 Shot 03」能否实现（技术文档第 91 条验收）。

**④ 上下文按预算裁剪，且绝不裁掉用户明确引用的东西**

`ContextResolver` 按优先级加载：@引用资产 → 关联内容 → 项目记忆 → 最近对话 → 资产清单。
超预算时从低优先级开始裁（一次裁一半而不是逐条），
但 **@引用资产与关联内容永不裁剪** —— 它们是用户明确指向的，裁掉会让 Agent 答非所问。
裁剪动作会记进 `notes`，而不是静默丢弃。

**⑤ 结构化输出而非原生 Function Calling**

三个 Provider 的工具调用协议各不相同。改用统一的结构化输出契约后，
一套 Schema 走通全部 Provider，且决策过程可被记录与回放。
代价是多一次文本解析，换来的是确定性。

### 三个真实缺陷（由测试与端到端验证暴露）

**缺陷一：异常时丢失已算出的结果**

模型不可用时，`runTurn` 的 catch 分支返回 `fallbackAnalysis`，
把「已识别为广告」覆盖成「未识别」。用户看到的是「我没理解你的意思」——
把「模型服务故障」误报成「听不懂用户」，掩盖了真实原因。

修正：`analysis` 与 `contextNotes` 提升到 try 之外声明，
异常时返回已经算出来的结果。

**缺陷二：引用缺失的告知被泛泛追问抢先**

用户 `@不存在的角色` 时，低置信度追问分支先返回，
用户看到的是「你想创作什么类型的内容」——完全答非所问。
修正：把「引用不存在」的检查提升到追问分支内部且优先判断。

**缺陷三：取消信号在早期阶段未检查**

用户取消后，`runTurn` 仍会走完意图分析与内容创建。
早期实现只在工具循环里检查取消。
修正：在轮次最开始就检查，取消后不发起任何模型调用或写入。

### 工具的取舍

Agent 通过 8 个工具操作项目：`project.get` / `asset.search` / `asset.create` /
`content.create` / `content.get` / `skill.list` / `skill.execute` / `memory.update`。

关键约束：**`asset.create` 与 `skill.execute` 都走任务链路**，
而不是直接写数据库。这样它们同样享有幂等、重试、版本与审计能力，
不会形成一条绕过状态机的旁路。

`skill.execute` 遇到高风险技能时**不直接入队**，而是转为 `confirmation_request` ——
未确认前绝不消耗额度。

---

## 7. 本阶段交付边界

**已完成（Phase 0 ~ Phase 4）**

- Phase 0：两份代码审计报告（见 `docs/ARCHITECTURE_AUDIT_*.md`）
- Monorepo 骨架、tsconfig 基线、Turbo 流水线
- 核心领域层：枚举、Schema、类型、图算法、错误体系、传输契约
- 全量数据模型 + 迁移 + 种子数据
- 环境配置校验（fail-fast + 弱默认值黑名单）
- 四套内置工作流定义 + 43 个技能目录
- Fastify API 骨架：健康检查、项目 / 内容 / 资产 / 技能 / 工作流 / 任务路由
- Phase 2：Skill 注册表与执行引擎、Model Router、BullMQ 资源池队列、
  Worker 进程与对账循环、任务运行时仓储
- Phase 3：OpenAI 兼容 / Anthropic / Gemini 三个真实适配器、
  Provider 与 Model 的完整 CRUD、API Key 加密存储与掩码返回、
  主动探活与失败自动降级、配置热更新
- Phase 4：Creative Agent（意图分析、上下文解析与预算、流程规划、
  Prompt 编译、8 个工具的多步调用循环）、Agent 对话 API 与确认回执
- 394 个单元与集成测试（`config` 25 / `domain` 57 / `database` 23 / `workflow` 35 /
  `skills` 20 / `model` 56 / `queue` 14 / `agent` 55 / `api` 68 / `worker` 41）

**尚未实现（后续阶段）**

| 能力 | 计划阶段 |
| --- | --- |
| Agent UI | Phase 5 |
| SSE 实时推送 | Phase 5（协议已定义） |
| Creative Canvas | Phase 7 |
| Timeline | Phase 7 |
| 多平台输出适配（`output.publish` 已做规格校验，缺实际转码） | P4 |

**刻意的「未实现」表达方式**：`POST /api/skills/:id/execute` 在功能未接通时返回 **501 并说明当前阶段**，而不是返回一个看似成功却什么都没做的响应。高成本技能即使功能未就绪也先走「需要确认」的领域语义，以保护用户额度。

---

## 8. 后续阶段的架构准备

本阶段为后续阶段预埋的接口：

- `Skill` / `SkillContext` / `SkillResult` 接口已在 `@svh/domain` 定义，Phase 2 只需实现注册表与执行器
- `ModelRoutingPolicy` / `ModelInvokeRequest` / `ModelInvokeResult` 已定义，含降级链路记录（`attempts` 数组），Phase 3 已按此实现三个真实适配器
- `model_providers.apiKeyEncrypted` + `apiKeyMask` 已就位，`ModelProviderView` 明确**不含密钥字段**，BYOK 接入不会泄漏凭据
- SSE 事件协议（`SSE_EVENT_TYPES` / `SseEnvelope`）已定义，含 `seq` 断点续传语义
- `SseEnvelope.sessionId` 为强制字段，服务端必须按会话过滤——这是防止跨用户事件泄漏的结构性保障

---

## 9. 已知限制

1. `prisma/schema.prisma` 中的枚举需手工与 `domain/enums.ts` 保持一致，靠测试守护而非编译器。升级到 Prisma 7 后可改为直接 `import`，届时删除该测试。
2. 数据库列命名使用 camelCase（Prisma 默认），需在查询时加引号。此选择优先保证「领域语言 ↔ 数据库语言」一致性，降低心智负担。
3. 尚无认证与鉴权。技术文档第 68 条要求的「默认拒绝 + 显式放行」模型将在引入用户体系时一并实现。
4. Redis 健康检查使用原生 TCP（避免为探针引入完整客户端），仅验证连通性，不验证 BullMQ 队列状态。
6. **`edit.video` 不做实际转码**：产出 EDL 而非成片文件，需要接入 FFmpeg 渲染器
   才能拿到可播放的视频。
7. **`output.publish` 只做规格校验**：会检查时长、画幅、字幕是否满足平台要求
   并给出提示，但不执行转码与上传。
8. **SSE 实时推送未实现**：前端目前需轮询 `/api/tasks/:id/progress`。
   事件协议已在 `@svh/domain/transport.ts` 定义好，Phase 5 接入。
9. **确认回执已闭环**：`POST /api/agent/sessions/:id/confirm` 会把等待确认的任务
   重新入队执行。但仍缺少 Agent UI 层面的确认交互（Phase 5）。
10. **媒体生成端点依赖用户配置**：视频 / 音频 / 数字人的接口在各家差异极大，
    没有通用协议。适配器提供 `config.routes` / `config.asyncRoutes` 覆盖能力，
    但用户需要按自己的服务填写；未配置时会得到明确的「需要配置」提示，
    而不是发出必然失败的请求。
11. **Anthropic 与 Gemini 不提供图片 / 视频生成**：遇到这类能力请求时适配器
    明确报错并建议改用其它协议的模型，不发出必然 404 的请求。
12. **流式输出（SSE）未接入**：适配器目前只支持一次性返回。
    `ModelInvokeResult` 与传输契约已预留位置，但 `supportsStreaming` 尚未被利用。
