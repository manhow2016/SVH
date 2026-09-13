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
| 前端 | React 19 + Vite 8（`apps/web`） | Vite 冷启动快，适合画布 / 时间线这类重交互页面；样式用 CSS Modules + 自建 Token，不引组件库（理由与前端结构见 §6.10） |

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

对账**循环**的每一次状态写入都会广播（`task.status`）：重入队发 `pending`，
尝试次数耗尽判失败发 `failed`（终态，不广播就会让前端永久停在 running，
只能靠用户刷新）。判据与写库同源 —— 只有 CAS 真的命中才发，
与 runner 侧「只播本次执行确实拥有的发言权」是同一条纪律。

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

## 6.9 Phase 5A 交付：实时事件总线

`@svh/realtime` 是一条**会话级**的单向事件通道，把「任务推进」与「Agent 轮次」
的变化实时送到客户端，替代前端轮询。对外只有一个端点：

```text
GET /api/agent/sessions/:id/events      text/event-stream，支持 Last-Event-ID
```

### Key 约定

| Key | 类型 | 用途 |
| --- | --- | --- |
| `svh:events:session:<sessionId>` | Stream | 该会话的事件流；`XADD` 写入，`XRANGE` 补发，`XREAD BLOCK` 实时消费 |
| `svh:seq:<sessionId>` | String | 会话内序号计数器（`INCR`），产出 `SseEnvelope.seq` |

所有键以 `svh:` 开头，与 `@svh/queue` 的 BullMQ 前缀一致。
流有 `MAXLEN ~ 2000` 与 24 小时 TTL，避免长期不活跃的会话无限占用内存。

**为什么通道的粒度是「会话」而不是「项目」**：传输契约把 `sessionId` 定为
强制字段并要求服务端按会话过滤。以会话分键之后，跨会话泄漏在**结构上**
不可能发生，而不是依赖查询条件写对。

### 两种游标，用途不同

- `seq`（业务序号，存在 `svh:seq:*`）：会话内单调递增的整数，供前端排序与展示
- Stream ID（形如 `1757650000000-0`）：作为 SSE 的 `id:` 字段，供 `Last-Event-ID` 断点续传

### 为什么用 Stream 而不是 Pub/Sub

Redis Pub/Sub 没有历史，订阅者断线期间的事件**永久丢失**。Stream 让
「补发历史」与「接收实时」共用同一个游标：订阅器先 `XRANGE` 补齐
`(客户端游标, 当前]` 区间，再从这个游标转入 `XREAD BLOCK`。
两者之间不存在空窗，因此不会出现审计结论 ⑫ 描述的「重连后永久静默」。

建立连接时服务端先 `XADD` 一条 `session.ready` 作为**基准游标**：

- 客户端**没有**带 `Last-Event-ID`：ready 帧带上自己的 Stream ID，客户端从此处开始
- 客户端**带了**合法 `Last-Event-ID`：ready 帧**省略** `id:`，避免在补发到达前
  把客户端游标推到新基准，那样中间那段历史就永远取不回来了

心跳（`ping`）同样省略 `id:` —— 游标不应该被推进到一个非事件上。

### 事件类型与来源

事件类型只在 `packages/domain/src/transport.ts` 的 `SSE_EVENT_TYPES` 定义一次。

| 事件类型 | 发布点 | 触发时机 |
| --- | --- | --- |
| `session.ready` | `apps/api/src/routes/events.ts` | 每次 SSE 建连 |
| `ping` | `apps/api/src/routes/events.ts` | `XREAD` 空闲超时（15s），用于探测断线 |
| `agent.state` | `apps/api/src/routes/agent.ts` | 轮次开始（`thinking`）与轮次结束 |
| `agent.message` | `apps/api/src/routes/agent.ts` | 每轮 Agent 回复 |
| `agent.plan` / `agent.confirmation` | `apps/api/src/routes/agent.ts` | 由结构化载荷类型映射（`eventTypeForPayload`）；载荷为空时**不发**，避免出现 data 为 null 的重复 `agent.message` |
| `task.status`（`pending`） | `apps/api/src/routes/agent.ts` | 确认放行，`waiting_user` → `pending` |
| `task.status`（`cancelled`） | `apps/api/src/routes/tasks.ts` | 用户取消；这是 Worker 之外唯一的**终态**写入点 |
| `task.status` / `task.progress` / `asset.changed` | `apps/worker/src/runner.ts` | Worker 抢占、进度上报、成功 / 失败 / 退回排队 / 等待确认 |
| `task.status`（`pending` / `failed`） | `apps/worker/src/index.ts` | 对账循环：回收过期租约后重入队（`pending`）、尝试次数耗尽放弃（`failed`） |

**协议里有、但当前还没有发布点的事件类型**：`content.changed` 与
`workflow.advanced` 已在 `SSE_EVENT_TYPES` 中声明，但全仓没有任何调用点
（留给 Phase 6 / Phase 7）。`agent.result_card`、`error` 与 `task.progress`
虽然出现在 `apps/api/src/routes/agent.ts` 的 `eventTypeForPayload` 映射表里，
但 Agent 轮次当前只产出 `plan` 与 `confirmation_request` 两种载荷，
这三个分支今天都发不出来：`result_card` 载荷由 Skill 产出、随任务输出返回，
不经过 Agent 轮次；`task.progress` 的真实来源是 Worker（见上表最后一行）。
这份清单是「协议声明的类型」与「今天真的会发出的事件」的差集，
前端不应依赖最后一行之外的类型。

Worker 侧的广播有一条统一纪律：**只播本次执行确实拥有的发言权**。
进度与成功看仓储层返回的 `written`，等待确认看 `parked`，失败路径看
`failTask` 的 `written`。`written` 为假说明这次 CAS 什么都没改
（租约已被接管，或任务已被用户取消），此时广播必然与数据库不一致，
因此一律不播 —— 否则前端会永久停在一个数据库中并不存在的状态上。

### 约定：发布失败不影响业务

实时推送是**增强能力，不是业务前置条件**。因此：

- `publishSessionEvent` 契约上**从不抛异常**：发布失败返回 `null` 并记日志
- 连接**建立**阶段的失败（`getEnv()` 校验、连接串解析、ioredis 构造抛错）
  与发布阶段的失败一并兜住
- API 侧另加 500ms 硬上界（`PUBLISH_TIMEOUT_MS` 的 `Promise.race`），
  与连接实现无关；发布器内部的 `commandTimeout` 只管单条命令，三条串行
  叠加最坏约 1.5s，业务请求不能被事件推送拖住
- 发布是**同步 `await`** 的：事件在响应返回前就已落进 Stream，
  前端拿到响应时不会出现「先看到结果、后看到过程」的乱序

### 运维说明：发布器的 `commandTimeout` 与网络 RTT（部署前提）

`createEventPublisher` 给连接设了 `commandTimeout: 500`（`PUBLISH_COMMAND_TIMEOUT_MS`）。
用意是给「连接还在、但对端不回包」这类形态（TCP 半开、Redis 被 `STOP`、网络分区）
一个硬上界：没有它，`XADD` / `INCR` 的 `await` 会**无限期挂住**，
把发布路径连同它所在的业务请求一起拖死。

**取舍**：这个超时是**连接级**的，它同样罩住 ioredis 在握手阶段自己发出的就绪探测
（`INFO`）。因此 Redis 与 API / Worker 进程之间的 RTT 必须**显著小于 500ms**：

- RTT 正常（同机 / 同局域网，通常 < 1ms）：握手与发布都在超时内完成，无影响
- RTT 接近或超过 500ms（跨机房、跨地域、链路拥塞、经代理或隧道绕行）：
  `INFO` 超时 → 连接**永远进不了 `ready`** → `publish()` 一律返回 `null`。
  由于「发布失败不影响业务」是契约，API 依旧返回 200

**因此部署前提是：Redis 与应用同机（推荐）或同局域网部署。**
这不是靠重试能绕开的抖动 —— 成因是持续存在的链路时延，重试只会一直失败。

**症状**（实时功能整段消失，但业务侧看起来完全正常）：

- 前端只收到 `session.ready` 与 `ping`，拿不到任何 `task.status` / `agent.*` /
  `asset.changed`；任务本身照常执行，`GET /api/tasks/:id` 也照常给出最新状态
- `svh:events:session:*` 与 `svh:seq:*` 不再增长（在 Redis 里能直接看出来）
- 日志反复出现 `事件总线连接异常` / `事件发布失败（已忽略，不影响业务主流程）`，
  错误文案是 `Command timed out`

**排查方式**：

1. 量 RTT：`redis-cli -h <host> -p <port> --latency`（看 avg / max），
   或在应用所在主机上连续 `PING` 取往返时间
2. 与阈值对照：`max` 接近 `PUBLISH_COMMAND_TIMEOUT_MS`（500ms）即属于本节的
   失效形态；检查是否跨机房、是否有代理 / 隧道绕行、是否链路拥塞
3. 区分「RTT 太大」与「Redis 完全不可用」：后者日志是连接拒绝 / `ECONNREFUSED`，
   `GET /health` 的 Redis 探针也会失败；前者只有发布失败、健康检查照常
4. 处置：把 Redis 挪到与应用同机 / 同网段（首选）。确需跨机房时，
   把 `PUBLISH_COMMAND_TIMEOUT_MS` 与实测 RTT 一起评估后同步调大 ——
   代价是半开 TCP 下发布挂起更久（API 侧的 500ms `PUBLISH_TIMEOUT_MS` 硬上界
   只兜住请求响应时间，Worker 侧的发布是发射后不管，只受这个值约束）

订阅侧**不适用**这条取舍：`XREAD BLOCK` 的连接配了 `blockingTimeout`
（见 `packages/realtime/src/subscriber.ts`），对端不回包时有界返回并产出 `idle`，
不会永久挂住。

### 已知边界

1. **没有 `sessionId` 的任务不推送**。`POST /api/skills/:id/execute` 不传
   `sessionId`、或经其它入口创建的任务没有会话归属，事件无处可路由，
   发布被静默跳过（返回 `null`）。这类客户端需回退到轮询
   `GET /api/tasks/:id/progress`。
2. **需要外部服务时客户端回退轮询**。Redis 不可用、或部署形态不提供
   长连接（部分网关会缓冲 / 截断 `text/event-stream`）时，实时通道不可用，
   此时以 `GET /api/tasks/:id` 与 `GET /api/agent/sessions/:id` 为准。
3. **每个 SSE 连接占用一条 Redis 连接**。`XREAD BLOCK` 会独占连接，
   不能与发布器复用。单用户部署规模下可接受，高并发场景需要引入连接池
   或改为共享订阅分发。
4. **断线过久会丢历史**。`MAXLEN ~ 2000` 裁剪后，客户端游标可能已不在流中，
   此时只能拿到裁剪后仍存在的事件；`session.ready` 会带上当前游标，
   客户端可据此判断是否需要用 REST 全量拉取。

---

## 6.10 Phase 5B 交付：前端结构（Agent UI）

`apps/web` 是一个独立的 Vite 应用，通过 `/api` 相对路径访问 Fastify（开发期由
Vite 代理到 3030）。它**不复制任何领域逻辑**：意图分析、规划、确认 CAS、
任务执行都在后端，前端只做「把协议渲染成人能看懂的东西」与「把人的动作翻译成请求」。

### 技术选型

| 层面 | 选型 | 理由 |
| --- | --- | --- |
| 框架 | React 19 + `react-router-dom` 7 | 与仓库既有 TS/ESM 工具链一致；路由只需要三个页面，不需要框架级数据层 |
| 构建 | Vite 8（`tsc --noEmit` + `vite build`） | 冷启动快、配置少；构建脚本先跑类型检查，避免「能打包但类型是错的」 |
| 样式 | CSS Modules + `styles/tokens.css` 自建 Token | 样式随组件就近、类名自动隔离；Token 是**唯一**的颜色 / 字号 / 圆角 / 间距来源，由 `test/tokens.test.ts` 钉住（组件 CSS 里出现字面值即失败） |
| 状态 | 组件内 `useState` + 少量 `useRef` | 没有跨页面共享的客户端状态：真源是服务端（REST + SSE），引入 Redux/Zustand 只会多一份需要同步的副本 |
| 测试 | Vitest 5 + jsdom + Testing Library | 与仓库其它包同构；`test/setup.ts` 统一补齐 jsdom 缺失的 `matchMedia` 等 API |

**为什么不用 UI 组件库**（Ant Design / MUI / shadcn 等）：

1. **组件总量小**：12 个图标 + 10 个通用组件（按钮 / 输入 / 弹层 / 三态 / 进度 / 轻提示）。
   为这点体量引入一个几十万行的依赖，收益只剩「少写几个 div」。
2. **设计约束在 Token，而不在组件库**：规范禁止 emoji 图标、要求圆角与字号成体系、
   要求 Card 只用于有独立操作边界的对象。组件库的默认主题与这些约束**相反**，
   接入后第一件事就是逐个覆盖它的默认样式 —— 那时「省事」已经变成负债。
3. **组件库会把设计决策外包**：升级组件库等于被动接受别人对间距、焦点、动效的改动，
   而本项目的视觉一致性靠的是自己那份 Token 契约。

### SSE 客户端的三条判据

`lib/sse.ts` + `features/agent/useSessionStream.ts` 用三条**互相独立**的判据判断
「实时链路还靠得住吗」，缺一条就会出现「界面看起来正常但进度早就停了」：

| 判据 | 实现 | 覆盖的故障 |
| --- | --- | --- |
| 连接状态 | `StreamState`（`connecting` / `open` / `reconnecting` / `closed`） | 连接被明确关闭、建连失败（API 进程没了、网关重置） |
| 事件陈旧度 | `isEventStale()`：距最后一条**业务**事件超过 45 秒（`ping` 心跳不算） | **半开链路**：TCP 还在、对端不回包。此时连接状态一直是 `open`，只有心跳照常到达 |
| 建连超时 | 建连后在规定时间内没有收到 `session.ready` 即视为失败并进入退避重连 | **建连黑洞**：请求挂着不返回也不报错，`fetch` 永远不会 reject |

任一为真都会让 `degraded` 为真：顶部显示降级提示条（绝不静默），
任务面板同时回退到 3 秒轮询 `GET /api/tasks?sessionId=...`，
重连时带上 `Last-Event-ID` 由服务端补发缺口事件（§6.9）。
陈旧度必须是**拉取式**检查（`useSessionStream` 每 5 秒查一次）：
半开链路不会有任何事件来触发回调，没有这个定时器，这个信号永远不会浮上水面。

### 数据流：结果卡来自任务产出，而不是 Agent 轮次

对话流里的四类卡片（计划 / 确认 / 结果 / 错误）有两套**不同**的来源：

```
计划卡、确认卡、错误卡：Agent 轮次的 payload
  POST /api/agent/chat ─┐
                        ├─→ 响应体 payload ─────┐
  SSE agent.plan /      │                       ├─→ 对话流
  agent.confirmation /  └─→ 事件 payload ───────┘
  error / agent.message                    （两者是同一轮的副本，按指纹去重）

结果卡：任务的产出（task.output.card）
  Worker 执行技能成功 → 把 ResultCardPayload 写进 task.output.card
  SSE task.status(success) / asset.changed ─→ GET /api/tasks/:id ─→ 取 card ─→ 对话流
```

因此「结果卡」**不随 Agent 轮次返回**：一轮对话只能提交任务（异步），
卡片的标题、媒体与可执行动作要等 Worker 真正产出资产之后才存在（见
`packages/skills/src/implementations/generation-skills.ts` 的 `card` 字段）。
去重按 `taskId` 而不是消息内容：同一任务会被 `task.status` 与 `asset.changed`
指到两次，而卡片内容可能被后续版本改写，内容比对既不可靠也没必要。

### 已知缺口：结果卡不落会话消息

服务端只把 **Agent 轮次**的载荷落成会话消息，Worker 产出的卡没有任何落消息路径。
后果是：刷新页面后任务面板显示「已完成」，对话流里却找不到那张卡 ——
看上去就是 bug。彻底修复要后端补一条消息落库（不在本阶段范围），
当前用**加载后回捞**缓解：`load()` 在拉完历史消息后，按
`GET /api/tasks?sessionId=...&status=success` 取回该会话的终态任务，
串行拉详情、把 `output.card` 补进对话流末尾，并与实时链路共用同一套
`resultCardDone` / `resultCardLoading` 去重集合（同一 taskId 只会补出一张卡）。
代价与边界：

- 回捞窗口是最近 50 个成功任务（`BACKFILL_TASK_LIMIT`），更早的历史不补；
- 每张卡要多一次 `GET /api/tasks/:id`，因此串行执行，避免页面加载时打满后端；
- 回捞失败**不弹提示**：任务面板已经显示成功，为一张卡再报一次错会把成功说成失败；
  后续事件与下次刷新还会再试。

---

## 7. 本阶段交付边界

**已完成（Phase 0 ~ Phase 5B）**

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
- Phase 5A：`@svh/realtime` 事件总线（Redis Stream 发布器 / 订阅器，
  含补发与取消清理）、`GET /api/agent/sessions/:id/events` SSE 端点
  （`Last-Event-ID` 断点续传 + 会话隔离 + `ping` 心跳）、
  API 与 Worker 两侧的事件发布点接入、高风险技能改为创建真实
  `waiting_user` 任务
- Phase 5B：`apps/web`（React 19 + Vite）三个页面 —— 项目入口、Agent 工作台
  （对话流 / 五类载荷渲染 / 输入区 `/` 与 `@` 补全 / 实时任务面板 / 确认交互）、
  模型 Provider 配置页（密钥只写不读）；Design Token 与 10 个通用组件；
  SSE 客户端三条判据与断线降级提示 + 轮询回退；三档响应式（窄屏侧区折叠为抽屉）。
  结构见 §6.10。**注意**：UI 本身已交付，但旗舰链路（视频成片）被两个后端既有缺陷
  卡住、目前跑不通，见 §9 第 15 条与 §7 表中标注为「立即（缺陷）」的三项
- 732 个单元与集成测试（`config` 25 / `domain` 66 / `database` 23 /
  `workflow` 35 / `skills` 38 / `model` 56 / `queue` 14 / `agent` 58 /
  `api` 121 / `worker` 63 / `realtime` 40 / `web` 193）

**尚未实现（后续阶段）**

| 能力 | 计划阶段 |
| --- | --- |
| ~~修复技能 metadata 与 asset schema 的字段契约~~ | ✅ 已完成（§9 第 15 条，原估「2 个技能」实为 5 个） |
| 技能执行护栏：每个已实现技能真跑一遍（`packages/skills/test/skill-execution.test.ts`） | ✅ 已完成 |
| ~~广告计划卡的「开始制作」入口 / `requiresApproval` 判据口径~~ | ✅ 已完成（§9 第 15 条，入口与审批判据已解耦） |
| ~~未配置模型时工作台的显式提示 + Mock 回落警告落日志~~ | ✅ 已完成（§9 第 15 条） |
| ~~测试与开发期 Worker 的队列隔离~~ | ✅ 已完成（§9 第 16 条，`QUEUE_PREFIX` 可配） |
| `POST /api/tasks` 建高风险技能的出路（§9 第 17 条） | 建议尽快 |
| 会话历史分页加载（当前一次最多 200 条，见 §9 第 14 条） | Phase 6 |
| Creative Canvas | Phase 7 |
| Timeline | Phase 7 |
| 多平台输出适配（`output.publish` 已做规格校验，缺实际转码） | P4 |

**刻意的「未实现」表达方式**：`POST /api/skills/:id/execute` 对尚未接入实现的技能
**照常返回 202 并创建任务**（任务链路本身与实现是否就绪无关），随后由 Worker 失败该任务，
并把面向用户的文案写进 `errorMessage`：「『广告创意』的执行能力正在开发中，当前版本尚未接通。」
也就是说「未实现」通过任务终态 + 明确文案表达，而不是返回一个看似成功却什么都没做的响应，
也不是在入口处用一个技术性的状态码打发掉。高成本技能即使功能未就绪也先走
「需要确认」的领域语义，以保护用户额度。

**高风险技能确认链路已闭环**：`/confirm` 在**同一次** CAS 更新里写入批准凭据
`confirmedAt` 并把任务置回 `pending`，Worker 读到该字段即对本次执行放行；
生产默认策略仍是 `reject`，未确认的任务依旧停在 `waiting_user`。
两条边界（批准是任务级授权、`/retry` 不得绕过确认闸门）见 §9 第 9 条。

---

## 8. 后续阶段的架构准备

本阶段为后续阶段预埋的接口：

- `Skill` / `SkillContext` / `SkillResult` 接口已在 `@svh/domain` 定义，Phase 2 只需实现注册表与执行器
- `ModelRoutingPolicy` / `ModelInvokeRequest` / `ModelInvokeResult` 已定义，含降级链路记录（`attempts` 数组），Phase 3 已按此实现三个真实适配器
- `model_providers.apiKeyEncrypted` + `apiKeyMask` 已就位，`ModelProviderView` 明确**不含密钥字段**，BYOK 接入不会泄漏凭据
- SSE 事件协议（`SSE_EVENT_TYPES` / `SseEnvelope`）已在 Phase 4 定义，
  Phase 5A 已按此实现端点与事件源（见 §6.9）
- `SseEnvelope.sessionId` 为强制字段，服务端按会话过滤——这是防止跨用户事件泄漏的结构性保障
- Agent UI（Phase 5B）已按此消费 §6.9 的事件流：`session.ready` 提供基准游标，
  `agent.*` 提供对话与计划，`task.*` / `asset.changed` 触发任务面板刷新与结果卡回捞
  （见 §6.10）。这一层没有新增任何协议字段 —— 预埋的 `SseEnvelope` 契约足以支撑整套 UI

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
8. **SSE 已接入（Phase 5A）**：`GET /api/agent/sessions/:id/events` 基于 Redis Stream
   推送会话事件，支持 `Last-Event-ID` 断点续传；补发与实时订阅共用同一游标，
   不存在「重连后永久静默」的空窗。边界见 §6.9「已知边界」——
   无 `sessionId` 的任务不推送、Redis 或长连接不可用时客户端回退
   `GET /api/tasks/:id/progress` 轮询。
9. **高风险技能的确认链路已闭环（批准是任务级授权，不是一次性令牌）**：
   Agent 遇到高风险技能会创建真实的 `waiting_user` 任务且不入队；
   `POST /api/agent/sessions/:id/confirm` 在**同一次** `updateMany`（CAS
   `where: { id, status: 'waiting_user' }`）里把任务置回 `pending` 并写入批准凭据
   `confirmedAt`（数据库列 `agent_tasks."confirmedAt"`，camelCase，见 §9 第 2 条），
   只有这次写入真的命中 1 行，
   才入队、才把任务计入响应的 `resumed`、才广播 `task.status: pending` ——
   三者同源，CAS 落空（并发确认 / 用户取消 / Worker 抢先）时一律不做，
   避免产出「看似成功的失败」。
   Worker 侧按 `confirmedAt == null ? 全局默认 : 'allow'`（**宽松相等**，同时覆盖
   `null` 与 `undefined`）决策：非空说明用户在
   「确认执行」里批准过这条任务，本次执行放行确认闸门；缺失则沿用运行器的全局
   默认值 `reject`（`apps/worker/src/index.ts` 的生产默认仍是 `reject`），
   **未经确认的任务依旧停在 `waiting_user`**。端到端验收见
   `apps/api/test/confirmation-loop.test.ts` 与 `apps/worker/test/confirmation-loop.test.ts`。
   两条边界需要知晓：
   - **`/retry` 不得绕过确认闸门**：`requeueTask` 的 CAS 白名单**不含**
     `waiting_user`。对一条未确认的高风险任务调用 `POST /api/tasks/:id/retry`
     不会被置回 `pending`，而是以「任务正在等待用户确认」被拒绝。
     `retry` 不是批准的等价物 —— 它不写 `confirmedAt`，放行只会让 Worker
     再次把任务退回 `waiting_user`，还白白消耗一次尝试次数（这正是修复前的症状）。
     唯一的放行出口是确认接口。已确认的任务此时是 `pending` 且凭据仍在，
     重试照常工作。
   - **`confirmedAt` 没有撤销 / 消费语义**：它是「用户批准过这条任务」的审计事实，
     一次批准授权该任务的后续**所有**执行 —— 自动重试、租约回收后的重排，
     以及「确认过 → 取消 → `/retry`」都继续放行。
     也就是说安全属性「未确认不被放行」成立，而「一次批准 = 一次执行」不成立。
     之所以保持任务级授权：若改成 claim 时消费（每次执行后清空凭据），
     一次瞬时故障触发的自动重试就会立刻失去凭据、退回 `waiting_user`，
     反而更接近本轮刚修掉的「用户确认了也永远没有结果」那个缺陷。
10. **媒体生成端点依赖用户配置**：视频 / 音频 / 数字人的接口在各家差异极大，
    没有通用协议。适配器提供 `config.routes` / `config.asyncRoutes` 覆盖能力，
    但用户需要按自己的服务填写；未配置时会得到明确的「需要配置」提示，
    而不是发出必然失败的请求。
11. **Anthropic 与 Gemini 不提供图片 / 视频生成**：遇到这类能力请求时适配器
    明确报错并建议改用其它协议的模型，不发出必然 404 的请求。
12. **模型侧流式输出未接入**：适配器目前只支持一次性返回。
    `ModelInvokeResult` 与传输契约已预留位置，但 `supportsStreaming` 尚未被利用。
    注意这与 §6.9 的**传输层** SSE 是两件事：后者推的是任务 / 轮次级事件，
    一次 `agent.message` 就是一条完整回复，不是逐 token 增量。
13. **Agent UI 层的确认交互已交付（Phase 5B）**：`ConfirmationCard` 渲染
    载荷里的 `taskIds`，点「确认执行」调 `POST /api/agent/sessions/:id/confirm`
    并**精确放行这一组任务**；载荷里没有任何 id 时才退化为「确认全部执行」，
    且按钮文案会跟着变（不然用户会以为只确认了眼前这一条）。
    放行结果按 `resumed` / `skipped` 分别给出「已确认 N 个操作」「N 个未能放行
    （原因）」，不照抄后端那句「没有等待确认的操作」——并发确认或状态已变化时
    那句话会把人引向错误结论。
14. **前端侧的真实限制（Phase 5B 交付时确认）**：

    - **没有认证**：每个请求都不带身份，API 也没有鉴权（与 §9 第 3 条同源）。
      前端因此没有任何登录态、路由守卫或「未授权」分支。
    - **结果卡不落会话消息，刷新靠回捞**：见 §6.10「已知缺口」。
      回捞窗口只有最近 50 个成功任务，超出部分刷新后不会出现在对话流里
      （任务面板仍有记录）。
    - **计划不是可执行对象，「开始制作」只是一轮对话**：计划卡上的按钮发送
      一条「开始制作」消息触发新的 Agent 轮次，**不是**把计划提交给 Workflow
      Engine 逐步执行（Phase 9 才有执行器）。因此计划里的步骤状态只会停在
      「待开始」，界面不显示假的进度。
      另外这个按钮只在 `requiresApproval` 为真时出现（内置模板按「高成本节点
      ≥ 3」判定），而广告模板只有 1 个高成本节点 —— 于是广告场景下用户只能
      自己在输入框里敲「开始制作」，卡片上没有任何入口。
    - **未配置模型时工作台不提示去配置**：`model_providers` 为空时后端的
      Mock 回落会让整条链路照常返回占位结果，前端拿不到任何「模型未配置」的信号，
      用户看到的是无意义的占位文本（例如工具名变成「示例文本-878」）。
      目前只有 `/settings/providers` 在**列表为空**时给出「配置模型后才能开始生成内容」
      的提示条与空状态主操作。
    - **没有根级错误边界**：错误边界是**逐条消息**包在 `MessageBoundary` 里的
      （一条载荷渲染崩了，只有那条降级，对话流与工作台照常）。渲染期之外的异常
      （路由层、Provider 之外的外层组件）没有兜底，仍会白屏。
    - **会话历史一次最多 200 条**：`load()` 显式带 `limit=200`（端点上限），
      更早的历史需要分页加载，而「加载更早的消息」入口尚未实现。
    - **结果卡的媒体依赖存储可用性**：卡片里的 `media[].url` 来自技能写入的
      资产引用。存储（本地盘 / 远端 URL）不可用时卡片照常渲染，但媒体加载失败，
      界面不会替用户区分「生成失败」与「媒体取不回来」。
    - **手写类型接缝的护栏已经补上**：`apps/web/src/lib/api-types.ts` 是手写的
      （前端构建不该把 Prisma / Fastify 拉进 bundle），它原本声明的护栏是
      「跑一遍 spec §10 第 1 条的端到端」—— 而那条链路因下面第 15 条**不可达**，
      等于这个接缝上一道护栏都没有。现在由 `apps/api/test/api-contract.test.ts`
      承担：用 `app.inject()` 打 15 个真实端点，再用 TypeScript 编译器 API 从
      `api-types.ts` 解析出每个接口的**必填**字段，断言「声明了就必须真的存在」。
      这条不变量是**刻意单向**的（响应里多出的字段不报错），因为该文件的设计
      意图就是「只保留界面真正消费的字段」；反向断言只会制造噪音。
      写它的时候当场抓到一处真漂移：`TaskProgress.terminal` 被声明在任务列表项上，
      而服务端只在 `GET /api/tasks/:id/progress` 返回它 —— 列表项现在改用
      `TaskRow`。同一轮还删掉了一处照旧接口文档猜出来的字段（连通性测试的
      `{ ok }`，服务端从来不返回，`result.ok === true` 那个分支永远不成立）。
      **仍未覆盖**：`ToolCallRecord`（Mock 链路不产生工具调用，硬造样本等于自欺）
      与 `MessagePayload` 五个成员里本场景没有实际产生的那些。
    - **矮视口的极端档位（Phase 5B 尾账补测）**：`.workspace` 高度钉在 `100dvh`、
      栅格行为 `minmax(0, 1fr)`，输入区的垂直空间因此完全由视口高度决定。
      真机补测四档矮视口（844×390 / 667×375 / 390×320，以及含超长不可断行文本的
      844×390），**在 390×320 上发现了 B1 的复发形态**：
      `--layout-composer-max-height` 的绝对值 200px 让 header + 输入区的最小高度
      超过视口，`.main` 的 min-content 撑破容器，页面级滚动重新接管
      （文档高 367 > 视口 320），停止按钮底边被切掉 5px。844×390 与 667×375 正常。
      修法是把上限改成 `min(200px, 40dvh)` —— 视口高度 ≥500px 时算出来仍是 200px、
      外观零变化，矮屏则提前封顶并转为输入框内部滚动。修复后四档全部
      「文档高 == 视口高、无纵横滚动」，且在 390×320 与 844×390 上派发**真实鼠标
      点击**都能正常中断这一轮生成。
    - **一处被真机否证的代码注释**：`Composer` 曾写着「在 Chromium 里落在禁用
      表单控件上的点击会被派发到祖先元素」。用 CDP 真实鼠标点击实测（对照组：
      把 `disabled` 换成 `readonly`）表明**说反了**：禁用控件仍然参与命中测试
      （`elementFromPoint` 返回控件本身），但点击事件被整个吞掉 —— 控件收不到、
      祖先也收不到，更不会误触发旁边的按钮。`readOnly` 依然是对的选择，
      理由改写为「可聚焦、可选中、点击有正常反馈」。
15. **旗舰链路曾被两个后端缺陷卡住（Phase 5B 验收时确认，不是可选优化）** ——
    其中「技能 metadata」一条**已修复**：

    - ✅ **技能写出的 metadata 与 asset schema 的字段契约**（已修，范围比原估大得多）：
      原登记只提了 `video.generate` / `video.extend`，实际把 7 个生成类技能的
      写入点逐个对下来，**坏了 5 个**：

      | 技能 | 写了 schema 不认的键 |
      | --- | --- |
      | `image.generate` | —（合规，所以图片链路一直是通的） |
      | `audio.generate` | —（合规） |
      | `video.generate` | `aspectRatio`、`shotCount` |
      | `image.edit` | `generation.editedFrom` |
      | `video.extend` | `generation.extendedFrom`、`extraSeconds` |
      | `voice.generate` | `generation.voiceAssetId` |
      | `subtitle.generate` | `cues` |

      它们全都在「登记资产」这一步被 `.strict()` 拒掉，**而前面模型调用、进度上报
      一切正常** —— 表现是「跑了 10 秒然后失败」，错误文案指向 schema，
      排查时很难联想到是技能写错了字段名。

      **修法**（`packages/domain/src/asset.ts`）：`mediaMetadataSchema` 顶层收
      `aspectRatio`（图/视频）、`shotCount`（视频）、`cues`（字幕时间轴，按结构校验
      而不是收成 `unknown`）；`generation` 子对象收血缘字段 `editedFrom` /
      `extendedFrom` / `extraSeconds` / `voiceAssetId`。**`.strict()` 保持不变** ——
      这个 schema 本来就是「跨媒体类型的共享字段袋」（`channels` 只对音频、
      `fps` 只对视频、`sampleRate` 只对音频），新增字段符合既有约定，
      而放宽 strict 会直接毁掉写入时的类型安全。

      **为什么 5 个坏了都没人发现**：`packages/skills/test/skill-catalog.test.ts`
      只校验**目录元数据**（id 唯一、队列绑定、风险标记……），**从来不执行技能体**。
      本轮补上 `packages/skills/test/skill-execution.test.ts`：给每个已实现技能喂
      一份最小合法输入并真的执行一遍，承接写入的内存 `SkillAssetPort` 在
      `create` / `update` 时调用 domain 的真实 schema（与生产路径
      `buildAssetData` 同一套规则）。做过负向验证 —— 往 `video.generate` 里注入一个
      未知键，只有那一条用例失败并直接点名该字段。

      **端到端复验**：`video.generate` 经「建任务 → 会话确认 → 执行」跑通，
      `success 100%`，`output.card` 为带视频 URL 的 `result_card`，
      资产 metadata 为 `{duration, aspectRatio, shotCount, generation}`。
    - ✅ **广告计划卡没有「开始制作」按钮**（已修）：按钮原先只在 `requiresApproval`
      为真时渲染，而它由「模板里高成本节点 ≥ 3」判定
      （`packages/agent/src/workflow-planner.ts` 的 `APPROVAL_NODE_THRESHOLD`）。
      广告模板 13 步里只有 1 个高成本节点 —— 计划消息写着「确认后我就开始制作」，
      卡片上一个按钮都没有，用户只能自己猜到输入框里敲「开始制作」。

      **根因是判据用错了地方**，不是阈值不合适：`requiresApproval` 回答的是
      「系统要不要先停下来等你」（Agent 轮次据此结束在 `waiting_user`），
      而按钮回答的是「界面上有没有动手的入口」。把阈值从 3 调到 1 只能救广告模板，
      任何高成本节点更少的模板照样没有入口。

      **修法**（`apps/web/src/features/agent/renderers/PlanCard.tsx`）：操作区
      **始终**渲染 —— 计划产出后不会自动执行任何东西，这个入口是唯一的下一步，
      挂在任何可选字段上都等于把用户困在卡片上（本项目已因「把协议里可省略的字段
      当必填」白屏过一次）。`requiresApproval` 改为只影响一句提示文案
      （「这份计划包含多个高成本步骤，确认后才会开始执行。」）。

      **真机验证**：广告计划卡上两个按钮都在，按钮完全在视口内，
      `elementFromPoint(按钮中心)` 命中按钮自己，派发真实鼠标点击后
      确实发出了新一轮对话。端到端（计划卡 → 开始制作 → 确认 → 实时进度 →
      `success 100%`）已跑通。

      顺带修掉一条**把缺陷写成预期行为**的测试
      （`renderers.test.tsx` 的「不需要审批时不显示「开始制作」」）。
    - ✅ **未配置模型时工作台静默回落 Mock**（已修）：没有可用的真实模型时链路改用
      Mock，Agent 照常回复、任务照常执行，只是产出全是占位数据 ——
      界面此前拿不到任何信号（实测「示例文本-878」，`错误提示: []`），
      用户会把占位文本当成模型答复，与 spec §10 第 4 条「不要报错或**静默失败**」不符。

      **两处根因**：
      ① `buildModelRuntime` 里那句「数据库中没有可用的模型配置，已自动回落 Mock Provider」
         走的是 `options.logger?.warn`，而 API 侧**从来不传 logger** —— 警告被静默丢掉；
      ② `ModelRuntime.usingMock` 一直存在、注释也写着「供启动日志与就绪探针展示」，
         但**没有任何出口**，界面无从得知。

      **修法**：
      - `getAgentModelRuntime(logger?)` / `buildAgentDeps(logger?)` 接一个可选 logger，
        由 `routes/agent.ts` 与状态端点传 `request.log`（经一层收窄适配 pino 的重载签名）。
        实测日志里现在能看到 `level:40` 的那条警告。
      - 新增 `GET /api/models/providers/runtime` → `{ placeholderOnly, realModelCount,
        providerCount, modelCount }`，工作台据此显示常驻警告条并给出「去配置模型」入口。

      **`usingMock` 不能当判据（踩过的坑）**：它只表示「一个可用模型都没有、
      装配层加了内置 Mock 兜底」；而库里那条 `kind='mock'` 的 Mock Provider 行
      **自带 5 个模型**，于是「只剩 Mock 可用」时它依然是 `false`。
      实测：把唯一一个真实 Provider 禁用后，端点照样报 `usingMock:false`，
      提示条根本不会出现 —— 信号选错了等于没修。改成按 **Provider 类型**算：
      所有可用模型都来自 mock 类 Provider（或内置 `provider_mock`）→ `placeholderOnly: true`。

      **真机验证**（探针 `~/svh-probe/phase5b-tail/model-banner.mjs`，跑在**真的禁用了
      Provider 的环境**上）：只剩 Mock 时提示条出现、文案说清「都是占位内容」、
      链接指向 `/settings/providers` 且可点、条在视口内；还原后提示条消失
      （负向断言，否则「恒显」也能绿）。

      **选择「强提示但不禁用」**：原登记写的是「禁用「开始制作」」，实际改成不禁用 ——
      Mock Provider 本身是开发期合法功能，硬禁用会让没配 key 的人完全无法试用任何流程。
      提示条已经把「你现在看到的是假的」说清楚了。

      **回落机制（终审修正，先前的描述是错的）**：回落**不写数据库**。
      `buildModelRuntime` 在没有真实模型时只把 `buildMockProvider()` /
      `buildMockModels()` 的结果 `push` 进**内存数组**
      （`packages/database/src/model-runtime.ts:186-190`），
      因此「首次回落会 upsert `provider_mock` 行」的说法与代码不符 ——
      按那个描述去修会找错位置。真正会写库的是**记录 Mock 调用**时的惰性 upsert：
      `model_tasks.modelId` 是外键，而 Mock 模型在库里没有对应行，
      于是 `resolveModelRowId()`（`packages/database/src/model-runtime.ts:291-330`）
      在第一次记录 Mock 调用时 upsert 出 `provider_mock` 行（**`kind: 'custom'`**）
      与一条 `capabilities: []` 的模型行。

      **由此产生的真实陷阱（空库实测，2026-09-13）**：那些行一旦落库，下一次
      `buildModelRuntime` 就会读到它们，`models.length > 0` 于是**不再回落**
      （`usingMock: false`），而那唯一一条模型既没有能力声明、其 Provider 协议
      `custom` 也没有内置适配器 —— 结果是模型调用直接抛
      「没有可用于「text」能力的模型，请先在设置中配置模型 API」，
      比 Mock 回落更难用。实测序列：空库首次装配 `usingMock=true`／库中 provider 行 0
      → 跑一次 Mock 调用 → 库中出现 `provider_mock(kind=custom)` + `mockmocktextv1(capabilities=[])`
      → 再次装配 `usingMock=false`、模型 1 条 → 调用失败。
      这是一条**单向棘轮**：行落库后不会自行消失，只有手工清理或修掉 upsert 才能恢复。
      它属于下面的 ③，修复时要一并处理（要么别为 Mock 建库行，要么建出来的行
      带上 `kind: 'mock'` 与正确 capabilities，要么装配时跳过这些占位行）。

      **缓存不失效的运维陷阱（必须知道）**：`getAgentModelRuntime()`
      （`apps/api/src/core/agent-deps.ts`）把 Model Runtime 缓存在**模块级变量**里，
      进程内**不设过期**。本修复之前它导出的 `invalidateAgentModelRuntime()`
      没有任何调用方，注释里「Worker 的热更新会同时刷新它」也是错的
      （Worker 刷新的是它自己那份 runtime）。后果：界面里把 Provider 配好、
      连接测试通过，Agent 对话**仍然走进程启动时装配的那份**（未配置模型时即 Mock），
      用户看到的是占位文本，且没有任何提示。
      现在的行为：`routes/providers.ts` 用一条 `onResponse` 钩子在
      **任何非 GET 请求**之后调用 `invalidateAgentModelRuntime()`，
      下一次 Agent 对话即重新查库装配，与 Worker 的配置版本号轮询对齐。
      仍然需要重启 API 的唯一情形是**绕过 API 直接改库**（手写 SQL / seed /
      另一个进程代改）—— 那种改动不会经过写路径，缓存不会失效。

    **修复登记**：①②③ 均已完成（见上）。**spec §10 第 1、4 条现在都可以按字面重验**。
    仍在册的是上面那条「Mock 占位行落库后不再回落」的**单向棘轮**
    （涉及 `packages/database` 的装配语义，与 §9 第 16、17 条同列为后续任务）。
16. ✅ **测试与开发期 Worker 共用同一套队列**（已修）：
    两边共用同一个 `REDIS_URL` 库，而队列前缀写死成 `svh`
    （原 `packages/queue/src/index.ts:87`），于是正在跑的 Worker 会**抢走测试刚
    建出来的任务**并推到 `running` / 占用租约：

    ```
    confirmation-loop.test.ts   expected 'running' to be 'pending'
                                expected '抢占失败：already_leased' to contain '等待用户确认'
    smoke.test.ts               取消任务后状态为 cancelled…  expected 404 to be 204
    ```

    实测：Worker 在跑时 `@svh/api` 有 **5 条**失败；停掉 Worker 后同一份代码
    **118/118 全过**。不是代码缺陷，而是运行环境冲突 —— 但它极容易被误判成
    「刚才那个改动把测试改坏了」，排查成本远高于修它的成本。

    **修法**：`QUEUE_PREFIX` 进配置 schema（默认 `svh`，只允许字母数字下划线连字符），
    `createTaskQueuePool` / `createTaskWorker` 接受前缀参数，调用方从 `env` 传入；
    测试在 `setup-env.ts` 里改成自己的前缀（`svh-test-api` / `svh-test-worker`，
    队列包用 `svh-test-queue`）—— 放在 `loadEnvFile` 之后、任何 import 之前。
    各包用各自的前缀，因为 turbo 会并行跑它们的测试。

    **为什么前缀隔离就够**：对账循环 `reclaimExpiredTasks()` 确实直接查库，
    但它只回收**有租约且状态为 running** 的任务；测试建的任务拿不到租约
    （Worker 已经看不见它们了），因此不受影响。

    **验证**：Worker 一直开着，`@svh/api` **121/121 全过**、全流水线 **48/48**
    （此前这个组合必失败）。护栏 `apps/api/test/queue-isolation.test.ts`
    直接证明「同一个 jobId 在开发期前缀下查不到」。
    开发期链路另跑一条真实 `asset.create` 任务确认未被改坏（1 秒 success）。

    **仍未解决的同源问题**：桩服务（`~/svh-probe/task9/stub-openai.mjs`）的
    一次性状态会被 API 测试套件里的「继续」消耗掉，导致随后的探针复现拿到
    预置回复而不是工具调用。这次共用的是「已配置的模型 Provider」而非队列。
17. **`POST /api/tasks` 直接建高风险技能会永久卡在 `waiting_user`**：
    该端点把 `sessionId` 留空（`routes/tasks.ts:102` 传 `input.sessionId ?? null`），
    而任务级没有确认端点 —— 唯一的确认入口
    `POST /api/agent/sessions/:id/confirm` 在查询里**硬过滤 `sessionId`**
    （`routes/agent.ts:319-326`）。没有会话的任务因此没有任何接口能放行它。
    实测：建 `video.generate` 任务 → Worker 消费时撞确认闸门置为 `waiting_user`
    → `POST /api/tasks/:id/retry` 返回 `{retried:true}`，1.5 秒后又回到
    `waiting_user`（闸门只看 `confirmedAt`，而它永远为 null）。
    Agent 链路建的高风险任务都挂在会话上，所以旗舰链路不受影响；
    要修得先定口径：是禁止该端点建高风险技能，还是补一个任务级确认端点。

